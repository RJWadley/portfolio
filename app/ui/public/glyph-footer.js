import glyphs from "./glyph-footer-data.js";
// Same legacy rest collision polygons, baked once offline. No canvas readback or
// poly-decomp work during page startup/remount. Metrics only position the glyph.
export function createFooterBody(el, rect, cs, options, M) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const metrics = ctx.measureText(el.textContent),
    scale = parseFloat(cs.fontSize) / 200;
  const baseline =
    rect.top +
    ((parseFloat(cs.lineHeight) || rect.height) -
      metrics.fontBoundingBoxAscent -
      metrics.fontBoundingBoxDescent) /
      2 +
    metrics.fontBoundingBoxAscent;
  const parts = glyphs[el.textContent].map((poly) => {
    const vertices = poly.map(([x, y]) => ({
      x: rect.left + x * scale,
      y: baseline + y * scale,
    }));
    return M.Body.create({
      ...options,
      vertices,
      position: M.Vertices.centre(vertices),
    });
  });
  return {
    body: parts.length === 1 ? parts[0] : M.Body.create({ ...options, parts }),
    size: rect.height,
  };
}
