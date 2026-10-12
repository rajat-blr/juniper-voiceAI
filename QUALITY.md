# VoiceAI quality observations

Observed on 11 October 2026 in the local Chrome/macOS demo using LiveKit Cloud and the local worker. This is a snapshot of the existing session's latest 100 events, not a controlled benchmark or a complete scripted-run history. Exact browser version, network conditions, and configured model overrides were not recorded for this snapshot.

| Stage | p50 | p95 | Successful samples | Errors |
| --- | --- | --- | --- | --- |
| Booking API round trip | 37 ms | 37 ms | 1 | 0 |
| Transcription | 1008 ms | 1449 ms | 18 | 0 |
| End-of-turn detection | 1072 ms | 2501 ms | 18 | 0 |
| Model first token | 433 ms | 1153 ms | 18 | 0 |
| Speech first byte | 620 ms | 903 ms | 20 | 0 |
| Browser reply estimate | 3050 ms | 4925 ms | 18 | 0 |
| Interruption estimate | 184 ms | 1942 ms | 5 | 0 |
| Voice startup | 2154 ms | 2237 ms | 2 | 0 |

The browser reply estimate exceeds the PRD goals of median ≤1200 ms and p95 ≤2500 ms. The interruption estimate's median is below the ≤350 ms goal. One API round trip is below the ≤300 ms p95 goal but is insufficient evidence of sustained performance. None of these observations establishes release readiness.

Browser reply and interruption values use audio-level estimates, not a verified recording of what the visitor heard. The speech stages have different sample counts and may overlap; their percentiles must not be added. End-of-turn detection has the highest displayed speech-stage p95 and merits investigation in a controlled run. Do not reduce endpointing delays without testing premature replies and false interruptions.

False-interruption and STT-correction markers were added after these interactions. Zero recorded markers does not mean no mistakes occurred. Reconnect has no samples in this snapshot.

The browser JSON export was downloaded, validated, and saved locally at `.data/quality/2026-10-11-initial.json`. The ignored local artifact contains aggregate telemetry only. A setup/scenario report was also generated at `.data/quality/runs/initial-snapshot-2026-10-11.md`. It records observed booking and tester-confirmed interruption; other scenarios remain unrun in this snapshot. Model names and network details remain unknown instead of being inferred from defaults.

## Remaining verification

1. Restart the worker after code changes and run the cases in [DEMO.md](DEMO.md), using synthetic visitor details.
2. Verify fresh-session confirmation, live rescheduling, and refresh/reconnect at each checkpoint.
3. Mark observed false interruptions and STT corrections during the run. Export timing CSV and the quality JSON report promptly, before older events leave the window.
4. Record actual model names, browser/OS versions, network conditions, scripted outcomes, and sample counts. Check estimated reply latency against a consented test recording before publishing audible performance claims.
5. Record the portfolio demonstration only after the live cases pass. State any missed targets and the evidence for their cause.
