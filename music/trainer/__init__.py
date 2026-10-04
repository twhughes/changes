"""Trainer app: the browser chord drill (view seam per CONTRACTS.md §5).

Layer: apps. May import: learn, theory, midio, web.
"""

from music.trainer.service import TrainerService, session_summary

__all__ = ["TrainerService", "session_summary"]
