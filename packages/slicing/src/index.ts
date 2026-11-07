// Print preparation (Phase 3). Phase 1 only provides build-volume checks used by
// the viewer; slicing is delegated to an existing engine (OrcaSlicer/PrusaSlicer,
// validated against official Afinia slicer output) — never a slicer written from scratch.
import { fitsBuildVolume } from "@morphix/domain";
import { QD330_BUILD_VOLUME_MM } from "@morphix/shared";

export interface SizeCheck {
  size: { x: number; y: number; z: number };
  fits: boolean;
  volume: typeof QD330_BUILD_VOLUME_MM;
}

export function checkBuildVolume(size: { x: number; y: number; z: number }): SizeCheck {
  return { size, fits: fitsBuildVolume(size, QD330_BUILD_VOLUME_MM), volume: QD330_BUILD_VOLUME_MM };
}
