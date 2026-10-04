"""testkit — the interactive terminal exam: prompt, play, grade, record, replay.

Layer: apps. Reads exams (CONTRACTS.md §2), records the MIDI stream (§1) and
writes the session record (§3); sessions promote into replay fixtures so a real
pair of hands becomes a regression test.
"""

from music.testkit.examdef import Exam, exam_sha, load_exam

__all__ = ["Exam", "load_exam", "exam_sha"]
