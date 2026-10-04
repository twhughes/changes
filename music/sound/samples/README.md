# Sample sets — the `samples` sound driver

The browser `samples` sound driver (`web/static/sound/samples.js`, served by
`samples_api.py`) plays a real multisampled electric piano. Each set is one
subdirectory here with a `manifest.json`; the API picks the single subdir that
has a `manifest.json` (override with the `MUSIC_SAMPLES` env var = set name).

## Installed set: `wurlitzer-ep200`

- **Instrument**: Wurlitzer EP200 electric piano (Greg Sullivan, v1.1).
- **License**: CC-BY 3.0 Unported — see `wurlitzer-ep200/LICENSE.txt`.
- **Source**: <https://github.com/sfzinstruments/GregSullivan.E-Pianos>, folder
  `Wurlitzer EP200`. SFZ mapping by kinwie.
- **On disk**: 42 mono WAV samples in `wurlitzer-ep200/wav/` (~8.5 MB), across
  4 velocity layers (pp / mp / f / ff), ~1 root every few semitones.

### Layout of a set

```
<setname>/
  manifest.json          # what samples.js reads (built by build_manifest.py)
  LICENSE.txt            # license text + source + attribution (required)
  <name>.sfz             # the upstream SFZ, kept for rebuilds
  wav/*.wav              # the samples
```

`manifest.json` shape:

```json
{
  "name": "...", "license": "...", "source": "...",
  "release_s": 0.4,
  "samples": [
    {"file": "wav/a1pp.wav", "note": 33, "vel_lo": 1, "vel_hi": 37,
     "tune_cents": -5, "gain_db": -3.2, "loop": null}
  ]
}
```

`note` is the MIDI root; `vel_lo`/`vel_hi` bound the velocity layer; the driver
maps each played (note, velocity) to the nearest-root zone in the matching
velocity band and pitch-shifts by `playbackRate = 2^((note-root)/12)`.
`tune_cents` and `gain_db` are optional refinements the driver honors if present.

### git note

`.gitignore` does **not** ignore this directory, so the WAVs live here and are
tracked. The set is ~8.5 MB — well under the ~60 MB budget — so no LFS needed.

## Rebuilding the manifest from the SFZ

```
.venv/bin/python music/sound/samples/build_manifest.py \
  music/sound/samples/wurlitzer-ep200 \
  --name "Wurlitzer EP200 (Greg Sullivan)" \
  --license "CC-BY 3.0 Unported" \
  --source "https://github.com/sfzinstruments/GregSullivan.E-Pianos (Wurlitzer EP200)" \
  --release 0.4
```

## Adding another set

1. Drop per-note WAV files under `<setname>/wav/` (convert FLAC/OGG with
   `ffmpeg -i in.flac -c:a pcm_s16le out.wav` — Safari's Web Audio does not
   reliably decode FLAC, so WAV is the safe on-disk format).
2. If the pack ships an SFZ, copy it in and run `build_manifest.py`. Otherwise
   hand-write `manifest.json` in the shape above.
3. Copy the pack's license + source into `<setname>/LICENSE.txt`.
4. Keep the total under ~60 MB (one velocity layer or every-other-semitone if a
   pack is bigger).
