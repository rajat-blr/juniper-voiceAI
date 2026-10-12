"""LiveKit worker with streaming speech, booking tools, and recoverable progress."""

import asyncio
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession, RunContext, function_tool, inference, llm
from livekit.plugins import silero

from .booking_client import BookingClient, BookingError
from .confirmation import ConfirmationGate, is_affirmative
from .conversation import Conversation

ROOT = Path(__file__).resolve().parents[4]
load_dotenv(ROOT / ".env")
LOGGER = logging.getLogger("voiceai")
server = AgentServer(log_level="INFO")


class RedactSpeechDetails(logging.Filter):
    def filter(self, record):
        for key in tuple(vars(record)):
            if key.startswith("lk.pii."):
                setattr(record, key, "[redacted]")
        return True


def suppress_duplicate_confirmation(event):
    for call, output in event.zipped():
        if call.name not in {"select_slot", "confirm_booking"} or output.is_error:
            continue
        try:
            result = json.loads(output.output)
        except (ValueError, TypeError):
            continue
        if isinstance(result, dict) and result.get("status") == "awaiting_confirmation":
            # Selection or confirmation recovery already speaks the exact question.
            # Preserve the tool result, but suppress the model's second question.
            output.reply_required = False


def speech_error_stage(event):
    return {"stt_error": "stt", "llm_error": "model", "tts_error": "tts"}.get(
        getattr(event.error, "type", ""), "connection"
    )


def speech_failure_event(event):
    if getattr(event.error, "recoverable", False):
        return None
    # Never publish provider payloads, credentials, or transcript details.
    return {"type": "error", "fatal": True, "message": "Speech service unavailable. Your booking progress is saved. Use the form or reconnect."}


