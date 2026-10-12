# Product Requirements Document: Voice Appointment Receptionist

**Status:** Draft for implementation  
**Version:** 1.0  
**Date:** 11 October 2026  
**Owner:** Rajat Varma  
**Planned location:** `Documents/VoiceAI/VoiceAI-PRD.md`

## 1. Product summary

Build a browser-based, real-time voice receptionist. A visitor uses the microphone and speakers on their own device to book or reschedule an appointment through natural speech. The application shows live transcription, available slots, and the final appointment. If the visitor refreshes the page or loses the connection, they can return to the unfinished request without repeating confirmed details.

The MVP uses a **Python voice agent** and a **TypeScript booking service**. The browser microphone is the input; no phone number or telephony provider is needed. The first demo uses a fictional appointment-based business and synthetic customer information. Voice models may run through external services; “local mic” describes the input device, not a requirement for on-device inference.

### Problem

Booking interfaces make customers browse dates and forms. Basic voice bots often feel slow, mishandle interruptions, or lose progress when the connection drops. The project should demonstrate a voice interaction that completes a real booking while making latency and recovery visible.

### Product promise

“Speak naturally to find, book, or change an appointment. Interrupt or reconnect without losing progress.”

## 2. Goals and success criteria

| Goal | MVP success criterion |
|---|---|
| Complete a booking | A visitor can select a service, hear available slots, confirm one, and receive a booking reference. |
| Change an appointment | A visitor can provide the booking reference, hear alternative slots, confirm one, and see the updated appointment. |
| Support natural speech | The agent accepts corrections and interruptions without duplicating a booking or using stale details. |
| Recover a session | After a refresh or simulated disconnect, the visitor can resume from persisted, confirmed state. |
| Show real-time progress | The interface displays partial and final transcription, current intent, and booking status. |
| Make performance inspectable | A developer can see latency for transcription, turn detection, model response, speech generation, tool calls, and audible reply. |

Initial performance targets are **engineering goals**, not claims about an implemented system. Measure a baseline with the chosen models before treating them as release gates:

- Median delay from end of visitor speech to first audible agent audio: **≤ 1.2 seconds**; p95: **≤ 2.5 seconds** on a stable connection.
- Median time for the agent to stop speaking after a genuine interruption: **≤ 350 ms**.
- Booking or reschedule API p95: **≤ 300 ms** in local testing, excluding model time.
- **Zero** double bookings in concurrent slot tests; **zero** duplicate writes after retried tool calls.
- Recovery succeeds at every scripted checkpoint: before a slot is offered, after an offer, and after confirmation but before the browser receives the result.

## 3. Scope

### In scope for MVP

- Browser microphone and speaker session.
- Streaming speech recognition with partial and final transcripts.
- Spoken responses that can be interrupted.
- One fictional business with a configurable timezone, working hours, services, and appointment durations.
- Search available slots, book an appointment, look up a booking, and reschedule it.
- Spoken confirmation before any booking write.
- Durable booking state and recoverable conversation progress.
- A compact web UI showing connection state, transcript, proposed slot, appointment, and performance metrics.
- Synthetic data and a scripted demonstration.

### Out of scope for MVP

- Phone numbers, SIP trunks, SMS, email, payments, calendar-provider integration, and multiple businesses.
- Cancellation, waitlists, staff assignment, recurring appointments, and multilingual support.
- Production identity verification or real customer records.
- Autonomous decisions outside the booking tools.

The architecture should allow telephony to replace the browser audio transport later without changing booking rules.

## 4. Users and jobs

**Visitor:** Wants to book or move an appointment quickly, without using a form. They need confidence that a slot is real and the final change succeeded.

**Business operator:** Wants a consistent schedule with no duplicate or overlapping appointments. In the MVP, this role configures services and business hours through seed data or configuration rather than an admin UI.

**Portfolio reviewer:** Wants to see the actual voice interaction, system behavior during an interruption, recovery after a disconnect, and evidence that booking writes are correct.

## 5. Core user journeys

### 5.1 Book an appointment

1. Visitor clicks **Start conversation** and grants microphone access.
2. Agent asks what service they need. The browser shows partial transcription while the visitor speaks.
3. Agent confirms the service and preferred date or time window when needed.
4. Python agent calls `find_slots` on the TypeScript service.
5. Agent offers a small number of real slots. The UI shows the same choices.
6. Visitor selects a slot. Agent repeats the service, date, time, and timezone and asks for confirmation.
7. Only after an affirmative response, the agent calls `create_booking` with an operation ID.
8. TypeScript service commits the booking transaction and returns a reference. The agent speaks the reference and the UI shows the confirmed booking.

### 5.2 Correct or interrupt

If the visitor says “Tuesday at three—actually, four,” the agent must use the corrected time. If the agent is speaking and the visitor interrupts, audio playback stops promptly. Any previous slot offer becomes provisional; the agent checks availability again when the visitor chooses a new time. A partial transcript may help the agent prepare, but a booking write requires a final understood request and explicit confirmation.

### 5.3 Reschedule

