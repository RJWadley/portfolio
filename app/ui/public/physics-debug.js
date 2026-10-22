// Debug-only overlay. Geometry is copied at 6 Hz with backpressure; raster work
// runs in a worker. I requests a paused, DPR-independent IoU snapshot.
import { Lifetime } from "./lifetime.ts";
import { createDebugRenderer } from "./physics-debug-renderer.js";
export function physicsDebug(
  { engine, letters, ball, sign, isRunning, interaction, hullMetrics },
  signal,
) {
  const scope = new Lifetime(signal),
    Matter = window.Matter;
  const canvas = document.createElement("canvas");
  canvas.className = "physics-debug";
  canvas.setAttribute("aria-hidden", "true");
  let worker,
    drawLocal,
    busy = false,
    spareBuffer,
    on = false,
    frame = 0,
    timer = 0,
    idleDraw = 0,
    lastDraw = -Infinity,
    lastTick = 0,
    lastSteps = 0,
    steps = 0,
    rate = 0,
    mean = 0,
    rigRect,
    rigElement;
  let viewWidth = innerWidth,
    viewHeight = innerHeight,
    viewX = scrollX,
    viewY = scrollY;
  let oracle,
    snapshotPending = false,
    snapshotIndex = 0;
  if (canvas.transferControlToOffscreen && globalThis.Worker) {
    const code = `let draw;onmessage=e=>{if(e.data.canvas){draw=(${createDebugRenderer.toString()})(e.data.canvas);}else{draw(e.data);const b=e.data.geometry.buffer;postMessage(b,[b]);}};`;
    const source = URL.createObjectURL(
      new Blob([code], { type: "text/javascript" }),
    );
    worker = new Worker(source);
    URL.revokeObjectURL(source);
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage({ canvas: offscreen }, [offscreen]);
    worker.onmessage = (event) => {
      spareBuffer = event.data;
      busy = false;
    };
    scope.cleanup(() => worker.terminate());
  } else drawLocal = createDebugRenderer(canvas);
  canvas.dataset.renderer = worker ? "worker" : "fallback";
  const { requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout } = scope;
  const vertices = (p) => {
    const out = new Float32Array(p.length * 2);
    for (let i = 0; i < p.length; i++) {
      out[i * 2] = p[i].x;
      out[i * 2 + 1] = p[i].y;
    }
    return out;
  };
  const onStep = () => steps++;
  Matter.Events.on(engine, "afterUpdate", onStep);
  function toggle(force = !on) {
    on = force;
    if (on) {
      document.body.append(canvas);
      frame = requestAnimationFrame(draw);
    } else {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (idleDraw) window.cancelIdleCallback(idleDraw);
      idleDraw = 0;
      canvas.remove();
    }
  }
  async function snapshot() {
    if (isRunning() || snapshotPending) return;
    snapshotPending = true;
    snapshotIndex = 0;
    try {
      if (!oracle) {
        const { createGlyphOracle, glyphFontUrl } = await import(
          "./glyph-iou.js"
        );
        oracle = await createGlyphOracle(
          glyphFontUrl(),
          2 / (devicePixelRatio || 1),
        );
      }
      if (signal.aborted) {
        oracle.dispose();
        snapshotPending = false;
      }
    } catch (error) {
      snapshotPending = false;
      console.error(error);
    }
  }
  function draw(now) {
    frame = 0;
    // Poll at the overlay's own cadence, not at 60Hz when physics leaves no
    // idle budget. Manual snapshots alone need one sample per animation frame.
    if (snapshotPending) frame = requestAnimationFrame(draw);
    else timer = setTimeout(() => {
      if (on) frame = requestAnimationFrame(draw);
    }, worker ? 1000 / 6 : 1000 / 5);
    // Manual readback runs only while asleep. Any new interaction cancels it.
    if (snapshotPending && oracle) {
      if (isRunning()) snapshotPending = false;
      else {
        const current = letters().filter((l) => l.glyph),
          l = current[snapshotIndex++];
        if (l) {
          l.debugIoU = oracle.sample(l).iou;
          l.debugIoUKey = l.hull.pose;
          l.debugIoUPose = {
            x: l.body.position.x,
            y: l.body.position.y,
            angle: l.body.angle,
          };
        }
        if (snapshotIndex >= current.length) snapshotPending = false;
      }
    }
    if (busy || now - lastDraw < (worker ? 1000 / 6 : 1000 / 5) - 1) return;
    // Physics and native-font rendering have priority. Copy the optional hull
    // overlay only in genuine idle time, with headroom for the next frame.
    if (isRunning() && window.requestIdleCallback) {
      if (!idleDraw) idleDraw = window.requestIdleCallback((deadline) => {
        idleDraw = 0;
        if (on && !signal.aborted && deadline.timeRemaining() >= 8)
          paint(performance.now());
      });
      return;
    }
    paint(now);
  }
  function paint(now) {
    if (busy || now - lastDraw < (worker ? 1000 / 6 : 1000 / 5) - 1) return;
    lastDraw = now;
    if (now - lastTick > 500) {
      rate = Math.round(((steps - lastSteps) * 1000) / (now - lastTick));
      lastSteps = steps;
      lastTick = now;
      mean = hullMetrics?.().meanMs ?? 0;
    }
    const current = letters(),
      contacts = [],
      transfers = [];
    // One reusable transfer buffer avoids hundreds of tiny allocations and
    // structured-clone objects per overlay refresh. The worker returns it.
    const geometry = new Float32Array(spareBuffer ?? new ArrayBuffer(131072));
    spareBuffer = null;
    let cursor = 0;
    let parts = 0;
    const shapes = current.map((l) => {
      const b = l.body,
        start = cursor,
        visible = b.bounds.max.x >= viewX && b.bounds.min.x <= viewX + viewWidth &&
          b.bounds.max.y >= viewY && b.bounds.min.y <= viewY + viewHeight;
      let count = 0;
      const source = b.parts.length > 1 ? b.parts : [b];
      for (let k = b.parts.length > 1 ? 1 : 0; k < source.length; k++) {
        const ps = source[k].vertices;
        if (ps.length < 3) continue;
        parts++;
        if (!visible) continue;
        geometry[cursor++] = ps.length;
        for (let i = 0; i < ps.length; i++) {
          geometry[cursor++] = ps[i].x;
          geometry[cursor++] = ps[i].y;
        }
        count++;
      }
      if (cursor > geometry.length) throw new Error("Debug geometry buffer exceeded");
      return {
        start,
        count,
        char: l.el.textContent,
        x: b.position.x,
        y: b.position.y,
        hx: l.hx,
        hy: l.hy,
        vx: b.velocity.x,
        vy: b.velocity.y,
        speed: b.speed,
        left: b.bounds.min.x,
        top: b.bounds.min.y,
        iou:
          l.hull?.pose === l.debugIoUKey &&
          l.debugIoUPose?.x === b.position.x &&
          l.debugIoUPose?.y === b.position.y &&
          l.debugIoUPose?.angle === b.angle
            ? l.debugIoU
            : undefined,
        color: l.held
          ? "#ff8a00"
          : l.nudged
            ? "#ffb000"
            : l.stuck
              ? "#ff3355"
              : b.speed > 0.05
                ? "#00b7ff"
                : "#13a34a",
      };
    });
    for (const pair of engine.pairs.list)
      if (pair.isActive) {
        const c = pair.collision;
        for (let i = 0; i < (c.supportCount ?? c.supports.length); i++)
          contacts.push([c.supports[i].x, c.supports[i].y]);
      }
    const s = sign?.();
    let signData;
    if (s) {
      if (!rigRect || rigElement !== s.rig) {
        rigElement = s.rig;
        rigRect = s.rig.getBoundingClientRect();
      }
      signData = {
        left: rigRect.left,
        top: rigRect.top,
        anchors: s.anchors,
        ends: s.ends,
        lengths: s.lengths,
      };
    }
    const cb = ball?.(),
      ballData = cb ? vertices(cb.body.vertices) : null;
    transfers.push(geometry.buffer);
    if (ballData) transfers.push(ballData.buffer);
    const state = interaction?.(),
      data = {
        width: viewWidth,
        height: viewHeight,
        scrollX: viewX,
        scrollY: viewY,
        letters: shapes,
        geometry,
        ball: ballData,
        contacts,
        sign: signData,
        lines: [
          `letters  ${current.length} bodies / ${parts} convex parts`,
          `hulls    ${mean.toFixed(2)}ms/step · ${worker ? "worker 6Hz" : "fallback 5Hz"} idle overlay`,
          "IoU      I: paused snapshot · 2× CSS pixels",
          `contacts ${contacts.length} · ball ${(state?.distance ?? 0).toFixed(1)}px to cursor`,
          `sim      ${isRunning() ? "awake" : "asleep"} · ${rate} steps/s`,
          "green rest · blue moving · orange held · red contact",
          "D to hide · I to sample IoU while asleep",
        ],
      };
    if (worker) {
      busy = true;
      worker.postMessage(data, transfers);
    } else { drawLocal(data); spareBuffer = geometry.buffer; }
  }
  scope.listen(window, "resize", () => {
    rigRect = undefined;
    viewWidth = innerWidth;
    viewHeight = innerHeight;
  });
  scope.listen(
    window,
    "scroll",
    () => {
      viewX = scrollX;
      viewY = scrollY;
    },
    { passive: true },
  );
  scope.listen(window, "keydown", (e) => {
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      e.target.closest?.("input, textarea, [contenteditable]")
    )
      return;
    const key = e.key.toLowerCase();
    if (key === "d") toggle();
    else if (key === "i" && on) void snapshot();
  });
  scope.cleanup(() => {
    if (idleDraw) window.cancelIdleCallback(idleDraw);
    idleDraw = 0;
    canvas.remove();
    oracle?.dispose();
    Matter.Events.off(engine, "afterUpdate", onStep);
  });
  if (new URLSearchParams(location.search).has("debug")) toggle(true);
  return { toggle };
}
