# CONTRACTS.md — the layer map and its pinned contracts

*Every boundary between packages is a versioned contract in this file. Arrows point down only.
Change a contract → bump its version here and migrate all producers/consumers in the same session.*

## Layer map

```
apps        trainer · player (learn-a-song) · songs (Real Book charts) · drums · instrument panel
            · testkit(CLI)
learning    learn/ — drill engine, decks, grading policy, Anki (AnkiConnect)
analysis    analysis/ — ingest·stems·sections·key·chords·audio→MIDI  (own heavy venv;
            talks to everything else ONLY via bundle dirs on disk)
theory      theory/ — chord vocab, matching ladder, naming, transpose (pure, zero-dep)
substrate   midio/ (MIDI I/O, capture/replay, mode router) · instrument/ (schema+backends)
            · web/ (cockpit shell: FastAPI 8768, WS hub, view registry)
```

Rules: a package may import only from layers at or below itself. `analysis/` never imports
apps and apps never import `analysis` — the bundle directory is the interface. The chord
matcher's authority is `theory/` (Python). The server path has no JS matcher: the cockpit's
browser renders verdicts, it does not compute them. The static page (§12) carries a JS twin of
the matcher, drill engine, grade policy and SM-2 scheduler that must pass the Python-generated
parity vectors on every test run.

## 1. MIDI event stream — JSONL v1 (`midio/events.py`)

One file per capture, append-only (crash-safe). Timestamps are seconds relative to capture
start, stamped `time.monotonic()` at callback receipt (device/rtmidi timing is not trusted).
`note_on` with velocity 0 is normalized to `note_off` before writing.

```jsonl
{"kind":"header","v":1,"port":"KeyLab...","started":"2026-07-28T09:00:00-04:00"}
{"kind":"ev","t":1.2341,"type":"note_on","note":55,"vel":92,"ch":0}
{"kind":"ev","t":1.9002,"type":"note_off","note":55,"vel":0,"ch":0}
{"kind":"mark","t":8.1000,"label":"item:2:prompt"}
```

`mark` records are injected by runners to segment the stream (exam items, verdicts).
Guarantee: grading is a pure function of (event stream, exam spec) — live ≡ replay.

## 2. Exam definition — YAML v1 (`testkit/examdef.py`)

```yaml
id: chords-basic
title: Seventh chords, any voicing
defaults: {level: loose, debounce_ms: 300}
items:
  - prompt: "Play a G7 — any voicing"
    check: {chord: "G7"}            # level/debounce_ms default from `defaults`
  - prompt: "C/E — first inversion"
    check: {chord: "C/E", level: inversion}
```

Levels: `loose | strict | inversion | voiced` (see `theory/match.py` ladder).

## 3. Session record — session.json v1 (`testkit/report.py`)

`sessions/<ISO-ts>_<examid>/` contains `midi.jsonl` (contract 1), `session.json`, `report.md`.

```json
{"v":1, "exam_id":"chords-basic", "exam_sha":"...", "theory_version":"0.1.0",
 "started":"...", "items":[
   {"prompt":"...", "check":{...},
    "attempts":[{"ok":false,"missing":[2],"extra":[],"latency_s":4.1,"played":[55,59,62]}],
    "passed":true, "latency_s":6.2, "note":"Tyler's free text or null",
    "span":[12, 47]}],
 "summary":{"passed":9,"total":10,"duration_s":312.5,"mean_latency_s":3.4}}
```

`promote` copies a session into `tests/fixtures/replays/<name>/`;
`tests/test_replay_sessions.py` replays every fixture and asserts recorded verdicts.
Deliberate matcher changes re-bless fixtures via `promote --rebless` only (with a printed diff).

## 4. Song bundle — bundle.json v0 (`bundle/schema.py`) — *the Player retired 2026-10-04; the schema stays as `analysis/`'s interface (RETIRED.md)*

`bundles/<hash16>/` where hash16 = sha256 of decoded int16 PCM, first 16 hex
(re-encodes of the same audio dedupe). Layout: `bundle.json`, `source.wav`,
`stems/{drums,bass,vocals,other}.wav`, `midi/*.mid`.

```json
{"version":0, "id":"a1b2c3d4e5f60718",
 "source":{"title":"...","artist":null,"youtube_url":"...","duration_s":213.4,"sample_rate":44100},
 "key":{"tonic":"F#","mode":"minor","method":"krumhansl","confidence":0.83},
 "tempo":{"bpm":96.0,"beats":[0.52],"downbeats":[0.52],"time_signature":"4/4"},
 "sections":[{"start":0.0,"end":14.2,"label":"intro"}],
 "chords":[{"start":0.52,"end":2.98,"symbol":"F#m"}],
 "stems":{"drums":"stems/drums.wav","bass":"...","vocals":"...","other":"..."},
 "midi":{"vocals":"midi/vocals.mid"},
 "groove":null, "kit":null, "lyrics":null}
```

Validator requirement: every `chords[].symbol` must round-trip through `theory.parse_chord`
— chord timelines are human-editable drafts, and this keeps edits gradable by the player's
wait-mode. `groove`/`kit`/`lyrics` are reserved (null) until the drums/player milestones.

