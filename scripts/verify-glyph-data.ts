import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import {
  sourceFont,
  sourceModel,
  glyphVector as referenceVector,
  axisSamples,
} from "./lib/glyph-source.js";
import {
  glyphVector,
  glyphKernelBackend,
} from "../app/ui/public/glyph-model.js";
import topology from "../app/ui/public/glyph-topology.js";
import {
  fixedGlyphMesh,
  expandGlyphPoints,
} from "../app/ui/public/glyph-convex.js";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export async function verifyGlyphData() {
  const vectors: Record<string, string> = {},
    counts: Record<string, unknown> = {};
  let maxVectorError = 0,
    minimumTurn = 0;
  const poses = axisSamples();
  let seed = 73411;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 128; i++)
    poses.push({
      width: 25 + random() * 126,
      weight: 120 + random() * 880,
      round: random() * 100,
      grade: random() * 100,
      slant: -random() * 10,
      sx: 1,
      sy: 1,
      skew: 0,
    });
  for (const char of Object.keys(sourceFont.chars)) {
    const model: any = sourceModel(char),
      mesh: any = fixedGlyphMesh((topology as any)[char]);
    vectors[char] = hash({
      base: [...model.base],
      lengths: model.lengths,
      tuples: model.tuples.map(([id, indices, values]: any) => [
        id,
        [...indices].map((i, k) => [i, values[k]]),
      ]),
    });
    const original = JSON.stringify(mesh.polygons),
      state = {};
    for (const pose of poses) {
      const expected = referenceVector(char, pose),
        actual = glyphVector(char, pose);
      for (let i = 0; i < actual.length; i++)
        maxVectorError = Math.max(
          maxVectorError,
          Math.abs(actual[i]! - expected[i]!),
        );
      const points = Array.from(
        { length: (actual.length - 1) / 2 },
        (_, i) => ({ x: actual[i * 2], y: actual[i * 2 + 1] }),
      );
      expandGlyphPoints(mesh, points, state);
      for (const poly of mesh.polygons)
        for (let i = 0; i < poly.length; i++) {
          const a = points[poly[i]],
            b = points[poly[(i + 1) % poly.length]],
            c = points[poly[(i + 2) % poly.length]];
          const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          minimumTurn = Math.min(minimumTurn, cross);
          assert.ok(
            Number.isFinite(cross) && cross >= -0.01,
            `Fixed convex face: ${char} ${JSON.stringify(pose)} ${cross}`,
          );
        }
      assert.equal(
        JSON.stringify(mesh.polygons),
        original,
        "Baked part membership and source vertex slots never change",
      );
    }
    counts[char] = {
      parts: mesh.polygons.length,
      vertices: mesh.polygons.reduce((n: number, p: any) => n + p.length, 0),
    };
  }
  assert.deepEqual(
    vectors,
    JSON.parse(
      await readFile("scripts/fixtures/glyph-vector-hashes.json", "utf8"),
    ),
    "Canonical font fixture retains its verified geometry",
  );
  assert.ok(
    maxVectorError <= 0.025,
    `Baked Q64 controls stay within .025 font units of the original font: ${maxVectorError}`,
  );
  const sizes = [];
  for (const name of [
    "glyph-model-data.js",
    "glyph-topology.js",
    "glyph-model.js",
    "glyph-renderer.js",
    "glyph-codec.js",
    "glyph-convex.js",
    "glyph-footer.js",
    "glyph-footer-data.js",
    "glyph-hulls.js",
    "matter-coherence.js",
    "glyph-dynamics.js",
  ]) {
    const bytes = await readFile(`app/ui/public/${name}`);
    sizes.push({
      name,
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
    });
  }
  const combinedGzip = sizes.reduce((n, s) => n + s.gzip, 0);
  assert.ok(
    combinedGzip <= 57204,
    `Complete lazy geometry payload does not exceed its previous 57,204 bytes gzip: ${combinedGzip}`,
  );
  const report = {
    backend: glyphKernelBackend,
    maxVectorError,
    minimumTurn,
    counts,
    sizes,
    combinedGzip,
    poses: poses.length,
    runtimeTessellations: 0,
    runtimeFontPreparations: 0,
  };
  await mkdir(".verify", { recursive: true });
  await writeFile(".verify/glyph-data.json", JSON.stringify(report, null, 2));
  return report;
}
if (import.meta.main)
  console.log(JSON.stringify(await verifyGlyphData(), null, 2));
