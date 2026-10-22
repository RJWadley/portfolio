import { sourceFont, sourceModel } from "./lib/glyph-source.js";
import { gzipSync, inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
const Q = 64,
  models = {};
for (const c of new Set("RobbieWadley")) sourceModel(c);
function coords(g, id) {
  const d = id == null ? null : g.deltas?.get(id);
  return g.points.map(([x, y], i) => [
    x + (d?.[i * 2] ?? 0),
    y + (d?.[i * 2 + 1] ?? 0),
  ]);
}
function flatten(id, support, out = [], loops = [], ox = 0, oy = 0) {
  const g = sourceFont.glyphs[id],
    p = coords(g, support);
  if (g.components.length)
    for (let i = 0; i < g.components.length; i++)
      flatten(g.components[i], support, out, loops, ox + p[i][0], oy + p[i][1]);
  else {
    let start = 0;
    for (const end of g.ends) {
      const loop = [];
      for (let i = start; i <= end; i++) {
        loop.push({ id: out.length / 2, on: g.flags[i] & 1 });
        out.push(ox + p[i][0], -oy - p[i][1]);
      }
      loops.push(loop);
      start = end + 1;
    }
  }
  return { out, loops };
}
const sum = (...terms) => {
  const m = new Map();
  for (const [recipe, w] of terms)
    for (const [id, v] of recipe) m.set(id, (m.get(id) ?? 0) + v * w);
  return [...m].filter(([_, v]) => v !== 0);
};
for (const char of new Set("RobbieWadley")) {
  const id = sourceFont.chars[char],
    g = sourceFont.glyphs[id],
    base = flatten(id, null),
    vec = (s) => {
      const v = flatten(id, s).out,
        p = coords(g, s);
      return [...v, p.at(-3)[0] - p.at(-4)[0]];
    },
    b = vec(null),
    rows = [];
  for (let s = 0; s < 79; s++) {
    const v = vec(s),
      entries = [];
    for (let i = 0; i < v.length; i++) {
      const d = Math.round((v[i] - b[i]) * Q);
      if (d) entries.push([i, d]);
    }
    rows.push(entries);
  }
  const recipes = [],
    lengths = [];
  for (const loop of base.loops) {
    const expanded = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i],
        b = loop[(i + 1) % loop.length];
      expanded.push({ on: a.on, r: [[a.id, 1]] });
      if (!a.on && !b.on)
        expanded.push({
          on: true,
          r: [
            [a.id, 0.5],
            [b.id, 0.5],
          ],
        });
    }
    const f = expanded.findIndex((p) => p.on),
      ring = [...expanded.slice(f), ...expanded.slice(0, f)];
    let n = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      if (!a.on) continue;
      recipes.push(a.r);
      n++;
      if (!b.on) {
        const c = ring[(i + 2) % ring.length],
          steps = char === "o" ? 6 : 4;
        for (let j = 1; j < steps; j++) {
          const t = j / steps,
            u = 1 - t;
          recipes.push(sum([a.r, u * u], [b.r, 2 * u * t], [c.r, t * t]));
          n++;
        }
      }
    }
    lengths.push(n);
  }
  models[char] = {
    base: b,
    rows,
    recipes: recipes.map((r) => r.map(([i, w]) => [i, Math.round(w * 288)])),
    lengths,
  };
}
const bytes = [];
const u = (n) => {
  while (n > 127) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  bytes.push(n);
};
const s = (n) => u(n < 0 ? -n * 2 - 1 : n * 2);
u(Q);
u(sourceFont.upem);
u(5);
const tags = Object.keys(sourceFont.axes);
for (const tag of tags) {
  for (const c of tag) u(c.charCodeAt(0));
  for (const v of sourceFont.axes[tag]) s(v * 16384);
}
u(79);
for (const reg of sourceFont.supports) {
  u(Object.keys(reg).length);
  for (const [tag, range] of Object.entries(reg)) {
    u(tags.indexOf(tag));
    for (const v of range) s(v * 16384);
  }
}
u(10);
for (const [char, m] of Object.entries(models)) {
  u(char.charCodeAt(0));
  u(m.lengths.length);
  for (const n of m.lengths) u(n);
  u(m.base.length);
  for (const v of m.base) s(Math.round(v * Q));
  for (const row of m.rows) {
    u(row.length);
    let prev = -1;
    for (const [i, d] of row) {
      u(i - prev);
      s(d);
      prev = i;
    }
  }
  u(m.recipes.length);
  for (const r of m.recipes) {
    u(r.length);
    for (const [i, w] of r) {
      u(i);
      u(w);
    }
  }
}
// Spend compression CPU once offline. uv uses a disposable local environment;
// the browser still receives the same ordinary DEFLATE bytes and decoder.
const packed = execFileSync("uv", ["run", "--no-project", "--with", "zopfli==0.4.3", "python", "-c",
  "import sys,zopfli.zlib;sys.stdout.buffer.write(zopfli.zlib.compress(sys.stdin.buffer.read(),numiterations=30))"],
  { input: new Uint8Array(bytes), maxBuffer: 1024 * 1024 });
if (!inflateSync(packed).equals(Buffer.from(bytes))) throw new Error("Geometry compression roundtrip failed");
const text =
  '// Offline-baked controls and fixed linear vertex recipes.\nexport default "' +
  packed.toString("base64") +
  '";\n';
await writeFile("app/ui/public/glyph-model-data.js", text);
console.log({
  controls: Object.values(models).map((m) => m.base.length),
  raw: bytes.length,
  module: text.length,
  gzip: gzipSync(text, { level: 9 }).length,
});
