import encoded from "./glyph-model-data.js";
import { packedGlyphReader } from "./glyph-codec.js";
// Offline-baked control deltas and vertex recipes. No font parser or preparation.
const inflateStartedAt = performance.now();
const r = await packedGlyphReader(encoded);
const decodeStartedAt = performance.now();
const quantization = r.u(),
  upem = r.u(),
  axes = {};
const tagsInFile = Array.from({ length: r.u() }, () => {
  const tag = String.fromCharCode(r.u(), r.u(), r.u(), r.u());
  axes[tag] = [r.s(), r.s(), r.s()].map((n) => n / 16384);
  return tag;
});
const supportsInFile = Array.from({ length: r.u() }, () => {
  const value = {};
  for (let n = r.u(); n; n--)
    value[tagsInFile[r.u()]] = [r.s(), r.s(), r.s()].map((v) => v / 16384);
  return value;
});
const data = { axes, supports: supportsInFile, chars: {}, upem };
for (let n = r.u(); n; n--) {
  const char = String.fromCharCode(r.u()),
    lengths = Array.from({ length: r.u() }, () => r.u()),
    base = Float64Array.from({ length: r.u() }, () => r.s() / quantization),
    tupleOffsets = new Uint16Array(supportsInFile.length + 1),
    tupleIds = [], tupleDeltas = [];
  for (let id = 0; id < supportsInFile.length; id++) {
    tupleOffsets[id] = tupleIds.length;
    let i = -1;
    for (let n = r.u(); n; n--) {
      tupleIds.push(i += r.u());
      tupleDeltas.push(r.s() / quantization);
    }
  }
  tupleOffsets[supportsInFile.length] = tupleIds.length;
  const recipeCount = r.u();
  const recipeOffsets = new Uint16Array(recipeCount + 1),
    ids = [],
    values = [];
  for (let i = 0; i < recipeCount; i++) {
    recipeOffsets[i] = ids.length;
    for (let terms = r.u(); terms; terms--) {
      ids.push(r.u());
      values.push(r.u() / 288);
    }
  }
  recipeOffsets[recipeCount] = ids.length;
  data.chars[char] = {
    base,
    control: base.slice(),
    tupleOffsets,
    tupleIds: new Uint16Array(tupleIds),
    tupleDeltas: new Float64Array(tupleDeltas),
    recipeOffsets,
    recipeIds: new Uint16Array(ids),
    recipeWeights: new Float64Array(values),
    lengths,
    size: recipeCount * 2 + 1,
    cache: new Map(),
    order: [],
    next: 0,
  };
}
export const glyphKernelBackend = "baked-javascript";
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
const tags = ["wdth", "wght", "GRAD", "ROND", "slnt"],
  names = ["width", "weight", "grade", "round", "slant"];
// Support regions reuse a small set of one-axis factors. Evaluate each factor
// once instead of repeating its interpolation for every multi-axis tuple.
const factors = [],
  factorIds = new Map();
const supports = data.supports.map((s) =>
  Object.entries(s).map(([tag, range]) => {
    const key = tag + range.join(",");
    let id = factorIds.get(key);
    if (id == null) {
      id = factors.length;
      factorIds.set(key, id);
      factors.push([tags.indexOf(tag), ...range]);
    }
    return id;
  }),
);
// Nine fixed-font factors select active regions without scanning all 79 tuples.
const supportMasks = supports.map(ids => ids.reduce((mask, id) => mask | (1 << id), 0)),
  activeByMask = Array.from({ length: 1 << factors.length }, (_, mask) =>
    Uint8Array.from(supportMasks.flatMap((bits, id) => (bits & mask) === bits ? [id] : [])));
const normalized = new Float64Array(5),
  axisFactors = new Float64Array(factors.length),
  scalarOrder = [];
let scalarNext = 0;
let lastKey = "",
  lastScalars;
