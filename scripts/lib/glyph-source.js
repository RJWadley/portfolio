// Offline font evaluator. Never imported by the browser application.
import encoded from "../fixtures/glyph-font-source.js";
import { readGlyphFont, compileGlyph } from "./glyph-font.js";
export const sourceFont = await readGlyphFont(encoded);
export const restPose = {
  width: 100,
  weight: 760,
  grade: 0,
  round: 30,
  slant: 0,
  sx: 1,
  sy: 1,
  skew: 0,
};
const models = new Map();
export function sourceModel(char) {
  if (!models.has(char)) models.set(char, compileGlyph(sourceFont, char));
  return models.get(char);
}
export function glyphVector(char, pose = restPose) {
  const m = sourceModel(char),
    values = {
      wdth: pose.width,
      wght: pose.weight,
      GRAD: pose.grade,
      ROND: pose.round,
      slnt: pose.slant,
    },
    norm = {};
  for (const [tag, [lo, def, hi]] of Object.entries(sourceFont.axes)) {
    const v = values[tag];
    norm[tag] = v < def ? (v - def) / (def - lo) : (v - def) / (hi - def || 1);
  }
  const out = m.base.slice();
  for (const [id, indices, deltas] of m.tuples) {
    let s = 1;
    for (const [tag, [lo, peak, hi]] of Object.entries(
      sourceFont.supports[id],
    )) {
      const v = norm[tag];
      if (v === peak) continue;
      if (v <= lo || v >= hi) {
        s = 0;
        break;
      }
      s *= v < peak ? (v - lo) / (peak - lo) : (hi - v) / (hi - peak);
    }
    if (s)
      for (let k = 0; k < indices.length; k++) out[indices[k]] += deltas[k] * s;
  }
  return out;
}
export function glyphOutline(char, pose = restPose) {
  const m = sourceModel(char),
    v = glyphVector(char, pose);
  let at = 0;
  return {
    loops: m.lengths.map((n) =>
      Array.from({ length: n }, () => ({ x: v[at++], y: v[at++] })),
    ),
    advance: v.at(-1),
    upem: sourceFont.upem,
  };
}
export function axisSamples() {
  const poses = [restPose];
  for (const width of [25, 75, 100, 151])
    for (const weight of [120, 400, 760, 1000])
      for (const round of [0, 100])
        for (const grade of [0, 100])
          for (const slant of [0, -10])
            poses.push({ ...restPose, width, weight, round, grade, slant });
  return poses;
}
