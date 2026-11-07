"""Stateful failure detector. Feed it one snapshot at a time (bytes or a fetch
error) plus printer-state updates; it returns event dicts for the worker to
print. It never talks to the printer and never decides to pause anything."""
from __future__ import annotations

import hashlib
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

import numpy as np

from . import analysis
from .analysis import Roi

KINDS = ("spaghetti", "detachment", "stalled")

# MachineStatus values from M119 that mean "a job is running". Anything else
# (READY, PAUSED, ...) disables the failure checks when printer state is known.
PRINTING_STATES = {"BUILDING", "BUILDING_FROM_SD", "PRINTING", "BUSY_PRINTING"}
PAUSED_STATES = {"PAUSED", "PAUSE", "PAUSING"}

Event = Dict[str, object]
SaveEvidence = Callable[[bytes, str], Optional[str]]


@dataclass
class DetectorConfig:
    roi: Roi = (0.15, 0.2, 0.7, 0.75)
    analysis_width: int = 320
    # camera health
    black_mean: float = 12.0  # mean brightness below this = black frame
    blank_std: float = 4.0  # std below this = uniform/blank frame
    camera_lost_after: int = 3  # consecutive bad fetches/frames before camera_lost
    frozen_diff: float = 0.05  # mean abs diff below this (or identical bytes) = identical frame
    frozen_after: int = 6  # consecutive identical frames before frozen_frame
    # change detection
    pixel_threshold: int = 25
    baseline_alpha: float = 0.08  # EMA rate for background/texture baselines
    warmup_frames: int = 3  # frames used to build baselines before checks run
    spaghetti_ratio: float = 1.8  # texture must rise to this multiple of baseline
    spaghetti_min_increase: float = 0.02  # and by at least this absolute edge density
    detach_fraction: float = 0.30  # fraction of ROI changed vs background
    stall_seconds: float = 600.0  # no change for this long while printing = stalled
    stall_change: float = 0.003  # fraction of ROI pixels changed since the last frame below this = "no change"
    # confirmation: N suspicious of the last M analysed frames
    confirm_n: int = 3
    confirm_m: int = 5


@dataclass
class _KindState:
    window: Deque[bool]
    possible: bool = False
    confirmed: bool = False
    evidence: List[str] = field(default_factory=list)


