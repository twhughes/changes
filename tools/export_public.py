"""Export the public tree — what would go on GitHub — into a fresh folder of its own.

    python tools/export_public.py                 # into a new temp folder; prints its path
    python tools/export_public.py --out DIR       # into DIR (must not exist yet)
    python tools/export_public.py --check         # …then run the test suite inside it
    python tools/export_public.py --update public --message "…"   # sync the public checkout, commit

The file list starts from what git would keep (``git ls-files --cached --others
--exclude-standard``), so everything ignored — songs/ (scanned Real Book pages),
sessions/ (practice logs, review cards), bundles/ (song audio), the demo captures
that show a scan — can never leak. Then only the allowlisted paths below survive,
the release files are swapped in (README, CI), and the folder becomes its own git
repo with one first commit and NO remote.

Nothing is pushed. Creating the GitHub repo, pushing, and deploying the page are
outward steps that wait for Tyler's OK for that release (RELEASE.md).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# What ships: the practice app, its tests and content, the static-site tooling.
ALLOW_PREFIXES: tuple[str, ...] = ("music/", "tests/", "exams/", "demo-songs/", "docs/")
ALLOW_FILES: frozenset[str] = frozenset({
    "pyproject.toml", "run.sh", "CONTRACTS.md", ".gitignore", "LICENSE",
    "tools/build_site.py", "tools/static_vectors.py", "tools/deploy_site.sh",
    "tools/export_public.py", "tools/capture_songs_demo.mjs", "tools/songs_demo_server.py",
    "tools/smoke_static_site.mjs", "tools/vendor_twin.py", "tools/capture_readme_demo.mjs",
})
# Inside the allowed folders, but not the product (Tyler, 2026-10-04: "just midi hub +
# flashcards + sound engine"): the torch synth experiments, and the libraries kept only for
# HQ's sake — the S-1 library (hq/CLAUDE.md's sharing-rule exemplar) and the song-bundle
# schema (analysis/'s interface).
DENY_PREFIXES: tuple[str, ...] = ("music/dsp/", "music/instrument/", "music/bundle/",
                                  "music/drums/")
DENY_FILES: frozenset[str] = frozenset({"tests/test_dsp.py", "tests/test_instrument.py",
                                        "tests/test_bundle.py"})
# Release files that replace or add to the tree: source → destination.
SWAPS: dict[str, str] = {
    "release/README.md": "README.md",
    "release/ci.yml": ".github/workflows/ci.yml",
}


def candidate_files(root: Path = ROOT) -> list[str]:
    """Tracked + new-but-not-ignored files, as repo-relative POSIX paths."""
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                         cwd=root, capture_output=True, text=True, check=True).stdout
    return sorted({line for line in out.splitlines() if line and (root / line).is_file()})


def public_files(files: list[str]) -> list[str]:
    keep = []
    for path in files:
        if path in DENY_FILES or path.startswith(DENY_PREFIXES) or "/__pycache__/" in path:
            continue
        if path in ALLOW_FILES or path.startswith(ALLOW_PREFIXES):
            keep.append(path)
    return keep


def assemble(out: Path, root: Path = ROOT) -> list[str]:
    """Copy the public tree (and the release swaps) into ``out``; returns the file list.

    Refuses before copying anything when a private path made it into the list.
    """
    files = public_files(candidate_files(root))
    leaked = leaks(files)
    if leaked:
        raise SystemExit("refusing: private files in the export: " + ", ".join(leaked))
    for rel in files:
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, dest)
    for src, dest in SWAPS.items():
        if (root / src).is_file():
            (out / dest).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / src, out / dest)
    return files + [dest for src, dest in SWAPS.items() if (root / src).is_file()]


def leaks(files: list[str]) -> list[str]:
    """Paths that must never be public, whatever the allowlist says."""
    return [f for f in files if f.startswith(("songs/", "sessions/", "bundles/", "analysis/"))
            or f.endswith((".logicx", ".sf2")) or "songs-demo" in f]


def export(out: Path, root: Path = ROOT) -> list[str]:
    """Copy the public tree into ``out`` and make it a fresh repo; returns the file list."""
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} already exists and is not empty")
    files = assemble(out, root)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=out, check=True)
    subprocess.run(["git", "add", "-A"], cwd=out, check=True)
    message = ("First public release: chord + song practice, in the browser or with a local "
               "server\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n")
    subprocess.run(["git", "commit", "-q", "-m", message], cwd=out, check=True)
    return files


def update(checkout: Path, message: str, root: Path = ROOT) -> tuple[list[str], bool]:
    """Re-export into the public repo's existing checkout: one new commit, history kept.

    The export goes to a temp folder first; then every file the checkout tracks that the
    export no longer has is removed, every exported file is copied over, and what changed
    is committed. Nothing is pushed. Returns (the file list, whether a commit was made).
    """
    if not (checkout / ".git").exists():
        raise SystemExit(f"{checkout} is not a git checkout (make the first one with --out)")
    fresh = Path(tempfile.mkdtemp(prefix="music-public-"))
    files = assemble(fresh, root)
    tracked = subprocess.run(["git", "ls-files"], cwd=checkout, capture_output=True, text=True,
                             check=True).stdout.splitlines()
    keep = set(files)
    for rel in tracked:
        if rel not in keep:
            subprocess.run(["git", "rm", "-q", "--", rel], cwd=checkout, check=True)
    for rel in files:
        dest = checkout / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fresh / rel, dest)
    shutil.rmtree(fresh, ignore_errors=True)
    subprocess.run(["git", "add", "-A"], cwd=checkout, check=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=checkout).returncode == 0:
        return files, False
    body = f"{message}\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>\n"
    subprocess.run(["git", "commit", "-q", "-m", body], cwd=checkout, check=True)
    return files, True


def check(out: Path) -> int:
    """Run the suite against the exported copy (its own files win over the editable install)."""
    python = ROOT / ".venv" / "bin" / "python"
    result = subprocess.run([str(python), "-m", "pytest", "-q", "-p", "no:cacheprovider"],
                            cwd=out, env={"PYTHONPATH": str(out), "HOME": str(Path.home()),
                                          "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
                            capture_output=True, text=True)
    tail = (result.stdout or result.stderr).strip().splitlines()[-1:] or ["(no output)"]
    print(f"tests in the export: {tail[0]}")
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="target folder (default: a new temp folder)")
    parser.add_argument("--update", type=Path, metavar="CHECKOUT",
                        help="re-export into the public repo's checkout and commit (nothing is pushed)")
    parser.add_argument("--message", default="Update from the private repo",
                        help="the commit message for --update")
    parser.add_argument("--check", action="store_true", help="run the tests inside the export")
    args = parser.parse_args(argv)
    if args.update:
        files, committed = update(args.update, args.message)
        where, what = args.update, "committed, nothing pushed" if committed else "already current"
    else:
        where = args.out or Path(tempfile.mkdtemp(prefix="music-public-"))
        files, what = export(where), "fresh repo, no remote, nothing pushed"
    leaked = leaks(files)
    if leaked:
        print("refusing: private files in the export: " + ", ".join(leaked), file=sys.stderr)
        return 1
    print(f"exported {len(files)} files to {where} ({what})")
    return check(where) if args.check else 0


if __name__ == "__main__":
    raise SystemExit(main())
