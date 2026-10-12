# Browser journey verification

Verified on 11 October 2026 with Chrome/macOS against the running local API and web app. The test used `http://localhost:5173` for a separate browser-storage session, leaving the existing `http://127.0.0.1:5173` session intact. All actions used the browser form; no microphone or cloud speech inference was used.

## Observed results

| Check | Result |
| --- | --- |
| Search availability | Consultation on Monday, 19 October 2026 returned real provisional slots. |
| Refresh after offer | Service, date, visitor details, and available choices returned. No appointment was created. |
| Refresh after selection | The 09:00 Asia/Kolkata selection returned with the confirmation button. |
| Explicit booking confirmation | Clicking confirmation created one appointment and displayed a reference. |
| Refresh after booking | The confirmed appointment and original reference returned. |
| Lookup for reschedule | The reference retrieved the existing Monday appointment. |
| Review replacement | Tuesday, 20 October at 09:30 appeared alongside the original Monday time. The appointment card kept the original time before confirmation. |
| Refresh before reschedule confirmation | Both old and new times returned, still awaiting explicit confirmation. |
| Confirm reschedule | The appointment moved to Tuesday at 09:30; the reference stayed unchanged. |
| Reconnect and final refresh | The moved appointment returned with the same reference and no confirmation button. |
| Export quality report | Downloaded JSON contained two successful API round trips and no speech samples. |

The synthetic fixture is **Alex Demo**, reference **VA-C43B5F177638**, now booked for Consultation on **20 October 2026 at 09:30 Asia/Kolkata**. It remains in the local demo database so its lookup and voice reschedule can be checked. This test did not cancel or modify any prior appointment.

API round trips in this run displayed p50 **11 ms** and p95 **12 ms**, with two samples and zero errors. Two samples are not a sustained performance benchmark. The ignored local artifacts are `.data/quality/2026-10-11-browser-journey.json` and `.data/quality/runs/browser-journey-2026-10-11.md`.

## Remaining live voice checks

These browser results do not verify speech recognition, spoken old/new times, audible latency, or creation of a new audio room after simulated disconnect. Run the voice cases in [DEMO.md](DEMO.md), particularly rescheduling and refresh/reconnect at each checkpoint. The tester has already confirmed that booking succeeds after the confirmation-loop fix.