class Receptionist(Agent):
    def __init__(self, conversation: Conversation, services: list[dict], timezone: str, publish):
        self.conversation = conversation
        self.services = services
        self.timezone = timezone
        self.publish = publish
        self.gate = ConfirmationGate()
        self.tool_lock = asyncio.Lock()
        today = datetime.now(ZoneInfo(timezone)).strftime("%A, %Y-%m-%d")
        super().__init__(instructions=f"""You are Juniper Studio's warm, concise appointment receptionist.
Today is {today}. Use {timezone} for every date and time.
Services: {json.dumps(services)}. Ask for a fictional visitor name.
Offer at most three slots, and only from find_slots. Clarify ambiguous dates and times.
Use the final correction: 'three, actually four' means four. Never act on partial speech.
To book, gather service, date, and name; find_slots; select_slot; ask for confirmation.
select_slot speaks the exact confirmation question. Do not repeat it or call confirm_booking
in that same turn. Only call confirm_booking after a new final affirmative visitor reply.
To move a booking, lookup_booking first, then find_slots with its reference and service.
Prefer API results to memory. Never invent references or availability.
Never say booked, confirmed, or changed until a tool returns committed or already_committed.
If a tool returns an error, explain it briefly and ask for missing details or offer alternatives.
If confirmation is ambiguous, ask the visitor to say 'yes, book it' or 'yes, move it'.
If select_slot returns confirmation_ready, call confirm_booking immediately: the same
details were already reviewed and the visitor has given a new final affirmative reply.
If confirm_booking returns awaiting_confirmation, its exact review is already spoken.
Wait for a new reply. Do not repeat the confirmation instruction yourself.
Do not retry provider failures with another provider. Keep replies under two sentences.""")

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage):
        self.gate.final_turn(new_message.text_content or "")

    async def outcome(self, action):
        try:
            result = await action()
            await self.publish({"type": "progress"})
            return result
        except BookingError as error:
            self.gate.invalidate()
            if error.status == "version_conflict":
                self.conversation.session = await self.conversation.client.load_session()
            return {"status": error.status, "instruction": "Explain this outcome. Do not claim success."}
        except (OSError, TimeoutError):
            return {"status": "connection_failed", "instruction": "The result is uncertain. Resume saved progress before another write."}

    @function_tool()
    async def find_slots(self, context: RunContext, service_id: str, date: str, visitor_name: str,
                         reference: str = "", preferred_time: str = "") -> dict:
        """Find real availability for a YYYY-MM-DD date. Time, when supplied, is 24-hour HH:MM.
        Use reference only for a booking already looked up. Use the visitor's final corrected time.
        """
        async with self.tool_lock:
            if context.speech_handle.interrupted:
                return {"status": "interrupted"}
            self.gate.invalidate()
            return await self.outcome(lambda: self.conversation.offer(service_id, date, visitor_name,
                reference or None, preferred_time or None))

    @function_tool()
    async def lookup_booking(self, context: RunContext, reference: str) -> dict:
        """Look up the synthetic booking reference before planning a reschedule."""
        async with self.tool_lock:
            if context.speech_handle.interrupted:
                return {"status": "interrupted"}
            self.gate.invalidate()
            return await self.outcome(lambda: self.conversation.client.lookup_booking(reference.strip().upper()))

    def confirmation_text(self, state: dict) -> str:
        service = next(s["name"] for s in self.services if s["id"] == state["serviceId"])
        time_label = datetime.fromisoformat(state["selectedSlot"]).astimezone(ZoneInfo(self.timezone)).strftime("%A, %B %d at %I:%M %p")
        if state["intent"] == "reschedule":
            old = datetime.fromisoformat(state["booking"]["starts_at"].replace("Z", "+00:00")).astimezone(ZoneInfo(self.timezone)).strftime("%A, %B %d at %I:%M %p")
            return f"Move your {service} from {old} to {time_label}, in {self.timezone}? Please say yes to confirm."
        return f"Book {service} for {state['visitorName']} on {time_label}, in {self.timezone}? Please say yes to confirm."

    @function_tool()
    async def select_slot(self, context: RunContext, slot: str) -> dict:
        """Select an exact ISO timestamp from find_slots. Speak its details and request confirmation.
        This tool does not book. Wait for the next final visitor turn before confirm_booking.
        """
        async with self.tool_lock:
            if context.speech_handle.interrupted:
                return {"status": "interrupted"}
            state = (self.conversation.session or {}).get("state", {})
            if state.get("selectedSlot") == slot and self.gate.ready:
                # A model may reselect the same slot on the confirmation turn.
                # Keep the earlier review armed instead of restarting the loop.
                return {"status": "confirmation_ready", "instruction": "These exact details were already reviewed. Call confirm_booking now; do not ask for another yes."}
            result = await self.outcome(lambda: self.conversation.select(slot))
            if "selectedSlot" not in result:
                return result
            self.gate.arm()
            self.session.say(self.confirmation_text(result), allow_interruptions=True)
            return {"status": "awaiting_confirmation", "instruction": "The question is already spoken. Wait for the visitor."}

    @function_tool()
    async def confirm_booking(self, context: RunContext) -> dict:
        """Commit the reviewed appointment only after a new final affirmative visitor reply.
        No arguments are accepted. Confirmation is independently checked against final speech.
        """
        async with self.tool_lock:
            if context.speech_handle.interrupted:
                return {"status": "confirmation_required", "instruction": "This turn was interrupted. Wait for a new final visitor reply."}
            if not self.gate.consume():
                LOGGER.info("Confirmation not ready: armed=%s affirmative=%s", self.gate.selected_turn is not None, is_affirmative(self.gate.final_text))
                if self.gate.selected_turn is None and is_affirmative(self.gate.final_text):
                    # Asking for yes without rearming a reviewed selection creates
                    # a permanent loop. Recover with a fresh exact review, not a write.
                    async def review():
                        self.conversation.session = await self.conversation.client.load_session()
                        state = self.conversation.session["state"]
                        if state.get("pendingOperationId"):
                            # Recovery owns this previously confirmed operation ID.
                            # A lost reply must not require a new selection or write ID.
                            if context.speech_handle.interrupted:
                                return {"status": "interrupted"}
                            context.disallow_interruptions()
                            recovered = await self.conversation.resume()
                            if recovered.get("status") == "resumed" and recovered.get("state", {}).get("booking"):
                                return {"status": "already_committed", "booking": recovered["state"]["booking"]}
                            return recovered
                        if not state.get("selectedSlot"):
                            return {"status": "confirmation_required", "instruction": "Find and select a real available slot first. Asking for yes alone cannot confirm an appointment."}
                        reviewed = await self.conversation.select(state["selectedSlot"])
                        self.gate.arm()
                        self.session.say(self.confirmation_text(reviewed), allow_interruptions=True)
                        return {"status": "awaiting_confirmation", "instruction": "The exact details have been spoken again. Wait for a new final affirmative reply."}
                    return await self.outcome(review)
                return {"status": "confirmation_required", "instruction": "Do not keep asking for yes. Resolve corrections, then call select_slot to speak exact details and arm a new confirmation. Never confirm in the selection turn."}
            # Once confirmation is accepted, finish the transaction despite a subsequent
            # audio interruption. Its operation ID and committed result are recoverable.
            context.disallow_interruptions()
            start = time.perf_counter()
            result = await self.outcome(lambda: self.conversation.confirm(final_turn=True, affirmative=True))
            try:
                await self.conversation.client.request("POST", "/metrics", {
                    "stage": "booking_api", "durationMs": (time.perf_counter() - start) * 1000,
                    "result": "ok" if result.get("status") in {"committed", "already_committed"} else "error",
                })
            except (BookingError, OSError, TimeoutError):
                LOGGER.info("Booking metric unavailable")
            return result


