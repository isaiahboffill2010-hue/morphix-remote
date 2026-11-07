# Vision worker (Phase 4)

Python/OpenCV process that pulls periodic snapshots from
`http://192.168.10.51:8080/?action=snapshot`, runs local checks (camera health,
frame differencing, spaghetti/detachment heuristics), confirms across several
frames, and only then asks Gemini about a suspicious snapshot. Evidence goes to
`/home/jd/Morphix/snapshots/`, incidents to SQLite. It reports
"possible failure", "confirmed failure", "pause requested" and
"printer confirmed paused" as separate states and never claims a pause it has
not seen acknowledged.
