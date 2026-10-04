"""notedeck: the sight-reading deck generator writes files, never Anki.

The renderer is stubbed (a tiny node script) so this pins the generator's
contract without depending on staff.js; one integration test runs the real
CLI when it exists.
"""

import json
import shutil
from pathlib import Path

import pytest

from music.learn import notedeck
from music.learn.anki import _plain
from music.learn.decks import item_for_front
from music.learn.notedeck import DEFAULT_CLI, RenderError, card_rows, generate, render_svg

NODE = shutil.which("node")

STUB = """\
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const job = JSON.parse(data);
  if (!job.pitches) { process.stderr.write(JSON.stringify({error: "no pitches"})); process.exit(2); }
  process.stdout.write(`<svg data-clef="${job.clef}" data-pitches="${job.pitches.join(",")}"></svg>`);
});
"""


@pytest.fixture
def stub_cli(tmp_path):
    cli = tmp_path / "stub-cli.mjs"
    cli.write_text(STUB)
    return cli


def test_card_rows_cover_the_deck_with_codec_fronts():
    rows = card_rows("reading-bass")
    assert len(rows) == 25 and rows[0]["front_codec"] == "C2 bass"
    assert rows[0]["staff"] == {"kind": "staff", "clef": "bass", "pitches": [36], "key": "C",
                                "width": notedeck.FRONT_W, "height": notedeck.FRONT_H}
    assert rows[0]["back"] == "C2" and "reading-bass" in rows[0]["tags"]
    grand = card_rows("reading-grand")[0]["staff"]
    assert grand["kind"] == "grand"
    chords = card_rows("reading-chords")
    assert all(r["staff"] is None for r in chords) and chords[0]["back"] == chords[0]["front_codec"]


@pytest.mark.skipif(NODE is None, reason="node not on PATH")
def test_generate_writes_svgs_tsv_manifest_readme(tmp_path, stub_cli):
    out = tmp_path / "deck"
    manifest = generate("reading-treble", out, cli=stub_cli)
    assert manifest["cards"] == 25 and manifest["deck"] == "reading-treble"
    svgs = sorted((out / "fronts").glob("*.svg"))
    assert len(svgs) == 25 and svgs[0].name == "reading-treble-001.svg"
    assert 'data-pitches="60"' in svgs[0].read_text()
    lines = (out / "cards.tsv").read_text().splitlines()
    assert len(lines) == 25
    front, back, tags = lines[4].split("\t")
    assert front.startswith('<img src="reading-treble-005.svg">') and back == "E4"
    # The hidden codec span survives Anki's HTML → what the trainer decodes.
    assert _plain(front) == "E4 treble"
    assert item_for_front(_plain(front)).pitches == (64,)
    assert (out / "README.md").read_text().startswith("# reading-treble")
    assert json.loads((out / "manifest.json").read_text())["items"][4]["front"] == "E4 treble"
    # Nothing in the generator imports or calls AnkiConnect.
    src = Path(notedeck.__file__).read_text()
    assert "AnkiClient" not in src and "storeMediaFile" not in src and "addNotes" not in src


@pytest.mark.skipif(NODE is None, reason="node not on PATH")
def test_generate_chord_deck_has_no_images(tmp_path, stub_cli):
    out = tmp_path / "chords"
    generate("reading-chords", out, cli=stub_cli)
    assert not list((out / "fronts").glob("*.svg"))
    first = (out / "cards.tsv").read_text().splitlines()[0].split("\t")
    assert first[0] == first[1] == "Dm7"


def test_render_errors_are_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(notedeck.shutil, "which", lambda name: None)
    with pytest.raises(RenderError, match="node is not on PATH"):
        render_svg({"kind": "staff"}, cli=tmp_path / "x.mjs")
    with pytest.raises(RenderError, match="staff CLI missing"):
        render_svg({"kind": "staff"}, cli=tmp_path / "missing.mjs", node="/usr/bin/true")


@pytest.mark.skipif(NODE is None, reason="node not on PATH")
def test_cli_stub_rejects_bad_job(stub_cli):
    with pytest.raises(RenderError, match="failed"):
        render_svg({"kind": "staff"}, cli=stub_cli)


def test_unknown_deck_raises(tmp_path):
    with pytest.raises(KeyError):
        generate("triads", tmp_path)


def test_dry_run_prints_rows(capsys):
    assert notedeck.main(["--deck", "reading-bass", "--out", "/nonexistent", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "C2 bass" in out and "→ C2" in out


@pytest.mark.skipif(NODE is None or not DEFAULT_CLI.is_file(),
                    reason="real staff CLI not present")
def test_real_renderer_round_trip(tmp_path):
    svg = render_svg({"kind": "staff", "clef": "treble", "pitches": [64], "key": "C",
                      "width": 360, "height": 180})
    assert svg.lstrip().startswith("<svg")