## 5. Cockpit WS protocol v1 + view registration (`web/`)

One FastAPI app, 127.0.0.1:**8768** (PORTS.md). One view since 2026-10-04: **Practice**
(chords + progressions + songs + review, §11); the header carries the sound (E-piano · S-1 twin ·
Off; the choice is remembered in `sessions/sound/config.json`; while the S-1 twin plays, ⚙ opens
its knobs — `sound/settings.js`, drawn from the vendored S-1 control list `sound/twin/schema.json`,
changes saved per browser on top of the driver's patch), the review backend and the keyboard.
A browser driver may add `set(cc, value)` and `values()` to the `{noteOn, noteOff, allOff,
dispose}` contract (`sound/index.js`); the twin does. **Following the S-1 twin page:** ⚙ → "Open
in S-1 twin ↗" opens hq/synth's page (`http://localhost:8766/` when it answers, else
`https://tylerwhughes.com/s1-twin/`) with `#sync=music`; that page posts `{v: 1, type:
"s1-twin:values", values: {cc: value}}` once, then `{v: 1, type: "s1-twin:param", cc, value}` per
change, to its opener. The music page takes them only from the window it opened and only from
`https://tylerwhughes.com` or `http://localhost|127.0.0.1[:port]`, only for the sound sections
(never CONTROLLER), integers 0..127; each plays and is saved like a panel change. Origin guard rejects non-localhost
Host/Origin (the server touches MIDI hardware). `/ws/state`: on connect the server sends
`{"type":"hello", ...full state...}`, then deltas (thread → `call_soon_threadsafe` → queue →
socket). Held-note deltas throttled ~30 Hz and carry `{notes, pcs, names}` — `names` is the
top-2 `theory.naming.name_notes` reading, derived once per *change*, not per throttled
repeat, and empty below two pitch classes; verdicts immediate. Client→server messages are
typed dicts (`{"type":"start","deck":...}` etc.) — each view namespaces its types.
The static page (§12) speaks this same protocol through an in-browser socket with ws.js's
`{on, send, close}` shape.

**Key hints** (2026-10-04, "Show keys" in chord drills): `prompt`, `step` and the status's
`drill` carry `notes` — the live chord's one hint voicing (`theory.chords.hint_voicing`: the
bass in octave 3, every other chord tone in the octave above middle C), or `null` for a recall
card (a song phrase) or a pitch card. Any voicing still passes; `notes` only lights the piano.

View seam: an app package contributes (a) a FastAPI `APIRouter` mounted under `/api/<view>`,
(b) one ES module in `web/static/views/<view>.js` exporting `{id, title, mount(el, ctx)}`,
registered in `web/server.py` and `web/static/main.js`. Shared client modules: `ws.js`,
`keyboard.js` (SVG piano colored from `Verdict.per_note`).

## 6. Instrument schema v1 (`instrument/`) — *the S-1 tab retired 2026-10-04; this library stays (RETIRED.md)*

`InstrumentSchema`: ordered sections of params `{id, name, cc, type: continuous|switch|discrete,
min, max, labels?, format?}` + patch dict `{param_id: value}`.

**The a(k, s) split (differentiability contract):** every param is either **k** (continuous —
normalized float in [0,1], eligible for gradient descent) or **s** (discrete — enumerated
choices, optimized by enumeration/global search). A backend may additionally expose a
differentiable forward model `render(k, s, note) -> audio` (torch, `[dsp]` extra) — the S-1
twin and all own-built synths do; the hardware S-1 backend does not (its twin stands in,
with hardware verification probes). Optimizers see instruments ONLY through (k, s) + render
or probe — never through device specifics. A backend implements
`connect/disconnect/push_all/send(param,value)/on_incoming(cb)` (the S-1: CC map + push-all
sync policy + Program Change pattern select, adapted from synth). The panel view renders any
schema generically; the headless API (`/api/instrument/...`) exposes params/patches/notes.
AnkiConnect note: Anki's fixed port is 8765 — collides with mashup's backend only if both run.

## 7. Grading ladder semantics (`theory/match.py`)

- **loose** — all chord pitch-classes present (any octave/voicing/doubling); extras allowed.
  On 4+-tone chords the unaltered 5th is omittable at EVERY level (shell voicings —
  root/3rd/7th — pass; theory 0.2.0).
- **strict** — loose, plus no extra pitch-classes.
- **inversion** — strict, plus lowest sounding note's pc == slash bass (or root if no slash).
- **voiced** — inversion, plus a `VoicingConstraints` spec (exact interval stack / note count
  / range). Type pinned now; enforcement lands with a later milestone.

Grade policy v2 (`learn/grading.py`, one config dict `GRADE_POLICY`; v1's
latency-only mapping retired 2026-08-21): accuracy tier × speed tier → ease.
Accuracy from the wrong attempts: **clean** (none) · **slip** (≤1 wrong, ≤2 notes off)
· **rough** (≤3 wrong) · **fail**. Speed over total prompt→pass seconds, budget ×
chords-per-card: **fast** <2 s · **ok** <6 s · **slow** <15 s · **crawl**. Ease: clean+fast
Easy · clean+ok Good · clean slower Hard · slip Hard (slow slip Again) · rough/fail
Again — a slip shortens the interval, it never resets the card. Every `passed`
event carries the full `grade` breakdown; only Anki-backed cards also press the button.

