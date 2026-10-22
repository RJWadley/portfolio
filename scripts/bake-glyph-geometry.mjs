// Font-specific offline compiler. The e is the union of its C stroke and bar;
// preserving those two positive contours avoids a changing counter arrangement.
import { glyphOutline, axisSamples, restPose } from "./lib/glyph-source.js";
import { convexMesh, meshPoints } from "./lib/glyph-mesh.js";
import earcut from "earcut";
import { writeFile } from "node:fs/promises";
import {
  fixedGlyphMesh,
  expandGlyphPoints,
} from "../app/ui/public/glyph-convex.js";
const poses = axisSamples(),
  budget = Number(process.argv[2] ?? 0.02),
  out = {};
const area = (p) =>
  p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length];
    return s + a.x * b.y - a.y * b.x;
  }, 0) / 2;
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function extraPoints(mesh, base) {
  return meshPoints(mesh, base).map((p) => ({ ...p }));
}
function averageOutline(char) {
  const os = poses.map((p) => glyphOutline(char, p)),
    o = glyphOutline(char);
  return {
    ...o,
    loops: o.loops.map((l, k) =>
      l.map((_, j) => ({
        x: os.reduce((s, o) => s + o.loops[k][j].x, 0) / os.length,
        y: os.reduce((s, o) => s + o.loops[k][j].y, 0) / os.length,
      })),
    ),
  };
}
function borders(mesh) {
  const edges = new Map();
  for (const p of mesh.polygons)
    for (let i = 0; i < p.length; i++) {
      const a = p[i],
        b = p[(i + 1) % p.length];
      if (a === b) continue;
      const opposite = b + "," + a,
        k = a + "," + b;
      if (edges.has(opposite)) edges.delete(opposite);
      else edges.set(k, [a, b]);
    }
  const rings = [];
  while (edges.size) {
    const e = edges.values().next().value,
      ring = [e[0]];
    let cursor = e[1];
    edges.delete(e.join(","));
    for (let step = 0; cursor !== ring[0] && step < 10000; step++) {
      ring.push(cursor);
      let next;
      for (const [k, v] of edges)
        if (v[0] === cursor) {
          next = v;
          edges.delete(k);
          break;
        }
      if (!next) break;
      cursor = next[1];
    }
    if (ring.length > 2) rings.push(ring);
  }
  return rings;
}
function hull(ids, points) {
  const sorted = [...new Set(ids)].sort(
      (a, b) => points[a].x - points[b].x || points[a].y - points[b].y,
    ),
    low = [],
    high = [];
  for (const id of sorted) {
    while (
      low.length >= 2 &&
      cross(points[low.at(-2)], points[low.at(-1)], points[id]) <= 1e-6
    )
      low.pop();
    low.push(id);
  }
  for (const id of sorted.toReversed()) {
    while (
      high.length >= 2 &&
      cross(points[high.at(-2)], points[high.at(-1)], points[id]) <= 1e-6
    )
      high.pop();
    high.push(id);
  }
  return [...low.slice(0, -1), ...high.slice(0, -1)];
}
function contains(poly, id, points) {
  const p = points[id];
  for (let i = 0; i < poly.length; i++) {
    const a = points[poly[i]],
      b = points[poly[(i + 1) % poly.length]];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -0.01)
      return false;
  }
  return true;
}