class Detector:
    def __init__(self, config: DetectorConfig, save_evidence: Optional[SaveEvidence] = None):
        self.cfg = config
        self.save_evidence = save_evidence or (lambda data, label: None)
        self.kinds = {k: _KindState(window=deque(maxlen=config.confirm_m)) for k in KINDS}
        self.camera = "unknown"  # unknown | ok | lost | frozen
        self.failures = 0
        self.identical = 0
        self.frames = 0
        self.good_frames = 0
        self.printer: Optional[Dict[str, object]] = None
        self.prev: Optional[analysis.Frame] = None
        self.prev_digest: Optional[bytes] = None
        self.background: Optional[np.ndarray] = None  # float32 ROI background
        self.full_background: Optional[np.ndarray] = None
        self.edge_base: Optional[float] = None
        self.thin_base: Optional[float] = None
        self.last_change_at: Optional[float] = None

    # ----- inputs -------------------------------------------------------
    def update_printer(self, state: Dict[str, object]) -> List[Event]:
        """Accepts {"machine": "BUILDING_FROM_SD", ...} (a PrinterStatus) or
        {"printing": true}. Returns suspicion_cleared events if checks stop."""
        was_active = self.detection_active
        was_printing = self.printing
        self.printer = dict(state)
        if self.printing and not was_printing:
            self.last_change_at = None  # restart the stall clock for a new job
        if was_active and not self.detection_active:
            return self._clear_all("printer_not_printing")
        return []

    def reset_baseline(self) -> List[Event]:
        self.background = self.full_background = None
        self.edge_base = self.thin_base = None
        self.good_frames = 0
        self.last_change_at = None
        return self._clear_all("baseline_reset")

    @property
    def printer_state(self) -> Optional[str]:
        if not self.printer:
            return None
        m = self.printer.get("machine")
        return str(m).upper() if m is not None else None

    @property
    def printing(self) -> bool:
        if not self.printer:
            return False
        if isinstance(self.printer.get("printing"), bool):
            return bool(self.printer["printing"])
        return self.printer_state in PRINTING_STATES

    @property
    def detection_active(self) -> bool:
        """Checks run while printing, or when no printer state was ever given."""
        return self.printer is None or self.printing

    # ----- main entry ---------------------------------------------------
    def process(self, data: Optional[bytes], now: float, error: Optional[str] = None) -> List[Event]:
        self.frames += 1
        if error is not None or not data:
            return self._camera_failure("fetch_error", error or "empty response")
        img = analysis.decode_jpeg(data)
        if img is None:
            return self._camera_failure("decode_error", "snapshot is not a valid image")
        frame = analysis.prepare(img, self.cfg.roi, self.cfg.analysis_width)
        mean, std = analysis.brightness_stats(frame.gray)
        if mean < self.cfg.black_mean:
            return self._camera_failure("black_frame", f"mean brightness {mean:.1f}")
        if std < self.cfg.blank_std:
            return self._camera_failure("blank_frame", f"brightness std {std:.1f}")

        events: List[Event] = []
        self.failures = 0
        if self.camera in ("unknown", "lost"):
            events.append({"type": "camera_ok", "width": frame.width, "height": frame.height,
                           "recovered_from": None if self.camera == "unknown" else "lost"})
            self.camera = "ok"
            self.identical = 0

        # Frozen camera: identical pixels frame after frame. A live sensor always
        # has some noise, so this means the stream is stuck, not a static scene.
        digest = hashlib.sha1(data).digest()
        same_bytes, self.prev_digest = digest == self.prev_digest, digest
        if self.prev is not None and frame.gray.shape == self.prev.gray.shape:
            if same_bytes or analysis.mean_abs_diff(frame.gray, self.prev.gray) < self.cfg.frozen_diff:
                self.identical += 1
            else:
                if self.camera == "frozen":
                    events.append({"type": "camera_ok", "width": frame.width, "height": frame.height,
                                   "recovered_from": "frozen"})
                    self.camera = "ok"
                self.identical = 0
        if self.identical >= self.cfg.frozen_after and self.camera != "frozen":
            self.camera = "frozen"
            events.append({"type": "frozen_frame", "identical_frames": self.identical + 1})
            events.extend(self._clear_all("camera_frozen"))
        if self.camera == "frozen":
            self.prev = frame
            return events
        if self.identical > 0:
            # a repeated frame carries no new information: it must not count
            # towards N-of-M confirmation (or reset the stall clock)
            events.append({"type": "observation", "frame": self.frames, "printer_state": self.printer_state,
                           "detection_active": self.detection_active, "duplicate_frame": True,
                           "suspicions": [], "metrics": {"brightness": round(mean, 2), "contrast": round(std, 2)}})
            return events

        events.extend(self._analyse(frame, data, now, mean, std))
        self.prev = frame
        return events

    # ----- internals ----------------------------------------------------
    def _camera_failure(self, reason: str, detail: str) -> List[Event]:
        self.failures += 1
        events: List[Event] = []
        if self.failures >= self.cfg.camera_lost_after and self.camera != "lost":
            self.camera = "lost"
            self.prev = None
            events.append({"type": "camera_lost", "reason": reason, "detail": detail,
                           "consecutive_failures": self.failures})
            events.extend(self._clear_all("camera_lost"))
        else:
            events.append({"type": "frame_error", "reason": reason, "detail": detail,
                           "consecutive_failures": self.failures})
        return events

    def _analyse(self, frame: analysis.Frame, data: bytes, now: float, mean: float, std: float) -> List[Event]:
        cfg = self.cfg
        roi = frame.roi
        roi_f = roi.astype(np.float32)
        full_f = frame.gray.astype(np.float32)
        same_shape = self.background is not None and self.background.shape == roi.shape \
            and self.full_background is not None and self.full_background.shape == frame.gray.shape
        if not same_shape:
            self.background, self.full_background = roi_f.copy(), full_f.copy()
            self.edge_base = self.thin_base = None
            self.good_frames = 0

        motion, moving = 0.0, 1.0
        if self.prev is not None and self.prev.roi.shape == roi.shape:
            motion = analysis.mean_abs_diff(roi, self.prev.roi)
            moving = analysis.changed_fraction(roi, self.prev.roi, cfg.pixel_threshold)
        edge = analysis.edge_density(roi)
        thin = analysis.thin_structure_density(roi)
        bg = self.background.astype(np.uint8)
        roi_change = analysis.changed_fraction(roi, bg, cfg.pixel_threshold)
        outside_change = self._outside_change(frame.gray)

        if self.last_change_at is None or moving >= cfg.stall_change:
            self.last_change_at = now
        still_for = now - self.last_change_at

        warm = self.good_frames >= cfg.warmup_frames and self.edge_base is not None
        edge_base = self.edge_base if self.edge_base is not None else edge
        thin_base = self.thin_base if self.thin_base is not None else thin
        edge_ratio = edge / max(edge_base, 0.005)
        thin_ratio = thin / max(thin_base, 0.005)
        spaghetti_score = min(edge_ratio, thin_ratio)

        flags = {k: False for k in KINDS}
        scores = {"spaghetti": round(spaghetti_score, 3), "detachment": round(roi_change, 3),
                  "stalled": round(still_for, 1)}
        active = self.detection_active
        if active and warm:
            flags["spaghetti"] = spaghetti_score >= cfg.spaghetti_ratio and (edge - edge_base) >= cfg.spaghetti_min_increase
            # a lighting/camera change moves the whole frame; detachment is local to the bed
            flags["detachment"] = roi_change >= cfg.detach_fraction and outside_change < roi_change * 0.5
        if active and self.printing:
            flags["stalled"] = still_for >= cfg.stall_seconds

        suspicious = [k for k, v in flags.items() if v]
        if not (flags["spaghetti"] or flags["detachment"]):
            # learn slowly from normal frames only, so a failure cannot become the baseline
            a = cfg.baseline_alpha if warm else 0.5
            self.background = (1 - a) * self.background + a * roi_f
            self.full_background = (1 - a) * self.full_background + a * full_f
            self.edge_base = edge if self.edge_base is None else (1 - a) * self.edge_base + a * edge
            self.thin_base = thin if self.thin_base is None else (1 - a) * self.thin_base + a * thin
            self.good_frames += 1

        events: List[Event] = [{
            "type": "observation",
            "frame": self.frames,
            "printer_state": self.printer_state,
            "detection_active": active,
            "warmed_up": warm,
            "suspicions": suspicious,
            "metrics": {
                "brightness": round(mean, 2), "contrast": round(std, 2),
                "motion": round(motion, 3), "moving_fraction": round(moving, 4), "roi_change": round(roi_change, 4),
                "outside_change": round(outside_change, 4),
                "edge_density": round(edge, 4), "edge_baseline": round(edge_base, 4),
                "thin_density": round(thin, 4), "thin_baseline": round(thin_base, 4),
                "spaghetti_score": round(spaghetti_score, 3), "still_seconds": round(still_for, 1),
            },
        }]

        evidence: Optional[str] = None
        if suspicious:
            evidence = self.save_evidence(data, "suspect_" + "+".join(suspicious))
        for kind in KINDS:
            events.extend(self._confirm(kind, flags[kind], scores[kind], evidence, data))
        return events

    def _outside_change(self, gray: np.ndarray) -> float:
        if self.full_background is None or self.full_background.shape != gray.shape:
            return 0.0
        x0, y0, x1, y1 = analysis.roi_pixels(gray.shape, self.cfg.roi)
        diff = np.abs(gray.astype(np.int16) - self.full_background.astype(np.int16)) > self.cfg.pixel_threshold
        total = diff.size - (x1 - x0) * (y1 - y0)
        if total <= 0:
            return 0.0
        inside = int(np.count_nonzero(diff[y0:y1, x0:x1]))
        return float(np.count_nonzero(diff) - inside) / float(total)

    def _confirm(self, kind: str, hit: bool, score: float, evidence: Optional[str], data: bytes) -> List[Event]:
        st = self.kinds[kind]
        st.window.append(hit)
        if hit and evidence:
            st.evidence = (st.evidence + [evidence])[-self.cfg.confirm_m:]
        hits = sum(st.window)
        window = {"hits": hits, "of": len(st.window), "need": self.cfg.confirm_n, "size": self.cfg.confirm_m}
        events: List[Event] = []
        if hit and not st.possible and not st.confirmed:
            st.possible = True
            events.append({"type": "possible_failure", "kind": kind, "score": score, "window": window,
                           "evidence": evidence})
        if hits >= self.cfg.confirm_n and not st.confirmed:
            st.confirmed = True
            path = self.save_evidence(data, f"confirmed_{kind}") if hit else evidence
            events.append({"type": "confirmed_failure", "kind": kind, "score": score, "window": window,
                           "evidence": path or (st.evidence[-1] if st.evidence else None),
                           "evidence_frames": list(st.evidence)})
        if hits == 0 and (st.possible or st.confirmed):
            events.append({"type": "suspicion_cleared", "kind": kind, "reason": "no_longer_detected",
                           "was_confirmed": st.confirmed})
            st.possible = st.confirmed = False
            st.evidence = []
        return events

    def _clear_all(self, reason: str) -> List[Event]:
        events: List[Event] = []
        for kind, st in self.kinds.items():
            if st.possible or st.confirmed:
                events.append({"type": "suspicion_cleared", "kind": kind, "reason": reason,
                               "was_confirmed": st.confirmed})
            st.window.clear()
            st.possible = st.confirmed = False
            st.evidence = []
        return events
