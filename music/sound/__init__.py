"""Sound — what Tyler hears when he presses a key (no Logic required).

One seam, several drivers, swapped live from the cockpit header:

  browser drivers  (``side == "browser"``)  — the server only records the choice
      and broadcasts ``{"type": "sound", "driver": id}``; the page mounts
      ``web/static/sound/<id>.js`` and feeds it the raw ``note`` firehose.
  server drivers   (``side == "server"``)   — a Python object with
      ``note_on/note_off/all_off/close``; the service wires it to the
      trainer's ``add_note_listener`` and plays out the Mac's default output.
  external         (``side == "external"``) — Logic Pro: ``POST /api/sound/logic``
      opens the electric-piano template; the cockpit stays silent.

Drivers register themselves in ``DRIVERS`` (see ``registry.py``). Exactly one
is active; switching always ``all_off()``s the old one first.
"""
