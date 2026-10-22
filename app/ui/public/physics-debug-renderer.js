// Self-contained so the same renderer can run in a dedicated debug-only worker.
export function createDebugRenderer(canvas) {
  // The diagnostic layer must not make the native-font compositor wait for a
  // worker canvas commit. Browsers without low-latency 2D ignore this hint.
  const ctx = canvas.getContext("2d", { desynchronized: true });
  const path = (vertices) => {
    ctx.beginPath();
    for (let i = 0; i < vertices.length; i += 2) {
      if (i) ctx.lineTo(vertices[i], vertices[i + 1]);
      else ctx.moveTo(vertices[i], vertices[i + 1]);
    }
    ctx.closePath();
  };
  return (data) => {
    if (canvas.width !== data.width || canvas.height !== data.height) {
      canvas.width = data.width;
      canvas.height = data.height;
    }
    ctx.clearRect(0, 0, data.width, data.height);
    ctx.save();
    ctx.translate(-data.scrollX, -data.scrollY);
    for (const l of data.letters) {
      ctx.beginPath();
      let cursor = l.start;
      for (let part = 0; part < l.count; part++) {
        const n = data.geometry[cursor++];
        for (let i = 0; i < n; i++) {
          const x = data.geometry[cursor++], y = data.geometry[cursor++];
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = l.color + "18";
      ctx.fill();
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = "#9b5cff";
      ctx.beginPath();
      ctx.moveTo(l.hx - 4, l.hy);
      ctx.lineTo(l.hx + 4, l.hy);
      ctx.moveTo(l.hx, l.hy - 4);
      ctx.lineTo(l.hx, l.hy + 4);
      if (Math.hypot(l.x - l.hx, l.y - l.hy) > 1) {
        ctx.moveTo(l.hx, l.hy);
        ctx.lineTo(l.x, l.y);
      }
      ctx.stroke();
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.arc(l.x, l.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (l.speed > 0.05) {
        ctx.strokeStyle = "#ff00aa";
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.lineTo(l.x + l.vx * 6, l.y + l.vy * 6);
        ctx.stroke();
      }
      if (l.iou !== undefined) {
        ctx.font = "12px monospace";
        ctx.fillStyle = l.iou >= 0.95 ? "#065f27" : "#c01835";
        ctx.fillText(
          `${l.char} IoU ${(l.iou * 100).toFixed(1)}% (snapshot)`,
          l.left,
          l.top - 8,
        );
      }
    }
    if (data.ball) {
      path(data.ball);
      ctx.fillStyle = "#c8f53caa";
      ctx.fill();
      ctx.strokeStyle = "#111";
      ctx.stroke();
    }
    ctx.fillStyle = "#ff3355";
    for (const p of data.contacts) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    if (data.sign) {
      const s = data.sign;
      ctx.save();
      ctx.translate(s.left, s.top);
      ctx.strokeStyle = "#ff8a00";
      ctx.setLineDash([3, 3]);
      for (let i = 0; i < s.anchors.length; i++) {
        const a = s.anchors[i],
          e = s.ends[i];
        ctx.beginPath();
        ctx.arc(a.x, a.y, s.lengths[i], 0, Math.PI * 2);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      }
      ctx.restore();
    }
    const lines = data.lines,
      boxH = lines.length * 16 + 16,
      bx = 12,
      by = data.height - boxH - 12;
    ctx.fillStyle = "rgba(17,19,17,.9)";
    ctx.fillRect(bx, by, Math.min(data.width - 24, 550), boxH);
    ctx.font = "11px monospace";
    ctx.fillStyle = "#c8f53c";
    for (let i = 0; i < lines.length; i++)
      ctx.fillText(lines[i], bx + 10, by + 20 + i * 16);
  };
}
