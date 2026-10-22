import { Lifetime } from "./lifetime.ts";
import { typographyReady } from "./typography.ts";
// Vanilla behavior, with resources owned by the component AbortSignal.
export function mount(signal) {
  const scope = new Lifetime(signal);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let controller, state;
  const syncMotion = () => {
    controller?.abort();
    state = undefined;
    if (!reduceMotion.matches) {
      controller = new AbortController();
      state = mountAnimated(AbortSignal.any([signal, controller.signal]));
    }
  };
  scope.listen(reduceMotion, "change", syncMotion);
  syncMotion();
  return () => state?.();
}

function mountAnimated(signal) {
  const scope = new Lifetime(signal);
  const { requestAnimationFrame, setTimeout, clearTimeout } = scope;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  let signState = null; // read by the debug overlay

  /* ---------- Hanging sign: drops in on two verlet ropes ---------- */
  const rig = document.querySelector(".sign-rig");
  if (rig) {
    const sign = rig.querySelector(".sign");
    const svg = rig.querySelector(".sign-ropes");
    const NS = "http://www.w3.org/2000/svg";
    const layers = ["rope-edge", "rope-body", "rope-twist", "rope-shine"].map(
      (cls) => {
        const path = document.createElementNS(NS, "path");
        path.setAttribute("class", cls);
        svg.append(path);
        return path;
      },
    );
    const SEGMENTS = 9,
      ROPE_W = 4.2;
    // Tape-measure reels: rope never stretches; it pays out while you pull and winds back when released.
    const GRAVITY = 0.42,
      DAMPING = 0.985,
      BOUNCE = 0.6,
      REEL_ACCEL = 0.75,
      REEL_MAX = 34;
    let W,
      holeX,
      holeY,
      ropeLen,
      baseRopeLen,
      viewportHeight,
      bar,
      anchors,
      ends,
      chains,
      rest,
      lengths,
      reel = [0, 0],
      squash = 0,
      frameId = 0,
      last = 0,
      acc = 0,
      grab = null,
      quietSteps = 0,
      previous = [],
      pageScroll = 0;
    let pendingScroll = Math.max(0, scrollY);
    const lastPaths = ["", "", "", ""];
    let resizeTimer;

    const point = (x, y) => ({ x, y, ox: x, oy: y });
    function setup({ drop = false } = {}) {
      sign.style.transform = "none";
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const eye =
        parseFloat(getComputedStyle(rig).getPropertyValue("--eye")) * rem;
      W = sign.offsetWidth;
      holeX = eye + 2;
      holeY = -4;
      // The live rig sits at document top. Reels pay out to follow the viewport.
      const anchorY = 0,
        restY = 1.25 * rem + 0.35 * rem + 4;
      pageScroll = pendingScroll = Math.max(0, scrollY);
      viewportHeight = innerHeight;
      baseRopeLen = restY - anchorY;
      ropeLen = baseRopeLen + pageScroll;
      lengths = [ropeLen, ropeLen];
      reel = [0, 0];
      squash = 0;
      bar = W - holeX * 2;
      rig.style.width = `${W}px`;
      document.documentElement.style.setProperty("--sign-w", `${W}px`);
      anchors = [
        { x: holeX, y: anchorY },
        { x: W - holeX, y: anchorY },
      ];
      rest = anchors.map((a) => ({ x: a.x, y: restY + pageScroll }));
      if (drop) {
        // Start hidden above the top edge, tilted and tossed sideways.
        const top = -110;
        ends = [point(holeX + 28, top - 18), point(W - holeX + 28, top)];
        for (const e of ends) e.ox = e.x + 2.2;
      } else {
        ends = rest.map((r) => point(r.x, r.y));
      }
      chains = anchors.map((a, i) => {
        const e = ends[i],
          nodes = [];
        for (let n = 0; n <= SEGMENTS; n++) {
          const t = n / SEGMENTS;
          nodes.push(
            point(
              a.x + (e.x - a.x) * t + (drop ? Math.sin(n * 1.7) * 6 : 0),
              a.y + (e.y - a.y) * t,
            ),
          );
        }
        return nodes;
      });
      previous = [...ends, ...chains.flat()].map(() => ({ x: 0, y: 0 }));
      quietSteps = 0;
      rig.classList.add("is-live");
      signState = () => ({
        rig,
        anchors,
        ends,
        lengths,
        rest,
        ropeLen,
        reel,
        pageScroll,
        scope,
        running: frameId !== 0,
      });
      window.__portfolioSign = signState;
      render();
    }

    function followScroll() {
      const next = pendingScroll,
        dy = next - pageScroll;
      if (!dy) return;
      pageScroll = next;
      // Scrolling changes the reel target, never the solved pose or its velocity.
      // The board moves with the document until gravity or winding brings it back.
      ropeLen = baseRopeLen + pageScroll;
      for (const r of rest) r.y = ropeLen;
      // A held board follows the pointer's new document position through the grab constraint.
      if (grab) {
        grab.y += pageScroll - grab.scroll;
        grab.scroll = pageScroll;
      }
    }

    // Keep an end within its rope's reach. With `bounce`, a rope snapping taut throws it back.
    function tether(i, bounce) {
      const end = ends[i],
        a = anchors[i],
        dx = end.x - a.x,
        dy = end.y - a.y,
        d = Math.hypot(dx, dy) || 0.0001;
      if (d <= lengths[i]) return;
      const nx = dx / d,
        ny = dy / d;
      // Velocity before the rope yanks it back, so none of the impact is lost.
      let vx = end.x - end.ox,
        vy = end.y - end.oy;
      end.x = a.x + nx * lengths[i];
      end.y = a.y + ny * lengths[i];
      if (!bounce) return;
      // Compare against the rope itself, which may be winding in at reel[i] px per step.
      const outward = vx * nx + vy * ny,
        relative = outward + reel[i];
      if (relative > 0) {
        // Gentle contact (just hanging there) shouldn't jitter: only real impacts bounce.
        const e = relative > 1.5 ? BOUNCE : 0;
        const change =
          -reel[i] - Math.min(reboundLimit(), e * relative) - outward;
        vx += nx * change;
        vy += ny * change;
        if (relative > 2.5)
          squash = Math.max(squash, Math.min(0.14, relative * 0.018));
      }
      end.ox = end.x - vx;
      end.oy = end.y - vy;
    }

    // The reel stop absorbs hard impacts: a long fall or wind-in gets a small rebound.
    const reboundLimit = () =>
      Math.sqrt(2 * GRAVITY * Math.min(120, viewportHeight * 0.2));

    function stepSign() {
      let clunks = 0;
      // Reels: while held they pay out freely (and take up slack); released, they wind in, faster and faster.
      for (let i = 0; i < 2; i++) {
        const d = Math.hypot(
          ends[i].x - anchors[i].x,
          ends[i].y - anchors[i].y,
        );
        if (grab) {
          lengths[i] = Math.max(ropeLen, d);
          reel[i] = 0;
          continue;
        }
        if (lengths[i] <= ropeLen) {
          // Free payout lets the board fall. No position/history correction accompanies it.
          lengths[i] = ropeLen;
          reel[i] = 0;
        }
        if (lengths[i] > ropeLen) {
          reel[i] = Math.min(REEL_MAX, reel[i] + REEL_ACCEL);
          lengths[i] = Math.max(ropeLen, lengths[i] - reel[i]);
          if (lengths[i] === ropeLen) {
            reel[i] = 0;
            clunks |= 1 << i;
          }
        }
      }
      for (let i = 0; i < ends.length; i++) {
        const e = ends[i],
          vx = (e.x - e.ox) * DAMPING;
        let vy = (e.y - e.oy) * DAMPING;
        if (clunks & (1 << i)) vy = Math.max(vy, -reboundLimit());
        e.ox = e.x;
        e.oy = e.y;
        e.x += vx;
        e.y += vy + GRAVITY;
      }
      tether(0, true);
      tether(1, true);
      for (let k = 0; k < 6; k++) {
        const [a, b] = ends,
          dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.hypot(dx, dy) || 1,
          diff = (d - bar) / d / 2;
        a.x += dx * diff;
        a.y += dy * diff;
        b.x -= dx * diff;
        b.y -= dy * diff;
        if (grab) {
          const t = grab.t,
            gx = grab.x - (a.x + (b.x - a.x) * t),
            gy = grab.y - (a.y + (b.y - a.y) * t);
          a.x += gx * (1 - t);
          a.y += gy * (1 - t);
          b.x += gx * t;
          b.y += gy * t;
        } else {
          tether(0, false);
          tether(1, false);
        }
      }
      squash *= 0.82;
    }

    // The visible rope: a light chain pinned at both ends. Slack rope hangs; stretched rope goes taut.
    function stepChains() {
      chains.forEach((nodes, i) => {
        const a = anchors[i],
          e = ends[i];
        nodes[0].x = a.x;
        nodes[0].y = a.y;
        nodes[SEGMENTS].x = e.x;
        nodes[SEGMENTS].y = e.y;
        for (let n = 1; n < SEGMENTS; n++) {
          const p = nodes[n],
            vx = (p.x - p.ox) * 0.96,
            vy = (p.y - p.oy) * 0.96;
          p.ox = p.x;
          p.oy = p.y;
          p.x += vx;
          p.y += vy + GRAVITY;
        }
        const len = lengths[i] / SEGMENTS;
        for (let k = 0; k < 8; k++) {
          for (let n = 0; n < SEGMENTS; n++) {
            const p = nodes[n],
              q = nodes[n + 1],
              dx = q.x - p.x,
              dy = q.y - p.y,
              d = Math.hypot(dx, dy) || 0.0001;
            if (d <= len) continue;
            const pinP = n === 0,
              pinQ = n + 1 === SEGMENTS,
              diff = (d - len) / d;
            if (pinP && pinQ) continue;
            const sp = pinP ? 0 : pinQ ? 1 : 0.5,
              sq = pinQ ? 0 : pinP ? 1 : 0.5;
            p.x += dx * diff * sp;
            p.y += dy * diff * sp;
            q.x -= dx * diff * sq;
            q.y -= dy * diff * sq;
          }
        }
      });
    }

    function simulate() {
      let index = 0;
      for (const e of ends) {
        previous[index].x = e.x;
        previous[index++].y = e.y;
      }
      for (const nodes of chains)
        for (const p of nodes) {
          previous[index].x = p.x;
          previous[index++].y = p.y;
        }
      stepSign();
      stepChains();
      // Verlet's previous positions include gravity/constraint corrections even at rest.
      // Compare solved poses across steps, then require half a second of quiet.
      index = 0;
      let motion = 0;
      for (const e of ends) {
        const p = previous[index++];
        motion = Math.max(motion, Math.hypot(e.x - p.x, e.y - p.y));
      }
      for (const nodes of chains)
        for (const e of nodes) {
          const p = previous[index++];
          motion = Math.max(motion, Math.hypot(e.x - p.x, e.y - p.y));
        }
      const away =
        ends.some(
          (e, i) => Math.abs(e.x - rest[i].x) + Math.abs(e.y - rest[i].y) > 3,
        ) ||
        lengths.some((l) => l > ropeLen + 0.05) ||
        squash > 0.002;
      quietSteps = grab || motion > 0.15 || away ? 0 : quietSteps + 1;
      if (quietSteps < 30) return true;
      squash = 0;
      for (let i = 0; i < 2; i++) {
        ends[i].x = ends[i].ox = rest[i].x;
        ends[i].y = ends[i].oy = rest[i].y;
        lengths[i] = ropeLen;
        reel[i] = 0;
        for (let n = 0; n <= SEGMENTS; n++) {
          const p = chains[i][n],
            t = n / SEGMENTS;
          p.x = p.ox = anchors[i].x + (ends[i].x - anchors[i].x) * t;
          p.y = p.oy = anchors[i].y + (ends[i].y - anchors[i].y) * t;
        }
      }
      return false;
    }

    // Smooth curve through the rope nodes, sampled for the twist marks.
    function sampleRope(nodes) {
      const out = [];
      for (let i = 0; i < nodes.length - 1; i++) {
        const p0 = nodes[Math.max(0, i - 1)],
          p1 = nodes[i],
          p2 = nodes[i + 1],
          p3 = nodes[Math.min(nodes.length - 1, i + 2)];
        for (let s = 0; s < 6; s++) {
          const t = s / 6,
            t2 = t * t,
            t3 = t2 * t;
          out.push({
            x:
              0.5 *
              (2 * p1.x +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y:
              0.5 *
              (2 * p1.y +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      const end = nodes[nodes.length - 1];
      out.push({ x: end.x, y: end.y });
      return out;
    }
    function render() {
      const [a, b] = ends,
        angle = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = bar / 2;
      sign.style.transform = `translate(${a.x}px, ${a.y}px) rotate(${angle}rad) translate(${mid}px, 0) scale(${1 + squash * 0.6}, ${1 - squash}) translate(${-mid - holeX}px, ${-holeY}px)`;
      let line = "",
        twist = "",
        shine = "";
      for (const nodes of chains) {
        const pts = sampleRope(nodes);
        line +=
          "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L");
        // Diagonal strands every few pixels make it read as twisted rope.
        let travelled = 0;
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1],
            q = pts[i],
            dx = q.x - p.x,
            dy = q.y - p.y,
            d = Math.hypot(dx, dy);
          if (!d) continue;
          const tx = dx / d,
            ty = dy / d,
            nx = -ty,
            ny = tx;
          // Keep the full rope outline, but only detail strands near the viewport.
          // Work per frame stays bounded when thousands of pixels have paid out.
          let start = 0,
            stop = d;
          const top = pageScroll - 8,
            bottom = pageScroll + viewportHeight + 8;
          if (dy) {
            const u = (top - p.y) / dy,
              v = (bottom - p.y) / dy;
            start = Math.max(0, Math.min(u, v)) * d;
            stop = Math.min(1, Math.max(u, v)) * d;
          } else if (p.y < top || p.y > bottom) stop = 0;
          for (
            let s =
              (Math.floor((travelled + start) / 3.4) + 1) * 3.4 - travelled;
            s < stop;
            s += 3.4
          ) {
            const cx = p.x + tx * s,
              cy = p.y + ty * s,
              h = ROPE_W / 2;
            const sx = (nx * 0.85 + tx * 0.55) * h,
              sy = (ny * 0.85 + ty * 0.55) * h;
            twist += `M${(cx - sx).toFixed(1)},${(cy - sy).toFixed(1)}L${(cx + sx).toFixed(1)},${(cy + sy).toFixed(1)}`;
            shine += `M${(cx - sx * 0.2 + nx).toFixed(1)},${(cy - sy * 0.2 + ny).toFixed(1)}L${(cx + sx * 0.6 + nx).toFixed(1)},${(cy + sy * 0.6 + ny).toFixed(1)}`;
          }
          travelled += d;
        }
      }
      const paths = [line, line, twist, shine];
      for (let i = 0; i < layers.length; i++)
        if (paths[i] !== lastPaths[i]) {
          layers[i].setAttribute("d", paths[i]);
          lastPaths[i] = paths[i];
        }
    }
    function tick(now) {
      frameId = 0;
      followScroll();
      // Large anchor/End jumps can leave the board many screens away. Run more of the
      // same fixed physics steps offscreen, tapering back to real time within one viewport.
      const middle = (ends[0].y + ends[1].y) / 2;
      const outside = Math.max(
        pageScroll - middle - viewportHeight,
        middle - pageScroll - viewportHeight,
        0,
      );
      const rate = grab ? 1 : Math.min(6, 1 + outside / viewportHeight);
      acc += Math.min((now - (last || now - 16.7)) * rate, 100);
      last = now;
      let active = acc < 16.7;
      for (; acc >= 16.7; acc -= 16.7) active = simulate() || active;
      render();
      if (active) frameId = requestAnimationFrame(tick);
      else last = acc = 0;
    }
    const kick = () => {
      quietSteps = 0;
      if (!frameId) frameId = requestAnimationFrame(tick);
    };

    const local = (e) => {
      const r = rig.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    scope.listen(sign, "pointerdown", (e) => {
      if (!ends) return;
      e.preventDefault();
      sign.setPointerCapture(e.pointerId);
      const p = local(e),
        [a, b] = ends,
        bx = b.x - a.x,
        by = b.y - a.y;
      const t = clamp(
        ((p.x - a.x) * bx + (p.y - a.y) * by) / (bx * bx + by * by),
        0,
        1,
      );
      grab = {
        t,
        x: p.x,
        y: p.y,
        scroll: Math.max(0, scrollY),
        offX: p.x - (a.x + bx * t),
        offY: p.y - (a.y + by * t),
      };
      grab.x -= grab.offX;
      grab.y -= grab.offY;
      kick();
    });
    scope.listen(sign, "pointermove", (e) => {
      if (!ends) return;
      const p = local(e);
      if (grab) {
        grab.x = p.x - grab.offX;
        grab.y = p.y - grab.offY;
        grab.scroll = Math.max(0, scrollY);
        kick();
        return;
      }
      const end = ends[p.x < W / 2 ? 0 : 1];
      end.ox -= clamp(e.movementX, -14, 14) * 0.3;
      end.oy -= clamp(e.movementY, -14, 14) * 0.15;
      kick();
    });
    const drop = () => {
      if (grab) {
        grab = null;
        kick();
      }
    };
    scope.listen(sign, "pointerup", drop);
    scope.listen(sign, "pointercancel", drop);
    scope.listen(
      window,
      "scroll",
      () => {
        pendingScroll = Math.max(0, scrollY);
        if (!ends || pendingScroll === pageScroll) return;
        kick();
      },
      { passive: true },
    );

    // Drop in shortly after load, once the hero has started its entrance.
    const start = () => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const drop =
        scrollY < 1 &&
        !location.hash &&
        navigation?.type !== "reload" &&
        navigation?.type !== "back_forward";
      setup({ drop });
      if (drop) setTimeout(kick, 650);
      else kick();
    };
    // Native hash/reload restoration can happen after hydration. Initialize from that
    // final scroll position, rather than starting a long fall from an early layout.
    const loaded =
      document.readyState === "complete"
        ? Promise.resolve()
        : new Promise((resolve) =>
            scope.listen(window, "load", resolve, { once: true }),
          );
    Promise.all([loaded, typographyReady()]).then(
      scope.guard(() => {
        requestAnimationFrame(() => requestAnimationFrame(start));
      }),
    );
    scope.listen(document.fonts, "loadingdone", () => {
      if (ends && !grab) {
        setup();
        kick();
      }
    });
    // Mobile browser chrome changes the viewport height on nearly every scroll.
    // Only a width change can move the rig, so height-only resizes keep the
    // sign where it is and just update the visible area.
    let setupWidth = innerWidth;
    scope.listen(window, "resize", () => {
      if (!ends) return;
      viewportHeight = innerHeight;
      if (innerWidth === setupWidth) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setupWidth = innerWidth;
        setup();
        kick();
      }, 150);
    });
  }

  scope.cleanup(() => {
    rig?.classList.remove("is-live");
    rig?.style.removeProperty("width");
    rig?.querySelector(".sign")?.style.removeProperty("transform");
    rig?.querySelector(".sign-ropes")?.replaceChildren();
    document.documentElement.style.removeProperty("--sign-w");
    delete window.__portfolioSign;
  });
  return () => signState?.();
}
