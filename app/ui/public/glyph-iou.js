// Independent pixel oracle: rasterize the actual DOM path, or native font for
// static text. A separate native-font mask guards fidelity to the original font.
export function glyphFontUrl() {
  for (const sheet of document.styleSheets)
    for (const rule of sheet.cssRules) {
      if (
        rule.style?.fontFamily?.includes("Google Sans Flex") &&
        rule.style?.src
      )
        return new URL(
          rule.style.src.match(/url\(["']?([^"')]+)/)[1],
          sheet.href,
        ).href;
    }
  throw new Error("Google Sans Flex font source missing");
}
export async function createGlyphOracle(
  fontUrl = glyphFontUrl(),
  resolution = 4,
) {
  const bytes = await (await fetch(fontUrl)).arrayBuffer();
  const face = new FontFace("GlyphPixelOracle", bytes);
  await face.load();
  document.fonts.add(face);
  const glyph = document.createElement("canvas"),
    hull = document.createElement("canvas"),
    native = document.createElement("canvas");
  glyph.dataset.glyphOracle = hull.dataset.glyphOracle = native.dataset.glyphOracle = "";
  const g = glyph.getContext("2d", { willReadFrequently: true }),
    h = hull.getContext("2d", { willReadFrequently: true }),
    n = native.getContext("2d", { willReadFrequently: true });
  const indices = new WeakMap(
    [...document.querySelectorAll(".hero-name .char-glyph")].map(
      (el, index) => [el, index],
    ),
  );
  let lastRaster;
  function sample(l, overlay = false, measureBounds = false, includeNative = true) {
    const letterIndex = l.index ?? indices.get(l.glyph);
    const cs = getComputedStyle(l.el),
      gs = getComputedStyle(l.glyph),
      axes = l.glyph.getAttribute("data-font-axes") ?? gs.fontVariationSettings,
      path = l.glyph instanceof SVGElement ? l.glyph.querySelector("path")?.getAttribute("d") : null;
    // Read the visible glyph: its axes are local to its layout containment.
    face.variationSettings = axes;
    g.textRendering =
      {
        geometricprecision: "geometricPrecision",
        optimizelegibility: "optimizeLegibility",
        optimizespeed: "optimizeSpeed",
      }[gs.textRendering] ?? "auto";
    g.font = `${cs.fontSize} GlyphPixelOracle`;
    const metrics = g.measureText(l.el.textContent),
      size = parseFloat(cs.fontSize);
    const baseline =
      (parseFloat(cs.lineHeight) -
        metrics.fontBoundingBoxAscent -
        metrics.fontBoundingBoxDescent) /
        2 +
      metrics.fontBoundingBoxAscent;
    // Recover the drawing transform from the glyph's own screen box. Reading
    // live DOM geometry includes baseline alignment and ancestor layout movement;
    // the physics model's stored origin is deliberately not an input to the ink.
    const gw = parseFloat(gs.width),
      gh = parseFloat(gs.height);
    const combined = new DOMMatrix(cs.transform).multiply(
      new DOMMatrix(gs.transform),
    );
    const linear = new DOMMatrix([
      combined.a,
      combined.b,
      combined.c,
      combined.d,
      0,
      0,
    ]);
    const boxCorners = [
      [0, 0],
      [gw, 0],
      [gw, gh],
      [0, gh],
    ].map(([x, y]) => linear.transformPoint({ x, y }));
    const rect = l.glyph.getBoundingClientRect();
    const layoutX =
      rect.left + scrollX - Math.min(...boxCorners.map((p) => p.x));
    const layoutY =
      rect.top + scrollY - Math.min(...boxCorners.map((p) => p.y));
    const boxMatrix = new DOMMatrix([
      linear.a,
      linear.b,
      linear.c,
      linear.d,
      layoutX,
      layoutY,
    ]),
      // The inline rest strut includes trailing letter spacing. Native text's
      // advance does not; cancel that spacing when centering its reference ink.
      nativeMatrix = boxMatrix.translate(path ? (gw - metrics.width - (parseFloat(gs.letterSpacing) || 0)) / 2 : 0, baseline),
      matrix = path ? boxMatrix : nativeMatrix;
    // Bounds include the entire glyph and every part; no clipping to viewport or ink.
    const left = -metrics.actualBoundingBoxLeft - 2,
      right = metrics.actualBoundingBoxRight + 2,
      top = -metrics.actualBoundingBoxAscent - 2,
      bottom = metrics.actualBoundingBoxDescent + 2;
    const corners = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ].map(([x, y]) => nativeMatrix.transformPoint({ x, y }));
    if (path) {
      const box = l.glyph.getBBox();
      for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]])
        corners.push(matrix.transformPoint({ x, y }));
    }
    const parts = (
      l.body.parts.length > 1 ? l.body.parts.slice(1) : l.body.parts
    ).filter((p) => p.vertices.length >= 3);
    const points = [...corners, ...parts.flatMap((p) => p.vertices)];
    const x = Math.floor(Math.min(...points.map((p) => p.x))) - 2,
      y = Math.floor(Math.min(...points.map((p) => p.y))) - 2;
    const scale = resolution * devicePixelRatio,
      w = Math.ceil((Math.max(...points.map((p) => p.x)) - x + 2) * scale),
      height = Math.ceil((Math.max(...points.map((p) => p.y)) - y + 2) * scale);
    glyph.width = hull.width = w;
    glyph.height = hull.height = height;
    g.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    g.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    g.textRendering =
      {
        geometricprecision: "geometricPrecision",
        optimizelegibility: "optimizeLegibility",
        optimizespeed: "optimizeSpeed",
      }[gs.textRendering] ?? "auto";
    g.font = `${cs.fontSize} GlyphPixelOracle`;
    g.fillStyle = "#fff";
    if (path) g.fill(new Path2D(path), "nonzero");
    else g.fillText(l.el.textContent, 0, 0);
    let nativePixels;
    if (path && includeNative) {
      native.width = w; native.height = height;
      n.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      n.transform(nativeMatrix.a, nativeMatrix.b, nativeMatrix.c, nativeMatrix.d, nativeMatrix.e, nativeMatrix.f);
      n.textRendering = g.textRendering;
      n.font = `${cs.fontSize} GlyphPixelOracle`;
      n.fillStyle = "#fff";
      n.fillText(l.el.textContent, 0, 0);
      nativePixels = n.getImageData(0, 0, w, height).data;
    }
    h.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
    h.fillStyle = "#fff";
    h.beginPath();
    for (const p of parts) {
      p.vertices.forEach((v, i) =>
        i ? h.lineTo(v.x, v.y) : h.moveTo(v.x, v.y),
      );
      h.closePath();
    }
    h.fill("nonzero");
    const a = g.getImageData(0, 0, w, height),
      b = h.getImageData(0, 0, w, height);
    let intersection = 0,
      union = 0,
      ink = 0,
      body = 0,
      nativeIntersection = 0, nativeUnion = 0, fidelityIntersection = 0, fidelityUnion = 0,
      gx = 0,
      gy = 0,
      hx = 0,
      hy = 0, minInkX = Infinity, minInkY = Infinity, maxInkX = -Infinity, maxInkY = -Infinity;
    for (let i = 3; i < a.data.length; i += 4) {
      const ga = a.data[i] >= 128,
        ha = b.data[i] >= 128;
      if (nativePixels) {
        const na = nativePixels[i] >= 128;
        nativeIntersection += na && ha; nativeUnion += na || ha;
        fidelityIntersection += na && ga; fidelityUnion += na || ga;
      }
      intersection += ga && ha;
      union += ga || ha;
      ink += ga;
      body += ha;
      const px = ((i - 3) / 4) % w,
        py = Math.floor((i - 3) / 4 / w);
      if (ga) {
        gx += px;
        gy += py;
        if (measureBounds) {
          minInkX = Math.min(minInkX, px); minInkY = Math.min(minInkY, py);
          maxInkX = Math.max(maxInkX, px); maxInkY = Math.max(maxInkY, py);
        }
      }
      if (ha) {
        hx += px;
        hy += py;
      }
    }
    lastRaster = { data: a.data, w, height, x, y, scale };
    const iou = intersection / union;
    let png;
    if (overlay) {
      for (let i = 0; i < a.data.length; i += 4) {
        const ga = a.data[i + 3] >= 128,
          ha = b.data[i + 3] >= 128;
        a.data[i] = ha ? 255 : 0;
        a.data[i + 1] = ga ? 210 : 0;
        a.data[i + 2] = ga ? 255 : 0;
        a.data[i + 3] = ga || ha ? 255 : 0;
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.putImageData(a, 0, 0);
      g.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
      g.strokeStyle = "#ff395c";
      g.lineWidth = 1 / scale;
      for (const p of parts) {
        g.beginPath();
        p.vertices.forEach((v, i) =>
          i ? g.lineTo(v.x, v.y) : g.moveTo(v.x, v.y),
        );
        g.closePath();
        g.stroke();
      }
      const output = document.createElement("canvas");
      output.width = Math.max(w, 440);
      output.height = height + 64;
      const label = output.getContext("2d");
      label.fillStyle = "#101512";
      label.fillRect(0, 0, output.width, output.height);
      label.drawImage(glyph, 0, 64);
      label.font = "16px sans-serif";
      label.fillStyle = "#fff";
      label.fillText(
        `${l.el.textContent} [${letterIndex}] IoU ${(iou * 100).toFixed(2)}% · cyan ink / red hull`,
        8,
        20,
      );
      label.font = "12px monospace";
      label.fillText(axes, 8, 40);
      label.fillText(path ? cs.transform : gs.transform, 8, 56);
      png = output.toDataURL();
    }
    return {
      iou,
      nativeIoU: nativePixels ? nativeIntersection / nativeUnion : iou,
      renderFidelityIoU: nativePixels ? fidelityIntersection / fidelityUnion : 1,
      renderer: path ? "baked-font-contours" : "native-font",
      letterIndex,
      sampleAt: performance.now(),
      partCount: parts.length,
      glyphBox: {
        x: rect.left + scrollX,
        y: rect.top + scrollY,
        width: rect.width,
        height: rect.height,
      },
      ink,
      body,
      intersection,
      union,
      fontMetrics: {
        ascent: metrics.fontBoundingBoxAscent,
        descent: metrics.fontBoundingBoxDescent,
        baseline,
      },
      glyphCentroid: { x: x + (gx / ink + 0.5) / scale, y: y + (gy / ink + 0.5) / scale },
      inkBounds: measureBounds ? { left: x + minInkX / scale, top: y + minInkY / scale,
        right: x + (maxInkX + 1) / scale, bottom: y + (maxInkY + 1) / scale } : undefined,
      centroidDelta: {
        x: (gx / ink - hx / body) / scale,
        y: (gy / ink - hy / body) / scale,
      },
      scale,
      char: l.el.textContent,
      axes,
      transform: path ? cs.transform : gs.transform,
      position: { ...l.body.position },
      angle: l.body.angle,
      png,
    };
  }
  function overlap(letters) {
    const rasters = letters.map((l) => {
      sample(l);
      return lastRaster;
    });
    const scale = rasters[0]?.scale ?? 2,
      left = Math.min(...rasters.map((r) => r.x)),
      top = Math.min(...rasters.map((r) => r.y)),
      width =
        Math.ceil(Math.max(...rasters.map((r) => r.x + r.w / scale)) - left) *
        scale,
      height =
        Math.ceil(
          Math.max(...rasters.map((r) => r.y + r.height / scale)) - top,
        ) * scale;
    const coverage = new Uint8Array(width * height);
    let overlap = 0,
      union = 0;
    for (const r of rasters) {
      const dx = Math.round((r.x - left) * scale),
        dy = Math.round((r.y - top) * scale);
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.w; x++)
          if (r.data[(y * r.w + x) * 4 + 3] >= 128) {
            const i = (y + dy) * width + x + dx;
            if (coverage[i]++) overlap++;
            else union++;
          }
    }
    return {
      overlapArea: overlap / scale ** 2,
      unionArea: union / scale ** 2,
      fraction: overlap / union,
    };
  }
  return {
    sample,
    overlap,
    dispose() {
      document.fonts.delete(face);
    },
  };
}