Anki is now one backend of the review seam (§10) — the trainer works without it. Anki
organization (`learn/anki.py`): parent `Music::PianoChords` with one subdeck per
seedable built-in deck (`SUBDECKS`); card Fronts round-trip through the codec in
`learn/decks.py` (`seed_fronts` ↔ `item_for_front`): plain chord = any voicing ·
`"X shell"` = strict shell · slash chord = inversion · `"<label> in <key>"` = progression
(`PROGRESSIONS` registry). Trainer sessions: `anki-due` (all themes) and `anki:<builtin>`
(one theme, short sessions filled from the built-in deck; fill cards grade on screen
but never answer Anki).

## 8. Lesson graph v1 + receipts v1 (`lessons/`) — *retired 2026-10-04 with the Lessons tab, seed gate included (RETIRED.md); kept here as history*

A **lesson** teaches the mental model behind one trainer deck and then proves the hands
learned it. Layer: *learning* — `lessons/` imports `theory/`, `learn/` and `midio/` only.

### Lesson file — YAML v1 (`lessons/model.py`, content in `lessons/content/<phase>.yaml`)

```yaml
id: shells                 # == the built-in deck this lesson gates
title: Sevenths as shells
deck: shells               # drill handoff target (defaults to `id`)
steps:                     # a DAG: each step may name `next`; default next = the next in file order
  - id: predict-1
    kind: predict          # question first — answer before being told
    prompt: "G#m7 is which major triad floated over G#?"
    choices: ["B", "E", "G#", "C#"]     # optional; free-text when absent
    answer: "B"                          # a string or a list of accepted answers
    explain_on_miss: "Xm7 = a major triad a minor third up, over X."   # optional
  - id: explain-1
    kind: explain
    html: "<p>…mental model…</p>"        # rendered by the UI; the server passes it through
  - id: play-1
    kind: play             # verified by the matcher, never by self-report
    prompt: "Play G#m7 — shell (root·3·7)"
    check: {chord: "G#m7", level: strict}   # or {chords: [...], level: loose}
                                            # or {pitches: [64], clef: treble, key: C}
    tries: 3               # after N failed attempts the step fails; the lesson continues
  - id: drill
    kind: drill            # handoff: the UI starts `deck` in the Trainer
    deck: shells
```

Validated at load time (a bad lesson fails before the keyboard is touched): step ids unique,
every explicit `next` resolves, every `chord`/`chords` parses through `theory.parse_chord`,
`level` on the §7 ladder, pitches are MIDI 0–127, predict has an answer, explain has html.
`load_lessons(dir)` raises on the first bad file; `load_lessons_with_errors(dir)` skips it
and returns the problems — the service loads leniently so one half-written YAML cannot take
the cockpit down. A step's wire form **never carries the answer key**.

### Grading and events (`lessons/service.py`)

`LessonService(content_dir=…, publish=…, receipts_path=…)`. It owns no port and no clock: the
`TrainerService` feeds it each tick via `add_feeder(feed_midi)`, exactly like the player's
wait-mode, and every `play` step is graded by a **one-item `DrillEngine`** — so a lesson
grades the way the trainer drills and the one matcher stays in `theory/`. Commands:
`start(lesson_id)` · `answer(text)` (predict; case/whitespace-insensitive, a miss keeps the
step live) · `advance()` (explain/drill → next) · `skip()` · `stop()` · `status()`.

Firehose events, all `{"type": "lesson", "event": …}`:
`started {lesson, title, total, step}` · `step {step, idx, total}` ·
`answered {ok, step, expected?, explain?}` · `attempt {step, verdict, latency_s}` ·
`progress {step, chord, at, of}` (a progression moved to its next chord) ·
`passed {step, latency_s}` · `failed {step, tries}` · `done {lesson, receipt}` ·
`stopped {lesson}` (abandoned — no receipt) · `error {message}`.

WS client→server (`web/server.py`): `lesson_start {lesson}` · `lesson_answer {text}` ·
`lesson_next` · `lesson_skip` · `lesson_stop`. `hello` carries `"lesson": status()`.
HTTP (`/api/lessons`): `GET ""` cards `[{id, title, deck, steps, complete}]` ·
`GET /status` · `GET /receipts` · `GET /{id}` full lesson. `VIEW = {"id": "lessons",
"title": "Lessons"}` is served by `lessons/router.py`.

### Receipt — JSONL v1

Append-only at `sessions/lessons/receipts.jsonl` (`MUSIC_LESSONS_RECEIPTS` overrides;
`MUSIC_LESSONS_DIR` overrides the content dir):

```json
{"v":1,"lesson":"shells","started":"ISO","finished":"ISO",
 "steps":[{"id":"predict-1","kind":"predict","ok":true,"attempts":2},
          {"id":"play-1","kind":"play","ok":true,"attempts":1,"latency_s":1.9}],
 "complete":true}
```

`complete` = every visited `predict` and `play` step passed (a miss then a correct answer
still counts, and stays recorded). Only a finished walk writes a receipt; `stop()` writes
nothing. `completed_lessons()` reads the file.

