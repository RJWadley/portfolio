import { glyphLayout } from "./glyph-model.js";
const pair = (x, y, scale, offset, baseline) =>
  Math.round((x * scale + offset) * 1000) / 1000 + " " +
  Math.round((y * scale + baseline) * 1000) / 1000;

export function restoreNativeGlyph(l) {
  if (!l.nativeGlyph) return;
  l.glyph.replaceWith(l.nativeGlyph);
  l.glyph = l.nativeGlyph;
  l.nativeGlyph = l.vectorPath = null;
  l.renderedPose = null;
}
export function renderGlyphOutline(l) {
  if (!l.vectorPath) {
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg"),
      desc = document.createElementNS(ns, "desc"),
      path = document.createElementNS(ns, "path");
    desc.textContent = l.el.textContent;
    svg.append(desc, path);
    svg.classList.add("char-glyph");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = `left:0;translate:none;overflow:visible;fill:currentColor;width:${l.el.style.width};height:${l.size}px;transform-origin:${l.glyphOrigin}`;
    l.nativeGlyph = l.glyph;
    l.glyph.replaceWith(svg);
    l.glyph = svg;
    l.vectorPath = path;
    l.vectorLayout = glyphLayout(l.el.textContent);
    l.vectorOrigin = l.origin.split(" ").map(parseFloat);
  }
  // Font contours stay independent of the convex collision faces.
  const h = l.hull, v = h.vector,
    offset = h.centerX - v.at(-1) * h.scale / 2 + l.vectorOrigin[0],
    baseline = h.baseline + l.vectorOrigin[1];
  let d = "";
  for (const { start, commands } of l.vectorLayout.contours) {
    d += "M" + pair(v[start], v[start + 1], h.scale, offset, baseline);
    for (const [to, mid, from] of commands) {
      // A quadratic's midpoint recovers its original control exactly. Reuse
      // baked samples instead of shipping another copy of the font curves.
      if (mid >= 0) d += "Q" + pair(2 * v[mid] - (v[from] + v[to]) / 2,
        2 * v[mid + 1] - (v[from + 1] + v[to + 1]) / 2, h.scale, offset, baseline) + " ";
      else d += "L";
      d += pair(v[to], v[to + 1], h.scale, offset, baseline);
    }
    d += "Z";
  }
  if (d !== l.vectorKey) {
    l.vectorPath.setAttribute("d", d);
    l.vectorKey = d;
  }
}
