"""HTTP-only booking tools. The agent never opens the appointment database."""

import asyncio
import json
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen


class BookingError(Exception):
    """A booking-service outcome that the voice layer must explain to the visitor."""

    def __init__(self, status: str):
        super().__init__(status)
        self.status = status


class BookingClient:
    def __init__(self, base_url: str, session_token: str, timeout: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.session_token = session_token
        self.timeout = timeout

    async def request(self, method: str, path: str, payload: dict | None = None) -> dict:
        def send():
            request = Request(
                self.base_url + path,
                data=json.dumps(payload).encode() if payload is not None else None,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.session_token}",
                    "Content-Type": "application/json",
                },
            )
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    return json.load(response)
            except HTTPError as error:
                try:
                    status = json.load(error).get("status", "api_error")
                except (ValueError, TypeError):
                    status = "api_error"
                raise BookingError(status) from None

        return await asyncio.to_thread(send)

    async def load_session(self) -> dict:
        return await self.request("GET", "/session")

    async def save_state(self, version: int, state: dict) -> dict:
        return await self.request("PATCH", "/session", {"version": version, "state": state})

    async def find_slots(self, service_id: str, date: str, reference: str | None = None) -> dict:
        query = {"serviceId": service_id, "date": date}
        if reference:
            query["reference"] = reference
        return await self.request("GET", "/availability?" + urlencode(query))

    async def lookup_booking(self, reference: str) -> dict:
        return await self.request("GET", "/bookings/" + quote(reference, safe=""))

    async def operation(self, operation_id: str) -> dict:
        return await self.request("GET", "/operations/" + quote(operation_id, safe=""))

    async def commit(self, state: dict) -> dict:
        payload = {
            "operationId": state["pendingOperationId"],
            "slot": state["selectedSlot"],
            "confirmed": True,
        }
        path = "/bookings"
        if state["intent"] == "reschedule":
            path += "/" + quote(state["reference"], safe="") + "/reschedule"
        else:
            payload.update(serviceId=state["serviceId"], visitorName=state["visitorName"])
        # A timeout is ambiguous: retry only with the already-persisted operation ID.
        for attempt in range(2):
            try:
                return await self.request("POST", path, payload)
            except (TimeoutError, OSError):
                if attempt:
                    raise
        raise AssertionError("unreachable")