### The seed gate

`POST /api/trainer/seed {"builtin": X}` → **409** `{"detail": "lesson 'X' not completed",
"lesson": X}` when a lesson with id `X` exists and has no complete receipt. `{"force": true}`
advances anyway — the gate is a nudge, not a lock. **A deck with no lesson file is never
gated**, and an unknown deck still 404s.

## 9. Songs — song text v1, song JSON v1, song decks, receipts v1 (`songs/`)

A **song** is a chord chart Tyler learns by heart: a Real Book page goes in, the changes come
out as a small text file, and the song gets three practice modes. Layer: *learning* (like
`lessons/`) — `songs/` imports `theory/`, `learn/` and `midio/` only; the trainer never
imports it (the server wires it in through the deck-source seam below).

### Data layout (`songs/` at the repo root, gitignored like `bundles/`; `MUSIC_SONGS_DIR` overrides)

```
songs/<id>/song.txt      the chart — song text v1, the one source of truth
songs/<id>/page.<ext>    the original page as imported (svg/png/jpg/pdf/heic…), display copy
songs/<id>/read/*.png    the raster(s) Claude read (extracted or rendered from the page)
songs/<id>/import.json   both reads + the flags from the last import (diagnostics only)
songs/.trash/<id>-<ts>/  DELETE moves a song here — nothing is ever hard-deleted
sessions/songs/runs.jsonl   receipts v1 (MUSIC_SONGS_RUNS overrides)
```

`<id>` is the slug of the title (`Very Early` → `very-early`; a clash adds `-2`).

### Song text v1 (`songs/chart.py`: `parse_song`, `format_song`)

```
title: Very Early
composer: Bill Evans
style: Medium Waltz
time: 3/4
key: C
form: A A B Ending        # optional — default: each written section once, in written order
grade: core               # core | written | triads (default core) — the grading dial
source: https://…         # optional
checked: 2026-10-03       # absent = a draft nobody has checked against the page yet

[A]
| Cmaj7  | Bb7 | Ebmaj7 | Ab7      |
| Dbmaj7 | G7  | Cmaj7  | Bb7(#11) |
| Dmaj7  | A-7 | F#-7   | B7b9     |
| E-9    | Ab7 | Dbmaj7 | 1. G7 | 2. G7#5 |
[B]
| Bmaj7 | Ab7 | Dbmaj7 | Bb7 |
| D-7:2 E-7:1 | Fmaj7:1 G7:2 | % | N.C. |
```

- Header: `key: value` lines before the first `[label]`. Unknown keys are kept and written back.
  `title` is required. `#` starts a comment line (comments do not survive a rewrite).
- `[label]` opens a section. Labels are unique (`A`, `B`, `A2`, `Ending` …).
- A bar line holds `|`-separated cells; **each text line is one written line = one phrase**
  (the importer follows the page's printed systems, normally 4 bars).
- A cell: an optional volta prefix `1.`/`2.`… (that bar belongs to the 1st/2nd ending), then
  chord tokens split by spaces. `Sym:beats` fixes a chord's beats; tokens without beats share
  the rest of the bar evenly (`time` numerator = beats per bar). `%` = the previous bar again.
  An empty cell = the previous chord holds. `N.C.` / `NC` / `-` = no chord (never graded).
- Play order: `form` lists section labels; the k-th time a label is played it takes ending k
  (or its highest ending when k is past the last one). Bars outside any ending always play.
- Every symbol must parse through `theory.parse_chord` (Real Book spellings included:
  `Bb7(#11)`, `A7b5(b9)`, `E-9`, `G7#5`, `C6/9`, `D-maj7`, `F7alt` …). A symbol that does not
  parse stays in the file and shows up in `problems`; drills skip it.

### The grading dial (`theory/simplify.py`: `simplify(chord, dial)`)

What you are asked to play, per song. `written` = the symbol as written. `core` (default) =
root + chord type: tensions and alterations drop off (`B7b9`→`B7`, `E-9`→`E-7`,
`A7b5(b9)`→`A7`, `C6`→`C`, `D-7/C`→`D-7`). `triads` = root + major/minor/dim/aug/sus
(`Cmaj7`→`C`, `F#-7`→`F#-`, `Bm7b5`→`Bdim`). All song items grade **loose** (extras allowed),
so playing the ♭9 on a `core` B7 still passes. The minor style of the page (`-7` vs `m7`) is kept.

### Song JSON v1 (`GET /api/songs/{id}` — `Song.to_dict()` + store fields)

```json
{"id":"very-early","title":"Very Early","composer":"Bill Evans","style":"Medium Waltz",
 "time":"3/4","beats_per_bar":3,"key":"C","tempo":null,"form":["A","A","B","Ending"],
 "grade":"core","checked":"","source":"https://…",
 "page":{"url":"/api/songs/very-early/page","mime":"image/svg+xml","name":"early.svg"},
 "sections":[{"label":"A","lines":[{"n":1,"bars":[
     {"addr":"A.1.1","volta":null,"repeat":false,"text":"Cmaj7",
      "slots":[{"symbol":"Cmaj7","beats":3,"play":"Cmaj7","ok":true}]}]}]}],
 "play":[{"n":1,"addr":"A.1.1","section":"A","pass":1}],
 "phrases":[{"id":"A1","section":"A","line":1,"volta":null,"name":"A line 1",
     "front":"Very Early · A line 1 (start)","back":"Cmaj7 · B♭7 · E♭maj7 · A♭7","cue":null,
     "steps":[{"play":"Cmaj7","symbol":"Cmaj7","addr":"A.1.1","slot":0}]}],
 "chords":[{"play":"Cmaj7","symbols":["Cmaj7"]}],
 "runs":{"all":[{"play":"Cmaj7","symbol":"Cmaj7","addr":"A.1.1","slot":0,"n":1}],"A":[],"B":[]},
 "decks":{"chords":"song:very-early:chords","phrases":"song:very-early:phrases",
          "run":"song:very-early:run","sections":{"A":"song:very-early:run:A"}},
 "anki":{"subdeck":"Music::PianoChords::Songs::Very Early","theme":"anki:song:very-early"},
 "problems":[{"addr":"A.4.5","message":"unknown chord quality …"}],
 "flags":[{"addr":"A.4.5","message":"the two reads differ","other":"G7+"}],
 "updated":"2026-10-03T17:02:11"}
```

- `addr` = `<section>.<line>.<bar>` in the **written** chart (1-based). `play` lists the bars
  in play order (`n` 1-based, `pass` = which time through that section).
- `bars[].text` = the bar's cell exactly as `format_song` writes it (`1. G7`, `D-7:2 E-7:1`,
  `%`, `N.C.`) — what the check screen edits and `PUT /{id}/bar/{addr}` sends back.
