# VoiceAI scripted demonstration

UI update: the observability panel and browser export/observation controls were removed by request. Timing events remain available through the authenticated metrics API. References below to timing-panel exports describe the earlier test workflow; they are not present in the redesigned booking screen. Use developer metrics tooling for new measurement runs.

Use fictional visitor **Alex Demo** and a future weekday in the displayed business timezone. Run the API, web app, and local Python worker. Keep the LiveKit project on Build. Confirm worker registration before starting audio.

This checklist is a test protocol, not a complete live voice test report. Booking API and conversation safety tests are automated. On 11 October 2026, worker registration, greeting, incoming speech, remote audio playback, live transcription, and a confirmed voice booking were observed. The tester confirmed interruption behavior. Other cloud scenarios remain unverified until each case is observed.

## Setup record

Record the test date, timezone, browser/version, operating system, network type, and selected STT, LLM, TTS, and voice names. Never include API keys, session tokens, or provider error payloads. The defaults are documented in `.env.example`; note any local overrides without copying the credential lines.

Use a fresh browser session for comparable runs. Open the timing panel. Its statistics cover the latest 100 events for that booking session; older events can leave the window. Export timing CSV and the quality JSON report after each run. Errors are counted separately and excluded from latency percentiles. An error duration of zero means duration was not measured.

## Scenarios

| Case | Actions | Evidence required |
| --- | --- | --- |
| Book | Ask for a consultation on a future weekday as Alex Demo. Choose an offered slot. Say “yes, book it” after the exact confirmation. | Real availability; no booking before confirmation; spoken and visible reference match. |
| Correct a time | Say “Tuesday at three—actually four.” Clarify the date if asked. | Agent checks four; stale three o'clock selection cannot commit. |
| Interrupt | Interrupt the spoken slot list with a different date or time. | Speech stops; final correction drives a fresh availability check. Observe false interruptions separately. |
| Early confirmation | Say “yes, book it” before the confirmation question finishes. | One confirmed write, or an explicit repeat request if speech was unclear; no duplicate reference. |
| Refresh after offer | Refresh before selecting a slot. Start voice again. | Saved service, date, and offer resume; selection rechecks availability. |
| Refresh after selection | Select a slot, refresh before confirming, then restart voice. | Exact selected details are spoken again; a new affirmation is required. |
| Taken selection on reconnect | Select a provisional time, book it from a second session, then reconnect the first session. | Stale selection is cleared; receptionist asks for a new time without writing. |
| Confirmed request not sent | Run the automated recovery checkpoint tests for confirmation persisted before transmission. | Recovery retries the original operation ID once; no additional affirmation or duplicate appointment. |
| Lost response | Use the automated retry test for a committed write whose result was lost. | Same operation ID returns original reference; exactly one appointment exists. Avoid inventing a live network failure result. |
| Reconnect after confirmation | Confirm, then use Reconnect conversation. | Persisted operation result is recovered; another write is not created. |
| Reschedule | Provide the reference, choose a new available time, and explicitly confirm the move. | Old and new times are confirmed; same reference; failed changes leave original intact. |
| Last slot conflict | Have two sessions select the same slot and confirm. | Exactly one succeeds; the other hears an unavailable outcome and alternatives. Automated API test covers the transaction invariant. |
| Misheard detail | Give an ambiguous date/time or correct the visitor name before confirmation. | Clarification; no write using stale or ambiguous details. |
| Missing worker | End the worker, then start browser voice. | Waiting for receptionist, followed by a clear 30-second timeout; microphone released. |
| Pending microphone permission | Start voice without answering the browser microphone prompt. | Allow microphone access is shown; after 60 seconds the attempt ends. A later grant cannot start the cancelled conversation. |
| Microphone denial | Deny the browser microphone request. | Clear permission retry message; no room connection or credential request. |
| Speech failure | Observe a provider/quota error without enabling paid fallback. | Failure count appears for the stage; saved booking progress remains usable. |
| Session expires | Keep a session until its configured lifetime ends, then perform an authenticated action. | Audio stops; **Start a new session** works; no old confirmation is replayed. Existing appointments remain available by reference. Automated checks advance an isolated API clock rather than changing the demo database. |

## Measurement boundaries

- Compare the same scenarios across models and networks. A handful of samples is not a stable p95; report sample counts.
- PRD goals: audible reply median ≤1.2 seconds and p95 ≤2.5 seconds; interruption median ≤350 ms; local booking API p95 ≤300 ms.
- Browser reply and interruption metrics are estimates based on detected audio. They do not prove the audible latency goals. Validate against a consented test recording before publishing a performance claim; the app does not record audio.
- Stage samples are independent, and a single turn can contain multiple tool calls. Adding stage percentiles does not calculate end-to-end latency.
- Use **Mark false interruption** when the receptionist stops without an intended interruption. Use **Mark STT correction** when the tester corrects a transcription mistake. These zero-duration observation events are saved with the session and counted separately from latency stages. Do not mark intended changes of date or time as STT mistakes. Record clarification counts and scenario results separately in the run notes.
- The quality report labels audio comparisons as estimates, missing stages as `not_measured`, and API timings as measured round trips. A target comparison does not prove release readiness. Reports omit transcripts, names, booking references, and session credentials.

## Portfolio recording

Before recording, create a run context from `tools/demo-run.example.json`. Choose a unique `runId`, record the actual setup, and mark each scenario as `pass`, `fail`, or `not_run`. Use `live_voice` for an observed cloud speech test, `automated` for a programmatic check, and `not_run` for an untested case. Keep unknown setup fields null. Do not include names, transcripts, booking references, keys, or provider error payloads.

After exporting the browser quality JSON, create the run report:

```sh
cp tools/demo-run.example.json .data/run-context.json
# Edit .data/run-context.json with the actual setup and observed outcomes.
npm run demo:report -- --metrics /path/to/juniper-quality-report.json --context .data/run-context.json
```

The command creates JSON and Markdown in `.data/quality/runs/`. It validates both inputs, recomputes PRD target comparisons from the numeric measurements, lists missing setup and scenarios, and distinguishes automated checks from live voice evidence. Scenario results remain tester-reported. The command does not contact providers, read `.env`, start a microphone, or certify audible latency. It refuses to overwrite an existing run; choose a new `runId` for another attempt. Keep the exported timing CSV beside the report when archiving the run.

After live cases pass, record a short synthetic demo: booking, corrected time, interruption, refresh, and reschedule. Keep the transcript, confirmed reference, and timing panel visible. Publish model/network context, sample counts, and any missed target alongside the recording.

| Run | Models / network | Successful cases | Failures / missed targets | Timing CSV |
| --- | --- | --- | --- | --- |
| 11 October 2026 initial live check | LiveKit Cloud, Chrome/macOS; no controlled network baseline | Greeting, dialogue, voice booking; interruption confirmed by tester | Duplicate confirmation found and fixed; fixed behavior and voice reschedule still need a fresh-session test | No benchmark export |
