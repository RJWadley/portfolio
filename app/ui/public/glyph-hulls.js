import dynamics, { dynamicsFontSize } from "./glyph-dynamics.js";
import {
  glyphOutline,
  glyphVector,
  glyphLayout,
  restPose,
  glyphKernelBackend,
  glyphDecodeMetrics,
} from "./glyph-model.js";
import topology from "./glyph-topology.js";
import {
  fixedGlyphMesh,
  expandGlyphPoints,
} from "./glyph-convex.js";
export { glyphOutline, restPose };
export { renderGlyphOutline, restoreNativeGlyph } from "./glyph-renderer.js";
export const glyphGeometryMetrics = {
  initializationMs: 0,
  pretraceMs: 0,
  backend: glyphKernelBackend,
  ...glyphDecodeMetrics,
};
const cache = new Map();
const profiling =
  globalThis.location?.search.includes("profile-hulls") ?? false;
const costs = {
  shape: 0,
  vector: 0,
  coordinate: 0,
  travel: 0,
  shapeCalls: 0,
  apply: 0,
  plans: 0,
  applies: 0,
};
if (profiling) globalThis.__glyphCosts = costs;
// Preserve the same pose precision without allocating a string for each
// intermediate frame. Most moving poses differ at the first comparison.
const samePose = (a, b) =>
  Math.round(a.width * 100) === Math.round(b.width * 100) &&
  Math.round(a.weight * 10) === Math.round(b.weight * 10) &&
  Math.round(a.grade * 10) === Math.round(b.grade * 10) &&
  Math.round(a.round * 10) === Math.round(b.round * 10) &&
  Math.round(a.slant * 100) === Math.round(b.slant * 100) &&
  Math.round(a.sx * 10000) === Math.round(b.sx * 10000) &&
  Math.round(a.sy * 10000) === Math.round(b.sy * 10000) &&
  Math.round(a.skew * 100) === Math.round(b.skew * 100);
function poseDistance(a, b) {
  return (
    Math.abs(a.width - b.width) / 126 +
    Math.abs(a.weight - b.weight) / 880 +
    Math.abs(a.round - b.round) / 100 +
    Math.abs(a.grade - b.grade) / 100 +
    Math.abs(a.slant - b.slant) / 10 +
    Math.abs(a.sx - b.sx) / 0.3 +
    Math.abs(a.sy - b.sy) / 0.4 +
    Math.abs(a.skew - b.skew) / 20
  );
}
function blendAxis(a, b, t, step, snap) {
  const value = Math.round(Math.round((a + (b - a) * t) / step) * step * 10000) / 10000;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b),
    snap && Math.abs(value - b) <= step * 1.5 ? b : value));
}
function blendPose(a, b, t, precision = 1, snap = true) {
  return {
    width: blendAxis(a.width, b.width, t, 0.1 * precision, snap),
    weight: blendAxis(a.weight, b.weight, t, 1 * precision, snap),
    grade: blendAxis(a.grade, b.grade, t, 1 * precision, snap),
    round: blendAxis(a.round, b.round, t, 1 * precision, snap),
    slant: blendAxis(a.slant, b.slant, t, 0.1 * precision, snap),
    sx: blendAxis(a.sx, b.sx, t, 0.001 * precision, snap),
    sy: blendAxis(a.sy, b.sy, t, 0.001 * precision, snap),
    skew: blendAxis(a.skew, b.skew, t, 0.1 * precision, snap),
  };
}
function shape(h, pose, avoid) {
  if (!h.work) {
    const layout = glyphLayout(h.text);
    h.work = (h.text === "i" || h.text === "l" ? [0, 1, 2] : [0, 1]).map(() => {
      const points = Array.from({ length: h.mesh.size }, () => ({ x: 0, y: 0 }));
      return {
        vector: new Float64Array(layout.size),
        points,
        advance: 0,
      };
    });
  }
  const started = profiling ? performance.now() : 0;
  let out = h.work[0];
  if (out.points === h.points || out.points === avoid) out = h.work[1];
  if (out.points === h.points || out.points === avoid) out = h.work[2];
  const v = glyphVector(h.text, pose, out.vector),
    shear = pose.sy * Math.tan((pose.skew * Math.PI) / 180),
    advance = v.at(-1),
    offset = h.centerX - (advance * h.scale) / 2;
  const positioned = profiling ? performance.now() : 0;
  if (profiling) {
    costs.vector += positioned - started;
    costs.shapeCalls++;
  }
  for (let i = 0; i < h.mesh.rawCount; i++) {
    const p = out.points[i];
    const x = v[i * 2] * h.scale + offset,
      y = v[i * 2 + 1] * h.scale + h.baseline;
    p.x = x * pose.sx + y * shear;
    p.y = y * pose.sy;
  }
  expandGlyphPoints(h.mesh, out.points, out);
  if (profiling) costs.coordinate += performance.now() - positioned;
  out.advance = advance;
  return out;
}
function travelBetween(a, b, start = 0) {
  const started = profiling ? performance.now() : 0;
  let squared = 0;
  for (let i = start; i < a.length; i++) {
    const dx = a[i].x - b[i].x,
      dy = a[i].y - b[i].y;
    squared = Math.max(squared, dx * dx + dy * dy);
  }
  if (profiling) costs.travel += performance.now() - started;
  return Math.sqrt(squared);
}

