# VoiceAI release checklist

The PRD implementation and available automated checks are complete for the local demo. Release readiness is **not yet verified**: live voice rescheduling/recovery, controlled audible latency, and the portfolio recording require a microphone operator and recording capability.

## Evidence as of 12 October 2026

| Area | Evidence | Status |
| --- | --- | --- |
| Booking service | PostgreSQL constraints, concurrent slot race, confirmation matching, versioning, expiry, API validation | Automated checks pass |
| Browser journey | Book, refresh after offer/selection, lookup, review old/new times, reschedule, refresh final result | Observed; see BROWSER-QA.md |
| Voice booking | Tester confirmed booking succeeds after the confirmation-loop fix | Live verified before the latest safety changes |
| Interruption | Tester confirmed speech stops and the receptionist responds | Live verified |
| Voice tools | Installed SDK confirmation controls, correction rejection, real API booking/reschedule, taken-slot alternatives, recovery, lost responses | Automated checks pass |
| Failure handling | Permission denial/pending timeout, late grant cancellation, expired sessions, network timeouts, fatal provider events, unreachable-room cleanup | Automated checks pass |
| Metrics | Stage p50/p95, failures, observations, CSV/JSON exports, contextual run report | Implemented and tested |
| Final verification | `npm run verify`: 33 TypeScript tests, 24 Python tests, production build, isolated benchmark | Passed |
| API baseline | 40 booking, 40 reschedule, 40 idempotent retry samples; five warmup iterations | Measured without network |
| Live voice reschedule/recovery | Spoken old/new times, unchanged reference, new audio rooms at checkpoints | Pending |
| Controlled audible latency | Stable connection, actual model/network context, recording-based validation | Pending; previous reply estimates missed goals |
| Portfolio recording | Actual booking, correction, interruption, refresh, reschedule | Pending |

The verification artifact is `.data/verification/2026-10-12T13-46-58-999Z/verification.md`. It records booking p95 **1.7 ms** and reschedule p95 **1.9 ms** under Fastify injection with isolated PGlite. These values exclude network and do **not** verify the ≤300 ms HTTP round-trip goal. Retries preserved references; the slot race had exactly one winner.

## One final execution sequence

1. End any active conversation. In the worker terminal, press Control+C and run `npm run dev:agent`; wait for `registered worker`. Python dev mode does not hot-reload.
2. In a normal terminal, run `npm run verify -- --http`. It performs the build/tests and an isolated loopback HTTP benchmark. It does not use provider credits or modify `.data/booking`.
3. Run the full live voice checklist and capture setup/results using [FINAL-DEMO.md](FINAL-DEMO.md). Use synthetic names only. Export timing CSV and quality JSON after each session.
4. Complete `tools/demo-run.example.json` for each run, then use `npm run demo:report` as described in DEMO.md. Missing cases must remain `not_run`.
5. Record the actual five-scene portfolio demonstration after the live checks pass. Publish model/network context, sample counts, and missed goals alongside it.

The coding sandbox cannot bind the benchmark HTTP socket or access the Docker daemon. It also has no usable screen/audio recording capability and cannot supply the visitor's physical microphone speech. Injection measurements, mocked speech playback, and a recording script must not be presented as live audible verification or a recorded demo.

Standalone PostgreSQL pool/concurrency behavior remains unverified here. The default portfolio demo uses embedded PGlite; validate the standalone mode separately before claiming multi-process behavior. Public deployment is deferred by the PRD until the scripted flows pass.
