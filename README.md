# VoiceAI — Voice Appointment Receptionist

A browser receptionist for the fictional **Juniper Studio**, built from [VoiceAI-PRD.md](VoiceAI-PRD.md).

The booking foundation and LiveKit voice integration are implemented. You can find real available times, explicitly confirm a booking, look it up, reschedule it, and restore saved progress after a refresh. With a configured LiveKit project and the Python worker running, the browser connects microphone audio, streaming partial/final transcription, interruptible speech, and booking tools. A live greeting, speech exchange, and confirmed booking were observed on 11 October 2026; interruption behavior was confirmed by the tester. No measured voice performance claims are made yet.

## PRD delivery status

Follow the PRD sequence and validate each step before advancing:

1. **Booking foundation:** automated database and API checks pass; manual booking and rescheduling verified.
2. **Voice loop:** registered worker, greeting, incoming speech, partial/final transcripts, remote audio playback, and dialogue verified. Tester confirmed that speaking over the receptionist stops speech and receives a response.
3. **Tool integration:** a live voice booking produced a confirmed reference. Duplicate confirmation speech was found and fixed using the SDK's [tool reply controls](https://docs.livekit.io/reference/agents/events/). Automated reschedule tools verify old/new spoken times and new confirmation before a write. Tester verified successful booking after the confirmation-loop fix. Live voice rescheduling remains pending.
4. **Recovery:** browser refresh retries persisted, confirmed operations with the same ID. Voice reconnect rechecks saved offers and clears taken selections. Definitive conflicts reset confirmation while preserving an existing appointment; uncertain network outcomes remain pending. Automated API and conversation checkpoint checks cover these cases; live voice checkpoint scenarios remain pending.
5. **Quality pass — current step:** stage percentiles, failure counts, manual false-interruption/STT-correction markers, and a JSON report compare measurements with PRD targets. `npm run demo:report` combines exported metrics with setup and scripted outcomes into a reviewable run report. Fatal provider failures release browser audio so the form remains usable. Tester verified that booking succeeds after the confirmation-loop fix. Controlled voice baseline, live recovery/reschedule checks, and recorded scripted demonstration remain pending. See [QUALITY.md](QUALITY.md) for observed measurements and their limits.

## Run locally

Requires Node.js 22.12+ (tested with 24.18.0). The voice worker uses Python 3.11–3.13 (tested with 3.12.14) and LiveKit Agents 1.8.6.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on **http://127.0.0.1:3001**. Both processes bind to loopback. Vite forwards `/api` requests to the booking service.

By default, the API runs **PGlite**, an embedded PostgreSQL engine, with durable files in `.data/booking`. It runs the actual PostgreSQL schema, transactions, range types, and exclusion constraint. This mode supports one local API process; do not open the same data directory from multiple processes.

To use a standalone PostgreSQL server:

```sh
docker compose up -d
DATABASE_URL=postgresql://voiceai:voiceai@127.0.0.1:5432/voiceai npm run dev
```

The API applies its initial schema on startup. The standalone adapter uses a connection pool and per-transaction connections. Subsequent schema changes should use numbered migrations before deployment.

Environment variables are documented in [.env.example](.env.example). The API and Python worker load root `.env`; existing exported environment variables take precedence. Restart the processes after changing `.env`. Defaults: Asia/Kolkata, weekdays 09:00–17:00, starts every 30 minutes, consultation 30 minutes, extended care 60 minutes, and sessions expiring after 24 hours. Service seed data lives in `apps/api/src/schema.sql`. The API owns scheduling rules in `apps/api/src/booking.ts`.

## Enable voice with LiveKit Build