function meshFor(text) {
  if (!cache.has(text)) cache.set(text, fixedGlyphMesh(topology[text]));
  return cache.get(text);
}
export function createGlyphBody(el, rect, cs, options, M) {
  const initializedAt = performance.now();
  const text = el.textContent,
    outline = glyphOutline(text),
    scale = parseFloat(cs.fontSize) / outline.upem;
  const c = document.createElement("canvas").getContext("2d");
  c.textRendering = "geometricPrecision";
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const metrics = c.measureText(text);
  const baseline =
    rect.top +
    (parseFloat(cs.lineHeight) -
      metrics.fontBoundingBoxAscent -
      metrics.fontBoundingBoxDescent) /
      2 +
    metrics.fontBoundingBoxAscent;
  const mesh = meshFor(text),
    points = expandGlyphPoints(mesh, outline.loops.flat(), {}).map((p) => ({
      x: rect.left + p.x * scale,
      y: baseline + p.y * scale,
    }));
  const count = mesh.polygons.length,
    parts = [];
  for (let i = 0; i < count; i++) {
    const poly = mesh.polygons[i]?.map((j) => points[j]) ?? [
      { ...points[0] },
      { x: points[0].x + 0.0001, y: points[0].y },
      { x: points[0].x, y: points[0].y + 0.0001 },
    ];
    if (Math.abs(M.Vertices.area(poly)) < 0.00001)
      poly.splice(
        0,
        poly.length,
        { ...points[0] },
        { x: points[0].x + 0.01, y: points[0].y },
        { x: points[0].x, y: points[0].y + 0.01 },
      );
    const center = M.Vertices.centre(poly);
    parts.push(M.Body.create({ ...options, position: center, vertices: poly }));
  }
  const body = M.Body.create({ ...options, parts });
  // Font geometry and its partition must not retune the established springs,
  // ball response or rotational feel. Morphs preserve this rest calibration.
  const calibration = dynamics[text],
    ratio = parseFloat(cs.fontSize) / dynamicsFontSize;
  M.Body.setMass(body, calibration.mass * ratio ** 2);
  M.Body.setInertia(body, calibration.inertia * ratio ** 4);
  const h = {
    body,
    text,
    scale,
    centerX: rect.left + (outline.advance * scale) / 2 - body.position.x,
    baseline: baseline - body.position.y,
    pose: { ...restPose },
    initialized: false,
    restAdvance: outline.advance,
    mesh,
    points: [],
    changed: false,
    updates: 0,
    sx: 1,
    sy: 1,
    shear: 0,
    from: [1],
    to: [1, 1, 0],
    travel: 0,
  };
  const initial = shape(h, restPose);
  h.points = initial.points;
  h.vector = initial.vector;
  // Reuse the baked vertex and normal slots.
  h.world = Array.from({ length: h.points.length }, () => ({ x: 0, y: 0 }));
  h.intermediate = h.points.map(() => ({ x: 0, y: 0 }));
  h.tweenSource = h.points.map(p => ({ ...p }));
  h.tweenFrames = [0, 1].map(() => h.points.map(() => ({ x: 0, y: 0 })));
  h.tweenFontSource = h.vector.slice();
  h.tweenFontFrames = [h.vector.slice(), h.vector.slice()];
  h.slots = body.parts.slice(1).map((part, k) => ({
    part,
    vertices: Array.from(
      {
        length: Math.max(part.vertices.length, topology[text].groups[k].length),
      },
      (_, i) =>
        part.vertices[i] ?? {
          x: 0,
          y: 0,
          index: i,
          body: part,
          isInternal: false,
        },
    ),
    axes: Array.from(
      {
        length: Math.max(part.vertices.length, topology[text].groups[k].length),
      },
      (_, i) => part.axes[i] ?? { x: 1, y: 0 },
    ),
  }));
  h.nextSweep = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  h.satMs = 0;
  h.timeSAT = new URLSearchParams(globalThis.location?.search ?? "").has("verify") ||
    new URLSearchParams(globalThis.location?.search ?? "").has("debug");
  for (const slot of h.slots) {
    slot.active = new Uint16Array(slot.vertices.length);
    slot.clean = new Uint16Array(slot.vertices.length);
    slot.ids = Array.from({ length: slot.vertices.length }, (_, i) => i);
    slot.part.prepareGlyphCollision = () => {
      if (!slot.pending) return;
      slot.pending = false;
      const at = h.timeSAT ? performance.now() : 0, b = h.body;
      updateGlyphPart(slot, slot.ids, slot.vertices,
        Math.min(0, b.velocity.x), Math.max(0, b.velocity.x),
        Math.min(0, b.velocity.y), Math.max(0, b.velocity.y), slot.part.vertices.length);
      if (h.timeSAT) h.satMs += performance.now() - at;
    };
  }
  h.motionRadius = Math.max(
    ...h.points.slice(h.mesh.visibleStart).map((p) => Math.hypot(p.x, p.y)),
  );
  // Prepare support slots during staged initialization, before the first landing.
  planGlyphHull(h, glyphHullTarget(h, restPose), Infinity);
  applyGlyphHull(h, 1, M.Bounds);
  glyphGeometryMetrics.initializationMs += performance.now() - initializedAt;
  return { body, hull: h, size: rect.height };
}
export function glyphHullTarget(h, pose) {
  return { pose };
}
export function planGlyphHull(h, target, maxTravel, frames = 1) {
  h.eagerSAT = !Number.isFinite(maxTravel);
  h.sweepCacheValid = false;
  if (frames === 1) h.tween = null;
  if (!target) return advanceGlyphTween(h);
  const desired = target.pose;
  h.requestedPose = desired;
  h.changed = false;
  h.travel = 0;
  if (h.initialized && !h.approximate && samePose(desired, h.pose)) {
    h.tween = null;
    return false;
  }
  const at = profiling ? performance.now() : 0;
  // Predict a conservative pose fraction from the previous measured response.
  // The evaluated outline remains the authority: shrink again if needed, so the
  // prediction saves a full target evaluation without relaxing the travel bound.
  const path = poseDistance(h.pose, desired);
  const predicted = h.responseRate * path * 1.12;
  let fraction =
    Number.isFinite(maxTravel) && predicted > maxTravel
      ? maxTravel / predicted
      : 1;
  let pose = fraction === 1 ? desired : blendPose(h.pose, desired, fraction),
    next = shape(h, pose),
    travel = travelBetween(next.points, h.points, h.mesh.visibleStart);
  for (
    let attempt = 0;
    travel > maxTravel + 0.00001 && attempt < 4;
    attempt++
  ) {
    fraction = (maxTravel / travel) * 0.99;
    const shrunk = blendPose(h.pose, pose, fraction, 0.1, false);
    if (samePose(shrunk, pose)) break;
    pose = shrunk;
    next = shape(h, pose);
    travel = travelBetween(next.points, h.points, h.mesh.visibleStart);
  }
  const appliedPath = poseDistance(h.pose, pose);
  if (appliedPath > 1e-9 && (!h.approximate || travel >= 0.5 * maxTravel))
    h.responseRate = Math.max(
      (h.responseRate ?? 0) * 0.9,
      travel / appliedPath,
    );
  if (profiling) {
    costs.shape += performance.now() - at;
    costs.plans++;
  }
  h.appliedStage = 0;
  h.stages = 0;
  h.next = next;
  h.nextPose = pose;
  h.nextApproximate = false;
  h.travel = travel;
  h.changed = true;
  h.previous = h.points;
  h.from[0] = h.sx;
  h.to[0] = (next.advance / h.restAdvance) * pose.sx;
  h.to[1] = pose.sy;
  h.to[2] = pose.sy * Math.tan((pose.skew * Math.PI) / 180);
  if (frames > 1) {
    h.tweenFontSource.set(h.vector);
    for (let i = h.mesh.visibleStart; i < h.points.length; i++) {
      h.tweenSource[i].x = h.points[i].x;
      h.tweenSource[i].y = h.points[i].y;
    }
    h.tween = { from: h.pose, to: pose, points: next.points, vector: next.vector,
      travel: travel / frames,
      advanceFrom: h.lastAdvance ?? h.restAdvance, advanceTo: next.advance,
      frames, elapsed: 0 };
    return advanceGlyphTween(h);
  }
  h.lastAdvance = next.advance;
  return true;
}
// A busy name evaluates exact keyframes in staggered groups, but never holds
// the drawing. Fixed vertex correspondence advances both font pose and collision
// coordinates on every 60Hz tick. The pixel oracle checks this short chord against
// the native font, including non-affine outline changes between keyframes.
function advanceGlyphTween(h) {
  const t = h.tween;
  h.changed = false; h.travel = 0;
  if (!t || t.elapsed >= t.frames) return false;
  // Retargeting restarts elapsed; parity alone can select the current buffer
  // and erase the previous contour before travel/contact staging is measured.
  const progress = ++t.elapsed / t.frames,
    points = h.tweenFrames[h.points === h.tweenFrames[0] ? 1 : 0],
    vector = h.tweenFontFrames[h.vector === h.tweenFontFrames[0] ? 1 : 0],
    bounds = h.nextSweep, body = h.body,
    sweep = h.sweepNeeded,
    c = sweep ? Math.cos(body.angle) : 0,
    s = sweep ? Math.sin(body.angle) : 0;
  bounds.minX = bounds.minY = Infinity; bounds.maxX = bounds.maxY = -Infinity;
  if (!sweep) for (let i = h.mesh.visibleStart; i < points.length; i++) {
    const a = h.tweenSource[i], b = t.points[i], p = points[i];
    p.x = a.x + (b.x - a.x) * progress;
    p.y = a.y + (b.y - a.y) * progress;
  } else for (let i = h.mesh.visibleStart; i < points.length; i++) {
    const a = h.tweenSource[i], b = t.points[i], p = points[i];
    p.x = a.x + (b.x - a.x) * progress;
    p.y = a.y + (b.y - a.y) * progress;
    const x = body.position.x + p.x * c - p.y * s,
      y = body.position.y + p.x * s + p.y * c;
    bounds.minX = Math.min(bounds.minX, x); bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x); bounds.maxY = Math.max(bounds.maxY, y);
  }
  h.sweepCacheValid = !!h.sweepNeeded;
  // Interpolate the independent font contour without another model evaluation.
  for (let i = 0; i < vector.length; i++)
    vector[i] = h.tweenFontSource[i] + (t.vector[i] - h.tweenFontSource[i]) * progress;
  const pose = progress === 1 ? t.to : blendPose(t.from, t.to, progress, 0.1);
  let exactAdvance, stepTravel = t.travel;
  // Hairline i/l strokes have little ink area: a subpixel chord error can
  // dominate their IoU. Their tiny models are cheap to evaluate exactly while
  // thin; retain the same smooth pose and fixed part correspondence.
  if ((h.text === "i" || h.text === "l") && pose.weight < 400) {
    const exact = shape(h, pose, t.points);
    exactAdvance = exact.advance;
    vector.set(exact.vector);
    for (let i = h.mesh.visibleStart; i < points.length; i++) {
      points[i].x = exact.points[i].x; points[i].y = exact.points[i].y;
    }
    h.sweepCacheValid = false;
  }
  if (h.text === "i" || h.text === "l")
    stepTravel = travelBetween(points, h.points, h.mesh.visibleStart);
  h.nextPose = pose;
  h.nextApproximate = progress < 1 && exactAdvance == null;
  h.previous = h.points;
  h.next = { points, vector };
  // Corresponding vertices traverse equal fractions of one straight chord.
  // Its already-measured maximum distance gives exact per-tick travel.
  h.travel = stepTravel;
  h.appliedStage = h.stages = 0;
  h.from[0] = h.sx;
  h.lastAdvance = exactAdvance ?? t.advanceFrom + (t.advanceTo - t.advanceFrom) * progress;
  h.to[0] = h.lastAdvance / h.restAdvance * pose.sx;
  h.to[1] = pose.sy;
  h.to[2] = pose.sy * Math.tan(pose.skew * Math.PI / 180);
  h.changed = true;
  return true;
}
export function applyGlyphHull(h, progress, Bounds) {
  if (!h.changed) return false;
  const stages =
    h.stages ||
    Math.max(
      1,
      Math.ceil(h.travel / (h.stageTravel ?? (6 * h.scale * 2000) / 268.8)),
    );
  const stage = Math.floor(progress * stages + 1e-7);
  if (stage <= (h.appliedStage ?? 0)) return false;
  h.appliedStage = stage;
  progress = stage / stages;
  const at = profiling ? performance.now() : 0;
  if (profiling) costs.applies++;
  const b = h.body,
    bx = b.position.x,
    by = b.position.y,
    cos = Math.cos(b.angle),
    sin = Math.sin(b.angle),
    vxMin = Math.min(0, b.velocity.x),
    vxMax = Math.max(0, b.velocity.x),
    vyMin = Math.min(0, b.velocity.y),
    vyMax = Math.max(0, b.velocity.y);
  // Solver substeps interpolate corresponding boundary points. The final drawing
  // uses nextPose, including every font axis, at the final solved world position.
  const boundary =
    progress === 1
      ? h.next.points
      : h.intermediate;
  if (progress !== 1)
    // Native contour/control scratch is only needed while evaluating a pose.
    // Solver stages interpolate the fixed collision slots, not that prefix.
    for (let i = h.mesh.visibleStart; i < boundary.length; i++) {
      const p = h.previous[i],
        next = h.next.points[i];
      boundary[i].x = p.x + (next.x - p.x) * progress;
      boundary[i].y = p.y + (next.y - p.y) * progress;
    }
  const mesh = h.mesh, points = boundary;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    radius = 0;
  const world = h.world;
  if (h.eagerSAT) {
    for (let i = mesh.visibleStart; i < points.length; i++) {
      const p = points[i], w = world[i];
      w.x = bx + p.x * cos - p.y * sin; w.y = by + p.x * sin + p.y * cos;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      radius = Math.max(radius, p.x * p.x + p.y * p.y);
    }
    for (let k = 0; k < h.slots.length; k++) {
      h.slots[k].pending = false;
      updateGlyphPart(h.slots[k], mesh.polygons[k], world, vxMin, vxMax, vyMin, vyMax);
    }
  } else for (let k = 0; k < h.slots.length; k++) {
    const slot = h.slots[k];
    updateGlyphPartBounds(slot, mesh.polygons[k], points, bx, by, cos, sin, vxMin, vxMax, vyMin, vyMax);
    minX = Math.min(minX, slot.minX); minY = Math.min(minY, slot.minY);
    maxX = Math.max(maxX, slot.maxX); maxY = Math.max(maxY, slot.maxY);
    radius = Math.max(radius, slot.radius);
  }
  // The parent's envelope is broadphase only. Actual collisions use the parts.
  if (b.vertices.length !== 4)
    b.vertices = Array.from({ length: 4 }, (_, index) => ({
      x: 0,
      y: 0,
      index,
      body: b,
      isInternal: false,
    }));
  const v = b.vertices;
  v[0].x = bx + minX * cos - minY * sin;
  v[0].y = by + minX * sin + minY * cos;
  v[1].x = bx + maxX * cos - minY * sin;
  v[1].y = by + maxX * sin + minY * cos;
  v[2].x = bx + maxX * cos - maxY * sin;
  v[2].y = by + maxX * sin + maxY * cos;
  v[3].x = bx + minX * cos - maxY * sin;
  v[3].y = by + minX * sin + maxY * cos;
  Bounds.update(b.bounds, b.vertices, b.velocity);
  h.motionRadius = Math.sqrt(radius);
  h.points = boundary;
  h.sx = h.to[0];
  h.sy = h.to[1];
  h.shear = h.to[2];
  h.updates++;
  if (progress === 1) {
    h.vector = h.next.vector;
    h.pose = h.nextPose;
    h.approximate = h.nextApproximate;
    h.initialized = true;
  }
  if (profiling) costs.apply += performance.now() - at;
  return true;
}