- `slots[].play` = the dial's target text (null for `N.C.` or a symbol that does not parse);
  `ok` = the written symbol parses. `beats` may be fractional.
- `phrases`: one per written line; a line with endings splits into `A4.1`/`A4.2`
  (`volta` 1/2, name `A line 4 · 1st ending`) unless both endings give the same chords under
  the dial — then it is one phrase `A4`. `steps` = the chords to play in order (rests skipped,
  repeats of the same chord merged), each pointing at the first written slot it covers.
  `cue` = the chord played just before the phrase's first appearance (null at the top).
- `chords`: the distinct dial targets in first-appearance order (`symbols` = written forms).
- `runs.all` = the whole form in play order (one chorus + whatever `form` lists); `runs[<label>]`
  = that section's first pass on its own. Same step shape as phrases, plus `n` (play bar).
  The Play through deck drills exactly these steps.
- Every step (phrases, runs) and every `chords[]` entry carries `notes`: one close voicing of
  the target as MIDI numbers (root in octave 3, the rest above middle C), computed by the
  theory kernel — the UI lights them on the piano as a "show keys" hint. Hints only: grading
  stays loose and any voicing passes.
- `review` = `{"theme": "song:<id>", "backend", "label", "cards", "due"}` from the active
  review backend (§10). `decks` = `{"chords", "phrases", "play", "sections": {label: deck}}`.
