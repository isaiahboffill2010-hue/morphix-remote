# Morphix roadmap — five phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Local foundation: Electron/React/TS kiosk app for 1024×600, push-to-talk mic, audio playback, live QD330 camera, Three.js viewer, model library, SQLite, local storage, demo Gemini/Meshy adapters, observation-only printer, settings, logs, crash recovery | **Built — awaiting on-device sign-off** |
| 2 | Gemini Live voice + Meshy generation, revisions, sizing by voice, cost confirmation | Not started (needs keys) |
| 3 | Print preparation: validation, repair, orientation, slicing via existing engine, QD330 file validation, protocol investigation | Not started |
| 4 | AI Print Guardian: snapshots, OpenCV, multi-frame confirmation, Gemini verification, alerts, incident history | Not started |
| 5 | Controlled printing: verified transfer, approved print start, pause/resume/cancel with confirmed acks, end-to-end demo, autostart | Not started |

## Phase 1 checklist (verify on the Pi with the touchscreen)
- [ ] App opens fullscreen on the 1024×600 touchscreen; all buttons easy to hit
- [ ] Hold-to-talk records from the TONOR G11; "Play recording" plays through the speaker
- [ ] "Test speaker" chime is audible
- [ ] Printer page shows the live QD330 camera and READY status
- [ ] "A small vase" → Create model → progress → Open in viewer; rotate/pinch/pan works
- [ ] 6 in preset updates the dimensions and fit check
- [ ] Library shows the model with a thumbnail after a restart
- [ ] Files appear under /home/jd/Morphix/models and the database under /home/jd/Morphix/database
