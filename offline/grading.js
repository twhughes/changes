// offline/grading.js — the static page's twin of learn/grading.py (grade policy v2,
// CONTRACTS.md §7): accuracy tier × speed tier → ease 1–4, with the full breakdown.
// The numbers are NOT here: `policy` is learn/grading.py GRADE_POLICY as exported into
// site/data/app.json ("policies.grade") by web/static_data.py. Pure.

import { pyRound } from "./theory.js";

const EASE_LABELS = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

const notesOff = (a) => (a.missing || []).length + (a.extra || []).length;

/** grade(attempts, latency_s, steps, policy) → {ease, label, accuracy, speed}. */
export function grade(attempts, latencyS, steps = 1, policy) {
  const wrong = attempts.filter((a) => !a.ok);
  const worst = wrong.reduce((m, a) => Math.max(m, notesOff(a)), 0);
  let accuracy;
  if (!wrong.length) accuracy = "clean";
  else if (wrong.length <= policy.slip_max_wrong && worst <= policy.slip_max_notes_off) accuracy = "slip";
  else if (wrong.length <= policy.rough_max_wrong) accuracy = "rough";
  else accuracy = "fail";

  let speed = "crawl";
  for (const [limit, tier] of policy.speed_tiers) {
    if (latencyS < limit * Math.max(steps, 1)) {
      speed = tier;
      break;
    }
  }
  const row = policy.ease.find(([acc, spd]) => acc === accuracy && spd === speed);
  const ease = row ? row[2] : 1;
  return {
    ease,
    label: EASE_LABELS[ease],
    accuracy: { tier: accuracy, wrong: wrong.length, notes_off: worst },
    speed: { tier: speed, latency_s: pyRound(latencyS, 3) },
  };
}