- `flags` come from the last import: bars where Claude's two independent reads disagree, or
  where either read marked a chord unsure (`?`), plus one flag with `addr: "form"` when the
  reads disagree on the form (`other` = the other read's form). Each stored flag remembers the
  text at import time and stays live only while the bar (or form) still reads that way — any
  edit clears it. "Looks right" (`PATCH {checked: true}`) settles every open flag: they move to
  `accepted_flags` in import.json.
- `problems` with `addr: ""` are song-level, e.g. "[Ending] is not in the form, so it is never
  played" (a written section the explicit form leaves out).
- `reads` = how many rasters Claude read (`GET /{id}/read/{n}` serves them, 1-based).

`GET /api/songs` → summaries `[{id,title,composer,key,time,checked,phrases,chords,problems,
flags,updated}]` sorted by title; a song whose file no longer parses comes back with
`"broken": true` (and `GET /{id}` answers 422 with its `errors` — fix it in the text editor).

### Song decks + the deck-source seam (`songs/decks.py` ↔ `trainer/service.py`)

Deck names: `song:<id>:chords` (the distinct targets, shuffled, one chord per card, shown by
name) · `song:<id>:phrases` (one card per phrase, shuffled, **recall**: the chords are hidden,
the prompt names the line and its cue) · `song:<id>:play` (**Play through**, v2 2026-10-03: one
card, the whole form in song order, chords SHOWN — flashcards in song order; the UI's Blind
switch hides them on screen only) · `song:<id>:play:<label>` (one section). `run` is a legacy
alias of `play`. Misses requeue in chords/phrases, never in a play-through. Review: the phrase
cards are theme `song:<id>` (§10); in Anki they live in `Music::PianoChords::Songs::<Title>`.

The trainer serves extra decks through **deck sources** (`TrainerService.add_deck_source`),
wired only by `web/server.py`. A source is any object with:
`deck_names() -> list[str]` · `deck(name) -> (items, requeue: bool) | None` ·
`item_for_front(text) -> DrillItem | None` · `anki_themes() -> {theme: subdeck}` ·
`fill(theme) -> list[DrillItem]`. Anki sessions decode Fronts with the built-in codec first,
then each source.

`DrillItem` gains `recall: bool = False` (the UI must not show the chords: the trainer sends
`chord: null` in `prompt`, `step` and `status.drill`) and `ref: str | None` (an opaque handle
the UI resolves — `song:<id>:phrase:<phrase id>`, `song:<id>:run`, `song:<id>:run:<label>`,
`song:<id>:chord:<play>`). `prompt` events and `status.drill` carry `ref` and `recall`;
`status.drill.step` = the live chord within a progression card (0-based), so a reloaded
view resumes mid-phrase.

Anki phrase card: Basic note, Front `"<Title> · <name> (after <cue>)"` or `"… (start)"`,
Back = the written chords joined by ` · ` with ♭/♯. The decoder ignores the parenthesised cue,
so fixing a chord updates the existing note (`updateNoteFields`) instead of adding a twin.
Seeding never deletes a note; a note whose line no longer exists just stops decoding.

### HTTP (`/api/songs`, `VIEW = {"id": "songs", "title": "Songs"}`)

`GET ""` summaries · `GET /{id}` song JSON · `GET|PUT /{id}/text` `{"text"}` (PUT answers 422
`{"detail", "errors":[…]}` on a fatal parse error) · `PUT /{id}/bar/{addr}` `{"text":"1. G7#5"}`
replaces one cell · `PATCH /{id}` `{"grade"?, "checked"?: bool, "title"?, "key"?, "form"?: str}`
· `DELETE /{id}` → trash · `GET /{id}/page` the original page file · `GET /{id}/read/{n}`
the n-th raster Claude read · `POST /{id}/seed` → `{"deck","added","updated","unchanged",
"total"}` or 503 when Anki is closed · `GET /{id}/runs` receipts, newest first ·
`POST /import` — JSON `{"url"}` or the raw file bytes (header `X-Filename`, 25 MB cap) →
`{"job"}` · `POST /{id}/reread` → `{"job"}` · `GET /imports` · `GET /imports/{job}`.

Import job: `{job, stage, message, song, error, origin, elapsed_s, done}`; stages
`queued → fetch → normalize → read → compare → saved | error` (`saved` is announced once,
carrying `song`). Claude reads through its own locked-down CLI call — `claude -p --safe-mode
--restricted --tools Read`, confined to the raster folder — never through `hq/llm.py`: a page
from the web is untrusted input, and this repo must not reach into HQ. A re-read keeps the
previous chart as `song.prev.txt`. URL rules follow DRAG.md:
public http(s) is fetched by the server; loopback only for registered hq ports; other private
addresses are refused. An HTML page is scanned for its chart (PDF/SVG/image links, embeds).

### WS additions

`{"type":"songs","event":"import", …job}` on each stage · `{"type":"songs","event":"changed",
"song":id}` after any write · `{"type":"songs","event":"receipt","song":id,"receipt":{…}}`
after a song drill ends. Drills themselves use the trainer's messages unchanged
(`start {deck}` / `skip` / `stop` → `prompt` / `step` / `attempt` / `passed` / `done`).

### Receipt — JSONL v1 (`sessions/songs/runs.jsonl`)

```json
{"v":1,"song":"very-early","deck":"song:very-early:run","mode":"run","finished":"ISO",
 "stopped":false,"passed":1,"total":1,"mean_latency_s":63.2,"misses":{"A.4.4":2,"B.3.4":1}}
```

`mode` = chords | phrases | run. `misses` counts wrong attempts per written bar address
(per chord name in `chords` mode). Written by the server from the trainer's `done` event.

## 10. Review seam v1 — spaced repetition with or without Anki (`srs/`)

*Added 2026-10-03 (Tyler: "hooking in Anki should not be required, but nice to have" — the
same shape as the sound drivers).* Flashcard scheduling is a **backend** behind one interface;
the cockpit works fully with the built-in one, and Anki is an optional plug-in. Layer: learning.

**Themes and cards.** A *theme* is a group of cards the trainer can drill: a built-in deck name
(`shells`, `two-five-one` …; the seedable ones = `learn/anki.py SUBDECKS` keys) or a song,
`song:<id>`. A *card spec* is `{key, front, back}` — `front` decodes through the trainer's codec
(built-ins: `learn/decks.item_for_front`; deck sources: `item_for_front`), `back` is the answer
text a phone or Anki shows, `key` is the card's stable identity inside its theme (built-ins: the
front; song phrases: title + line + ending — the cue in the front may change, the key does not).

**Scheduler interface** (duck-typed; `srs/base.py`):
`id` · `label` · `available() -> bool` · `due(theme: str | None) -> [DueCard(card_id, front, theme)]`
(due + new, oldest first; `None` = every theme) · `add(theme, specs) -> {added, updated,
unchanged, total}` (an existing key keeps its schedule; a changed front/back is rewritten; nothing
is deleted) · `answer(card_id, ease 1–4) -> bool` · `counts() -> {theme: {"cards": n, "due": n}}`.

