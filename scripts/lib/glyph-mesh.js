import libtess from "../vendor/libtess.js";
import { packedGlyphReader } from "../../app/ui/public/glyph-codec.js";
export async function readGlyphTopology(encoded) {
  const r = await packedGlyphReader(encoded),
    result = {};
  for (let n = r.u(); n; n--) {
    const char = String.fromCharCode(r.u()),
      slots = r.u();
    const variants = Array.from({ length: r.u() }, () => ({
      mesh: {
        polygons: Array.from({ length: r.u() }, () =>
          Array.from({ length: r.u() }, () => r.u()),
        ),
        extra: Array.from({ length: r.u() }, () => {
          const count = r.u();
          return {
            ids: Array.from({ length: count }, () => {
              const id = r.u();
              return id ? id - 1 : null;
            }),
            weights: Array.from({ length: count }, () => r.f64()),
          };
        }),
        missing: Array.from({ length: r.u() }, () => r.u()),
      },
    }));
    const capacities = [];
    for (const { mesh } of variants) {
      prepareConvexChecks(mesh);
      for (let k = 0; k < mesh.polygons.length; k++)
        capacities[k] = Math.max(capacities[k] ?? 0, mesh.polygons[k].length);
    }
    result[char] = { slots, variants, capacities };
  }
  return result;
}
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
const meshScratch = new WeakMap();
export function meshPoints(mesh, base) {
  if (!mesh.extra.length) return base;
  let points = meshScratch.get(mesh);
  if (!points) meshScratch.set(mesh, (points = []));
  // This scratch view is consumed synchronously, before the same mesh is used again.
  for (let i = 0; i < base.length; i++) points[i] = base[i];
  points.length = base.length + mesh.extra.length;
  for (let k = 0; k < mesh.extra.length; k++) {
    const { ids, weights } = mesh.extra[k],
      a = points[ids[0]],
      b = points[ids[1]],
      c = points[ids[2]],
      d = points[ids[3]];
    const point = (points[base.length + k] ??= { x: 0, y: 0 });
    let intersection = false;
    if (a && b && c && d) {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        ex = d.x - c.x,
        ey = d.y - c.y,
        den = dx * ey - dy * ex;
      if (Math.abs(den) > 1e-8) {
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
        point.x = a.x + dx * t;
        point.y = a.y + dy * t;
        intersection = true;
      }
    }
    if (!intersection) {
      let x = 0,
        y = 0;
      for (let i = 0; i < ids.length; i++)
        if (ids[i] != null) {
          x += points[ids[i]].x * weights[i];
          y += points[ids[i]].y * weights[i];
        }
      point.x = x;
      point.y = y;
    }
  }
  return points;
}
const convexChecks = new WeakMap();
export function convexMesh(loops) {
  const points = loops.flat(),
    extra = [],
    triangles = [],
    tess = new libtess.GluTesselator(),
    e = libtess.gluEnum;
  tess.gluTessNormal(0, 0, 1);
  tess.gluTessProperty(
    e.GLU_TESS_WINDING_RULE,
    libtess.windingRule.GLU_TESS_WINDING_NONZERO,
  );
  tess.gluTessCallback(e.GLU_TESS_VERTEX, (id) => triangles.push(id));
  tess.gluTessCallback(e.GLU_TESS_EDGE_FLAG, () => {});
  tess.gluTessCallback(e.GLU_TESS_ERROR, (code) => {
    throw new Error(`Glyph tessellation failed: ${code}`);
  });
  tess.gluTessCallback(e.GLU_TESS_COMBINE, (coords, ids, weights) => {
    const id = points.length;
    points.push({ x: coords[0], y: coords[1] });
    extra.push({ ids, weights });
    return id;
  });
  tess.gluTessBeginPolygon(null);
  let index = 0;
  for (const loop of loops) {
    tess.gluTessBeginContour();
    for (const p of loop) tess.gluTessVertex([p.x, p.y, 0], index++);
    tess.gluTessEndContour();
  }
  tess.gluTessEndPolygon();
  const polygons = [];
  for (let i = 0; i < triangles.length; i += 3) {
    let tri = triangles.slice(i, i + 3);
    if (cross(...tri.map((i) => points[i])) < 0) tri.reverse();
    polygons.push(tri);
  }
  // Shorter interior diagonals avoid thin fans around counters and make the
  // following convex merge compact. Boundary edges are never changed.
  for (let pass = 0; pass < 8; pass++) {
    const edges = new Map();
    let flips = 0;
    for (let a = 0; a < polygons.length; a++) {
      const tri = polygons[a];
      for (let i = 0; i < 3; i++) {
        const u = tri[i],
          v = tri[(i + 1) % 3],
          w = tri[(i + 2) % 3],
          key = u < v ? `${u}:${v}` : `${v}:${u}`,
          other = edges.get(key);
        if (!other) {
          edges.set(key, { a, u, v, w });
          continue;
        }
        const z = other.w,
          old =
            (points[u].x - points[v].x) ** 2 + (points[u].y - points[v].y) ** 2,
          next =
            (points[w].x - points[z].x) ** 2 + (points[w].y - points[z].y) ** 2;
        if (
          next >= old * 0.999 ||
          cross(points[w], points[z], points[v]) <= 0.001 ||
          cross(points[z], points[w], points[u]) <= 0.001
        )
          continue;
        // Restart indexing after each flip; this is only preprocessing/fallback.
        polygons[a] = [w, z, v];
        polygons[other.a] = [z, w, u];
        flips++;
        break;
      }
      if (flips) break;
    }
    if (!flips) break;
  }
  // Merge adjacent faces through an edge index. Re-scanning every pair after
  // each merge made the rare runtime tessellation much slower than the trace.
  const faces = polygons.map((indices) => ({ indices, active: true })),
    edges = new Map(),
    queue = [];
  const edgeKey = (a, b) =>
    a < b ? a * points.length + b : b * points.length + a;
  function register(face) {
    const poly = face.indices;
    for (let i = 0; i < poly.length; i++) {
      const key = edgeKey(poly[i], poly[(i + 1) % poly.length]);
      let owners = edges.get(key);
      if (!owners) edges.set(key, (owners = new Set()));
      for (const other of owners) if (other !== face) queue.push([face, other]);
      owners.add(face);
    }
  }
  function unregister(face) {
    const poly = face.indices;
    for (let i = 0; i < poly.length; i++) {
      const key = edgeKey(poly[i], poly[(i + 1) % poly.length]),
        owners = edges.get(key);
      owners?.delete(face);
      if (!owners?.size) edges.delete(key);
    }
  }
  for (const face of faces) register(face);
  for (let at = 0; at < queue.length; at++) {
    const [a, b] = queue[at];
    if (!a.active || !b.active) continue;
    const pa = a.indices,
      pb = b.indices;
    for (let i = 0; i < pa.length; i++) {
      const j = pb.indexOf(pa[(i + 1) % pa.length]);
      if (j < 0 || pb[(j + 1) % pb.length] !== pa[i]) continue;
      const poly = [
        ...pa.slice(i + 1),
        ...pa.slice(0, i + 1),
        ...pb.slice(j + 2),
        ...pb.slice(0, j),
      ];
      if (
        poly.length > 32 ||
        poly.some(
          (v, k) =>
            cross(
              points[v],
              points[poly[(k + 1) % poly.length]],
              points[poly[(k + 2) % poly.length]],
            ) < -0.0001,
        )
      )
        continue;
      unregister(a);
      unregister(b);
      a.indices = poly;
      b.active = false;
      register(a);
      break;
    }
  }
  polygons.length = 0;
  for (const face of faces) if (face.active) polygons.push(face.indices);
  // Preserve every boundary sample even when a reference pose makes it collinear
  // or coincident. Otherwise a square reference silently cuts off a rounded pose.
  const ranges = [];
  let offset = 0;
  for (const loop of loops) {
    ranges.push([offset, offset + loop.length]);
    offset += loop.length;
  }
  for (let k = 0; k < polygons.length; k++) {
    const poly = polygons[k],
      complete = [];
    for (let j = 0; j < poly.length; j++) {
      const a = poly[j],
        b = poly[(j + 1) % poly.length];
      complete.push(a);
      const range = ranges.find(
        ([lo, hi]) => a >= lo && a < hi && b >= lo && b < hi,
      );
      if (!range) continue;
      const [lo, hi] = range,
        n = hi - lo,
        between = [];
      let cursor = lo + ((a - lo + 1) % n);
      while (cursor !== b) {
        between.push(cursor);
        cursor = lo + ((cursor - lo + 1) % n);
      }
      if (!between.length) continue;
      const pa = points[a],
        pb = points[b],
        dx = pb.x - pa.x,
        dy = pb.y - pa.y,
        len2 = dx * dx + dy * dy;
      if (
        between.every((i) => {
          const p = points[i],
            t = len2 ? ((p.x - pa.x) * dx + (p.y - pa.y) * dy) / len2 : 0;
          return (
            t >= -1e-7 &&
            t <= 1 + 1e-7 &&
            Math.abs(dx * (p.y - pa.y) - dy * (p.x - pa.x)) < 0.001 &&
            (len2 > 1e-8 || Math.hypot(p.x - pa.x, p.y - pa.y) < 0.001)
          );
        })
      )
        complete.push(...between);
    }
    polygons[k] = complete;
  }
  const missing = [];
  const used = new Set(polygons.flat());
  for (let i = 0; i < offset; i++) if (!used.has(i)) missing.push(i);
  return { polygons, extra, missing };
}
function prepareConvexChecks(mesh) {
  let checks = convexChecks.get(mesh);
  if (!checks) {
    const ids = [];
    for (const poly of mesh.polygons) {
      // Every cyclic cross product of a triangle is its same signed area.
      const count = poly.length === 3 ? 1 : poly.length;
      for (let i = 0; i < count; i++)
        ids.push(
          poly[i],
          poly[(i + 1) % poly.length],
          poly[(i + 2) % poly.length],
        );
    }
    checks = new Uint16Array(ids);
    convexChecks.set(mesh, checks);
  }
  return checks;
}
export function meshIsConvex(mesh, base, tolerance = 0.5) {
  const points = meshPoints(mesh, base);
  const checks = prepareConvexChecks(mesh);
  for (let i = 0; i < checks.length; i += 3) {
    const a = points[checks[i]],
      b = points[checks[i + 1]],
      c = points[checks[i + 2]];
    if (!((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) >= -tolerance))
      return false;
  }
  return true;
}
