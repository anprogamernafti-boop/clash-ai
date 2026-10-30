import unittest

from gpu_budget import gpu_duration_for_text, split_at_pauses


class GpuBudgetTests(unittest.TestCase):
    def test_short_mixed_derja_phrase_uses_one_segment_budget(self):
        text = "يَا ahmed إِلْوَقْفَةْ photo d'identité مْتَاعْ passeport"
        self.assertEqual(gpu_duration_for_text(text), 60)

    def test_long_phrase_increases_budget_by_segment(self):
        text = "a" * 181
        self.assertEqual(len(split_at_pauses(text)), 2)
        self.assertEqual(gpu_duration_for_text(text), 90)

    def test_maximum_input_is_capped_at_150_seconds(self):
        self.assertEqual(gpu_duration_for_text("a" * 600), 150)

    def test_empty_text_keeps_minimum_budget(self):
        self.assertEqual(gpu_duration_for_text("  "), 60)

    def test_rejected_oversized_input_does_not_reserve_long_duration(self):
        self.assertEqual(gpu_duration_for_text("a" * 601), 60)

    def test_splits_at_natural_pause_before_word_boundary(self):
        parts = split_at_pauses("a" * 90 + "، " + "b" * 100)
        self.assertEqual(len(parts), 2)
        self.assertTrue(parts[0].endswith("،"))


if __name__ == "__main__":
    unittest.main()