// Keep the per-face kernel small and shared: it warms once for all the baked
// parts, rather than repeatedly optimizing a large whole-body morph routine.
function updateGlyphPart(slot, indices, world, vxMin, vxMax, vyMin, vyMax, sourceCount = indices?.length ?? 0) {
  const { part, vertices, axes } = slot;
    if (!indices) {
      if (part.vertices.length) {
        part.vertices.length = 0;
        part.axes.length = 0;
        part.bounds.min.x = part.bounds.min.y = Infinity;
        part.bounds.max.x = part.bounds.max.y = -Infinity;
      }
      return;
    }
    let clean = indices,
      n = sourceCount,
      redundant = false;
    for (let i = 0; i < n; i++) {
      const a = world[indices[(i + n - 1) % n]],
        b = world[indices[i]],
        c = world[indices[(i + 1) % n]];
      if (
        Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) <= 1e-7
      ) {
        redundant = true;
        break;
      }
    }
    if (redundant) {
      const active = (slot.active ??= new Uint16Array(indices.length)),
        compact = (slot.clean ??= new Uint16Array(indices.length));
      let count = 0;
      for (let j = 0; j < n; j++) {
        const id = indices[j], p = world[id],
          previous = count ? world[active[count - 1]] : null;
        if (
          !previous ||
          Math.abs(p.x - previous.x) + Math.abs(p.y - previous.y) > 1e-8
        )
          active[count++] = id;
      }
      if (count > 1) {
        const a = world[active[0]],
          b = world[active[count - 1]];
        if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 1e-8) count--;
      }
      n = count;
      for (let i = 0; i < n; i++) compact[i] = active[i];
      let again = true;
      while (again && n > 3) {
        again = false;
        for (let i = 0; i < n; i++) {
          const a = world[compact[(i + n - 1) % n]],
            b = world[compact[i]],
            c = world[compact[(i + 1) % n]];
          if (
            Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) <=
            1e-7
          ) {
            for (let j = i; j < n - 1; j++) compact[j] = compact[j + 1];
            n--;
            again = true;
            break;
          }
        }
      }
      clean = compact;
    }
    // Fixed source slots include vertices projected onto straight edges. Giving
    // SAT repeated/collinear supports makes a wide contact look like one point,
    // causing torque and jams. Remove only geometrically redundant vertices;
    // every convex face and its source topology remains unchanged.
    if (n < 3) {
      part.vertices.length = part.axes.length = 0;
      part.bounds.min.x = part.bounds.min.y = Infinity;
      part.bounds.max.x = part.bounds.max.y = -Infinity;
      return;
    }
    while (vertices.length < n) {
      const i = vertices.length;
      vertices.push({ x: 0, y: 0, index: i, body: part, isInternal: false });
      axes.push({ x: 1, y: 0 });
    }
    if (part.vertices.length !== n) {
      part.vertices.length = n;
      for (let i = 0; i < n; i++) part.vertices[i] = vertices[i];
    }
    const previousAxes = part.axes.length;
    let cx = 0,
      cy = 0,
      area = 0,
      bminX = Infinity,
      bminY = Infinity,
      bmaxX = -Infinity,
      bmaxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = world[clean[i]],
        v = vertices[i];
      v.x = p.x;
      v.y = p.y;
      cx += v.x;
      cy += v.y;
      bminX = Math.min(bminX, v.x);
      bmaxX = Math.max(bmaxX, v.x);
      bminY = Math.min(bminY, v.y);
      bmaxY = Math.max(bmaxY, v.y);
    }
    let axisCount = 0;
    for (let i = 0; i < n; i++) {
      const a = part.vertices[i],
        c = part.vertices[(i + 1) % n],
        dx = c.x - a.x,
        dy = c.y - a.y,
        len = Math.sqrt(dx * dx + dy * dy) || 1;
      if (Math.abs(dx) + Math.abs(dy) > 1e-8) {
        const nx = dy / len,
          ny = -dx / len;
        // Collinear clamped vertices retain fixed slots, but add no SAT axis.
        let duplicate = false;
        for (let j = 0; j < axisCount; j++)
          if (Math.abs(axes[j].x * nx + axes[j].y * ny) > 1 - 1e-10) {
            duplicate = true;
            break;
          }
        if (!duplicate) {
          axes[axisCount].x = nx;
          axes[axisCount].y = ny;
          axisCount++;
        }
      }
      area += a.x * c.y - c.x * a.y;
    }
    // A collapsed face has no ink area but SAT can still treat its line as a
    // barrier. Disable it like an unused slot until a later pose gives it area.
    if (Math.abs(area / 2) <= 0.000001) {
      part.vertices.length = part.axes.length = 0;
      part.bounds.min.x = part.bounds.min.y = Infinity;
      part.bounds.max.x = part.bounds.max.y = -Infinity;
      return;
    }
    if (previousAxes !== (axisCount || 1)) {
      part.axes.length = axisCount || 1;
      for (let i = 0; i < part.axes.length; i++) part.axes[i] = axes[i];
    }
    if (!axisCount) {
      axes[0].x = 1;
      axes[0].y = 0;
      part.axes[0] = axes[0];
    }
    part.position.x = cx / n;
    part.position.y = cy / n;
    part.area = Math.max(0.00000001, Math.abs(area / 2));
    part.density = part.mass / part.area;
    part.bounds.min.x = bminX + vxMin;
    part.bounds.min.y = bminY + vyMin;
    part.bounds.max.x = bmaxX + vxMax;
    part.bounds.max.y = bmaxY + vyMax;
}