1. Visitor provides a booking reference in the demo.
2. Service retrieves the current booking. The UI displays the existing time.
3. Agent gathers the desired replacement time and checks available slots.
4. Agent repeats old and new times, then asks for confirmation.
5. Service changes the booking in one transaction. The reference stays the same.
6. Agent announces success only after the service returns a committed result.

### 5.4 Refresh or disconnect

1. A browser session receives an opaque session token and stores it locally.
2. The booking service saves structured progress after meaningful steps: intent, service, preferred date, offered slot, selected slot, and confirmation state.
3. After refresh, the browser reconnects and presents the same token.
4. The agent loads that structured state and resumes with a short recap. Example: “We were finding a cleaning appointment for Thursday afternoon. Shall we continue?”
5. If a booking write succeeded but its reply was lost, the same operation ID returns the original committed result. The agent reports the booking instead of creating another.

Recovery means resuming a task in a **new audio session**. It does not require preserving the old audio connection. Sessions expire after a configurable period; the default demo value is 24 hours.

## 6. Functional requirements

| ID | Requirement | Acceptance test |
|---|---|---|
| FR-01 | Ask for microphone permission only when the visitor starts a session. | Denial gives a clear retry path. |
| FR-02 | Stream audio to the Python agent and show partial and final transcripts separately. | Partial text updates during speech; final text replaces it. |
| FR-03 | Let visitors interrupt spoken output. | Agent stops, takes the correction, and updates its pending request. |
| FR-04 | Use service-provided availability; never invent a slot. | Offered slots appear in the service response. |
| FR-05 | Confirm service and exact local time before booking or rescheduling. | No write occurs before confirmation. |
| FR-06 | Keep all appointment writes in the TypeScript service. | The Python process has no direct appointment-table write path. |
| FR-07 | Reject overlapping bookings in a database transaction. | Two simultaneous requests for one slot yield exactly one success. |
| FR-08 | Make write tools idempotent. | Retrying the same operation ID returns the original result. |
| FR-09 | Persist structured progress and restore it after reconnect. | Refresh at each checkpoint preserves confirmed details. |
| FR-10 | Treat tool errors as outcomes to explain. | On a taken slot, agent offers alternatives; it never claims success. |
| FR-11 | Show final booking status and reference in the UI. | Spoken and visible results match database state. |
| FR-12 | Capture timing and failure events without storing raw audio by default. | Metrics can be inspected after a test session. |

### Conversation rules

- Keep spoken replies brief; offer at most three slots at a time.
- Use one explicit timezone throughout a conversation. Speak the weekday and time clearly.
- Ask for clarification when a date, time, service, or booking reference is ambiguous.
- Confirm corrections before committing a write.
- Prefer a tool result over conversational memory for availability or appointment status.
- Never announce “booked” or “changed” before a successful API response.
- If transcription fails, ask the visitor to repeat the relevant detail.

## 7. Proposed architecture

```text
Browser UI (TypeScript)
  ├─ microphone and speaker via WebRTC
  ├─ live transcript, connection state, appointment card
  └─ opaque session token for resume
             │
             ▼
Python voice agent
  ├─ streaming STT → turn detection → language model → streaming TTS
  ├─ interruption handling and concise voice instructions
  ├─ tool calls to the booking API
  └─ latency/error events
             │ HTTPS
             ▼
TypeScript booking service
  ├─ availability and timezone rules
  ├─ transactional booking/rescheduling
  ├─ idempotency and session-state endpoints
  └─ PostgreSQL
```

**Suggested components:** LiveKit for browser audio transport and the Python voice agent; a Node.js TypeScript API; PostgreSQL for appointments and session progress. The booking API is also usable without voice, which makes correctness tests fast and deterministic. The voice transport and model providers should be replaceable behind narrow interfaces.

### Component ownership

| Component | Owns | Must not own |
|---|---|---|
| Browser | Microphone consent, audio playback, visual state, reconnect token | Booking rules |
| Python agent | Speech, conversation flow, interruption, tool selection | Direct database writes or final availability decisions |
| TypeScript service | Business hours, slot search, conflict checks, write transactions, durable progress | Audio processing |
| PostgreSQL | Appointments, idempotency records, recoverable session state | Model or speech logic |

### Tool/API contract, initial proposal

- `GET /services` — service IDs and durations.
- `GET /availability?serviceId=&date=` — available starts in the business timezone, each with an unambiguous timestamp and UTC offset.
- `POST /bookings` — create after explicit confirmation; accepts `sessionId`, service, slot, visitor name, and `operationId`.
- `GET /bookings/{reference}` — retrieve current booking for the demo.
- `POST /bookings/{reference}/reschedule` — move an existing booking; accepts new slot and `operationId`.
- `GET /sessions/{token}` — load structured progress.
- `PATCH /sessions/{token}` — update progress with a version number to avoid stale overwrites.

Write responses must distinguish `committed`, `already_committed`, `slot_unavailable`, `invalid_time`, and `not_found`. The agent should not have to infer whether a timeout hid a successful write: it retries with the same `operationId` or queries operation status.

## 8. Data and scheduling rules

### Main records