for (const char of new Set("RobbieWadley")) {
  const rest = averageOutline(char);
  if (char === "e" && rest.loops[0].length !== 103)
    throw new Error("Font changed: rebuild the e stroke recipe");
  const mesh =
      char === "e"
        ? { polygons: [], extra: [], missing: [] }
        : convexMesh(rest.loops),
    samples = [
      extraPoints(mesh, rest.loops.flat()),
      ...poses.map((p) =>
        extraPoints(mesh, glyphOutline(char, p).loops.flat()),
      ),
    ],
    points = samples[0],
    rings = (
      char === "e"
        ? [
            [
              ...Array.from({ length: 42 }, (_, i) => i),
              ...Array.from({ length: 58 }, (_, i) => i + 45),
            ],
            [41, 42, 43, 44, 45],
          ]
        : borders(mesh)
    ).map((r) => {
      const used = new Set(borders(mesh).flat()),
        native = rest.loops.flat(),
        starts = [];
      let offset = 0;
      for (const loop of rest.loops) {
        starts.push([offset, offset + loop.length]);
        offset += loop.length;
      }
      const missing = new Set(
        native.map((_, i) => i).filter((i) => !used.has(i)),
      );
      const result = [];
      for (let edge = 0; edge < r.length; edge++) {
        const a = r[edge],
          b = r[(edge + 1) % r.length];
        result.push(a);
        if (a >= native.length || b >= native.length) continue;
        const range = starts.find(
          ([lo, hi]) => a >= lo && a < hi && b >= lo && b < hi,
        );
        if (!range) continue;
        const [lo, hi] = range,
          via = [];
        let i = a;
        for (let n = 0; n < hi - lo; n++) {
          i = i + 1 === hi ? lo : i + 1;
          if (i === b) break;
          if (!missing.has(i)) {
            via.length = 0;
            break;
          }
          via.push(i);
        }
        const pa = points[a],
          pb = points[b],
          len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
        if (via.every((i) => Math.abs(cross(pa, pb, points[i])) / len < 0.01))
          result.push(...via);
      }
      return result;
    }),
    positive = rings.filter((r) => area(r.map((i) => points[i])) > 0),
    negative = rings.filter((r) => area(r.map((i) => points[i])) < 0);
  let tris = [];
  for (const outer of positive) {
    const holes = negative.filter((h) =>
      contains(hull(outer, points), h[0], points),
    );
    const ids = [...outer],
      offsets = [];
    for (const h of holes) {
      offsets.push(ids.length);
      ids.push(...h);
    }
    const indices = earcut(
      ids.flatMap((i) => [points[i].x, points[i].y]),
      offsets,
    );
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices.slice(i, i + 3).map((j) => ids[j]);
      if (area(t.map((i) => points[i])) < 0) t.reverse();
      tris.push(t);
    }
  }
  // Make the triangulation compatible with every sampled font pose.
  const triCost = (t) =>
    samples.reduce(
      (sum, ps) => sum + Math.max(0, -area(t.map((i) => ps[i]))),
      0,
    );
  for (let pass = 0; pass < 1000; pass++) {
    const owners = new Map();
    let best;
    for (let ti = 0; ti < tris.length; ti++)
      for (let j = 0; j < 3; j++) {
        const u = tris[ti][j],
          v = tris[ti][(j + 1) % 3],
          w = tris[ti][(j + 2) % 3],
          opposite = owners.get(v + "," + u);
        if (!opposite) {
          owners.set(u + "," + v, { ti, w });
          continue;
        }
        const z = opposite.w,
          a = [w, z, v],
          b = [z, w, u];
        if (
          area(a.map((i) => points[i])) < 1e-7 ||
          area(b.map((i) => points[i])) < 1e-7
        )
          continue;
        const improvement =
          triCost(tris[ti]) +
          triCost(tris[opposite.ti]) -
          triCost(a) -
          triCost(b);
        if (improvement > 1e-5 && (!best || improvement > best.improvement))
          best = { i: ti, j: opposite.ti, a, b, improvement };
      }
    if (!best) break;
    tris[best.i] = best.a;
    tris[best.j] = best.b;
  }
  console.log(
    char,
    "triangle flips remaining",
    tris.filter((t) => triCost(t) > 1e-5).length,
    "negative",
    Math.max(
      ...samples.map((ps) =>
        tris.reduce(
          (sum, t) => sum + Math.max(0, -area(t.map((i) => ps[i]))),
          0,
        ),
      ),
    ),
  );
  function candidate(ids) {
    const hs = samples.map((ps) => hull(ids, ps)),
      all = [...new Set(hs.flat())],
      cx = all.reduce((s, i) => s + points[i].x, 0) / all.length,
      cy = all.reduce((s, i) => s + points[i].y, 0) / all.length;
    const ring = all.sort(
      (a, b) =>
        Math.atan2(points[a].y - cy, points[a].x - cx) -
        Math.atan2(points[b].y - cy, points[b].x - cx),
    );
    const valid = hs.every((h) => {
      const is = h.map((id) => ring.indexOf(id));
      let wraps = 0;
      for (let i = 0; i < is.length; i++)
        if (is[(i + 1) % is.length] < is[i]) wraps++;
      return wraps <= 1;
    });
    return {
      ids,
      ring,
      valid,
      areas: hs.map((h, i) => Math.abs(area(h.map((j) => samples[i][j])))),
    };
  }
  let parts = tris.map((p, i) => ({ ...candidate(p), group: new Set([i]) }));
  const edges = new Map(),
    adjacent = new Set();
  for (let i = 0; i < tris.length; i++)
    for (let j = 0; j < 3; j++) {
      const a = tris[i][j],
        b = tris[i][(j + 1) % 3],
        k = Math.min(a, b) + "," + Math.max(a, b);
      if (edges.has(k))
        adjacent.add(
          Math.min(i, edges.get(k)) + "," + Math.max(i, edges.get(k)),
        );
      else edges.set(k, i);
    }
  const totals = samples.map((ps) =>
      tris.reduce((s, p) => s + area(p.map((j) => ps[j])), 0),
    ),
    excess = samples.map(
      (_, i) => parts.reduce((s, p) => s + p.areas[i], 0) - totals[i],
    );
  const memo = new Map();
  let iterations = 0;
  while (true) {
    let best;
    for (let a = 0; a < parts.length; a++)
      for (let b = a + 1; b < parts.length; b++) {
        const aa = parts[a],
          bb = parts[b];
        let neighbor = false;
        for (const x of aa.group)
          for (const y of bb.group)
            if (adjacent.has(Math.min(x, y) + "," + Math.max(x, y)))
              neighbor = true;
        if (!neighbor) continue;
        const ids = [...new Set([...aa.ids, ...bb.ids])].sort((a, b) => a - b),
          key = ids.join(",");
        let c = memo.get(key);
        if (!c) {
          c = candidate(ids);
          memo.set(key, c);
        }
        if (!c.valid) continue;
        let max = 0;
        const increase = [];
        let ok = true;
        for (let i = 0; i < samples.length; i++) {
          const added = c.areas[i] - aa.areas[i] - bb.areas[i];
          increase[i] = added;
          const ratio = (excess[i] + added) / totals[i];
          if (ratio > budget + 1e-8) {
            ok = false;
            break;
          }
          max = Math.max(max, added / totals[i]);
        }
        if (ok && (!best || max < best.score))
          best = { a, b, c, increase, score: max };
      }
    if (!best) break;
    const { a, b, c, increase } = best;
    for (let s = 0; s < excess.length; s++) excess[s] += increase[s];
    const merged = {
      ...c,
      group: new Set([...parts[a].group, ...parts[b].group]),
    };
    parts.splice(b, 1);
    parts.splice(a, 1, merged);
    iterations++;
  }
  out[char] = {
    groups: parts.map((p) => p.ring),
    extra: mesh.extra,
    rawCount: rest.loops.flat().length,
  };
  // Remove slivers that together occupy at most 0.5% in every sampled pose.
  // This is an offline area allowance; the independent pixel IoU remains the
  // authority and still checks every dropped pose/letter at the original bar.
  const fixed = fixedGlyphMesh(out[char]);
  const faceAreas = poses.map((pose) => {
    const ps = expandGlyphPoints(
      fixed,
      glyphOutline(char, pose).loops.flat(),
      {},
    );
    return fixed.polygons.map((ids) => Math.abs(area(ids.map((i) => ps[i]))));
  });
  const pruneTotals = faceAreas.map((values) =>
      values.reduce((sum, v) => sum + v, 0),
    ),
    removed = faceAreas.map(() => 0);
  const ranked = out[char].groups
      .map((_, i) => ({
        i,
        max: Math.max(
          ...faceAreas.map((values, j) => values[i] / pruneTotals[j]),
        ),
      }))
      .sort((a, b) => a.max - b.max),
    drop = new Set();
  for (const { i } of ranked)
    if (
      faceAreas.every(
        (values, j) => (removed[j] + values[i]) / pruneTotals[j] <= 0.005,
      )
    ) {
      drop.add(i);
      faceAreas.forEach((values, j) => (removed[j] += values[i]));
    }
  out[char].groups = out[char].groups.filter((_, i) => !drop.has(i));

  console.log(
    char,
    "parts",
    out[char].groups.length,
    "maxExcess",
    Math.max(...excess.map((x, i) => x / totals[i])),
  );
}
await writeFile(
  "app/ui/public/glyph-topology.js",
  "// Generated by scripts/bake-glyph-geometry.mjs. Fixed parts and vertex slots.\nexport default " +
    JSON.stringify(out) +
    ";\n",
);
