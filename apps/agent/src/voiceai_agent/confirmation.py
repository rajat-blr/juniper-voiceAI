"""Confirmation comes from a final visitor turn, never model-supplied flags."""

import re


def is_affirmative(text: str) -> bool:
    # Keep digits and non-English words: dropping them can turn a correction
    # such as "yes, 10" into an unintended bare "yes".
    normalized = re.sub(r"[^\w\s']", " ", text.casefold().replace("’", "'")).strip()
    normalized = " ".join(normalized.split())
    return normalized in {
        "yes", "yes please", "yes that's right", "yes thats right", "that's right",
        "thats right", "that's correct", "thats correct", "correct", "confirm",
        "yes confirm", "yes book it", "yes book that", "yes book that appointment",
        "yes move it", "yes reschedule it", "yes go ahead", "go ahead",
        "yes please book it", "yes you can book it", "yes i confirm", "i confirm",
        "please book it", "book it", "yes book it please", "yes please move it",
        "yes move it please", "yes please reschedule it", "yes go ahead and book it",
    }


class ConfirmationGate:
    def __init__(self):
        self.turn_id = 0
        self.selected_turn: int | None = None
        self.final_text = ""

    def final_turn(self, text: str):
        self.turn_id += 1
        self.final_text = text
        if self.selected_turn is not None and not is_affirmative(text):
            self.invalidate()

    def arm(self):
        self.selected_turn = self.turn_id

    def invalidate(self):
        self.selected_turn = None

    @property
    def ready(self) -> bool:
        return (self.selected_turn is not None
                and self.turn_id > self.selected_turn
                and is_affirmative(self.final_text))

    def consume(self) -> bool:
        accepted = self.ready
        if accepted:
            self.invalidate()
        return accepted
