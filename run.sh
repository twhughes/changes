#!/bin/bash
# music cockpit — port 8768 (PORTS.md), or $MUSIC_PORT.
# Args pass straight through to the entrypoint: ./run.sh --no-browser --port 8999
cd "$(dirname "$0")"
exec .venv/bin/python -m music.web.server "$@"