**Backends.** `local` (default) — `srs/local.py`, a small SM-2 scheduler (one policy dict,
`SRS_POLICY`: learning steps 1 / 10 min, graduate 1 d, easy 4 d, ease 2.5 ± deltas, floor 1.3,
cap 365 d) storing `sessions/srs/cards.json` (`MUSIC_SRS_DIR` moves it). `anki` — `srs/anki.py`,
the AnkiConnect client: themes map to subdecks (`Music::PianoChords::<Sub>` for built-ins,
`Music::PianoChords::Songs::<Title>` for songs); unavailable when Anki is closed. The choice is
persisted in `sessions/srs/config.json` `{"backend": "local"|"anki"}`. Switching never moves
cards: each backend keeps its own.

**Grades.** The trainer's grade policy (§7) yields ease 1–4 for every pass; in a review session
that ease is handed to `answer()` of the active backend (`passed` carries `review_ease` and
`backend`; `anki_ease` stays as an alias when the backend is anki).

**Trainer sessions.** `review` = every due card of every theme; `review:<theme>` = one theme's
due cards, topped up from that theme's deck when short (top-up cards grade on screen, never
answer). The old names `anki-due` / `anki:<theme>` still start the same sessions. "Add to
review" = `POST /api/trainer/seed {"builtin"}` and `POST /api/songs/{id}/seed`; both answer
`{backend, deck, added, updated, unchanged, total}`, and 503 only when the chosen backend is
unavailable (Anki closed). **A song in review stays in sync:** every chart edit (text, a bar,
the grading dial, the header fields) re-adds its phrase cards to the active backend — the same
`add()`, so schedules survive and changed backs are rewritten. Best-effort: the chart is saved
first; a closed Anki skips the sync until the next edit or Add to review. An edit never puts a
song into review by itself.

**HTTP.** `GET /api/srs` → `{"backend", "label", "available", "backends": [{id, label,
available, note}]}` · `POST /api/srs/backend {"backend"}` → the same (400 unknown id). WS:
`{"type": "srs", "backend": id}` after a switch.

## 11. The Practice menu (`GET /api/practice`, composed in `web/server.py`)

