import { packedGlyphReader } from "../../app/ui/public/glyph-codec.js";

export async function readGlyphFont(encoded) {
  const r = await packedGlyphReader(encoded),
    upem = r.u(),
    axes = {};
  const tags = Array.from({ length: r.u() }, () => {
    const tag = String.fromCharCode(r.u(), r.u(), r.u(), r.u());
    axes[tag] = [r.s(), r.s(), r.s()].map((v) => v / 16384);
    return tag;
  });
  const supports = Array.from({ length: r.u() }, () => {
    const region = {};
    for (let i = r.u(); i; i--)
      region[tags[r.u()]] = [r.s(), r.s(), r.s()].map((v) => v / 16384);
    return region;
  });
  const glyphs = Array.from({ length: r.u() }, () => {
    const points = Array.from({ length: r.u() }, () => [r.s(), r.s()]);
    let end = -1;
    const ends = Array.from({ length: r.u() }, () => (end += r.u()));
    const flags = Array.from({ length: r.u() }, () => r.u());
    const components = Array.from({ length: r.u() }, () => r.u());
    const tuples = Array.from({ length: r.u() }, () => {
      const id = r.u();
      let index = -1;
      return [
        id,
        Array.from({ length: r.u() }, () => [(index += r.u()), r.s(), r.s()]),
      ];
    });
    return { points, ends, flags, components, tuples };
  });
  const chars = {};
  for (let n = r.u(); n; n--) chars[String.fromCharCode(r.u())] = r.u();
  return { upem, axes, supports, glyphs, chars };
}
const rounded = (value) => {
  // Python's generated vectors use ties-to-even for exact binary midpoints.
  const scaled = value * 100000,
    lo = Math.floor(scaled);
  if (scaled - lo === 0.5 && (2 * lo + 1) % 3125 === 0)
    return (lo + (lo % 2 ? 1 : 0)) / 100000;
  return Number(value.toFixed(5));
};
function deltas(glyph) {
  if (glyph.deltas) return glyph.deltas;
  const result = new Map(),
    count = glyph.points.length;
  for (const [id, explicit] of glyph.tuples) {
    const values = Array(count).fill(null);
    for (const [i, x, y] of explicit) values[i] = [x, y];
    let start = 0;
    for (const end of [
      ...glyph.ends,
      count - 4,
      count - 3,
      count - 2,
      count - 1,
    ]) {
      const known = [];
      for (let i = start; i <= end; i++) if (values[i]) known.push(i);
      if (!known.length) {
        for (let i = start; i <= end; i++) values[i] = [0, 0];
      } else {
        for (let k = 0; k < known.length; k++) {
          const a = known[k],
            b = known[(k + 1) % known.length];
          let i = a;
          for (;;) {
            i = i === end ? start : i + 1;
            if (i === b) break;
            values[i] = [0, 0];
            for (let axis = 0; axis < 2; axis++) {
              let x1 = glyph.points[a][axis],
                x2 = glyph.points[b][axis],
                d1 = values[a][axis],
                d2 = values[b][axis];
              if (x1 > x2) {
                [x1, x2] = [x2, x1];
                [d1, d2] = [d2, d1];
              }
              const x = glyph.points[i][axis];
              values[i][axis] =
                x1 === x2
                  ? d1 === d2
                    ? d1
                    : 0
                  : x <= x1
                    ? d1
                    : x >= x2
                      ? d2
                      : d1 + (x - x1) * ((d2 - d1) / (x2 - x1));
            }
          }
        }
      }
      start = end + 1;
    }
    const delta = result.get(id) ?? new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      delta[i * 2] += rounded(values[i][0]);
      delta[i * 2 + 1] += rounded(values[i][1]);
    }
    result.set(id, delta);
  }
  glyph.deltas = result;
  return result;
}
function coordinates(glyph, support) {
  const delta = support == null ? null : deltas(glyph).get(support);
  return glyph.points.map(([x, y], i) => [
    x + (delta?.[i * 2] ?? 0),
    y + (delta?.[i * 2 + 1] ?? 0),
  ]);
}
function contours(font, id, support, ox = 0, oy = 0) {
  const glyph = font.glyphs[id],
    p = coordinates(glyph, support);
  if (glyph.components.length)
    return glyph.components.flatMap((child, i) =>
      contours(font, child, support, ox + p[i][0], oy + p[i][1]),
    );
  let start = 0;
  return glyph.ends.map((end) => {
    const points = p
      .slice(start, end + 1)
      .map(([x, y], i) => [x + ox, y + oy, glyph.flags[start + i] & 1]);
    start = end + 1;
    const expanded = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      expanded.push(a);
      if (!a[2] && !b[2])
        expanded.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1]);
    }
    const first = expanded.findIndex((p) => p[2]),
      ring = [...expanded.slice(first), ...expanded.slice(0, first)],
      out = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      if (!a[2]) continue;
      out.push(a[0], -a[1]);
      if (!b[2]) {
        const c = ring[(i + 2) % ring.length],
          steps = id === font.chars.o ? 6 : 4;
        for (let j = 1; j < steps; j++) {
          const t = j / steps,
            u = 1 - t;
          out.push(
            u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
            -(u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]),
          );
        }
      }
    }
    return out;
  });
}
export function compileGlyph(font, char) {
  const id = font.chars[char],
    loops = contours(font, id);
  const vector = (support) => {
    const p = coordinates(font.glyphs[id], support);
    return [...contours(font, id, support).flat(), p.at(-3)[0] - p.at(-4)[0]];
  };
  const base = vector(),
    tuples = [];
  for (let support = 0; support < font.supports.length; support++) {
    const values = vector(support),
      indices = [],
      delta = [];
    for (let i = 0; i < values.length; i++) {
      const d = values[i] - base[i];
      if (Math.abs(d) > 1e-6) {
        indices.push(i);
        delta.push(rounded(d));
      }
    }
    if (indices.length)
      tuples.push([support, new Int32Array(indices), new Float64Array(delta)]);
  }
  return {
    base: new Float64Array(base.map(rounded)),
    lengths: loops.map((l) => l.length / 2),
    tuples,
    cache: new Map(),
  };
}