const scalarCache = new Map();
function scalars(pose) {
  const key = Math.round(pose.width * 100) + "," +
    Math.round(pose.weight * 10) + "," + Math.round(pose.grade * 10) + "," +
    Math.round(pose.round * 10) + "," + Math.round(pose.slant * 100);
  if (key === lastKey) return lastScalars;
  if (scalarCache.has(key)) {
    lastKey = key;
    lastScalars = scalarCache.get(key);
    return lastScalars;
  }
  for (let i = 0; i < tags.length; i++) {
    const [min, def, max] = data.axes[tags[i]],
      v = pose[names[i]];
    normalized[i] =
      v < def ? (v - def) / (def - min) : (v - def) / (max - def || 1);
  }
  lastKey = key;
  let mask = 0;
  for (let i = 0; i < factors.length; i++) {
    const [axis, lo, peak, hi] = factors[i],
      v = normalized[axis];
    axisFactors[i] =
      v === peak
        ? 1
        : v <= lo || v >= hi
          ? 0
          : v < peak
            ? (v - lo) / (peak - lo)
            : (hi - v) / (hi - peak);
    if (axisFactors[i]) mask |= 1 << i;
  }
  let state;
  if (scalarCache.size >= 64) {
    const previous = scalarOrder[scalarNext];
    state = scalarCache.get(previous);
    scalarCache.delete(previous);
    scalarOrder[scalarNext] = key;
    scalarNext = (scalarNext + 1) & 63;
  } else {
    scalarOrder.push(key);
    state = { weights: new Float64Array(supports.length), active: null };
  }
  const { weights } = state,
    active = state.active = activeByMask[mask];
  for (const i of active) {
    let value = 1;
    for (const factor of supports[i]) {
      value *= axisFactors[factor];
    }
    weights[i] = value;
  }
  lastScalars = state;
  scalarCache.set(key, lastScalars);
  return lastScalars;
}

export function glyphLayout(char) {
  const m = data.chars[char];
  if (!m.layout) {
    let at = 0;
    const steps = char === "o" ? 6 : 4;
    const contours = m.lengths.map(n => {
      const commands = [], start = at;
      for (let i = 0; i < n;) {
        const next = start + (i + 1) % n,
          curve = m.recipeOffsets[next + 1] - m.recipeOffsets[next] === 3,
          count = curve ? steps : 1;
        commands.push([(start + (i + count) % n) * 2,
          curve ? (start + (i + count / 2) % n) * 2 : -1, (start + i) * 2]);
        i += count;
      }
      at += n;
      return { start: start * 2, commands };
    });
    m.layout = { lengths: m.lengths, size: m.size, upem, contours };
  }
  return m.layout;
}
export function glyphVector(
  char,
  pose,
  out = new Float64Array(data.chars[char].size),
) {
  const m = data.chars[char],
    { weights, active } = scalars(pose),
    key = lastKey,
    cached = m.cache.get(key);
  if (cached) {
    out.set(cached);
    return out;
  }
  const c = m.control;
  c.set(m.base);
  const tupleOffsets = m.tupleOffsets, tupleIds = m.tupleIds, tupleDeltas = m.tupleDeltas;
  for (const id of active) {
    const w = weights[id], end = tupleOffsets[id + 1];
    for (let i = tupleOffsets[id]; i < end; i++) c[tupleIds[i]] += tupleDeltas[i] * w;
  }
  const offsets = m.recipeOffsets, ids = m.recipeIds, recipeWeights = m.recipeWeights;
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i], end = offsets[i + 1], first = ids[start] * 2,
      weight = recipeWeights[start];
    let x = c[first] * weight, y = c[first + 1] * weight;
    // Quadratic samples have three terms; endpoints have one. Avoid an inner
    // indexed loop for the common recipes, preserving their addition order.
    if (end === start + 3) {
      const b = ids[start + 1] * 2, d = ids[start + 2] * 2,
        bw = recipeWeights[start + 1], dw = recipeWeights[start + 2];
      x += c[b] * bw; y += c[b + 1] * bw;
      x += c[d] * dw; y += c[d + 1] * dw;
    } else for (let j = start + 1; j < end; j++) {
      const id = ids[j] * 2, w = recipeWeights[j];
      x += c[id] * w; y += c[id + 1] * w;
    }
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  out[out.length - 1] = c[c.length - 1];
  let stored;
  // Bound per-glyph vectors independently of the shared support cache.
  if (m.cache.size >= 16) {
    const prev = m.order[m.next];
    stored = m.cache.get(prev);
    m.cache.delete(prev);
    m.order[m.next] = key;
    m.next = (m.next + 1) & 15;
    stored.set(out);
  } else {
    m.order.push(key);
    stored = out.slice();
  }
  m.cache.set(key, stored);
  return out;
}
export function glyphOutline(char, pose = restPose) {
  const m = data.chars[char],
    v = glyphVector(char, pose);
  let at = 0;
  return {
    loops: m.lengths.map((n) =>
      Array.from({ length: n }, () => ({ x: v[at++], y: v[at++] })),
    ),
    advance: v.at(-1),
    upem,
  };
}

export const glyphDecodeMetrics = {
  inflateElapsedMs: decodeStartedAt - inflateStartedAt,
  decodeMainThreadMs: performance.now() - decodeStartedAt,
};
