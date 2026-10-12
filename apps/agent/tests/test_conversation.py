import copy
import unittest
from voiceai_agent.booking_client import BookingError
from voiceai_agent.conversation import Conversation


class FakeClient:
    def __init__(self):
        self.session = {"version": 0, "state": {}}
        self.writes = []

    async def load_session(self):
        return copy.deepcopy(self.session)

    async def save_state(self, version, state):
        if version != self.session["version"]:
            raise BookingError("version_conflict")
        self.session = {"version": version + 1, "state": copy.deepcopy(state)}
        return await self.load_session()

    async def find_slots(self, service_id, date, reference=None):
        return {"timezone": "Asia/Kolkata", "slots": [{"start": f"2026-10-12T{hour}:00:00+05:30"} for hour in ("09", "10", "11", "12")]}

    async def commit(self, state):
        self.writes.append(copy.deepcopy(state))
        self.session["state"]["confirmed"] = False
        self.session["state"]["booking"] = {"reference": "VA-DEMO"}
        return {"status": "committed", "booking": {"reference": "VA-DEMO"}}


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = FakeClient()
        self.conversation = Conversation(self.client)
        self.offer = await self.conversation.offer("consultation", "2026-10-12", "Alex Demo")

    async def test_partial_or_negative_confirmation_never_writes(self):
        await self.conversation.select(self.offer["slots"][0]["start"])
        for final, affirmative in [(False, True), (True, False)]:
            with self.assertRaisesRegex(BookingError, "confirmation_required"):
                await self.conversation.confirm(final_turn=final, affirmative=affirmative)
        self.assertEqual(self.client.writes, [])

    async def test_correction_uses_new_slot_and_offers_at_most_three(self):
        self.assertEqual(len(self.offer["slots"]), 3)
        await self.conversation.select(self.offer["slots"][0]["start"])
        await self.conversation.select(self.offer["slots"][1]["start"])
        await self.conversation.confirm(final_turn=True, affirmative=True)
        self.assertEqual(self.client.writes[0]["selectedSlot"], self.offer["slots"][1]["start"])
        self.assertTrue(self.client.writes[0]["pendingOperationId"])

    async def test_resume_after_confirmation_reuses_operation_id(self):
        await self.conversation.select(self.offer["slots"][0]["start"])
        state = self.client.session["state"]
        state.update(confirmed=True, pendingOperationId="persisted-operation")
        fresh = Conversation(self.client)
        await fresh.resume()
        self.assertEqual(self.client.writes[0]["pendingOperationId"], "persisted-operation")

    async def test_unoffered_slot_cannot_be_selected(self):
        with self.assertRaisesRegex(BookingError, "slot_not_offered"):
            await self.conversation.select("invented-slot")

    async def test_invalid_time_preference_does_not_replace_existing_selection(self):
        await self.conversation.select(self.offer["slots"][0]["start"])
        original = await self.client.load_session()
        for time in ["ten", "9:00", "24:00", "10:60", "10:00 tomorrow"]:
            with self.assertRaisesRegex(BookingError, "invalid_time"):
                await self.conversation.offer("consultation", "2026-10-12", "Alex Demo", preferred_time=time)
            self.assertEqual(await self.client.load_session(), original)
