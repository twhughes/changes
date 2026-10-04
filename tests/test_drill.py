"""DrillEngine: arming, grading, advancing, skip — driven by synthetic time."""

from music.learn.decks import DeckRun, builtin_decks
from music.learn.drill import DrillEngine, DrillItem
from music.midio.events import MidiEvent
from music.midio.notes import NoteTracker
from music.theory.chords import parse_chord
from music.theory.match import Level


def make_engine(chords, level=Level.LOOSE):
    events = []
    items = [DrillItem(prompt=f"Play {c}", chord=parse_chord(c), level=level,
                       debounce_s=0.3) for c in chords]
    eng = DrillEngine(items, on_event=lambda name, p: events.append((name, p)))
    return eng, events


def play(tracker, eng, t, notes_on=(), notes_off=()):
    for n in notes_on:
        tracker.feed(MidiEvent(t, "note_on", n, 90))
    for n in notes_off:
        tracker.feed(MidiEvent(t, "note_off", n, 0))
    eng.feed(t, tracker)


def test_pass_then_advance_then_done():
    eng, events = make_engine(["G7", "C"])
    tr = NoteTracker()
    eng.start(0.0)
    play(tr, eng, 1.0, notes_on=[55, 59, 62, 65])
    eng.feed(1.5, tr)                                 # stable → graded → pass
    assert eng.idx == 1 and eng.results[0].passed
    play(tr, eng, 2.0, notes_off=[55, 59, 62, 65])    # hands off arms item 2
    play(tr, eng, 3.0, notes_on=[60, 64, 67])
    eng.feed(3.5, tr)
    assert eng.done
    names = [e[0] for e in events]
    assert names == ["prompt", "attempt", "passed", "prompt", "attempt", "passed", "done"]
    assert eng.results[0].latency_s == 1.0            # chord down at t=1.0


def test_wrong_chord_records_attempt_keeps_listening():
    eng, events = make_engine(["G7"])
    tr = NoteTracker()
    eng.start(0.0)
    play(tr, eng, 1.0, notes_on=[55, 59, 62])         # no F
    eng.feed(1.5, tr)
    assert not eng.results[0].passed
    assert len(eng.results[0].attempts) == 1
    play(tr, eng, 2.0, notes_on=[65])                 # add the F
    eng.feed(2.5, tr)
    assert eng.done and eng.results[0].passed
    assert len(eng.results[0].attempts) == 2


def test_same_stable_chord_graded_once():
    eng, _ = make_engine(["G7"])
    tr = NoteTracker()
    eng.start(0.0)
    play(tr, eng, 1.0, notes_on=[55, 59, 62])
    eng.feed(1.5, tr)
    eng.feed(1.6, tr)
    eng.feed(2.0, tr)
    assert len(eng.results[0].attempts) == 1


def test_held_chord_does_not_leak_into_next_item():
    eng, _ = make_engine(["C", "C"])                  # same chord twice
    tr = NoteTracker()
    eng.start(0.0)
    play(tr, eng, 1.0, notes_on=[60, 64, 67])
    eng.feed(1.5, tr)                                 # passes item 0
    eng.feed(2.0, tr)                                 # still held — must NOT pass item 1
    assert eng.idx == 1 and not eng.done
    play(tr, eng, 3.0, notes_off=[60, 64, 67])
    play(tr, eng, 4.0, notes_on=[48, 52, 55])         # re-play C
    eng.feed(4.5, tr)
    assert eng.done


def test_skip():
    eng, events = make_engine(["G7", "C"])
    tr = NoteTracker()
    eng.start(0.0)
    eng.skip(1.0)
    assert eng.results[0].skipped and eng.idx == 1
    play(tr, eng, 2.0, notes_on=[60, 64, 67])
    eng.feed(2.5, tr)
    assert eng.done


def test_builtin_decks_and_requeue():
    decks = builtin_decks()
    assert len(decks["sevenths"]) == 36
    assert all(len({i.prompt for i in items}) == len(items) for items in decks.values())
    run = DeckRun(decks["triads"], shuffle=False)
    first = run.queue[0]
    run.queue.pop(0)
    run.requeue(first)
    assert run.queue[3] is first
