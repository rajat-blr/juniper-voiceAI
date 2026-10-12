"""Installed voice tools against the real TypeScript API and isolated PostgreSQL.

JSON pipes replace only HTTP transport so the suite also runs in socket-restricted
environments. No speech provider is mocked as working or called by this suite.
"""

import asyncio
import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from livekit.agents import llm
from voiceai_agent.booking_client import BookingClient, BookingError
from voiceai_agent.conversation import Conversation
from voiceai_agent.worker import Receptionist

ROOT = Path(__file__).resolve().parents[3]


class ApiBridge:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", "--import", "tsx", "tools/booking-test-bridge.ts"], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.lock = asyncio.Lock()

    async def request(self, method, path, token="", payload=None):
        def exchange():
            self.process.stdin.write(json.dumps({"method": method, "path": path, "token": token, "payload": payload}) + "\n")
            self.process.stdin.flush()
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError("Isolated booking API exited before responding")
            response = json.loads(line)
            if response["statusCode"] >= 400:
                raise BookingError(response["body"]["status"])
            return response["body"]
        async with self.lock:
            return await asyncio.to_thread(exchange)

    async def close(self):
        if self.process.poll() is None:
            self.process.stdin.write('{"shutdown":true}\n')
            self.process.stdin.flush()
        await asyncio.to_thread(self.process.communicate, timeout=10)


class RealApiClient(BookingClient):
    def __init__(self, bridge, token):
        super().__init__("http://isolated-test", token)
        self.bridge = bridge
        self.lose_next_write_response = False
        self.responses_to_lose = 0
        self.write_operation_ids = []

    async def request(self, method, path, payload=None):
        result = await self.bridge.request(method, path, self.session_token, payload)
        if method == "POST" and path.startswith("/bookings"):
            self.write_operation_ids.append(payload["operationId"])
            if self.lose_next_write_response or self.responses_to_lose > 0:
                self.lose_next_write_response = False
                self.responses_to_lose = max(0, self.responses_to_lose - 1)
                raise TimeoutError("Simulated response loss after API commit")
        return result


class SpokenReceptionist(Receptionist):
    @property
    def session(self):
        return self.speech


class ApiIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = ApiBridge()
        created = await self.bridge.request("POST", "/sessions", payload={})
        self.client = RealApiClient(self.bridge, created["token"])
        services = await self.client.request("GET", "/services")
        self.questions = []
        self.agent = SpokenReceptionist(Conversation(self.client), services["services"], services["timezone"], self.publish)
        self.agent.speech = SimpleNamespace(say=lambda text, **kwargs: self.questions.append(text))
        self.context = SimpleNamespace(speech_handle=SimpleNamespace(interrupted=False), disallow_interruptions=lambda: None)

    async def asyncTearDown(self):
        await self.bridge.close()

    async def publish(self, _event):
        pass

    async def final(self, text):
        await self.agent.on_user_turn_completed(llm.ChatContext(), llm.ChatMessage(role="user", content=[text]))

    async def select(self, date="2026-10-12", reference="", preferred_time="09:00"):
        offer = await self.agent.find_slots(self.context, "consultation", date, "Alex Demo", reference, preferred_time)
        self.assertLessEqual(len(offer["slots"]), 3)
        await self.final("The first offered time")
        slot = offer["slots"][0]["start"]
        selected = await self.agent.select_slot(self.context, slot)
        self.assertEqual(selected["status"], "awaiting_confirmation")
        return slot

    async def test_voice_tools_book_and_reschedule_through_real_api(self):
        original = await self.select()
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "confirmation_required")
        self.assertEqual(self.client.write_operation_ids, [])
        await self.final("yes, book it")
        booked = await self.agent.confirm_booking(self.context)
        self.assertEqual(booked["status"], "committed")
        reference = booked["booking"]["reference"]
        lookup = await self.agent.lookup_booking(self.context, reference.lower())
        self.assertEqual(lookup["booking"]["reference"], reference)
        replacement = await self.select("2026-10-13", reference, "10:00")
        self.assertIn("09:00 AM", self.questions[-1])
        self.assertIn("10:00 AM", self.questions[-1])
        self.assertIn("Asia/Kolkata", self.questions[-1])
        unchanged = (await self.client.lookup_booking(reference))["booking"]
        self.assertEqual(unchanged["starts_at"], booked["booking"]["starts_at"])
        await self.final("no, wait")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "confirmation_required")
        await self.final("yes")
        self.assertEqual((await self.agent.confirm_booking(self.context))["status"], "awaiting_confirmation")
        self.assertEqual(len(self.client.write_operation_ids), 1)
        await self.final("The ten o'clock time")
        await self.agent.select_slot(self.context, replacement)
        await self.final("yes, move it")
        moved = await self.agent.confirm_booking(self.context)
        self.assertEqual(moved["status"], "committed")
        self.assertEqual(moved["booking"]["reference"], reference)
        self.assertNotEqual(moved["booking"]["starts_at"], unchanged["starts_at"])
        self.assertEqual(len(self.client.write_operation_ids), 2)
        old_slots = await self.client.find_slots("consultation", "2026-10-12")
        self.assertIn(original, [slot["start"] for slot in old_slots["slots"]])
        new_slots = await self.client.find_slots("consultation", "2026-10-13")
        self.assertNotIn(replacement, [slot["start"] for slot in new_slots["slots"]])

    async def test_lost_commit_response_retries_same_operation_and_restores_reference(self):
        await self.select()
        self.client.lose_next_write_response = True
        await self.final("yes, book it")
        result = await self.agent.confirm_booking(self.context)
        self.assertEqual(result["status"], "already_committed")
        self.assertEqual(len(self.client.write_operation_ids), 2)
        self.assertEqual(self.client.write_operation_ids[0], self.client.write_operation_ids[1])
        state = (await self.client.load_session())["state"]
        self.assertEqual(state["booking"]["reference"], result["booking"]["reference"])
        self.assertFalse(state["confirmed"])
        recovered = await Conversation(self.client).resume()
        self.assertEqual(recovered["state"]["booking"]["reference"], result["booking"]["reference"])
        self.assertEqual(len(self.client.write_operation_ids), 2)

    async def test_repeated_final_confirmation_recovers_unarmed_gate_and_books_once(self):
        slot = await self.select()
        self.agent.gate.invalidate()
        await self.final("Yes, book it.")
        retry = await self.agent.confirm_booking(self.context)
        self.assertEqual(retry["status"], "awaiting_confirmation")
        self.assertEqual(self.client.write_operation_ids, [])
        await self.final("Yes, book it.")
        self.assertEqual((await self.agent.select_slot(self.context, slot))["status"], "confirmation_ready")
        booked = await self.agent.confirm_booking(self.context)
        self.assertEqual(booked["status"], "committed")
        self.assertEqual(len(self.client.write_operation_ids), 1)
        duplicate = await self.agent.confirm_booking(self.context)
        self.assertEqual(duplicate["status"], "already_committed")
        self.assertEqual(len(self.client.write_operation_ids), 1)
        state = (await self.client.load_session())["state"]
        self.assertEqual(state["booking"]["reference"], booked["booking"]["reference"])

    async def test_losing_both_commit_responses_recovers_on_repeated_confirmation(self):
        await self.select()
        self.client.responses_to_lose = 2
        await self.final("yes, book it")
        lost = await self.agent.confirm_booking(self.context)
        self.assertEqual(lost["status"], "connection_failed")
        self.assertEqual(len(self.client.write_operation_ids), 2)
        self.assertEqual(self.client.write_operation_ids[0], self.client.write_operation_ids[1])
        original = (await self.client.load_session())["state"]["booking"]["reference"]
        await self.final("yes, book it")
        recovered = await self.agent.confirm_booking(self.context)
        self.assertEqual(recovered["status"], "already_committed")
        self.assertEqual(recovered["booking"]["reference"], original)
        self.assertEqual(len(self.client.write_operation_ids), 2)

    async def test_taken_reschedule_slot_preserves_original_and_offers_alternatives(self):
        await self.select()
        await self.final("yes, book it")
        original = (await self.agent.confirm_booking(self.context))["booking"]
        target = await self.select("2026-10-13", original["reference"], "10:00")
        # Another visitor takes the provisional target after it was selected.
        created = await self.bridge.request("POST", "/sessions", payload={})
        other = Conversation(RealApiClient(self.bridge, created["token"]))
        await other.offer("consultation", "2026-10-13", "Taylor Demo", preferred_time="10:00")
        await other.select(target)
        await other.confirm(final_turn=True, affirmative=True)
        await self.final("yes, move it")
        conflict = await self.agent.confirm_booking(self.context)
        self.assertEqual(conflict["status"], "slot_unavailable")
        self.assertEqual((await self.client.lookup_booking(original["reference"]))["booking"]["starts_at"], original["starts_at"])
        replacement = await self.select("2026-10-13", original["reference"], "10:00")
        self.assertNotEqual(replacement, target)
        await self.final("yes, move it")
        moved = await self.agent.confirm_booking(self.context)
        self.assertEqual(moved["status"], "committed")
        self.assertEqual(moved["booking"]["reference"], original["reference"])

    async def test_reconnect_keeps_unconfirmed_progress_then_replays_confirmed_operation_once(self):
        # Each checkpoint uses a new conversation, as a new audio session would.
        empty = await Conversation(self.client).resume()
        self.assertFalse(empty["state"].get("confirmed"))
        offer = await self.agent.find_slots(self.context, "consultation", "2026-10-12", "Alex Demo", "", "09:00")
        offered = await Conversation(self.client).resume()
        self.assertEqual(offered["state"]["offeredSlots"], [slot["start"] for slot in offer["slots"]])
        selected = offer["slots"][0]["start"]
        await self.agent.conversation.select(selected)
        resumed = await Conversation(self.client).resume()
        self.assertEqual(resumed["state"]["selectedSlot"], selected)
        self.assertEqual(self.client.write_operation_ids, [])
        loaded = await self.client.load_session()
        operation_id = str(uuid4())
        await self.client.save_state(loaded["version"], {**loaded["state"], "confirmed": True, "pendingOperationId": operation_id})
        recovered = await Conversation(self.client).resume()
        self.assertEqual(recovered["status"], "committed")
        again = await Conversation(self.client).resume()
        self.assertEqual(again["state"]["booking"]["reference"], recovered["booking"]["reference"])
        self.assertEqual(self.client.write_operation_ids, [operation_id])

    async def test_reconnect_discards_taken_selection_and_preserves_failed_reschedule(self):
        await self.select()
        await self.final("yes, book it")
        original = (await self.agent.confirm_booking(self.context))["booking"]
        target = await self.select("2026-10-13", original["reference"], "10:00")
        created = await self.bridge.request("POST", "/sessions", payload={})
        other = Conversation(RealApiClient(self.bridge, created["token"]))
        await other.offer("consultation", "2026-10-13", "Taylor Demo", preferred_time="10:00")
        await other.select(target)
        await other.confirm(final_turn=True, affirmative=True)
        # A selection that was never confirmed cannot be replayed on reconnect.
        loaded = await self.client.load_session()
        selected_state = dict(loaded["state"])
        stale = await Conversation(self.client).resume()
        self.assertEqual(stale["status"], "slot_unavailable")
        self.assertNotIn("selectedSlot", stale["state"])
        self.assertNotIn(target, stale["state"]["offeredSlots"])
        self.assertEqual(len(self.client.write_operation_ids), 1)
        # A persisted confirmation can also fail during recovery. Keep the old booking.
        loaded = await self.client.load_session()
        loaded = await self.client.save_state(loaded["version"], selected_state)
        await self.client.save_state(loaded["version"], {**selected_state, "confirmed": True, "pendingOperationId": str(uuid4())})
        failed = await Conversation(self.client).resume()
        self.assertEqual(failed["status"], "slot_unavailable")
        self.assertFalse(failed["state"]["confirmed"])
        self.assertNotIn("pendingOperationId", failed["state"])
        self.assertNotIn("selectedSlot", failed["state"])
        unchanged = (await self.client.lookup_booking(original["reference"]))["booking"]
        self.assertEqual(unchanged["starts_at"], original["starts_at"])
        self.assertEqual(unchanged["reference"], original["reference"])
