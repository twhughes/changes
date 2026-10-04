"""Grade policy v2 — accuracy × speed → Anki ease (CONTRACTS.md §7).

One config dict, one pure function. Tunable knobs all live in GRADE_POLICY;
the `passed` event carries the full breakdown so Tyler can see what a card
scored and why, and feed that back into these numbers.

Accuracy comes first: a slip caps the grade at Hard, a rough card is Again no
matter how fast the recovery. Speed only separates Easy/Good/Hard on a clean
run. Speed budgets are per chord — a 3-chord ii–V–I gets 3× the seconds.
"""

from __future__ import annotations

GRADE_POLICY: dict = {
    # Speed tiers over total prompt→pass seconds, per chord in the card.
    # (upper bound, tier), fastest first; anything past the last bound is "crawl".
    "speed_tiers": ((2.0, "fast"), (6.0, "ok"), (15.0, "slow")),
    # Accuracy tiers from the wrong attempts:
    #   clean — no wrong attempts
    #   slip  — ≤ slip_max_wrong wrong attempts, each ≤ slip_max_notes_off notes off
    #   rough — ≤ rough_max_wrong wrong attempts
    #   fail  — worse ("really really messed up" = didn't get it)
    "slip_max_wrong": 1,
    "slip_max_notes_off": 2,
    "rough_max_wrong": 3,
    # (accuracy tier, speed tier) → ease. Pairs not listed grade Again (1).
    "ease": {
        ("clean", "fast"): 4, ("clean", "ok"): 3,
        ("clean", "slow"): 2, ("clean", "crawl"): 2,
        ("slip", "fast"): 2, ("slip", "ok"): 2,
    },
}

EASE_LABELS = {1: "Again", 2: "Hard", 3: "Good", 4: "Easy"}


def _notes_off(attempt: dict) -> int:
    return len(attempt.get("missing") or []) + len(attempt.get("extra") or [])


def grade(attempts: list[dict], latency_s: float, steps: int = 1) -> dict:
    """The grade a passed card earned, with the per-factor breakdown.

    ``attempts`` are the engine's attempt dicts (every graded chord, right and
    wrong); ``latency_s`` is prompt → final passing chord; ``steps`` is the
    number of chords in the card (progressions scale the speed budget).
    """
    policy = GRADE_POLICY
    wrong = [a for a in attempts if not a.get("ok")]
    worst = max((_notes_off(a) for a in wrong), default=0)
    if not wrong:
        accuracy = "clean"
    elif len(wrong) <= policy["slip_max_wrong"] and worst <= policy["slip_max_notes_off"]:
        accuracy = "slip"
    elif len(wrong) <= policy["rough_max_wrong"]:
        accuracy = "rough"
    else:
        accuracy = "fail"

    speed = "crawl"
    for limit, tier in policy["speed_tiers"]:
        if latency_s < limit * max(steps, 1):
            speed = tier
            break

    ease = policy["ease"].get((accuracy, speed), 1)
    return {
        "ease": ease,
        "label": EASE_LABELS[ease],
        "accuracy": {"tier": accuracy, "wrong": len(wrong), "notes_off": worst},
        "speed": {"tier": speed, "latency_s": round(latency_s, 3)},
    }
