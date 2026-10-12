import unittest
import logging
from types import SimpleNamespace
from livekit.agents import llm
from livekit.agents.voice.events import FunctionToolsExecutedEvent
from voiceai_agent.worker import Receptionist, speech_error_stage, speech_failure_event, suppress_duplicate_confirmation, RedactSpeechDetails
from voiceai_agent.conversation import Conversation
from test_conversation import FakeClient


class ToolClient(FakeClient):
    async def request(self, method, path, payload=None):
        return {"status": "recorded"}

    async def lookup_booking(self, reference):
        return {"booking": {"reference": reference, "service_id": "consultation", "visitor_name": "Alex Demo",
                            "starts_at": "2026-10-12T06:30:00Z", "timezone": "Asia/Kolkata"}}


class TestReceptionist(Receptionist):
    @property
    def session(self):
        return self.speech


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def test_only_fatal_provider_failures_end_browser_audio_without_publishing_details(self):
        error = SimpleNamespace(recoverable=True, message="private transcript and credentials")
        self.assertIsNone(speech_failure_event(SimpleNamespace(error=error)))
        error.recoverable = False
        failure = speech_failure_event(SimpleNamespace(error=error))
        self.assertTrue(failure["fatal"])
        self.assertEqual(failure["type"], "error")
        self.assertNotIn("private", str(failure))
        self.assertEqual(speech_failure_event(SimpleNamespace(error=SimpleNamespace())), failure)

    def test_exact_confirmation_suppresses_only_its_automatic_reply(self):
        calls = [llm.FunctionCall(call_id="selection", name="select_slot", arguments="{}"),
                 llm.FunctionCall(call_id="search", name="find_slots", arguments="{}")]
        outputs = [llm.FunctionCallOutput(call_id="selection", name="select_slot", output='{"status":"awaiting_confirmation"}', is_error=False),
                   llm.FunctionCallOutput(call_id="search", name="find_slots", output='{"slots":[]}', is_error=False)]
        event = FunctionToolsExecutedEvent(function_calls=calls, function_call_outputs=outputs)
        suppress_duplicate_confirmation(event)
        self.assertFalse(event.function_call_outputs[0].reply_required)
        self.assertTrue(event.function_call_outputs[1].reply_required)
        self.assertIn("awaiting_confirmation", event.function_call_outputs[0].output)
        for result in ['{"status":"slot_unavailable"}', 'invalid', '[]']:
            failed = FunctionToolsExecutedEvent(function_calls=[calls[0]], function_call_outputs=[
                llm.FunctionCallOutput(call_id="selection", name="select_slot", output=result, is_error=False)])
            suppress_duplicate_confirmation(failed)
            self.assertTrue(failed.has_tool_reply)
        recovered = FunctionToolsExecutedEvent(function_calls=[
            llm.FunctionCall(call_id="review", name="confirm_booking", arguments="{}")], function_call_outputs=[
            llm.FunctionCallOutput(call_id="review", name="confirm_booking", output='{"status":"awaiting_confirmation"}', is_error=False)])
        suppress_duplicate_confirmation(recovered)
        self.assertFalse(recovered.has_tool_reply)

    def test_speech_details_are_redacted_from_log_extras(self):
        record = logging.LogRecord("livekit.agents", logging.INFO, __file__, 1, "conversation event", (), None)
        setattr(record, "lk.pii.text", "Private visitor words")
        setattr(record, "lk.pii.user_transcript", "Private name")
        record.stage = "stt"
        self.assertTrue(RedactSpeechDetails().filter(record))
        self.assertEqual(getattr(record, "lk.pii.text"), "[redacted]")
        self.assertEqual(getattr(record, "lk.pii.user_transcript"), "[redacted]")
        self.assertEqual(record.stage, "stt")

    def test_provider_error_stages_are_allowlisted(self):
        for error_type, stage in [("stt_error", "stt"), ("llm_error", "model"), ("tts_error", "tts"), ("unknown", "connection")]:
            self.assertEqual(speech_error_stage(SimpleNamespace(error=SimpleNamespace(type=error_type))), stage)

    async def asyncSetUp(self):
        self.client = ToolClient()
        self.conversation = Conversation(self.client)
        self.offer = await self.conversation.offer("consultation", "2026-10-12", "Alex Demo")
        self.events = []
        async def publish(event):
            self.events.append(event)
        self.agent = TestReceptionist(self.conversation, [{"id": "consultation", "name": "Consultation", "duration_minutes": 30}], "Asia/Kolkata", publish)
        self.questions = []
        self.agent.speech = SimpleNamespace(say=lambda text, **kwargs: self.questions.append(text))
        self.context = SimpleNamespace(speech_handle=SimpleNamespace(interrupted=False), disallow_interruptions=lambda: None)

    async def final(self, text):
        await self.agent.on_user_turn_completed(llm.ChatContext(), llm.ChatMessage(role="user", content=[text]))

    async def test_selection_speaks_exact_question_and_waits_for_new_turn(self):
        await self.final("Tuesday at nine")
        result = await self.agent.select_slot(self.context, self.offer["slots"][0]["start"])
        self.assertEqual(result["status"], "awaiting_confirmation")
        self.assertIn("Asia/Kolkata", self.questions[0])
        self.assertIn("09:00 AM", self.questions[0])
        denied = await self.agent.confirm_booking(self.context)
        self.assertEqual(denied["status"], "confirmation_required")
        self.assertEqual(self.client.writes, [])
        await self.final("yes, book it")
        committed = await self.agent.confirm_booking(self.context)
        self.assertEqual(committed["status"], "committed")
        self.assertEqual(len(self.client.writes), 1)
        duplicate = await self.agent.confirm_booking(self.context)
        self.assertEqual(duplicate["status"], "already_committed")
        self.assertEqual(len(self.client.writes), 1)

    async def test_correction_and_interrupted_tool_cannot_commit(self):
        await self.final("nine")
        await self.agent.select_slot(self.context, self.offer["slots"][0]["start"])
        await self.final("yes, actually ten")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "confirmation_required")
        await self.final("yes")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "awaiting_confirmation")
        self.assertIn("09:00 AM", self.questions[-1])
        self.assertEqual(self.client.writes, [])
        self.context.speech_handle.interrupted = True
        self.assertEqual((await self.agent.select_slot(self.context, self.offer["slots"][1]["start"]))["status"], "interrupted")
        self.assertEqual(self.client.writes, [])

    async def test_reselecting_reviewed_slot_during_yes_preserves_confirmation(self):
        slot = self.offer["slots"][0]["start"]
        await self.final("nine")
        await self.agent.select_slot(self.context, slot)
        await self.final("yes, book it")
        self.assertEqual((await self.agent.select_slot(self.context, slot))["status"], "confirmation_ready")
        self.assertEqual(len(self.questions), 1)
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "committed")
        self.assertEqual(len(self.client.writes), 1)

    async def test_unarmed_confirmation_repeats_exact_review_then_accepts_next_yes(self):
        await self.final("nine")
        await self.agent.select_slot(self.context, self.offer["slots"][0]["start"])
        self.agent.gate.invalidate()
        await self.final("yes, book it")
        reviewed = await self.agent.confirm_booking(self.context)
        self.assertEqual(reviewed["status"], "awaiting_confirmation")
        self.assertEqual(self.client.writes, [])
        self.assertEqual(self.questions[0], self.questions[1])
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "confirmation_required")
        await self.final("yes, book it")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "committed")
        self.assertEqual(len(self.client.writes), 1)

    async def test_reschedule_confirms_old_and_new_times_before_one_write(self):
        booking = await self.agent.lookup_booking(self.context, "va-demo")
        self.assertEqual(booking["booking"]["reference"], "VA-DEMO")
        offer = await self.agent.find_slots(self.context, "consultation", "2026-10-12", "Alex Demo", "VA-DEMO", "09:00")
        await self.final("Move it to nine")
        await self.agent.select_slot(self.context, offer["slots"][0]["start"])
        self.assertIn("12:00 PM", self.questions[-1])
        self.assertIn("09:00 AM", self.questions[-1])
        self.assertIn("Asia/Kolkata", self.questions[-1])
        self.assertEqual(self.client.writes, [])
        await self.final("no, wait")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "confirmation_required")
        await self.final("Nine works")
        await self.agent.select_slot(self.context, offer["slots"][0]["start"])
        await self.final("yes, move it")
        moved = await self.agent.confirm_booking(self.context)
        self.assertEqual(moved["booking"]["reference"], "VA-DEMO")
        self.assertEqual(len(self.client.writes), 1)
        self.assertEqual(self.client.writes[0]["intent"], "reschedule")
        self.assertEqual(self.client.writes[0]["reference"], "VA-DEMO")
        self.assertTrue(self.client.writes[0]["pendingOperationId"])
