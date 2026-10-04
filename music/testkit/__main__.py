"""`python -m music.testkit run|promote` — the exam CLI."""

from __future__ import annotations

import sys

from music.testkit import promote as promote_cmd
from music.testkit import runner as run_cmd

USAGE = "usage: python -m music.testkit {run|promote} ...  (add -h for the subcommand's flags)"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "run":
        return run_cmd.main(rest)
    if cmd == "promote":
        return promote_cmd.main(rest)
    print(f"unknown subcommand {cmd!r}\n{USAGE}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
