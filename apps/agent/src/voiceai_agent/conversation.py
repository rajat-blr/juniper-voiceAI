"""Structured conversation state, independent of speech transport or providers.

Speech adapters must call these methods only after understanding a final turn.
They can publish partial transcripts without granting them permission to commit.
"""

from uuid import uuid4
from datetime import datetime
import re
from .booking_client import BookingClient, BookingError


class Conversation:
    def __init__(self, client: BookingClient):
        self.client = client
        self.session: dict | None = None

    async def resume(self) -> dict:
        self.session = await self.client.load_session()
        state = self.session["state"]
        if state.get("confirmed") and state.get("pendingOperationId"):
            # Do not require the visitor to confirm the same write twice after refresh.
            try:
                result = await self.client.commit(state)
            except BookingError as error:
                if error.status not in {"slot_unavailable", "invalid_time"}:
                    raise
                self.session = await self.client.load_session()
                fresh = dict(self.session["state"])
                if fresh.get("confirmed") and fresh.get("pendingOperationId") == state["pendingOperationId"]:
                    fresh.pop("selectedSlot", None)
                    fresh.pop("pendingOperationId", None)
                    fresh["confirmed"] = False
                    await self._save(fresh)
                return {"status": error.status, "state": self.session["state"]}
            self.session = await self.client.load_session()
            return result
        if state.get("booking") and state.get("pendingOperationId"):
            return {"status": "resumed", "state": state}
        if state.get("serviceId") and state.get("date"):
            available = await self.client.find_slots(state["serviceId"], state["date"], state.get("reference"))
            starts = {datetime.fromisoformat(slot["start"]) for slot in available["slots"]}
            fresh = dict(state)
            fresh["offeredSlots"] = [slot for slot in state.get("offeredSlots", []) if datetime.fromisoformat(slot) in starts]
            taken = bool(state.get("selectedSlot") and datetime.fromisoformat(state["selectedSlot"]) not in starts)
            if taken:
                fresh.pop("selectedSlot", None)
                fresh.pop("pendingOperationId", None)
                fresh["confirmed"] = False
            if fresh != state:
                await self._save(fresh)
            return {"status": "slot_unavailable" if taken else "resumed", "state": self.session["state"]}
        return {"status": "resumed", "state": state}

    async def _save(self, state: dict) -> dict:
        if self.session is None:
            self.session = await self.client.load_session()
        self.session = await self.client.save_state(self.session["version"], state)
        return self.session

    async def offer(self, service_id: str, date: str, visitor_name: str,
                    reference: str | None = None, preferred_time: str | None = None) -> dict:
        if preferred_time and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", preferred_time):
            raise BookingError("invalid_time")
        reference = reference.strip().upper() if reference else None
        result = await self.client.find_slots(service_id, date, reference)
        available = result["slots"]
        if preferred_time:
            available = [slot for slot in available
                         if datetime.fromisoformat(slot["start"]).strftime("%H:%M") >= preferred_time]
        slots = available[:3]
        state = {
            "intent": "reschedule" if reference else "book",
            "serviceId": service_id, "date": date, "visitorName": visitor_name,
            "offeredSlots": [slot["start"] for slot in slots], "confirmed": False,
        }
        if reference:
            state["reference"] = reference
            state["booking"] = (await self.client.lookup_booking(reference))["booking"]
        await self._save(state)
        return {"timezone": result["timezone"], "slots": slots}

    async def select(self, slot: str) -> dict:
        if self.session is None:
            self.session = await self.client.load_session()
        state = dict(self.session["state"])
        if slot not in state.get("offeredSlots", []):
            raise BookingError("slot_not_offered")
        # A recovered offer may have been taken by another visitor.
        if state.get("date"):
            fresh = await self.client.find_slots(state["serviceId"], state["date"], state.get("reference"))
            if not any(datetime.fromisoformat(s["start"]) == datetime.fromisoformat(slot) for s in fresh["slots"]):
                raise BookingError("slot_unavailable")
        state.update(selectedSlot=slot, confirmed=False)
        state.pop("pendingOperationId", None)
        await self._save(state)
        # Speech adapter reads exact service, local date, time, and timezone and asks
        # for confirmation. Selection alone never triggers an appointment write.
        return state

    async def confirm(self, *, final_turn: bool, affirmative: bool) -> dict:
        if not final_turn or not affirmative:
            raise BookingError("confirmation_required")
        if self.session is None:
            self.session = await self.client.load_session()
        state = dict(self.session["state"])
        if not state.get("selectedSlot"):
            raise BookingError("confirmation_required")
        state.update(confirmed=True, pendingOperationId=state.get("pendingOperationId") or str(uuid4()))
        await self._save(state)
        result = await self.client.commit(state)
        self.session = await self.client.load_session()
        return result
