"""``python -m music.songs`` — onboard and manage songs from the terminal.

The same steps as the Songs screen, one command each (the /song skill drives them):

    python -m music.songs add ~/Desktop/early.svg       # or a URL: two Claude reads + flags
    python -m music.songs list
    python -m music.songs show very-early                # chart text, problems, open flags
    python -m music.songs pages very-early               # the page image(s) Claude read
    python -m music.songs bar very-early Ending.1.2 "C#-7:1 Bbmaj7:1 Gmaj7:1"
    python -m music.songs form very-early "A A B Ending"
    python -m music.songs grade very-early core          # core | written | triads
    python -m music.songs check very-early               # "checked against the page"
    python -m music.songs review very-early              # phrase cards → review (built-in/Anki)
"""

from __future__ import annotations

import argparse
import sys
import time

from music.songs import importer
from music.songs.chart import ChartError
from music.songs.service import SongsService
from music.songs.store import SongStore
from music.srs import ReviewUnavailable


def _add(args: argparse.Namespace, store: SongStore) -> int:
    t0 = time.monotonic()

    def stage(name: str, message: str) -> None:
        print(f"[{time.monotonic() - t0:5.1f}s] {name:9} {message}", flush=True)

    try:
        if args.source.startswith(("http://", "https://")):
            stage("fetch", args.source)
            upload = importer.fetch_url(args.source, on_stage=stage)
        else:
            upload = importer.upload_from_path(args.source)
        song_id = importer.run_import(store, upload, on_stage=stage, reads=args.reads)
    except (importer.ImportFailed, OSError) as e:
        print(f"import failed: {e}", file=sys.stderr)
        return 1
    return _show(argparse.Namespace(song=song_id), store)


def _list(_args: argparse.Namespace, store: SongStore) -> int:
    for song_id in store.ids():
        try:
            song, problems = store.load(song_id)
        except ChartError as e:
            print(f"{song_id:28} BROKEN: {e}")
            continue
        state = "checked" if song.checked else "draft"
        flags = len(store.live_flags(song_id, song))
        print(f"{song_id:28} {song.title} · {song.key or '?'} · {song.time} · {state}"
              + (f" · {flags} flag(s)" if flags else "") + (f" · {len(problems)} problem(s)"
                                                           if problems else ""))
    return 0


def _show(args: argparse.Namespace, store: SongStore) -> int:
    try:
        text = store.text(args.song)
        song, problems = store.load(args.song)
    except KeyError:
        print(f"no song {args.song!r}", file=sys.stderr)
        return 1
    print(f"# songs/{args.song}/song.txt\n")
    print(text)
    for p in problems:
        print(f"problem {p.addr or '(song)'}: {p.message}")
    for f in store.live_flags(args.song, song):
        other = f" — other read: {f['other']}" if f.get("other") else ""
        print(f"check   {f['addr']}: {f['message']}{other}")
    return 0


def _edit(action, args: argparse.Namespace, store: SongStore) -> int:
    """Run one SongsService write, print what changed, return the exit code."""
    try:
        action(SongsService(store=store))
    except KeyError as e:
        print(f"not found: {e}", file=sys.stderr)
        return 1
    except ChartError as e:
        print("not saved: " + "; ".join(e.errors), file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"not saved: {e}", file=sys.stderr)
        return 1
    return _show(argparse.Namespace(song=args.song), store)


def _review(args: argparse.Namespace, store: SongStore) -> int:
    try:
        result = SongsService(store=store).seed(args.song)
    except KeyError:
        print(f"no song {args.song!r}", file=sys.stderr)
        return 1
    except ReviewUnavailable as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"review ({result['backend']}, {result['deck']}): {result['added']} added, "
          f"{result['updated']} updated, {result['unchanged']} unchanged of {result['total']}")
    return 0


def _pages(args: argparse.Namespace, store: SongStore) -> int:
    try:
        reads, page = store.reads(args.song), store.page(args.song)
    except KeyError:
        print(f"no song {args.song!r}", file=sys.stderr)
        return 1
    for path in reads:
        print(path)
    if page is not None:
        print(f"# original: {page}")
    return 0 if reads or page else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m music.songs", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add", help="import a page (file path or URL)")
    add.add_argument("source")
    add.add_argument("--reads", type=int, default=2, help="independent Claude reads (default 2)")
    sub.add_parser("list", help="every song")
    show = sub.add_parser("show", help="one song's chart and open flags")
    show.add_argument("song")
    pages = sub.add_parser("pages", help="paths of the page image(s) Claude read")
    pages.add_argument("song")
    bar = sub.add_parser("bar", help="replace one written bar, e.g. A.4.5 \"2. G7#5\"")
    bar.add_argument("song")
    bar.add_argument("addr")
    bar.add_argument("cell")
    form = sub.add_parser("form", help='set the play order, e.g. "A A B Ending"')
    form.add_argument("song")
    form.add_argument("form")
    grade = sub.add_parser("grade", help="the grading dial: core | written | triads")
    grade.add_argument("song")
    grade.add_argument("dial")
    check = sub.add_parser("check", help="mark the chart checked against the page")
    check.add_argument("song")
    review = sub.add_parser("review", help="add the phrase cards to review")
    review.add_argument("song")
    args = parser.parse_args(argv)
    store = SongStore()
    if args.cmd == "bar":
        return _edit(lambda svc: svc.save_bar(args.song, args.addr, args.cell), args, store)
    if args.cmd == "form":
        return _edit(lambda svc: svc.patch(args.song, {"form": args.form}), args, store)
    if args.cmd == "grade":
        return _edit(lambda svc: svc.patch(args.song, {"grade": args.dial}), args, store)
    if args.cmd == "check":
        return _edit(lambda svc: svc.patch(args.song, {"checked": True}), args, store)
    return {"add": _add, "list": _list, "show": _show, "pages": _pages,
            "review": _review}[args.cmd](args, store)


if __name__ == "__main__":
    raise SystemExit(main())
