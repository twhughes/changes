// Tyler's synesthesia palette (stated 2026-07-28) — THE note-color authority
// for every view that claims to show "his" colors. A sharp brightens the
// letter's color (a flat would darken it; a 12-pc grid can only spell one,
// so black keys render as brightened sharps).

const BASE = {
  A: [235, 92, 92], B: [181, 141, 102], C: [236, 236, 238], D: [178, 192, 216],
  E: [57, 255, 20], F: [168, 24, 30], G: [36, 66, 168],
};

// pitch class (0 = C) -> [letter, sharp?]
const PC_LETTER = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];

export const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** [r,g,b] for a pitch class. */
export function rgbOf(pc) {
  const [letter, sharp] = PC_LETTER[((pc % 12) + 12) % 12];
  let [r, g, b] = BASE[letter];
  if (sharp) {
    r = Math.round(r + (255 - r) * 0.35);
    g = Math.round(g + (255 - g) * 0.35);
    b = Math.round(b + (255 - b) * 0.35);
  }
  return [r, g, b];
}

/** rgba() string for a pitch class at a given alpha. */
export const css = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