@server.rtc_session(agent_name="voiceai-receptionist")
async def entrypoint(ctx: agents.JobContext):
    logging.getLogger("livekit.agents").setLevel(logging.INFO)
    for handler in logging.getLogger().handlers:
        handler.addFilter(RedactSpeechDetails())
    secret = os.environ.get("AGENT_SHARED_SECRET") or (ROOT / ".data/agent-secret").read_text().strip()
    metadata = json.loads(ctx.job.metadata or "{}")
    if not isinstance(metadata.get("ticket"), str):
        ctx.shutdown(reason="missing_session_ticket")
        return
    # Redeem only with the local service; the browser token never enters model prompts.
    import httpx
    base_url = os.environ.get("BOOKING_API_URL", "http://127.0.0.1:3001")
    async with httpx.AsyncClient(timeout=5) as http:
        response = await http.post(base_url + "/voice/redeem", json={"ticket": metadata["ticket"]}, headers={"x-agent-secret": secret})
        if response.status_code != 200:
            ctx.shutdown(reason="invalid_session_ticket")
            return
        token = response.json()["token"]
    client = BookingClient(base_url, token)
    conversation = Conversation(client)
    config = await client.request("GET", "/services")
    tasks: set[asyncio.Task] = set()

    async def publish(event: dict):
        try:
            await ctx.room.local_participant.publish_data(json.dumps(event).encode(), reliable=True, topic="voiceai")
        except Exception:
            # UI refresh can restore progress even when the audio connection has gone.
            LOGGER.info("Voice event delivery unavailable")

    def schedule(coroutine):
        task = asyncio.create_task(coroutine)
        tasks.add(task)
        def done(finished):
            tasks.discard(finished)
            if not finished.cancelled() and finished.exception():
                LOGGER.info("Voice event failed: %s", type(finished.exception()).__name__)
        task.add_done_callback(done)

    session = AgentSession(
        stt=inference.STT(model=os.environ.get("VOICE_STT_MODEL", "assemblyai/universal-streaming"), language="en"),
        llm=inference.LLM(model=os.environ.get("VOICE_LLM_MODEL", "google/gemma-4-31b-it"), extra_kwargs={"max_completion_tokens": 256, "parallel_tool_calls": False}),
        tts=inference.TTS(model=os.environ.get("VOICE_TTS_MODEL", "fishaudio/s2.1-pro"), voice=os.environ.get("VOICE_TTS_VOICE", "fa4c9eb3dccc4806b382b40d61c6b10a")),
        vad=silero.VAD.load(),
        turn_handling={"preemptive_generation": {"enabled": False}, "endpointing": {"min_delay": 0.5}, "interruption": {"enabled": True}},
        max_tool_steps=3, transcription_timeout=4,
    )
    receptionist = Receptionist(conversation, config["services"], config["timezone"], publish)

    @session.on("function_tools_executed")
    def tools_executed(event):
        suppress_duplicate_confirmation(event)

    @session.on("user_input_transcribed")
    def transcript(event):
        schedule(publish({"type": "transcript", "role": "user", "text": event.transcript, "final": event.is_final}))

    @session.on("conversation_item_added")
    def conversation_item(event):
        if getattr(event.item, "role", None) == "assistant" and event.item.text_content:
            schedule(publish({"type": "transcript", "role": "agent", "text": event.item.text_content, "final": True}))
        for field, stage in {"transcription_delay": "stt", "end_of_turn_delay": "turn_detection", "llm_node_ttft": "model", "tts_node_ttfb": "tts"}.items():
            duration = getattr(event.item, "metrics", {}).get(field)
            if isinstance(duration, (int, float)) and duration >= 0:
                schedule(client.request("POST", "/metrics", {"stage": stage, "durationMs": duration * 1000, "result": "ok"}))

    @session.on("agent_state_changed")
    def agent_state(event):
        schedule(publish({"type": "agent_state", "state": event.new_state}))

    @session.on("user_state_changed")
    def user_state(event):
        schedule(publish({"type": "user_state", "state": event.new_state}))

    @session.on("user_transcription_timeout")
    def transcription_timeout(_event):
        session.say("I missed that detail. Please repeat the service, date, or time.", allow_interruptions=True)

    @session.on("error")
    def failed(event):
        stage = speech_error_stage(event)
        # Failure counts carry no invented latency or provider error text.
        schedule(client.request("POST", "/metrics", {"stage": stage, "durationMs": 0, "result": "error"}))
        failure = speech_failure_event(event)
        if failure:
            schedule(publish(failure))

    await ctx.connect()
    # Disable SDK audio, transcript, and trace recording explicitly.
    await session.start(room=ctx.room, agent=receptionist, record=False)
    try:
        recovered = await conversation.resume()
        await publish({"type": "progress"})
        if recovered.get("status") in {"committed", "already_committed"}:
            session.say(f"Your confirmed booking reference is {recovered['booking']['reference']}.")
        else:
            state = recovered.get("state", {})
            if recovered.get("status") in {"slot_unavailable", "invalid_time"}:
                unchanged = " Your existing booking has not changed." if state.get("booking") else ""
                session.say("Your previous choice is no longer available." + unchanged + " Please tell me another time.")
            elif state.get("booking") and state.get("pendingOperationId"):
                session.say(f"Welcome back. Your booking reference is {state['booking']['reference']}. Would you like to move it?")
            elif state.get("selectedSlot"):
                receptionist.gate.arm()
                session.say("Welcome back. " + receptionist.confirmation_text(state), allow_interruptions=True)
            elif state.get("serviceId") or state.get("date"):
                await session.generate_reply(instructions=f"Resume this saved request with a short recap and ask what detail is needed next: {json.dumps(state)}")
            else:
                session.say("Welcome to Juniper Studio. Would you like a consultation or an extended care appointment?")
    except BookingError:
        session.say("That time may no longer be available. Please tell me the day you prefer.")

    async def limit():
        await asyncio.sleep(300)
        await publish({"type": "error", "message": "Five-minute demo limit reached. Your booking progress is saved."})
        session.shutdown(drain=False)
        ctx.shutdown(reason="demo_time_limit")
    schedule(limit())

    async def cleanup():
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    ctx.add_shutdown_callback(cleanup)


def main():
    missing = [key for key in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET") if not os.environ.get(key)]
    if missing:
        raise SystemExit("Add these values to .env before starting voice: " + ", ".join(missing))
    if os.environ.get("VOICEAI_ENV") == "production":
        from urllib.parse import urlparse
        api_url = urlparse(os.environ.get("BOOKING_API_URL", ""))
        if api_url.scheme != "https" or not api_url.hostname or api_url.username or api_url.password:
            raise SystemExit("Production BOOKING_API_URL must be an HTTPS URL without credentials")
        if len(os.environ.get("AGENT_SHARED_SECRET", "").encode()) < 32:
            raise SystemExit("Production AGENT_SHARED_SECRET must contain at least 32 bytes")
    agents.cli.run_app(server)


if __name__ == "__main__":
    main()