*v2, 2026-10-04 (Tyler: "just midi hub + flashcards + sound engine"; "retire player, s1,
lessons, viz"; "too many chord practice options — just triads, 7ths and common progressions,
grouped"; "the navigation will get crowded with 100 songs"; and the rule behind all of it: "dont
add stuff if it's not relevant to user").* **Practice is the app's one view** — Player, S-1,
Lessons, Viz and 6-6 are retired (RETIRED.md); the lesson seed gate went with Lessons. With one
view the shell hides its tab bar.

**The sidebar**, top to bottom: **Play** (free play, no cards: the held chord named big from
`held.names`, its notes, a full-width piano; the landing item when nothing is remembered — Tyler:
"a clear landing page where you can just play this thing. no flashcards") → **Review** (every
due card) → **Chords:** Triads, Sevenths,
Advanced (m7♭5, dim7, 7sus4, 7♯5) → **Progressions:** ii–V–I, Minor ii–V–i, Turnaround
(I–vi–ii–V), Tritone sub (ii–♭II7–I), Backdoor (iv–♭VII7–I) → **▾ Songs**, a group that folds
(open by default, remembered per browser): **+ Add song** first, then every song A–Z, broken ones
too. Folded over the open song, the header lights. The only numbers are cards due. "+ Add song"
opens the import page (the import field, its jobs, drop/paste; on the static page one line
saying it needs the local app) — no second list of songs.

*Rounds:* v2's first cut (2026-10-04) showed only the songs in review (at most 8) beside a
searchable library page; Tyler: "why do the songs not actually show up side bar? i'd think it
would be like drop down menu collapsable" — so the sidebar is the list. The menu's progressions
became the jazz ones ("focus on the common ones especially jazz ones": IV–V–I left) and Chords
gained Advanced ("i dont know what all the special chords are for jazz… can we add a new chord
category which is like 'advanced'").

Only `learn/decks.py MENU` decks are offered, and the trainer's deck list is the same eight.
Every other built-in deck (shells, sevenths-strict, inversions, jazz-workout, four-five-one,
reading-*) still drills by name and still decodes from review. The endpoint feeds the sidebar in
one call:

```json
{"review": {"backend": "local", "label": "Built-in", "available": true, "due": 12},
 "groups": [{"id": "chords", "title": "Chords", "decks": [
     {"id": "triads", "title": "Triads", "blurb": "major and minor · all 12 keys", "cards": 24,
      "in_review": true, "due": 3, "seedable": true}]},
   {"id": "progressions", "title": "Progressions", "decks": []}],
 "songs": [{"id": "very-early", "title": "Very Early", "composer": "Bill Evans", "key": "C",
            "checked": "", "in_review": false, "due": 0, "broken": false}]}
```

Deck titles, groups and blurbs live in one table (`learn/decks.py DECK_INFO`). The blurb says
what the deck is — the chords in C — under the title in the pane and as the sidebar tooltip. `seedable` = the deck can be added to review. `in_review` = the active backend holds
cards of that theme; `due` = how many are due now. A deck already in review offers no "Add to
review"; neither does a song (an edit to a song in review rewrites its cards, §10). `broken` = the
song's text has a fatal error. The trainer's own `GET /api/trainer/decks` lists no song decks
(they start by name through the deck-source seam, §9).

## 12. Static site — Practice with no server (`tools/build_site.py`, `web/static/offline/`)

*Added 2026-10-04 for GitHub Pages (tylerwhughes.com/<repo>/), on the S-1 twin's pattern.* One
front-end: the build copies `web/static/` and marks `index.html` with
`<meta name="music-static" content="1">`; `main.js` then boots `offline/runtime.js` instead of
`ws.js connect()`, every view runs unchanged, and `ctx.static` is true. The server path never
loads `offline/`.

**Build.** `python tools/build_site.py [--out site] [--songs demo-songs]` → `site/` (gitignored):
the static tree minus dev files (`*.check.mjs`, `*.test.mjs`, `dom-stub.mjs`, `staff-cli.mjs`)
and server-only views (player, panel, lessons, lessons-ref); `samples/<set>/` (the sampled
piano's WAVs and its LICENSE); `data/`; `.nojekyll`. Every path the page loads is relative.
Only `--songs` ships (default `demo-songs/`); the private `songs/` library is refused.

**Data** (`web/static_data.py` runs the kernel at build time — the page never parses a chord):
- `data/app.json` — `views`, the Practice menu's static `groups` (`DECK_INFO`; `lesson: null`),
  `policies` (`GRADE_POLICY`, `SRS_POLICY`), the `naming` vocabulary (`QUALITIES` in order +
  commonness), the `review` backend's label/note, and the `sound` plan (`default` = the e-piano
  when its sample set is installed, else the S-1 twin; browser `drivers` only; `samples` = the
  set's folder).
- `data/decks.json` — `chords` (text → `{pcs, req, bass}`: the chord's pitch classes, the ones a
  voicing must hold — the omittable 5th taken out — and the expected lowest pc), `decks` (every
  built-in deck as items), `seedable`, `cards` (each seedable deck's `{key, front, back}`), and
  `fronts` (front → item: the built-in codec, precomputed).
- `data/songs.json` — `[{id, title, file}]`; `data/songs/<id>.json` — the song text and, per dial
  (`core` · `written` · `triads`, exactly what the server serves after `PATCH {grade}`): its song
  JSON v1 (§9; `page: null`, no flags; the `review` block is added live), `summary`, `labels`,
  `items` (`chords`; `phrases` as `[{section, line, volta, item}]`; `play` as `{"" | label: item}`),
  `miss` (prompt → chord name / written addresses, for receipts), `cards`, its own `chords` table.
- An item: `{prompt, chord, level, chords?, pitches?, clef?, octave_exact?, recall?, ref?,
  debounce_s?}` — chords named by text into the file's table.

**Runtime** (`web/static/offline/`; pure modules, plus `boot()` for the browser):
`theory.js` (match, match_pitches, name_notes, Python's `round`) · `drill.js` (NoteTracker,
DrillEngine) · `grading.js` · `srs.js` (SM-2 with the same records and `sha1(theme \0 key)` ids;
naive-datetime arithmetic like `datetime + timedelta`) · `trainer.js` (TrainerService: shuffle,
`SESSION_CARDS`, requeue 3 later, `MAX_CARDS`, streak, review sessions and their top-ups, recall
cards, the held/note firehose) · `songs.js` (the deck source, song JSON + review block, the dial,
receipts — published before the `done`, like the server's hub) · `api.js` (answers
`fetch("/api/…")`; every other URL passes through; `/api/sound/samples/*` maps to `samples/<set>/`)
· `runtime.js` (composition; the socket: asynchronous, ordered, JSON-copied — `hello`, `held`
with names, `note`, `prompt`, `step`, `attempt`, `passed`, `skipped`, `done`, `error`, `songs`,
`sound`, `midi`) · `midi.js` (Web MIDI note on/off; an S-1 or IAC bus is not the keyboard; no Web
MIDI (Safari) → "no keyboard", the on-screen piano and ⌨ typing still play).
`localStorage` keys: `music.static.srs.v1` (the `{"v": 1, "cards"}` document of srs/local.py),
`music.static.dials.v1`, `music.static.runs.v1` (receipts v1), `music.static.sound`. Blocked
storage → the same, in memory. `window.__musicStatic` is a test hook, static page only.

**Parity — Python stays the authority.** `tools/static_vectors.py` runs the Python over matcher
verdicts (note sets × chords × all four levels), match_pitches, name_notes, the grade policy,
phrase Fronts, SM-2 walks on a fake clock, DrillEngine traces of timed notes (debounce, arming,
progressions, misses, skips) and whole TrainerService + SongsService sessions (shuffle off:
decks, requeue, streak, review sessions, recall, the dial, receipts, the held/note firehose).
`offline/parity.check.mjs` replays every case through the twin and must agree field for field.
`tests/test_static_site.py` regenerates the vectors on every run, builds the page, and runs
`offline/runtime.check.mjs` (the runtime and the real views over the built data). A grading
change lands in Python first; the twin follows until the vectors agree.
`tools/smoke_static_site.mjs` drives the built page in headless Chrome (local, not CI).

**Off on the page** — one calm line each ("… needs the local app — see the README"): importing a
page, the check screen and every chart edit (bar, text, form, checked, re-read, delete), Anki (the
🧠 menu offers Built-in only).
