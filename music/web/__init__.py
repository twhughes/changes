"""Cockpit shell: one FastAPI app on 127.0.0.1:8768, WS hub, view registry.

Layer: substrate. Views register here (CONTRACTS.md §5); import lazily —
``from music.web.server import create_app`` — so the package stays cheap.
"""