// Broadphase needs only current vertices/bounds. SAT support cleanup and normals
// are deferred until this exact face is a collision candidate. The detector
// prepares it before any axis test; its cost is charged to the same hull step.
function updateGlyphPartBounds(slot, indices, points, bx, by, cos, sin, vxMin, vxMax, vyMin, vyMax) {
  const { part, vertices } = slot, n = indices?.length ?? 0;
  slot.minX = slot.minY = Infinity; slot.maxX = slot.maxY = -Infinity; slot.radius = 0;
  if (!n) { part.vertices.length = part.axes.length = 0; return; }
  if (part.vertices.length !== n) {
    part.vertices.length = n;
    for (let i = 0; i < n; i++) part.vertices[i] = vertices[i];
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity,
    localMinX = Infinity, localMinY = Infinity, localMaxX = -Infinity, localMaxY = -Infinity,
    radius = 0, cx = 0, cy = 0, area = 0;
  for (let i = 0; i < n; i++) {
    const p = points[indices[i]], q = points[indices[(i + 1) % n]], v = vertices[i];
    v.x = bx + p.x * cos - p.y * sin; v.y = by + p.x * sin + p.y * cos;
    cx += v.x; cy += v.y;
    area += p.x * q.y - q.x * p.y;
    minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
    localMinX = Math.min(localMinX, p.x); localMinY = Math.min(localMinY, p.y);
    localMaxX = Math.max(localMaxX, p.x); localMaxY = Math.max(localMaxY, p.y);
    radius = Math.max(radius, p.x * p.x + p.y * p.y);
  }
  slot.minX = localMinX; slot.minY = localMinY;
  slot.maxX = localMaxX; slot.maxY = localMaxY; slot.radius = radius;
  if (Math.abs(area / 2) <= 0.000001) {
    part.vertices.length = part.axes.length = 0;
    part.bounds.min.x = part.bounds.min.y = Infinity;
    part.bounds.max.x = part.bounds.max.y = -Infinity;
    slot.pending = false;
    return;
  }
  part.position.x = cx / n; part.position.y = cy / n;
  part.area = Math.abs(area / 2); part.density = part.mass / part.area;
  part.bounds.min.x = minX + vxMin; part.bounds.min.y = minY + vyMin;
  part.bounds.max.x = maxX + vxMax; part.bounds.max.y = maxY + vyMax;
  slot.pending = true;
}