- **Service:** ID, display name, duration in minutes, active flag.
- **Appointment:** reference, service ID, visitor display name, start and end timestamps, timezone, status, created/updated timestamps.
- **Operation:** operation ID, action type, request fingerprint, committed result, created timestamp. A reused ID with different arguments is rejected.
- **Conversation session:** opaque token hash, state version, intent, confirmed fields, candidate/selected slot, pending operation ID, expiry timestamp.
- **Performance event:** anonymized session ID, stage, start/end timestamps, result, error class.

Store timestamps in UTC and display them in the configured business timezone. Slot length comes from the service duration. The MVP has one bookable resource, weekdays from 09:00 to 17:00 in the business timezone, and two sample services of 30 and 60 minutes. These are demo defaults, not fixed product assumptions. Use timezone-aware date handling, including daylight-saving changes.

Availability results are provisional. At commit time, the service checks conflicts again inside a transaction. A unique operation ID makes retries safe. A reschedule updates the appointment atomically so a failed change leaves the old appointment intact.

## 9. Latency and observability

Measure the latency the visitor actually hears, from end of their speech to first audible agent response. Break it into:

1. Audio transport and speech recognition.
2. End-of-turn detection.
3. Language-model first response or tool-call decision.
4. Booking API round trip, when used.
5. Speech synthesis and playback start.

Display per-turn p50 and p95 over scripted test runs, plus interruptions, false interruptions, STT corrections, tool errors, and reconnects. Keep partial transcripts visible in the UI, but rely on final transcripts and explicit confirmation for writes. Avoid lowering turn-detection delays blindly: premature replies can worsen the conversation even if a stopwatch improves.

## 10. Privacy and reliability boundaries

- Use fictional business data and synthetic customer details in the public demo.
- Do not record or retain raw audio by default. If recording is added later, make consent and retention explicit.
- Keep provider keys and database credentials on the server. The browser receives only short-lived connection credentials.
- Treat the browser session token as a secret; generate a random value, store only its hash on the server, and expire it.
- A booking reference alone is suitable for a synthetic demo, not real identity verification. Before handling real customers, add a verified ownership step for lookup and rescheduling.
- Handle reconnects, duplicate tool calls, STT/model failures, unavailable slots, and database errors explicitly.
- Do not log full personal details in performance traces.

## 11. Test and demo plan

### Booking service tests

- Business hours, service duration, timezone and daylight-saving edge cases.
- Concurrent booking attempts for one slot.
- Same operation ID repeated after timeout.
- Same operation ID with changed arguments is rejected.
- Reschedule preserves the old appointment when the new slot is unavailable.
- Session version conflicts and expiry.

### Voice scenario tests

| Scenario | Expected result |
|---|---|
| “Tuesday at three—actually four” | Only the corrected time is considered. |
| Visitor interrupts a spoken slot list | Agent stops and follows the new request. |
| Visitor says “yes” before the agent finishes | Confirmation is recognized once. |
| API times out after committing a booking | Retry returns the same reference; one appointment exists. |
| Browser refreshes after a slot is offered | Agent recalls the offered slot and verifies current availability. |
| Browser refreshes after confirmation | Agent checks the operation result before speaking. |
| Two visitors choose the last slot | One succeeds; the other hears alternatives. |
| STT mishears a name or time | Agent asks for clarification before writing. |

Record a short demo with a booking, a correction, an interruption, a refresh, and a successful reschedule. Show the live transcript, appointment card, and timing panel. The recorded demo and README should state the model and network setup used, so latency numbers have context.

## 12. Delivery sequence

1. **Booking foundation:** Implement and test the TypeScript API, PostgreSQL schema, slot conflict transaction, and idempotency.
2. **Voice loop:** Connect browser mic and speaker to the Python agent. Add partial transcripts, short replies, and interruption handling.
3. **Tool integration:** Wire slot search, booking, lookup, and rescheduling to the API. Require confirmation before writes.
4. **Recovery:** Persist structured state and pending operation IDs; restore after refresh and simulated disconnect.
5. **Quality pass:** Add latency breakdowns, scripted voice cases, error handling, and a clear demo UI.

## 13. Release criteria

The MVP is ready to present when the booking and reschedule journeys work end to end; concurrent writes cannot double-book; retries cannot duplicate actions; refresh recovery works at all listed checkpoints; the UI distinguishes provisional and committed results; and the scripted demo records actual latency and failure behavior. Document any measured target that was missed, with the stage responsible.

## 14. Open decisions

| Decision | Recommended starting point | Resolve when |
|---|---|---|
| Demo business | Generic appointment-based service | Before creating seed data and copy |
| Voice providers | Pick streaming STT and TTS after a small latency comparison | Before voice integration |
| Agent model | Choose for reliable tool use and acceptable first-response latency | Before voice integration |
| Session lifetime | 24 hours for demo | Before recovery tests |
| Deployment | Local development first; deploy only after scripted flows pass | Before public portfolio demo |

## 15. Portfolio positioning

Present this as a **real-time voice systems** project. The case study should show the audio-to-tool flow, how interruptions change state, why booking writes remain safe after retries, and measured response latency. Keep it separate from the existing evals project and the planned insurance automation project so each demonstrates a distinct engineering skill set.