Use the LiveKit **Build** plan. No separate STT, LLM, or TTS provider keys are needed: the worker calls LiveKit Inference using your LiveKit project credentials. The [current pricing page](https://livekit.com/pricing) lists Build at $0/month with $2.50 inference credit, 5,000 WebRTC minutes, and no credit card requirement. Inference is limited by the included credit; it is not unlimited free model usage. Keep the project on Build and inspect its remaining quota in the dashboard. This app neither upgrades plans nor falls back to another paid provider.

1. Create your LiveKit Build project and get its URL and API key pair.
2. Put `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in root `.env`. A blank template has been created locally. Never use `VITE_` prefixes for secrets.
3. Install the worker, if not already installed:

   ```sh
   uv sync --project apps/agent --python 3.12
   ```

4. Start `npm run dev` in one terminal, then `npm run dev:agent` in another.
5. Reload the browser and press **Start conversation**. Grant microphone permission when prompted. The app uses your browser’s default microphone.

This implementation runs the Python worker locally, while LiveKit Cloud transports WebRTC audio and serves inference. The worker can reach the local booking API directly; deploying the worker to the cloud would require a reachable authenticated booking API and explicit secret configuration.

Production packaging is configured for Vercel, Neon PostgreSQL, and LiveKit Cloud. See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment order, secret storage, migrations, and usage limits. Local startup still uses the development worker described below.

Keep the worker terminal open. Audio transport alone does not mean the receptionist is ready: the browser shows **Waiting for receptionist** until it receives an agent state event, and ends the attempt after 30 seconds without one. `npm run dev:agent` also saves its output to ignored local `.data/agent.log` for startup diagnosis. Worker logging defaults to INFO, and SDK fields tagged as personal speech data are redacted before logging. Successful startup should report worker registration; a binding permission error means the worker must run from a terminal with normal socket access. Restart the worker after code changes; its dev command does not hot-reload.

Before audio connects, the browser shows **Allow microphone access** while the permission request is pending. Choose Allow in the browser prompt, or use **End conversation** to cancel. Startup has a 60-second deadline covering microphone permission, credentials, and connection; the separate receptionist-readiness deadline starts after audio publication. A late microphone grant after cancellation is immediately stopped and cannot connect a room.

To restart the worker:

1. Click **End conversation** in the browser if a conversation is active.
2. In the terminal running `npm run dev:agent`, press **Control+C** and wait for the shell prompt.
3. Run:

   ```sh
   cd /Users/rajatvarma/Documents/VoiceAI
   npm run dev:agent
   ```

4. Wait for **registered worker**, then press **Start conversation** in the browser. Keep the API/web terminal running. Do not launch a second worker alongside the old one.

If Start immediately stops with HTTP 401, LiveKit rejected the participant token. Check that the URL, API key, and API secret all come from the same project and check your system clock. Restart both the API and worker after editing `.env`. The browser shows startup failures and releases the microphone so you can retry.

The default configurable models are AssemblyAI Universal Streaming for STT, Gemma 4 31B for tool use, and Fish Audio S2.1 Pro for TTS. These are starting defaults, not winners of a measured latency comparison. Change `VOICE_STT_MODEL`, `VOICE_LLM_MODEL`, `VOICE_TTS_MODEL`, and `VOICE_TTS_VOICE` in `.env` to compare supported LiveKit Inference models.

Each voice session ends after five minutes on both browser and worker. This cap limits individual demos, but does not track your project's remaining credit or guarantee a monthly quota. A model or quota failure is shown as an error; the manual booking flow remains usable.

The browser receives a two-minute participant JWT scoped to one randomly named room, microphone publication, and subscription. The Python worker receives a separate one-use handoff ticket. It redeems the ticket with a local shared secret to load booking progress. Provider credentials and the long-lived booking session token do not enter job metadata or model prompts. The API generates `.data/agent-secret` with owner-only permissions; the local worker reads the same file.

Voice tools require a final visitor turn. Partial transcripts are display-only and speculative generation is disabled. Selecting a slot speaks its service, exact local time, and timezone. A new explicit affirmative turn is independently checked before the write tool runs. Corrections invalidate that confirmation. During an accepted booking transaction, the tool finishes its write despite audio interruption and preserves the operation ID for recovery.

Repeated selection of the same reviewed slot on an affirmative turn preserves the confirmation gate. If the gate has become unarmed, the commit tool reloads the selected details, verifies availability, and speaks a fresh exact review before accepting a later affirmation. It does not repeatedly ask for yes against an unarmed gate, and it never discards a pending operation ID to start another write. Gate diagnostics log only armed/affirmative flags, without transcripts.

Use **Reconnect conversation** to end the old audio room and start a new one against the saved session. Refresh likewise creates a new audio connection after you press Start. The agent resumes selected details or recovers a previously confirmed operation before offering another write. Live transcript text stays in browser memory; SDK session recording is explicitly disabled with `record=False`.

The redesigned booking screen focuses on the conversation, appointment details, and saved progress. The “Behind the conversation” panel and its observation/export controls have been removed. Timing events still go to the authenticated metrics API for developer inspection; the benchmark and run-report commands remain available. Existing CSV/JSON exports are historical evidence, not controls in the current UI.

## Try the demo

1. Enter a fictional visitor name and select a future weekday.
2. Find availability. The UI offers three choices per page.
3. Select a time. Refresh now to verify recovery before confirmation.
4. Review the service, name, exact time, and timezone. Click **Yes, book this appointment**.
5. Copy the confirmed `VA-…` reference.
6. Select **Move an appointment**, look up the reference, choose a new time, and confirm. The reference stays unchanged.
7. Refresh or click **Restore saved progress**. The final appointment and API timings return from durable storage.

The sidebar restore button reloads persisted state over HTTP. During voice, the transcript panel provides the audio reconnect simulation described above.

## Correctness and recovery

- The browser and Python agent only use the TypeScript API. Neither owns appointment writes.
- PostgreSQL rejects overlapping `tstzrange` intervals using a GiST exclusion constraint. Adjacent intervals are allowed.
- Each write locks the single bookable resource, checks availability, writes the appointment, stores the idempotent result, and updates session progress in one transaction.
- Rescheduling updates the existing row atomically. A conflict leaves the original appointment intact.
- The operation fingerprint includes action, reference, slot, service, and name. Reusing an ID with different arguments fails.
- Operation results belong to their originating session. A retried committed operation returns `already_committed` and its original reference.
- Confirmation must match previously saved selected details. A correction invalidates confirmation.
- The browser saves the operation ID before sending the booking request. After a lost response, session progress or operation lookup reveals the committed result. An uncommitted confirmed request can safely retry the same ID.
- Refresh automatically retries an uncommitted request only when its confirmation and operation ID were already persisted. An offer or selection alone cannot trigger a write. Unknown network failures preserve the pending operation; a definitive slot conflict requires a new selection and confirmation.
- A new voice session checks saved offers against current availability before repeating a selection. An unavailable selection is cleared, and a failed reschedule leaves the original appointment unchanged.
- Session updates use optimistic versions. Conflicting tabs reload current progress instead of overwriting it silently.
- An expired browser session stops audio and provides **Start a new session**. The replacement clears old selections, confirmation, transcripts, and timings; existing appointments remain booked and can be looked up by reference. An expired confirmation is never copied into the new session.
- Browser API requests time out after 10 seconds. Transport failures and malformed proxy responses leave confirmed operations pending instead of automatically retrying writes. A late expiry response from an old token cannot expire a newly created session.
- Session tokens contain 32 random bytes. The server stores only their SHA-256 hashes. Tokens travel in bearer headers, rather than URL paths.

## API

`GET /services`, `GET /availability?serviceId=&date=`, and `POST /sessions` are public local-demo endpoints. The remaining endpoints require `Authorization: Bearer <session token>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /session` | Restore structured progress and version |
| `PATCH /session` | Replace structured state using `{version, state}` |
| `POST /bookings` | Commit `{operationId, serviceId, slot, visitorName, confirmed: true}` |
| `GET /bookings/:reference` | Look up a synthetic demo booking |
| `POST /bookings/:reference/reschedule` | Commit `{operationId, slot, confirmed: true}` |
| `GET /operations/:id` | Inspect an operation belonging to this session |
| `POST /metrics` | Save an allowlisted stage, duration, and outcome |
| `GET /metrics` | Inspect latest 100 events, stage summaries, and window limit |
| `GET /health` | Check API and database health |
| `GET /voice/config` | Check whether LiveKit project credentials are configured |
| `POST /voice/connect` | Issue a room-scoped LiveKit JWT for an authenticated booking session |
| `POST /voice/redeem` | Redeem the one-use worker ticket using `x-agent-secret` |

Availability timestamps include the business timezone's UTC offset. Writes require an ISO timestamp with an explicit offset. Stored appointments use UTC timestamps and retain their business timezone.

Important outcomes include `committed`, `already_committed`, `slot_unavailable`, `invalid_time`, `not_found`, `operation_conflict`, `confirmation_required`, `version_conflict`, and `session_expired`. A failed write is not reported as a successful booking.

## Validate

```sh
npm run verify
```

`npm run verify` runs the production build, all TypeScript and Python tests, and an isolated route/database benchmark in one pass. It saves JSON and Markdown under `.data/verification/`. It makes no cloud inference calls and does not change `.data/booking`. The default benchmark excludes network, so it cannot verify the HTTP round-trip goal.

In a normal terminal with socket access, use `npm run verify -- --http` to include an isolated loopback HTTP benchmark. Or run `npm run benchmark:api` separately. The benchmark checks new bookings, same-reference rescheduling, idempotent retries, restored committed state, and a two-session slot race. It uses 40 samples per stage after five warmup iterations. Standalone PostgreSQL behavior is a separate validation.

See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for the current evidence and [FINAL-DEMO.md](FINAL-DEMO.md) for the complete final live-test and recording sequence. The latest automated pass had 37 TypeScript tests and 24 Python tests; live voice release checks and the recording remain explicit pending items.

The TypeScript suite runs against embedded PostgreSQL and covers concurrent requests, retried writes, lost-response recovery, direct overlapping database inserts, failed and successful rescheduling, date validation, service duration, DST offsets, session expiry, stale updates, bearer authentication, and HTTP validation. Voice tests check room grants, credential secrecy, one-use worker handoff, ticket expiry, and missing configuration. Python tests verify that partial or negative confirmation cannot write, corrections invalidate confirmation and change the selected time, offers contain at most three slots, and resumed confirmation reuses the operation ID. The installed LiveKit SDK is exercised with mocked speech playback to verify exact spoken confirmation, final-turn gating, duplicate-question suppression, and interrupted-call rejection.

Python integration tests also run the receptionist tools against the actual TypeScript API and isolated embedded PostgreSQL. A JSON-pipe bridge invokes the HTTP routes without opening sockets; it replaces only transport. Tests cover booking, lookup, rescheduling with an unchanged reference, a competing visitor taking the selected replacement slot, and response loss after a committed write. New conversations restore checkpoints before an offer, after an offer, after selection, and after persisted confirmation. They also verify taken-slot and failed-reschedule recovery. Browser recovery tests invoke the real API to check automatic replay, uncertain outcomes, stale session reads, and preserved original appointments. These do not use cloud inference, incur provider charges, or modify `.data/booking`, and do not substitute for live speech checks.

Browser verification completed: booking, selected-slot recovery after refresh, lookup, and reschedule with an unchanged reference. Standalone PostgreSQL pool behavior has not been exercised here: Docker socket access was unavailable. The embedded engine serializes transaction execution, so its concurrent-request test does not establish standalone multi-process performance.

The full browser journey was rechecked on 11 October 2026, including offer/selection refresh, reschedule review before and after refresh, and recovery of the final moved appointment. See [BROWSER-QA.md](BROWSER-QA.md) for the synthetic fixture, results, measurement limits, and remaining live voice checks.

## Project layout

```text
apps/api/src/       TypeScript booking API, database adapters, SQL schema
apps/web/src/       TypeScript demo UI and styles
apps/agent/src/     Python HTTP tools and conversation core
apps/agent/tests/   Python conversation safety tests
tests/             PostgreSQL-backed booking and API tests
```

## Voice validation still needed

Follow [DEMO.md](DEMO.md) for the scripted scenarios, expected evidence, setup record, and measurement boundaries. The timing panel now shows each stage's successful sample count, p50/p95, and separate failure count. Expand Recent events to inspect outcomes or export the current window as CSV. Exports contain only stage, duration, outcome, and timestamp; no transcript, visitor data, booking reference, or credentials.

Voice startup failures and worker STT/model/TTS errors are recorded by stage. Provider failures without measured duration use zero only in the event trace and never enter latency percentiles. The sample window is session-scoped and ordered newest first; it is not a project-wide benchmark or a per-turn trace.

After adding credentials, run the PRD's scripted voice cases: book, correct a time, interrupt the agent, confirm before the question finishes, reconnect after an offer, reconnect after confirmation, and reschedule. Compare models with the same phrases and network. Record actual latency and failures, then resolve any missed targets before calling the voice MVP release-ready.

The timing panel records browser-to-booking-API round trips for manual writes, agent-to-API round trips for voice writes, and SDK transcription, turn-detection, first-token, and first-audio-byte timings. Browser reply timing estimates the delay from detected microphone speech to received audible audio using Web Audio analysis on one browser clock. This estimate is approximate: background noise, quiet speech, and playback buffering affect it. It is labeled separately and must be validated against an audio recording before judging the PRD's audible-latency target. No live voice latency baseline has been recorded yet.

Use synthetic data only. Booking references are sufficient for this local demo, but real customer lookup and rescheduling require ownership verification. Raw audio is not captured or retained. Do not expose this development service publicly without deployment authentication, rate limits, and production secret configuration.

Architecture references: [PostgreSQL range constraints](https://www.postgresql.org/docs/current/rangetypes.html), [PGlite](https://pglite.dev/docs/), [Fastify](https://fastify.dev/docs/latest/), and [LiveKit agent sessions](https://docs.livekit.io/agents/logic/sessions/).
