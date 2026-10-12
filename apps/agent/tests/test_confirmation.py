import unittest
from voiceai_agent.confirmation import ConfirmationGate, is_affirmative


class ConfirmationTests(unittest.TestCase):
    def test_affirmation_is_explicit_and_corrections_are_rejected(self):
        for text in ["Yes.", "Yes, please!", "Yes, book it", "That's correct.", "Yes, move it", "Yes, please book it.", "Yes, I confirm.", "That’s correct.", "Yes. Book it."]:
            self.assertTrue(is_affirmative(text), text)
        for text in ["yes, actually four", "no", "maybe", "yes but Tuesday", "book it next week", "not correct", "I said yes earlier", "yes, 10", "yes 4 pm", "yes नहीं", "yes book it at 10", "yes/no"]:
            self.assertFalse(is_affirmative(text), text)

    def test_same_turn_and_duplicate_confirmation_cannot_commit(self):
        gate = ConfirmationGate()
        gate.final_turn("yes")
        gate.arm()
        self.assertFalse(gate.consume())
        gate.final_turn("yes please")
        self.assertTrue(gate.consume())
        self.assertFalse(gate.consume())

    def test_a_correction_cannot_confirm_the_old_time(self):
        gate = ConfirmationGate()
        gate.arm()
        gate.final_turn("yes, actually four")
        self.assertFalse(gate.consume())
        gate.final_turn("yes")
        self.assertFalse(gate.consume())
