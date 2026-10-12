# Final live verification and recording

UI update: the booking screen no longer includes the observability panel or export controls. Timing evidence is available through the authenticated metrics API and offline tools. Timing-panel shots in the earlier storyboard require separate developer tooling.

This is the complete final handoff, not a video or a successful live test report. Follow it once, record outcomes, and do not infer untested results from passing automated checks.

## Preparation

- Keep `npm run dev` running. Restart the worker after the latest Python changes with `npm run dev:agent` and wait for registration.
- Open `http://127.0.0.1:5173`, or the separate `http://localhost:5173` test tab. These origins have separate browser session storage. Allow microphone access for the origin you use.
- Use **Alex Demo** and future weekdays in **Asia/Kolkata**. If a named time is unavailable, use a time returned by the receptionist rather than inventing availability.
- Record the actual STT, LLM, TTS, and voice names from the configured worker, plus browser/OS versions and network type. Do not copy credential lines from `.env`.
- Use a screen/audio recorder with the tester's consent. The app does not record raw audio. Show only the demo window, transcript, appointment card, and timing panel.
- Each audio session has a five-minute cap. Refresh/reconnect starts a new room; keep the recording running across those changes.

## Live acceptance pass

| Step | Visitor action | Required observation |
| --- | --- | --- |
| 1 | Start voice; ask for a Consultation on 22 October 2026 as Alex Demo. | Greeting, partial/final transcripts, real slots; no appointment yet. |
| 2 | Interrupt a slot list: “Actually, October 23 at ten.” | Speech stops; final correction drives fresh availability. |
| 3 | Select an offered time, then correct it before saying yes. | Old selection cannot commit; corrected details are reviewed. |
| 4 | After selecting a time, refresh before confirmation. Start voice again. | Exact service/date/time/timezone return; new affirmative reply required. |
| 5 | Say “Yes, book it” after the review. | Spoken and visible reference match; one appointment. |
| 6 | Use **Reconnect conversation** after booking. | New audio session restores the original confirmed reference. |
| 7 | Ask to move that booking to another offered weekday/time. | Old and new times are read before confirmation. |
| 8 | Say “Yes, move it.” | Same reference, new committed time; no change before confirmation. |
| 9 | In another request, refresh after an offer but before selecting. | Saved request resumes and availability is rechecked. |
| 10 | In another request, say yes before the review finishes. | One accepted confirmation, or a clear repeat request; no duplicate write. |
| 11 | Give an ambiguous date/time or correct a misheard name. | Clarification; no write using the ambiguous or stale detail. |

An existing synthetic fixture is **VA-C43B5F177638**, originally moved by the browser test to **20 October at 09:30 Asia/Kolkata**. Look it up first because later tests may have changed it. It can be used for a focused voice reschedule check to **21 October at 10:00**, subject to current availability.

Automated tests cover committed response loss, retries, slot races, stale selections, confirmed-but-unsent requests, failed reschedule recovery, expiry, and provider-failure event handling. Do not call these live cloud failure tests. If an actual provider error occurs, record its stage/outcome without recording the provider payload or switching to a paid fallback.

## Measurement run

Repeat a consistent short booking/reschedule dialogue on the same model and stable network. Mark observed false interruptions and STT corrections; an intended date/time change is not an STT mistake. Record clarification counts separately. Export both reports promptly because the session window contains only the latest 100 events.

The earlier uncontrolled reply estimates were p50 **3.05 seconds** and p95 **4.925 seconds**, above the PRD goals of **1.2/2.5 seconds**. End-of-turn detection had the largest displayed speech-stage p95. Its values can overlap transcription timing; do not add stage percentiles or assume causation. Test any endpointing/model change against corrections and false interruptions before retaining it.

Compare browser reply/interruption estimates with what the consented recording actually captures. Report sample counts and any missed target. Do not claim a stable p95 from a handful of turns.

## Recording storyboard

1. **Start and book:** Show microphone consent, a short request, real slots, and the exact confirmation. Display the committed reference.
2. **Correct and interrupt:** Interrupt a reply with a changed time. Show final transcription and the changed provisional selection.
3. **Refresh:** Refresh before confirmation; restart voice and show restored details. Confirm only after the recap.
4. **Reschedule:** Supply the reference, hear old/new times, confirm, and show the unchanged reference with its new time.
5. **Inspect:** Show latency percentiles, sample counts, failure/observation counts, and export the run evidence. State which goals were missed.

For each completed run, copy `tools/demo-run.example.json` into `.data`, choose a unique `runId`, and enter the actual setup and outcomes. Use `live_voice` only for observed speech cases. Then run:

```sh
npm run demo:report -- --metrics /path/to/juniper-quality-report.json --context .data/run-context.json
```

Keep the generated Markdown/JSON, exported timing CSV, and actual recording together. Review them for missing cases and setup before presenting the project.
