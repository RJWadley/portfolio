// The generator fixes every part and vertex slot. Runtime only evaluates their
// coordinates: analytic contour crossings and a local convexity clamp. There is
// no font parser, tessellator, part splitting/merging, or topology selection.
export function fixedGlyphMesh(definition) {
  let size = definition.rawCount + definition.extra.length;
  const polygons = definition.groups.map((ids) => ids.map(() => size++));
  return {
    ...definition,
    polygons,
    size,
    visibleStart: definition.rawCount + definition.extra.length,
  };
}
export const meshPoints = (_mesh, points) => points;
const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function expandGlyphPoints(mesh, points, state) {
  const { rawCount, extra, groups } = mesh;
  for (let k = 0; k < extra.length; k++) {
    const e = extra[k],
      p = (points[rawCount + k] ??= { x: 0, y: 0 }),
      [ai, bi, ci, di] = e.ids,
      a = points[ai],
      b = points[bi],
      c = points[ci],
      d = points[di];
    let intersection = false;
    if (a && b && c && d) {
      const dx = b.x - a.x,
        dy = b.y - a.y,
        ex = d.x - c.x,
        ey = d.y - c.y,
        den = dx * ey - dy * ex;
      if (Math.abs(den) > 1e-10) {
        const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / den;
        p.x = a.x + dx * t;
        p.y = a.y + dy * t;
        intersection = true;
      }
    }
    if (!intersection) {
      p.x = p.y = 0;
      for (let i = 0; i < e.ids.length; i++)
        if (e.ids[i] != null) {
          p.x += points[e.ids[i]].x * e.weights[i];
          p.y += points[e.ids[i]].y * e.weights[i];
        }
    }
  }
  const keep = (state.keep ??= groups.map(
    (ids) => new Uint16Array(ids.length),
  ));
  let at = rawCount + extra.length;
  for (let k = 0; k < groups.length; k++) {
    const ids = groups[k],
      active = keep[k],
      count = ids.length;
    let convex = true;
    for (let i = 0; i < count; i++)
      if (
        turn(
          points[ids[i]],
          points[ids[(i + 1) % count]],
          points[ids[(i + 2) % count]],
        ) < -1e-10
      ) {
        convex = false;
        break;
      }
    if (convex) {
      for (let i = 0; i < count; i++) {
        const p = points[ids[i]],
          o = (points[at + i] ??= { x: 0, y: 0 });
        o.x = p.x;
        o.y = p.y;
      }
      at += count;
      continue;
    }
    for (let i = 0; i < count; i++) active[i] = i;
    let n = count,
      changed = true;
    while (changed && n > 3) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (
          turn(
            points[ids[active[(i + n - 1) % n]]],
            points[ids[active[i]]],
            points[ids[active[(i + 1) % n]]],
          ) < -1e-10
        ) {
          for (let j = i; j < n - 1; j++) active[j] = active[j + 1];
          n--;
          changed = true;
          break;
        }
      }
    }
    const inverted =
      n === 3 &&
      turn(
        points[ids[active[0]]],
        points[ids[active[1]]],
        points[ids[active[2]]],
      ) < 0;
    if (inverted) {
      // Keep a folding triangle on its longest edge. Collapsing all slots to
      // one endpoint would create a discontinuous vertex jump at zero area,
      // trapping bounded pose interpolation on the fold forever.
      let ai = active[0],
        bi = active[1],
        longest = -1;
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const a = points[ids[active[i]]],
            b = points[ids[active[j]]],
            d = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
          if (d > longest) {
            longest = d;
            ai = active[i];
            bi = active[j];
          }
        }
      const a = points[ids[ai]],
        b = points[ids[bi]],
        dx = b.x - a.x,
        dy = b.y - a.y;
      for (let i = 0; i < count; i++) {
        const p = points[ids[i]],
          o = (points[at + i] ??= { x: 0, y: 0 }),
          t =
            longest > 0
              ? Math.max(
                  0,
                  Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / longest),
                )
              : 0;
        o.x = a.x + dx * t;
        o.y = a.y + dy * t;
      }
      at += count;
      continue;
    }
    for (let segment = 0; segment < n; segment++) {
      const from = active[segment],
        to = active[(segment + 1) % n],
        a = points[ids[from]],
        b = points[ids[to]],
        dx = b.x - a.x,
        dy = b.y - a.y,
        den = dx * dx + dy * dy;
      let tPrevious = 0;
      for (let i = from; ; i = (i + 1) % count) {
        const p = points[ids[i]],
          o = (points[at + i] ??= { x: 0, y: 0 });
        const t =
          i === from
            ? 0
            : Math.max(
                tPrevious,
                Math.min(
                  1,
                  den ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / den : 0,
                ),
              );
        o.x = a.x + dx * t;
        o.y = a.y + dy * t;
        tPrevious = t;
        if ((i + 1) % count === to) break;
      }
    }
    at += count;
  }
  return points;
}
