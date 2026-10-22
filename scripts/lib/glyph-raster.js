// Traces a rendered letter into collision polygons: draw it to a canvas, find each solid
// piece (the "i" has two), walk its outline, and simplify. Holes don't matter for collisions,
// so only outer outlines are kept. Works with whatever font is actually rendering.

const RASTER_SIZE = 200; // trace at this font size, then scale to the real one
let canvas, ctx;
const contours = new Map();

/** Polygons (arrays of {x, y}) in viewport coordinates for a single-character element. */
export function glyphPolygons(el, rect = el.getBoundingClientRect(), cs = getComputedStyle(el)) {
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const fontSize = parseFloat(cs.fontSize);
  const scale = fontSize / RASTER_SIZE;
  const font = (size) =>
    `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;

  // Where the baseline sits inside the element: half-leading plus the font's ascent.
  ctx.font = font(fontSize);
  const metrics = ctx.measureText(el.textContent);
  const lineHeight = parseFloat(cs.lineHeight) || rect.height;
  const baseline =
    rect.top +
    (lineHeight -
      (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) /
      2 +
    metrics.fontBoundingBoxAscent;

  // The trace is normalized to 200px, independent of element position and font size.
  // Translate fresh points for Matter, which mutates its vertices during decomposition.
  const key = `${el.textContent}|${font(RASTER_SIZE)}|${cs.fontVariationSettings}`;
  let polygons = contours.get(key);
  if (!polygons) {
    const pad = Math.ceil(RASTER_SIZE * 0.3);
    const w = Math.ceil(RASTER_SIZE * 1.4) + pad * 2,
      h = Math.ceil(RASTER_SIZE * 1.5) + pad * 2;
    const originY = pad + RASTER_SIZE * 1.1;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.font = font(RASTER_SIZE);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000";
    ctx.fillText(el.textContent, pad, originY);

    const alpha = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++)
      mask[i] = alpha[i * 4 + 3] > 110 ? 1 : 0;

    polygons = components(mask, w, h, RASTER_SIZE * RASTER_SIZE * 0.0006)
      .map((c) => simplify(trace(c, w, h), RASTER_SIZE * 0.012).map(p => ({ x: p.x - pad, y: p.y - originY })))
      .filter((poly) => poly.length >= 3);
    contours.set(key, polygons);
  }
  return polygons.map(poly => poly.map(p => ({ x: rect.left + p.x * scale, y: baseline + p.y * scale })));
}

/** Area-weighted centroid of several polygons, i.e. where a physics engine will put the body. */
export function centroid(polygons) {
  let area = 0,
    cx = 0,
    cy = 0;
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length],
        cross = a.x * b.y - b.x * a.y;
      area += cross;
      cx += (a.x + b.x) * cross;
      cy += (a.y + b.y) * cross;
    }
  }
  return area ? { x: cx / (3 * area), y: cy / (3 * area) } : polygons[0][0];
}

// Separate the mask into solid pieces, dropping specks.
function components(mask, w, h, minPixels) {
  const label = new Int32Array(w * h),
    out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = out.length + 1,
      piece = new Uint8Array(w * h),
      stack = [start];
    let count = 0;
    label[start] = id;
    while (stack.length) {
      const i = stack.pop(),
        x = i % w;
      piece[i] = 1;
      count++;
      for (const n of [
        x > 0 ? i - 1 : -1,
        x < w - 1 ? i + 1 : -1,
        i - w,
        i + w,
      ]) {
        if (n >= 0 && n < mask.length && mask[n] && !label[n]) {
          label[n] = id;
          stack.push(n);
        }
      }
    }
    if (count >= minPixels) out.push(piece);
  }
  return out;
}

// Marching squares around the outside of one piece, returning pixel-corner points.
function trace(piece, w, h) {
  const at = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h ? piece[y * w + x] : 0;
  let first = piece.indexOf(1);
  const sx = first % w,
    sy = (first - sx) / w;
  const points = [];
  let x = sx,
    y = sy,
    dx = 0,
    dy = 0,
    prevDx = 0,
    prevDy = 0;
  const limit = w * h * 2;
  do {
    const state =
      at(x - 1, y - 1) |
      (at(x, y - 1) << 1) |
      (at(x - 1, y) << 2) |
      (at(x, y) << 3);
    switch (state) {
      case 1:
      case 5:
      case 13:
        dx = 0;
        dy = -1;
        break; // up
      case 8:
      case 10:
      case 11:
        dx = 0;
        dy = 1;
        break; // down
      case 4:
      case 12:
      case 14:
        dx = -1;
        dy = 0;
        break; // left
      case 2:
      case 3:
      case 7:
        dx = 1;
        dy = 0;
        break; // right
      case 6:
        if (prevDx === 0 && prevDy === -1) {
          dx = -1;
          dy = 0;
        } else {
          dx = 1;
          dy = 0;
        }
        break;
      case 9:
        if (prevDx === 1 && prevDy === 0) {
          dx = 0;
          dy = -1;
        } else {
          dx = 0;
          dy = 1;
        }
        break;
      default:
        return points; // shouldn't happen on a boundary
    }
    if (dx !== prevDx || dy !== prevDy) points.push({ x, y }); // only keep corners
    x += dx;
    y += dy;
    prevDx = dx;
    prevDy = dy;
  } while ((x !== sx || y !== sy) && points.length < limit);
  return points;
}

// Douglas–Peucker for a closed loop: split at the two farthest-apart points, simplify each half.
function simplify(points, epsilon) {
  if (points.length < 4) return points;
  let far = 0,
    best = 0;
  for (let i = 1; i < points.length; i++) {
    const d =
      (points[i].x - points[0].x) ** 2 + (points[i].y - points[0].y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dp(points.slice(0, far + 1), epsilon),
    b = dp(points.slice(far).concat([points[0]]), epsilon);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function dp(points, epsilon) {
  if (points.length < 3) return points;
  const a = points[0],
    b = points[points.length - 1],
    len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let index = 0,
    max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d =
      Math.abs(
        (b.x - a.x) * (a.y - points[i].y) - (a.x - points[i].x) * (b.y - a.y),
      ) / len;
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [a, b];
  return dp(points.slice(0, index + 1), epsilon)
    .slice(0, -1)
    .concat(dp(points.slice(index), epsilon));
}
