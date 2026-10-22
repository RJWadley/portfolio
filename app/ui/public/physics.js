import { cacheSeparatingAxes, indexCompoundBounds } from "./matter-coherence.js";
import { createFooterBody } from "./glyph-footer.js";
import { Lifetime } from "./lifetime.ts";
import { typographyReady } from "./typography.ts";

// One shared world: a spring-driven mouse ball, touch grabs, and immediate bursts.
export function mountPhysics(signal) {
  const scope = new Lifetime(signal);
  let createGlyphBody, glyphHullTarget, planGlyphHull, applyGlyphHull;
  let renderGlyphOutline, restoreNativeGlyph;
  let glyphGeometryMetrics = { initializationMs: 0, pretraceMs: 0 };
  const {
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  } = scope;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(pointer: fine)");
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const Matter = window.Matter;
  if (Matter) {
    cacheSeparatingAxes(Matter, signal);
    indexCompoundBounds(Matter, signal);
  }
  const originals = [...document.querySelectorAll("[data-spring]")].map(
    (el) => [el, el.innerHTML],
  );
  scope.cleanup(() => {
    for (const [el, html] of originals) {
      el.innerHTML = html;
      el.removeAttribute("data-font-ready");
    }
  });
  /* ---------- Split letters ---------- */
  function split(root, startIndex = 0) {
    let i = startIndex;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      for (const ch of node.textContent) {
        if (ch === " ") {
          frag.append(" ");
          continue;
        }
        const outer = document.createElement("span");
        outer.className = "char-in";
        outer.style.setProperty("--i", i++);
        outer.setAttribute("aria-hidden", "true");
        const inner = document.createElement("span");
        inner.className = "char";
        if (root.closest(".hero-name") && ch !== ".") {
          inner.dataset.glyph = ch;
          const glyph = document.createElement("span");
          glyph.className = "char-glyph";
          glyph.textContent = ch;
          inner.append(glyph);
        } else inner.textContent = ch;
        outer.append(inner);
        frag.append(outer);
      }
      node.replaceWith(frag);
    }
    return i;
  }
  let chars = [];
  function prepareLetters() {
    if (chars.length) return;
    let letterIndex = 0;
    for (const [el] of originals) {
      letterIndex = split(el, el.closest(".hero") ? letterIndex : 0);
      el.setAttribute("data-font-ready", "");
    }
    chars = [...document.querySelectorAll(".char")];
    // Keep the rest layout hidden until the first above-page pose is measured/rendered.
    if (engine && !reduceMotion.matches)
      for (const el of chars)
        if (el.closest(".hero-name")) el.style.visibility = "hidden";
  }
  const contactLink = document.querySelector(".contact-big a");
  if (contactLink)
    contactLink.setAttribute("aria-label", "Say hi — email Robbie");

  /* ---------- Physics letters (Matter.js) ---------- */
  // Each letter is a rigid body sprung to its home position, so letters knock into each other but always return.
  const {
    Engine,
    Bodies,
    Body,
    Composite,
    Common,
    Vertices,
    Bounds,
    Constraint,
    Collision,
    Pair,
    Resolver,
  } = window.Matter || {};
  if (window.decomp) Common?.setDecomp(window.decomp);
  const pointer = { x: -1e4, y: -1e4 };
  const touchPointer = { x: 0, y: 0 };
  const engine = Engine?.create({
    gravity: { x: 0, y: 0 },
    positionIterations: 20,
    velocityIterations: 12,
  });
  let letters = [],
    floor = null,
    held = null,
    grab = null,
    frame = 0;
  // Read viewport state once, before a frame's style writes and all its solver substeps.
  const viewport = { x: 0, y: 0, width: 0, height: 0 };
  let viewportDirty = true;
  function readViewport() {
    if (!viewportDirty) return;
    viewportDirty = false;
    viewport.x = scrollX;
    viewport.y = scrollY;
    viewport.width = innerWidth;
    viewport.height = innerHeight;
  }
  readViewport();
  let fontsReady = false,
    measurePending = false,
    translationPending = false,
    measuredFloorY = null,
    layoutKey = "",
    entered = false;
  let measuredWithFont = false;
  // slop: how much touching letters may overlap before the solver pushes back. Matter's default
  // suits small objects; sized for ~250px letters, it stops squeezed letters from buzzing.
  const BODY_OPTIONS = {
    frictionAir: 0.09,
    friction: 0.05,
    restitution: 0.15,
    density: 0.002,
    slop: 0.5,
  };
  const HERO_CATEGORY = 0x0002,
    FLOOR_CATEGORY = 0x0004;
  // The existing burst tuning was set with the 21vw hero at 1280px.
  const HERO_REFERENCE_FONT_SIZE = 268.8;
  let heroFontSize = HERO_REFERENCE_FONT_SIZE,
    typeScale = 1;
  let ballWidth = 36,
    ballHeight = 36,
    ballRadius = 12;

  function ballShape(x, y) {
    return Bodies.rectangle(x, y, ballWidth, ballHeight, {
      chamfer: { radius: ballRadius },
      density: BALL_DENSITY,
      frictionAir: 0,
      friction: 0,
      restitution: 0,
      slop: 0.5,
    });
  }
  function sizeBall() {
    if (ballEl) {
      ballEl.style.setProperty("--cursor-width", `${ballWidth}px`);
      ballEl.style.setProperty("--cursor-height", `${ballHeight}px`);
      ballEl.style.setProperty("--cursor-radius", `${ballRadius}px`);
    }
    if (ball) {
      // Change its geometry in place: a resize must retain identity, pose and momentum.
      Body.setVertices(
        ball,
        ballShape(ball.position.x, ball.position.y).vertices,
      );
      Body.setInertia(ball, Infinity);
    }
  }
  const MAX_DRAG_SPEED = 28,
    LETTER_SPRING = 0.018,
    LETTER_ANGLE_SPRING = 0.012,
    LETTER_ANGLE_DAMPING = 0.06,
    GRAB_STIFFNESS = 0.2,
    GRAB_DAMPING = 0.1;
  const NUDGE = 0.8; // maximum sideways acceleration (px/frame²), tuned at the reference font
  const ENTRANCE_SETTLE_FRAMES = 90; // then normal unblocking can help a crowded entrance
  const NUDGE_FRAMES = 90; // ramps up then back down over this many frames
  const NUDGE_CLEARANCE_SCALE = 1 / 55;

  // A body shaped like the glyph itself: traced outline, split into convex pieces.
  function letterBody(el, rect, cs) {
    if (el.querySelector(".char-glyph"))
      return createGlyphBody(
        el,
        {
          ...rect.toJSON(),
          left: rect.left + viewport.x,
          top: rect.top + viewport.y,
        },
        cs,
        BODY_OPTIONS,
        Matter,
      );
    const worldRect = {
      left: rect.left + viewport.x,
      top: rect.top + viewport.y,
      height: rect.height,
    };
    if (!el.closest(".dot"))
      return createFooterBody(el, worldRect, cs, BODY_OPTIONS, Matter);
    return {
      body: Bodies.rectangle(
        worldRect.left + rect.width / 2,
        worldRect.top + rect.height / 2,
        rect.width,
        rect.height,
        BODY_OPTIONS,
      ),
      size: rect.height,
    };
  }

  const letterOf = new Map(); // body → letter, for finding what's blocking a stuck letter
  const hullContactPairs = new Set();
  const hullPairsByBody = new Map();
  function clearHullPairs() {
    hullContactPairs.clear();
    hullPairsByBody.clear();
  }

  if (engine) {
    Matter.Events.on(engine, "collisionStart", (event) => {
      for (const pair of event.pairs)
        if (
          letterOf.get(pair.collision.parentA)?.hull ||
          letterOf.get(pair.collision.parentB)?.hull
        ) {
          hullContactPairs.add(pair);
          for (const body of [pair.collision.parentA, pair.collision.parentB])
            if (letterOf.get(body)?.hull) {
              let pairs = hullPairsByBody.get(body);
              if (!pairs) hullPairsByBody.set(body, (pairs = new Set()));
              pairs.add(pair);
            }

          // A reactivated slot may now describe a different convex face. Impulses
          // cached for that slot's old vertices cannot warm the new contact.
          for (const contact of pair.contacts)
            contact.normalImpulse = contact.tangentImpulse = 0;
        }
    });
    Matter.Events.on(engine, "collisionEnd", (event) => {
      for (const pair of event.pairs) {
        hullContactPairs.delete(pair);
        for (const body of [pair.collision.parentA, pair.collision.parentB]) {
          const pairs = hullPairsByBody.get(body);
          pairs?.delete(pair);
          if (!pairs?.size) hullPairsByBody.delete(body);
        }
      }
    });
  }
  scope.cleanup(() => clearHullPairs());

  let initializingBodies = false;
  async function measure() {
    if (!engine || reduceMotion.matches || !fontsReady) return;
    if (initializingBodies) {
      measurePending = true;
      return;
    }
    if (held) {
      measurePending = true;
      return;
    }
    measurePending = false;
    readViewport();
    // Hero entrances belong to physics. Only the footer retains its CSS entrance, so
    // neutralize that outer transform along with the body's transform for layout reads.
    const entrances = chars
      .filter((el) => !el.closest(".hero-name"))
      .map((el) => el.parentElement);
    const transforms = chars.map((el) => el.style.transform);
    for (const outer of entrances)
      outer.style.setProperty("transform", "none", "important");
    const variationElements = chars.map((el) => el.querySelector(".char-glyph") ?? el),
      variations = variationElements.map((el) => el.style.fontVariationSettings);
    for (let i = 0; i < chars.length; i++) {
      const el = chars[i];
      el.style.transform = "none";
      variationElements[i].style.fontVariationSettings = "";
      el.style.removeProperty("width");
    }
    const layouts = chars.map((el) => {
      const style = getComputedStyle(el);
      // Snapshot rest styles: CSSStyleDeclaration stays live after variations are restored.
      const cs = Object.fromEntries(
        [
          "font",
          "fontSize",
          "fontStyle",
          "fontWeight",
          "fontStretch",
          "fontFamily",
          "fontVariationSettings",
          "lineHeight",
          "borderTopLeftRadius",
        ].map((key) => [key, style[key]]),
      );
      return { el, rect: el.getBoundingClientRect(), cs, anchor: el.parentElement.getBoundingClientRect() };
    });
    measuredWithFont = document.fonts.check('760 18px "Google Sans Flex"');
    const heroFoot = document.querySelector(".hero-foot");
    const floorY = heroFoot
      ? heroFoot.getBoundingClientRect().top + viewport.y
      : null;
    const dot = layouts.find(({ el }) => el.matches(".hero-name .dot .char"));
    const hero = layouts.find(({ el }) => el.closest(".hero-name"));
    const key =
      `${floorY};` +
      layouts
        .map(
          ({ el, rect, cs }) =>
            `${el.textContent}|${cs.font}|${cs.fontVariationSettings}|${cs.lineHeight}|${rect.left + viewport.x}|${rect.top + viewport.y}|${rect.width}|${rect.height}`,
        )
        .join(";");
    for (const outer of entrances) outer.style.removeProperty("transform");
    for (let i = 0; i < chars.length; i++) {
      chars[i].style.transform = transforms[i];
      variationElements[i].style.fontVariationSettings = variations[i];
      chars[i].style.width = `${layouts[i].rect.width}px`;
    }
    if (key === layoutKey && letters.length) return;
    for (const l of letters) if (l.nativeGlyph) restoreNativeGlyph(l);
    layoutKey = key;
    measuredFloorY = floorY;
    heroFontSize = hero
      ? parseFloat(hero.cs.fontSize)
      : HERO_REFERENCE_FONT_SIZE;
    typeScale = heroFontSize / HERO_REFERENCE_FONT_SIZE;
    if (dot) {
      ballWidth = dot.rect.width;
      ballHeight = dot.rect.height;
      ballRadius = Math.min(
        parseFloat(dot.cs.borderTopLeftRadius),
        ballWidth / 2,
        ballHeight / 2,
      );
    }
    sizeBall();
    Composite.clear(engine.world, false);
    clearHullPairs();
    ballEscape = null;
    ballStallFrames = 0;
    ballProgressDistance = Infinity;
    floorPairs.length = floorBodies.length = 0;
    // A deep surface, rather than a thin segment, also catches a grabbed glyph's
    // constraint correction. Only hero letters collide: the cursor can cross freely.
    floor =
      floorY === null
        ? null
        : Bodies.rectangle(
            viewport.width / 2,
            floorY + document.documentElement.scrollHeight / 2,
            viewport.width + heroFontSize * 8,
            document.documentElement.scrollHeight,
            {
              label: "Hero floor",
              isStatic: true,
              friction: 0.05,
              restitution: 0.15,
              slop: 0,
              collisionFilter: {
                category: FLOOR_CATEGORY,
                mask: HERO_CATEGORY,
              },
            },
          );
    const initialBuild = !entered && !letters.length,
      nextLetters = [];
    initializingBodies = initialBuild;
    try {
      for (let index = 0; index < layouts.length; index++) {
        // Body construction is independent per glyph. Spread the cold build
        // across frames; publish the complete world before starting the drop.
        if (initialBuild) await new Promise(requestAnimationFrame);
        if (signal.aborted || reduceMotion.matches) return;
        const { el, rect, cs, anchor } = layouts[index],
          made = letterBody(el, rect, cs);
        if (!made) continue;
        const { body, size } = made;
        const isHero = !!el.closest(".hero-name");
        if (isHero) body.collisionFilter.category = HERO_CATEGORY;
        const hx = body.position.x,
          hy = body.position.y;
        // ox/oy: where this element sits in the layout (for drawing). hx/hy: the slot it's heading for,
        // which identical letters can trade. `shape` groups letters that are interchangeable.
        nextLetters.push({
          index,
          el,
          layoutAnchor: { left: anchor.left + viewport.x, top: anchor.top + viewport.y, width: anchor.width, height: anchor.height },
          body,
          hx,
          hy,
          ox: hx,
          oy: hy,
          prev: { x: hx, y: hy, angle: 0 },
          origin: `${hx - viewport.x - rect.left}px ${hy - viewport.y - rect.top}px`,
          glyphOrigin: `calc(50% + ${hx - viewport.x - rect.left - rect.width / 2}px) ${hy - viewport.y - rect.top}px`,
          size,
          // Rotation moves the glyph's outermost point, not a whole line-height.
          // A full em overstates the new font's parked-contact angular chatter.
          motionRadius: made.hull?.motionRadius ?? Math.max(
            ...body.vertices.map((v) => Math.hypot(v.x - hx, v.y - hy)),
          ),
          isHero,
          isDot: !!el.closest(".dot"),
          homeBounds: {
            min: { ...body.bounds.min },
            max: { ...body.bounds.max },
          },
          tick: 0,
          settleFrames: 0,
          shape: `${el.textContent}|${cs.fontSize}|${cs.fontVariationSettings}|${cs.fontFamily}`,
          restAxes: Object.fromEntries(
            [...cs.fontVariationSettings.matchAll(/"(\w+)"\s+(-?[\d.]+)/g)].map(
              (match) => [match[1], Number(match[2])],
            ),
          ),
          glyph: el.querySelector(".char-glyph"),
          hull: el.querySelector(".char-glyph") ? made.hull : null,
          axes: {
            squash: { value: 0, velocity: 0 },
            puff: { value: 0, velocity: 0 },
            lean: { value: 0, velocity: 0 },
            mirror: { value: 0, velocity: 0 },
          },
          axisImpactFrames: 0,
          axisPhase: 0,
          axisBurstStage: -1,
          axisLanded: false,
          proximityTarget: 0,
          axesKey: "",
          glyphKey: "",
        });
      }
    } finally {
      initializingBodies = false;
    }
    letters = nextLetters;
    if (initialBuild) {
      // Loading time is not simulation time, including an early scroll wake.
      cancelAnimationFrame(frame);
      frame = last = acc = 0;
    }
    letterOf.clear();
    if (!entered) {
      const rows = [...document.querySelectorAll(".hero-name .line")];
      const rowIndices = new Map();
      for (const l of letters)
        if (l.isHero) {
          const row = l.el.closest(".line"),
            index = rowIndices.get(row) ?? 0;
          rowIndices.set(row, index + 1);
          // Drop the lower row first, leaving its path through the upper row clear.
          const stagger =
            index * 0.08 + (rows.length - 1 - rows.indexOf(row)) * 2.4;
          l.falling = l.entering = true;
          Body.setPosition(l.body, {
            x: l.hx,
            y: -heroFontSize * (0.5 + stagger) - (l.homeBounds.max.y - l.hy),
          });
          Body.setAngle(l.body, Math.sin((index + 1) * 2.4) * 0.06);
          l.prev = { ...l.body.position, angle: l.body.angle };
        }
      entered = true;
    }
    for (const l of letters) letterOf.set(l.body, l);
    for (const l of letters) {
      l.el.style.transformOrigin = l.origin;
      if (l.glyph) l.glyph.style.transformOrigin = l.glyphOrigin;
    }
    Composite.add(
      engine.world,
      letters.map((l) => l.body),
    );
    if (floor) Composite.add(engine.world, floor);
    // Remeasure letters after fonts/layout changes without moving or recreating the ball.
    if (ball && !engine.world.bodies.includes(ball)) Composite.add(engine.world, ball);
    render();
    for (const el of chars) el.style.removeProperty("visibility");
    quietFrames = 0;
    wake();
    if (measurePending) remeasure();
  }

  // Font drawings use the exact solved pose so their pixels follow the collision
  // body. Other shapes retain interpolation between fixed 60Hz steps.
  function render(alpha = 1, only) {
    for (const l of only ? [only] : letters) {
      const { x, y } = l.body.position,
        angle = l.body.angle;
      const prev = l.prev;
      const rx = l.glyph ? x : prev.x + (x - prev.x) * alpha,
        ry = l.glyph ? y : prev.y + (y - prev.y) * alpha,
        ra = l.glyph ? angle : prev.angle + (angle - prev.angle) * alpha;
      renderAxes(l);
      // A growing hull may have lifted its solved pose off the floor this step.
      // Keep the interpolated drawing above that same surface as well.
      let drawY = ry;
      if (l.isHero && !l.glyph && floor) {
        const cos = Math.cos(ra - angle),
          sin = Math.sin(ra - angle);
        let bottom = -Infinity;
        for (const v of l.body.vertices)
          bottom = Math.max(bottom, (v.x - x) * sin + (v.y - y) * cos);
        drawY = Math.min(drawY, floor.bounds.min.y - bottom);
      }
      const affine = l.glyph && l.glyphKey !== "none" ? ` ${l.glyphKey}` : "";
      const transform = `translate3d(${(rx - l.ox).toFixed(2)}px, ${(drawY - l.oy).toFixed(2)}px, 0) rotate(${ra.toFixed(4)}rad)${affine}`;
      if (transform !== l.renderedTransform) {
        l.el.style.transform = transform;
        l.renderedTransform = transform;
      }
    }
  }
  // Axis springs share the fixed 60Hz clock, with measured advances pinned in layout.
  function axisSpring(axis, target, damping = 0.73, stiffness = 0.18) {
    axis.velocity = axis.velocity * damping + (target - axis.value) * stiffness;
    axis.value += axis.velocity;
    if (
      Math.abs(target - axis.value) < 0.002 &&
      Math.abs(axis.velocity) < 0.002
    ) {
      axis.value = target;
      axis.velocity = 0;
      return false;
    }
    return true;
  }
  function simulateAxes(physicalActive) {
    const recovering = letters.filter((l) => l.recovering);
    if (
      recovering.length &&
      recovering.every(
        (l) =>
          swapTick >= l.recoverUntil &&
          Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
            Math.abs(l.body.angle) * l.size <
            LETTER_REST_AWAY,
      )
    )
      for (const l of recovering) l.recovering = false;
    let active = false;
    const now = performance.now();
    for (const l of letters) {
      if (!l.glyph) continue;
      const b = l.body,
        a = l.axes;
      let vx = physicalActive ? (b.position.x - l.prev.x) / typeScale : 0,
        vy = physicalActive ? (b.position.y - l.prev.y) / typeScale : 0;
      // Motion caused by a hull pushing back against a parked ball is not fresh
      // interaction energy. Let its axes return to rest rather than amplify chatter.
      const interactive =
        now < axisInputUntil ||
        l.falling ||
        l.entering ||
        l === held ||
        l.axisBurstStage >= 0 ||
        (ball && ball.speed / typeScale > 4);
      if (!interactive) vx = vy = 0;
      if (l === held && touch) {
        // Pointer events may arrive every other simulation step. Retain their
        // velocity briefly so drag lean/wobble does not alternate with zero input.
        const retain = clamp(
          1 - (now - (touch.movedAt ?? -Infinity)) / 120,
          0,
          1,
        );
        vx = ((touch.vx ?? 0) / typeScale) * retain;
        vy = ((touch.vy ?? 0) / typeScale) * retain;
      }
      const speed = Math.hypot(vx, vy);
      // A broad field with a full-strength core reaches 100 even beside a collision hull.
      const distance = ball
        ? Math.hypot(
            b.position.x - ball.position.x,
            b.position.y - ball.position.y,
          ) / heroFontSize
        : Infinity;
      const proximity = clamp((2 - distance) / 1.35, 0, 1);
      if (
        interactive ||
        proximity === 0 ||
        proximity === 1 ||
        Math.abs(proximity - l.proximityTarget) > 0.02
      )
        l.proximityTarget = proximity;
      let target =
        l.axisImpactFrames > 4
          ? 0.9
          : l.axisImpactFrames > 0
            ? 0
            : !l.falling && !l.entering && swapTick < hullQuietUntil
              ? 0
              : -Math.min(1, Math.abs(vy) / 11);
      if (l === held) {
        l.axisPhase += 0.38 + Math.min(10, speed) * 0.01;
        target = Math.sin(l.axisPhase) * Math.min(0.95, speed / 5);
      }
      // Keep the landing crest until the bounded collision pose has reached it.
      if (
        l.axisImpactFrames > 0 &&
        (l.axisImpactFrames !== 5 ||
          (l.hull.pose.width >= 145 && l.hull.pose.weight >= 950))
      )
        l.axisImpactFrames--;
      // The entrance spring catches letters just above their homes, before a hard
      // floor contact. Treat that rapid landing deceleration as an impact too.
      const landing = l.entering && !l.falling && !l.axisLanded;
      const contact =
        interactive && l.axisCollisionSpeed > 4 && swapTick >= hullQuietUntil;
      if (
        physicalActive &&
        (landing || contact) &&
        !l.axisImpactFrames &&
        l !== held &&
        l.axisBurstStage < 0
      ) {
        const impact =
          Math.hypot(l.axisVX - b.velocity.x, l.axisVY - b.velocity.y) /
          typeScale;
        if (impact > 2) {
          a.squash.value = Math.max(a.squash.value, 0.95);
          a.squash.velocity = Math.max(
            a.squash.velocity,
            Math.min(0.6, impact * 0.06),
          );
          l.axisImpactFrames = 18;
          l.axisLanded = true;
          target = 0.9;
        }
      }
      // A thin leading edge, then a heavy wide crest, travels one em per 100ms.
      // The whole name participates even outside the smaller physical impulse radius.
      if (l.axisBurstStage === 1) target = -1.25;
      const leaderReady =
        l.axisBurstAt === lastBurst?.axisLeadAt ||
        (lastBurst?.axisCrestAt != null &&
          now >= lastBurst.axisCrestAt + l.axisBurstAt - lastBurst.axisLeadAt);
      if (
        l.axisBurstStage === 1 &&
        leaderReady &&
        now >= l.axisBurstAt + 100 &&
        l.hull.pose.width <= 25
      ) {
        a.squash.value = 1.25;
        a.squash.velocity = 0.3;
        l.axisBurstStage = 2;
        l.axisBurstPeakAt = null;
        l.axisBurstCrestAt = now;
      }
      if (l.axisBurstStage === 2) {
        target = 1.2;
        if (l.hull.pose.width === 151 && l.hull.pose.weight === 1000)
          l.axisBurstPeakAt ??= now;
        if (
          now >= l.axisBurstCrestAt + 100 &&
          l.axisBurstPeakAt != null && now >= l.axisBurstPeakAt + 50 &&
          l.hull.pose.width === 151 &&
          l.hull.pose.weight === 1000
        ) {
          if (
            l.axisBurstAt === lastBurst?.axisLeadAt &&
            lastBurst.axisCrestAt == null
          )
            lastBurst.axisCrestAt = now;
          l.axisBurstStage = 3;
        }
      }
      if (l.axisBurstStage === 3) {
        target = -0.2;
        if (l.hull.pose.width <= 95 + clamp(a.puff.value, 0, 1) * 10)
          l.axisBurstStage = 4;
      }
      if (l.axisBurstStage === 4) {
        target = 0.12;
        if (l.hull.pose.width >= 102 + clamp(a.puff.value, 0, 1) * 10)
          l.axisBurstStage = -1;
      }
      // A cursor elsewhere on the page is not fresh input to this glyph.
      // Keep a jam's existing thin escape pose until home unless play returns.
      if (held || now < axisInputUntil || l.axisBurstStage >= 0 ||
        (ball && (l.mouseNear || l.proximityTarget > 0.01))) l.recovering = false;
      if (l.recovering) {
        target = -1.25;
        active = true;
      }
      if (l.axisBurstStage >= 0) active = true;
      active = axisSpring(a.squash, target) || active;
      active = axisSpring(a.puff, l.proximityTarget, 0.25, 0.25) || active;
      active = axisSpring(a.lean, -Math.min(10, Math.abs(vx) * 5)) || active;
      active =
        axisSpring(a.mirror, vx < 0 ? Math.min(20, -vx * 14) : 0) || active;
    }
    return active;
  }
  const poseAxes = ["weight", "width", "grade", "round", "slant", "sx", "sy", "skew"];
  const q = (value, step) => Math.round(Math.round(value / step) * step * 10000) / 10000;
  function axisPose(l) {
    const rest = l.restAxes,
      a = l.axes,
      squash = a.squash.value,
      puff = clamp(a.puff.value, 0, 1);
    const weight = q(
      clamp(
        rest.wght +
          squash * (squash < 0 ? 500 : 240) +
          puff * 240 +
          (l === held ? 60 : 0),
        120,
        1000,
      ),
      4,
    );
    const width = q(
      clamp(rest.wdth + squash * (squash < 0 ? 75 : 51) + puff * 10, 25, 151),
      0.25,
    );
    const grade = q(Math.max(rest.GRAD, puff * 100), 2);
    const round =
      l === held
        ? 100
        : q(
            clamp(
              rest.ROND +
                puff * 70 +
                Math.max(0, squash) * 60 -
                Math.max(0, -squash) * 30,
              0,
              100,
            ),
            2,
          );
    // Retain the old full-lean onset (9.5 internal degrees) while using fine
    // intermediate poses instead of whole-degree jumps.
    const slant = q(clamp(a.lean.value * (10 / 9.5), -10, 0), 0.1);
    // Balance the font's wide extreme with a compact drawing transform. The hull
    // combines both scales; a narrow falling pose stretches vertically as well.
    const sx = q(
        (1 - Math.min(1, Math.max(0, squash)) * 0.28) * (1 - puff * 0.08),
        0.002,
      ),
      // Crossed strokes need vertical clearance as well as a narrow outline.
      // Passive recovery briefly squashes both ink and collision geometry;
      // the bounded transition restores the full glyph once the group is home.
      sy = q(l.recovering ? 0.3 : 1 - clamp(squash, -1, 1) * 0.2, 0.002),
      skew = q(clamp(a.mirror.value, 0, 20), 0.1);
    return { width, weight, grade, round, slant, sx, sy, skew };
  }
  function renderAxes(l) {
    if (!l.glyph || l.renderedPose === l.hull.pose) return;
    l.renderedPose = l.hull.pose;
    const { weight, width, grade, round, slant, sx, sy, skew } = l.hull.pose;
    renderGlyphOutline(l);
    const key = `"wght" ${weight}, "wdth" ${width}, "GRAD" ${grade}, "ROND" ${round}, "slnt" ${slant}`;
    if (key !== l.axesKey) {
      // SVG paths already contain the font geometry. Applying unused font
      // styles here invalidates the SVG subtree on every frame.
      l.glyph.dataset.fontAxes = key;
      l.axesKey = key;
    }
    const glyphKey =
      sx === 1 && sy === 1 && skew === 0
        ? "none"
        : `skewX(${skew}deg) scale(${sx}, ${sy})`;
    if (glyphKey !== l.glyphKey) {
      // Compose this on the promoted HTML layer, around the same body origin.
      // Keep the SVG's own style/viewport unchanged while its path morphs.
      l.glyphKey = glyphKey;
    }
  }
  let hullChanging = false,
    hullQuietUntil = 0,
    axisInputUntil = 0;
  const timeHulls =
    new URLSearchParams(location.search).has("verify") ||
    new URLSearchParams(location.search).has("debug");
  let hullPlanCount = 0,
    hullClock = 0,
    hullBusyCount = 0,
    nextHullProgress = Infinity;
  const allActiveTimes = [],
    plannedHulls = [];
  const hullTimes = [],
    hullStats = {
      updates: 0,
      steps: 0,
      changedSteps: 0,
      totalMs: 0,
      changedMs: 0,
      maxMs: 0,
      coalescedSteps: 0,
      planMs: 0,
      applyMs: 0,
      satMs: 0,
    };
  let hullStepMs = 0;
  function planHulls() {
    const at = timeHulls ? performance.now() : 0;
    const now = performance.now();
    hullChanging = false;
    hullPlanCount = 0;
    plannedHulls.length = 0;
    hullBusyCount = letters.reduce(
      (count, l) =>
        count +
        (l.hull &&
        (l.falling ||
          l.entering ||
          l.axisBurstStage >= 0 ||
          (Math.abs(l.axes.squash.velocity) > 0.002 ||
           Math.abs(l.axes.puff.velocity) > 0.002 ||
           Math.abs(l.axes.lean.velocity) > 0.002 ||
           Math.abs(l.axes.mirror.velocity) > 0.002))
          ? 1
          : 0),
      0,
    );
    // Exact font evaluation remains staggered. Corresponding baked vertices
    // and the drawn axes advance together every tick, without a 20Hz hold.
    const busy = hullBusyCount > 6;
    hullClock = (hullClock + 1) % 4;
    if (busy) hullStats.coalescedSteps++;
    for (const l of letters)
      if (l.hull) {
        // Start the arriving wave before its first geometry plan. Starting in
        // simulateAxes after the solve delayed its visible lead by a full tick.
        if (l.axisBurstStage === 0 && now >= l.axisBurstAt) {
          l.axes.squash.value = -1.25;
          l.axes.squash.velocity = -0.2;
          l.axisBurstStage = 1;
        }
        const h = l.hull;
        h.substepChanged = false;
        h.sweepNeeded = l.falling;
        const immediate = l === held ||
          ((l.axisBurstStage === 1 || l.axisBurstStage === 2) &&
            l.axisBurstAt === lastBurst?.axisLeadAt);
        const frames = busy && !immediate ? 4 : 1;
        const desired = axisPose(l), tween = h.tween;
        // A pointer/velocity reversal can invalidate a queued keyframe. Retarget
        // on this tick rather than finishing a chord away from the new target.
        let reversed = false;
        if (tween && tween.elapsed < tween.frames)
          for (const axis of poseAxes)
            if (Math.abs(tween.to[axis] - h.pose[axis]) > 1e-6 &&
                (desired[axis] - h.pose[axis]) * (tween.to[axis] - h.pose[axis]) <= 0) {
              reversed = true;
              break;
            }
        h.requestedPose = desired;
        const slotIn = ((l.index - hullClock) % frames + frames) % frames,
          due = frames > 1 && (!tween || tween.elapsed >= tween.frames),
          span = due && slotIn ? slotIn : frames,
          scheduled = frames === 1 || slotIn === 0 || reversed || due;
        let grabContact = false;
        if (held && touch?.distance >= TAP_DISTANCE)
          for (const pair of hullPairsByBody.get(l.body) ?? [])
            if (pair.isActive) { grabContact = true; break; }
        if (
          planGlyphHull(
            h,
            scheduled ? glyphHullTarget(h, desired) : null,
            // Contacting grabs need bounded contact work. Free grabs keep
            // their full wobble; drawing follows the same collision pose.
            // A four-tick chord used to share one tick's entire allowance,
            // making a wide W's wave last over two seconds. Allow 18 reference
            // pixels per full chord: 4.5 per tick, still below the 6/12 bounds.
            (grabContact ? 6 : 12) * typeScale * span / frames * (frames > 1 ? 1.5 : 1),
            span,
          )
        ) {
          hullChanging = true;
          plannedHulls.push(l);
          hullPlanCount++;
          if (
            h.to[0] > h.from[0] &&
            (l.axes.squash.value > 0.1 || l.axes.puff.value > 0.01)
          )
            hullQuietUntil = swapTick + 12;
        }
      }
    // A thin stroke can be crossed completely by a six-pixel shape/rigid step.
    // Refine only nearby thin pairs, before their contours can become interlocked.
    let anyThin = false;
    for (const l of letters) {
      const h = l.hull;
      l.collisionWeight = h
        ? Math.min(h.pose.weight, h.nextPose?.weight ?? 1000)
        : 1000;
      if (l.collisionWeight < 400) anyThin = true;
    }
    const obstacles = anyThin
      ? [...letters, ...(ball ? [{ body: ball, collisionWeight: 1000 }] : [])]
      : [];
    // Matter bounds include absolute-velocity padding. Co-falling glyphs share
    // that velocity: using padded boxes and speed sums refined the entire
    // entrance to 1px steps despite no relative approach. Test actual swept
    // envelopes instead, including the pending morph and angular travel.
    for (const l of obstacles) {
      if (!l.falling) continue;
      const b = l.body,
        box = (l.sweepBounds ??= { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const v of b.vertices) {
        minX = Math.min(minX, v.x);
        minY = Math.min(minY, v.y);
        maxX = Math.max(maxX, v.x);
        maxY = Math.max(maxY, v.y);
      }
      if (l.hull?.changed) {
        const h = l.hull,
          c = Math.cos(b.angle),
          s = Math.sin(b.angle);
        if (h.sweepCacheValid) {
          minX = Math.min(minX, h.nextSweep.minX); minY = Math.min(minY, h.nextSweep.minY);
          maxX = Math.max(maxX, h.nextSweep.maxX); maxY = Math.max(maxY, h.nextSweep.maxY);
        } else for (let i = h.mesh.visibleStart; i < h.next.points.length; i++) {
          const p = h.next.points[i],
            x = b.position.x + p.x * c - p.y * s,
            y = b.position.y + p.x * s + p.y * c;
          minX = Math.min(minX, x); minY = Math.min(minY, y);
          maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
      }
      box.min.x = minX;
      box.min.y = minY;
      box.max.x = maxX;
      box.max.y = maxY;
    }
    for (const l of plannedHulls) {
      const h = l.hull,
        b = l.body;
      let precise = false;
      for (const obstacle of obstacles) {
        const other = obstacle.body;
        if (
          other === b ||
          (l.collisionWeight >= 400 && obstacle.collisionWeight >= 400)
        )
          continue;
        let margin, a, o;
        if (l.falling && obstacle.falling) {
          margin = typeScale + 2 * Math.hypot(
            b.velocity.x - other.velocity.x, b.velocity.y - other.velocity.y) +
            2 * (Math.abs(b.angularVelocity) * l.motionRadius +
              Math.abs(other.angularVelocity) * (obstacle.motionRadius ?? 0));
          a = l.sweepBounds; o = obstacle.sweepBounds;
        } else {
          // Preserve the established conservative refinement for grabs, bursts,
          // landing contacts and return-home motion. Only common free fall can
          // discard absolute-speed padding safely without changing contacts.
          margin =
            (h.changed ? h.travel : 0) +
            b.speed * 2 +
            6 * typeScale +
            other.speed * 2;
          a = b.bounds;
          o = other.bounds;
        }
        if (
          a.min.x - margin <= o.max.x &&
          a.max.x + margin >= o.min.x &&
          a.min.y - margin <= o.max.y &&
          a.max.y + margin >= o.min.y
        ) {
          precise = true;
          break;
        }
      }
      h.stageTravel = (precise ? 1 : 6) * typeScale;
    }
    nextHullProgress = Infinity;
    for (const l of plannedHulls) {
      const h = l.hull;
      h.stages = Math.max(1, Math.ceil(h.travel / h.stageTravel));
      nextHullProgress = Math.min(nextHullProgress, (1 - 1e-7) / h.stages);
    }
    hullStepMs = timeHulls ? performance.now() - at : 0;
    hullStats.planMs += hullStepMs;
    return hullChanging;
  }
  function updateHulls(progress) {
    if (!hullChanging || progress < nextHullProgress) return;
    const at = timeHulls ? performance.now() : 0;
    nextHullProgress = Infinity;
    for (const l of plannedHulls) {
      const changed = applyGlyphHull(l.hull, progress, Bounds);
      l.hull.substepChanged = changed;
      if (l.hull.appliedStage < l.hull.stages)
        nextHullProgress = Math.min(
          nextHullProgress,
          (l.hull.appliedStage + 1 - 1e-7) / l.hull.stages,
        );
      if (changed) {
        hullStats.updates++;
        l.motionRadius = l.hull.motionRadius;
        l.body.positionImpulse.x = l.body.positionImpulse.y = 0;
        // Invalidate only contacts incident to this changed body. Scanning every
        // active pair at every geometry stage made crowded entrance frames costly.
        for (const pair of hullPairsByBody.get(l.body) ?? [])
          if (pair.isActive)
            for (const contact of pair.contacts)
              contact.normalImpulse = contact.tangentImpulse = 0;
      }
    }
    if (timeHulls) {
      const elapsed = performance.now() - at;
      hullStepMs += elapsed; hullStats.applyMs += elapsed;
    }
  }
  const ballEl = document.querySelector(".cursor-ball");
  let renderedBall;
  function renderBall() {
    if (!ball || !ballEl) return;
    ballEl.classList.toggle("is-visible", !reduceMotion.matches);
    const translate = `${(ball.position.x - viewport.x).toFixed(1)}px ${(ball.position.y - viewport.y).toFixed(1)}px`;
    if (translate !== renderedBall) {
      ballEl.style.translate = translate;
      renderedBall = translate;
    }
  }

  let physicalActive = true, touchLayoutPending = false;
  function wake(continueFrame = false) {
    if (!continueFrame) {
      physicalActive = true;
      axisInputUntil = Math.max(axisInputUntil, performance.now() + 600);
    }
    if (!frame && engine && !reduceMotion.matches)
      frame = requestAnimationFrame(step);
  }

  // Fixed 60Hz simulation steps, so the feel doesn't change with display refresh rate.
  let last = 0,
    acc = 0;
  function step(now) {
    frame = 0;
    readViewport();
    // The first hybrid-device touch reveals the scroll link and can translate
    // the name without changing body height. Re-anchor once, before this tick;
    // a held body stays under the finger while its home/layout origin moves.
    if (touchLayoutPending) {
      touchLayoutPending = false;
      if (!translateLayout()) measurePending = true;
    }
    // Keep a fresh 60Hz run halfway between tick boundaries. Rounded rAF
    // timestamps otherwise alternate zero/two ticks at nominal 60fps, visibly
    // holding and jumping a current-pose glyph. The fractional remainder still
    // carries real elapsed time; solver steps remain exactly FRAME_MS.
    if (!last) acc = FRAME_MS / 2;
    acc += Math.min(now - (last || now - FRAME_MS), 100);
    last = now;
    let active = acc < FRAME_MS;
    for (; acc >= FRAME_MS; acc -= FRAME_MS) {
      for (const l of letters) {
        l.prev.x = l.body.position.x;
        l.prev.y = l.body.position.y;
        l.prev.angle = l.body.angle;
      }
      if (planHulls()) physicalActive = true;
      if (physicalActive) physicalActive = simulateLetters();
      active = simulateAxes(physicalActive) || physicalActive || active;
      if (timeHulls) {
        for (const l of letters) if (l.hull) {
          hullStepMs += l.hull.satMs; hullStats.satMs += l.hull.satMs; l.hull.satMs = 0;
        }
        hullStats.steps++;
        hullStats.totalMs += hullStepMs;
        hullStats.maxMs = Math.max(hullStats.maxMs, hullStepMs);
        hullTimes.push(hullStepMs);
        if (hullTimes.length > 600) hullTimes.shift();
        if (hullBusyCount === 12) {
          allActiveTimes.push(hullStepMs);
          if (allActiveTimes.length > 600) allActiveTimes.shift();
        }
        if (hullChanging) {
          hullStats.changedSteps++;
          hullStats.changedMs += hullStepMs;
        }
      }
    }
    render(active || held ? acc / FRAME_MS : 1);
    renderBall();
    if (active || held) wake(true);
    else last = acc = 0;
  }

  // Two letters caught on the wrong sides of each other (the b in the W's notch) get a nudge:
  // a gentle push in opposite directions around their shared midpoint, plus a little spin, that
  // ramps up and back down over a second. It's a force on top of normal physics, so full-strength springs keep working.
  // Still stuck? Nudge harder, the other way.
  function nudgeStuck(l, x, y) {
    const hx = l.hx - x,
      hy = l.hy - y,
      hd = Math.hypot(hx, hy) || 1;
    let partner = null,
      best = -Infinity;
    for (const pair of engine.pairs.list) {
      if (!pair.isActive) continue;
      const a = letterOf.get(pair.collision.parentA),
        b = letterOf.get(pair.collision.parentB);
      const other = a === l ? b : b === l ? a : null;
      if (!other || other === held || other.nudged || other.mouseNear) continue;
      // The neighbour most in the way of home.
      const ox = other.body.position.x - x,
        oy = other.body.position.y - y,
        od = Math.hypot(ox, oy) || 1;
      const score = (ox * hx + oy * hy) / (od * hd);
      if (score > best) {
        best = score;
        partner = other;
      }
    }
    // Not touching anything this instant? Use the nearest letter sitting between it and home.
    if (!partner) {
      let nearest = Infinity;
      for (const other of letters) {
        if (other === l || other === held || other.nudged || other.mouseNear)
          continue;
        const ox = other.body.position.x - x,
          oy = other.body.position.y - y,
          od = Math.hypot(ox, oy) || 1;
        if (
          (ox * hx + oy * hy) / (od * hd) > 0.3 &&
          od < l.size * 1.5 &&
          od < nearest
        ) {
          nearest = od;
          partner = other;
        }
      }
    }
    if (!partner) {
      // Untwist a lone glyph; a blocked pair first needs room to pass each other.
      if (Math.abs(l.body.angle) > 0.25) {
        l.attempts = (l.attempts || 0) + 1;
        l.nudged = {
          a: l,
          b: l,
          untwist: true,
          strength: NUDGE * Math.min(1 + 0.6 * (l.attempts - 1), 4),
          frames: NUDGE_FRAMES,
          total: NUDGE_FRAMES,
        };
        l.stuck = false;
        return;
      }
      return;
    }
    const p = partner.body.position,
      cx = (x + p.x) / 2,
      cy = (y + p.y) / 2;
    l.attempts = (l.attempts || 0) + 1;
    // Push the way that heads home, twice (stronger the second time), then try the other way.
    // Flipping every time just rocks a jammed pair back and forth.
    const towardHome = Math.sign(-(y - cy) * hx + (x - cx) * hy) || 1;
    const dir = Math.floor((l.attempts - 1) / 2) % 2 ? -towardHome : towardHome;
    const strength = NUDGE * Math.min(1 + 0.6 * (l.attempts - 1), 4);
    // A short, steady push rather than a single shove: forces add to the normal physics.
    const push = {
      a: l,
      b: partner,
      dir,
      strength,
      frames: NUDGE_FRAMES,
      total: NUDGE_FRAMES,
    };
    l.nudged = partner.nudged = push;
    if (!held && swapTick - dragEndedAt > 30 &&
      (!ball || performance.now() > axisInputUntil)) {
      // Closed counters can trap another stroke as a font pose thickens. Reuse
      // the existing thin pose until this recovery group reaches home, keeping
      // collision geometry and drawing synchronized throughout the escape.
      // Eligibility belongs to each glyph. A puffed neighbour must not veto
      // the escape of another glyph outside the cursor's contact/field.
      const eligible = (member) => member?.hull && member !== held &&
        !member.mouseNear && (!ball || member.proximityTarget <= 0.01);
      const group = [l, partner].filter(eligible);
      for (let i = 0; i < group.length; i++) {
        const member = group[i];
        if (member.hull) {
          member.recovering = true;
          member.recoverUntil = Math.max(member.recoverUntil ?? 0, swapTick + 30);
        }
        // A third thick counter can keep the original pair interlocked. Open
        // the whole eligible contact component with the same bounded pose.
        for (const pair of hullPairsByBody.get(member.body) ?? engine.pairs.list) {
          if (!pair.isActive) continue;
          const a = letterOf.get(pair.collision.parentA),
            b = letterOf.get(pair.collision.parentB),
            other = a === member ? b : b === member ? a : null;
          if (!eligible(other) || group.includes(other)) continue;
          group.push(other);
        }
      }
    }
    l.stuck = false;
  }

  // Identical letters (both b's, both e's) are interchangeable, so each heads for whichever
  // matching slot is closer. Swapping targets is invisible, and saves a lot of jams.
  let swapTick = 0,
    dragEndedAt = -Infinity;
  function swapIdenticalHomes() {
    for (let i = 0; i < letters.length; i++) {
      for (let j = i + 1; j < letters.length; j++) {
        const a = letters[i],
          b = letters[j];
        if (a.shape !== b.shape || a === held || b === held) continue;
        const A = a.body.position,
          B = b.body.position;
        const now =
          Math.hypot(A.x - a.hx, A.y - a.hy) +
          Math.hypot(B.x - b.hx, B.y - b.hy);
        const swapped =
          Math.hypot(A.x - b.hx, A.y - b.hy) +
          Math.hypot(B.x - a.hx, B.y - a.hy);
        if (swapped < now - 4) {
          [a.hx, b.hx] = [b.hx, a.hx];
          [a.hy, b.hy] = [b.hy, a.hy];
          for (const l of [a, b]) {
            l.noProgress = 0;
            l.lastAway = Infinity;
            l.attempts = 0;
          }
        }
      }
    }
  }

  // Speeds/accelerations use Matter's normalized 60Hz frame units; distances are page px.
  const FRAME_MS = 1000 / 60,
    BALL_DENSITY = 0.02,
    BALL_SPRING = 0.08,
    BALL_SPRING_DISTANCE = 0.00012,
    BALL_DAMPING_RATIO = 1.05,
    // Integrity ceiling only: 36,000px/s. Normal flights never reach this ceiling.
    BALL_SAFETY_SPEED = 600,
    // Limit relative ball/letter travel to 6px per solver update, even on a long scroll.
    MAX_SUBSTEP_TRAVEL = 6,
    MIN_SUBSTEPS = 2,
    MAX_SUBSTEPS = 128,
    BURST_RANGE = 240,
    BURST_SPEED = 38,
    BURST_FALLOFF = 1.5,
    BURST_SPIN = 0.018,
    MAX_LETTER_SPEED = 38,
    MAX_SPIN = 0.045,
    EDGE_MARGIN = 6,
    QUIET_MOTION = 0.08,
    QUIET_FRAMES = 30,
    LETTER_REST_AWAY = 3,
    LETTER_REST_SPEED = 0.4,
    BALL_REST_DISTANCE = 0.3,
    BALL_REST_SPEED = 0.08,
    BALL_ESCAPE_DISTANCE = 64,
    BALL_ESCAPE_PROGRESS = 12,
    BALL_STALL_FRAMES = 12,
    BALL_ESCAPE_FRAMES = 45,
    BALL_ESCAPE_STRENGTH = 1.5,
    BALL_ESCAPE_PULL = 0.12,
    TAP_MS = 200,
    TAP_DISTANCE = 8,
    RIPPLE_MS = 420;
  let ball = null,
    touch = null,
    quietFrames = 0,
    springForce = 0,
    ballStallFrames = 0,
    ballProgressDistance = Infinity,
    ballEscape = null,
    ballEscapes = 0,
    lastBurst = null,
    burstCount = 0,
    touchClick = null;
  const ripples = new Map();
  const previousActive = document.documentElement.hasAttribute(
    "data-physics-active",
  );
  const previousTouch =
    document.documentElement.hasAttribute("data-physics-touch");
  const syncActive = () =>
    document.documentElement.toggleAttribute(
      "data-physics-active",
      !reduceMotion.matches,
    );
  syncActive();
  scope.cleanup(() => {
    for (const [el, animation] of ripples) {
      animation.cancel();
      el.remove();
    }
    ripples.clear();
    ballEl?.classList.remove("is-visible");
    document.documentElement.toggleAttribute(
      "data-physics-active",
      previousActive,
    );
    document.documentElement.toggleAttribute(
      "data-physics-touch",
      previousTouch,
    );
  });
  function aimMouse(e) {
    if (
      reduceMotion.matches ||
      !finePointer.matches ||
      e.pointerType === "touch" ||
      !engine
    )
      return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (!ball) {
      // The only placement: first appearance. Subsequent entry/scroll/remeasure retains momentum.
      ball = ballShape(pointer.x + scrollX, pointer.y + scrollY);
      Body.setInertia(ball, Infinity);
      Composite.add(engine.world, ball);
    }
    quietFrames = 0;
    wake();
  }
  function ballSpring() {
    const dx = pointer.x + viewport.x - ball.position.x,
      dy = pointer.y + viewport.y - ball.position.y,
      distance = Math.hypot(dx, dy),
      stiffness = BALL_SPRING + BALL_SPRING_DISTANCE * distance;
    springState.dx = dx;
    springState.dy = dy;
    springState.distance = distance;
    springState.stiffness = stiffness;
    springState.damping = 2 * BALL_DAMPING_RATIO * Math.sqrt(stiffness);
    return springState;
  }
  function chaseBall(delta) {
    if (!ball) return;
    const { dx, dy, stiffness, damping } = ballSpring();
    const sx = dx * stiffness,
      sy = dy * stiffness;
    springForce = (ball.mass * Math.hypot(sx, sy)) / (FRAME_MS * FRAME_MS);
    // A concave glyph can balance the two springs far from the target. A short tangent
    // force slides the ball around that contact, retaining solid collisions and momentum.
    const escape = ballEscape ? BALL_ESCAPE_STRENGTH * Math.hypot(sx, sy) : 0;
    // Ease the inward pull during escape so the tangent force can climb a steep
    // concave face, rather than press the square more tightly into its notch.
    const pull = ballEscape ? BALL_ESCAPE_PULL : 1;
    let ax =
        sx * pull - ball.velocity.x * damping + (ballEscape?.x ?? 0) * escape,
      ay =
        sy * pull - ball.velocity.y * damping + (ballEscape?.y ?? 0) * escape;
    // Bound the predicted integrated velocity, rather than replacing the spring with a chase speed.
    const fraction = delta / FRAME_MS;
    const vx = ball.velocity.x + ax * fraction,
      vy = ball.velocity.y + ay * fraction;
    const speed = Math.hypot(vx, vy);
    if (speed > BALL_SAFETY_SPEED) {
      ax = ((vx * BALL_SAFETY_SPEED) / speed - ball.velocity.x) / fraction;
      ay = ((vy * BALL_SAFETY_SPEED) / speed - ball.velocity.y) / fraction;
    }
    ball.force.x += (ball.mass * ax) / (FRAME_MS * FRAME_MS);
    ball.force.y += (ball.mass * ay) / (FRAME_MS * FRAME_MS);
  }
  function noteBallHits() {
    if (!ball) return;
    for (const pair of engine.pairs.list) {
      if (!pair.isActive) continue;
      const other =
        pair.collision.parentA === ball
          ? pair.collision.parentB
          : pair.collision.parentB === ball
            ? pair.collision.parentA
            : null;
      const l = other && letterOf.get(other);
      if (l) markBallPlay(l);
    }
  }

  const connected = new Set();
  const springState = { dx: 0, dy: 0, distance: 0, stiffness: 0, damping: 0 };
  const previousBall = { x: 0, y: 0 };
  const bodyVector = { x: 0, y: 0 };
  function ballContacts() {
    // A neighbour resting against a letter that's against the ball is also blocked by the ball.
    connected.clear();
    if (ball) connected.add(ball);
    let changed = true;
    while (changed) {
      changed = false;
      for (const pair of engine.pairs.list) {
        if (!pair.isActive) continue;
        const a = pair.collision.parentA,
          b = pair.collision.parentB;
        // A shared static floor does not make distant letters part of a ball contact.
        if (a === floor || b === floor) continue;
        if (connected.has(a) === connected.has(b)) continue;
        connected.add(a);
        connected.add(b);
        changed = true;
      }
    }
    return connected;
  }
  function markBallPlay(l) {
    l.ballHitAt = swapTick;
    l.stuck = false;
    l.noProgress = 0;
    l.lastAway = Infinity;
    if (l.nudged) {
      const n = l.nudged;
      n.a.nudged = n.b.nudged = null;
    }
  }
  function glyphDistance(body, point) {
    let distance = Infinity;
    for (
      let partIndex = body.parts.length > 1 ? 1 : 0;
      partIndex < body.parts.length;
      partIndex++
    ) {
      const part = body.parts[partIndex];
      if (part.vertices.length < 3) continue;
      if (Vertices.contains(part.vertices, point)) return 0;
      const vs = part.vertices;
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i],
          b = vs[(i + 1) % vs.length];
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const t = clamp(
          ((point.x - a.x) * dx + (point.y - a.y) * dy) /
            (dx * dx + dy * dy || 1),
          0,
          1,
        );
        distance = Math.min(
          distance,
          Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy),
        );
      }
    }
    return distance;
  }
  function burst(clientX, clientY, input) {
    if (reduceMotion.matches || !engine) return;
    const point = { x: clientX + scrollX, y: clientY + scrollY };
    const range = BURST_RANGE * typeScale,
      speed = BURST_SPEED * typeScale,
      rippleSize = 144 * typeScale;
    lastBurst = {
      ...point,
      at: performance.now(),
      input,
      count: ++burstCount,
      fontSize: heroFontSize,
      scale: typeScale,
      range,
      speed,
      rippleSize,
    };
    axisInputUntil = lastBurst.at + 1200;
    for (const l of letters) {
      if (l.glyph) {
        l.axisBurstAt =
          lastBurst.at +
          (Math.hypot(l.ox - point.x, l.oy - point.y) / heroFontSize) * 100;
        l.axisBurstStage = 0;
      }
      const b = l.body,
        distance = glyphDistance(b, point);
      if (distance >= range) continue;
      // The physical easing shares the solver clock. A render stall must not
      // spend its 120ms window without advancing the corresponding motion.
      l.burstImpulseAt = engine.timing.timestamp;
      l.falling = l.entering = false;
      const dx = b.position.x - point.x,
        dy = b.position.y - point.y;
      const d = Math.hypot(dx, dy),
        centered = d < 1;
      // Native touch coordinates round by a few millionths of a pixel. A center
      // tap needs a stable direction, rather than amplifying that rounding sideways.
      const strength = speed * (1 - distance / range) ** BURST_FALLOFF;
      const vx = b.velocity.x + (centered ? 0 : dx / d) * strength,
        vy = b.velocity.y + (centered ? -1 : dy / d) * strength;
      const cap = Math.min(1, letterSpeedLimit() / (Math.hypot(vx, vy) || 1));
      Body.setVelocity(b, { x: vx * cap, y: vy * cap });
      Body.setAngularVelocity(
        b,
        clamp(
          b.angularVelocity +
            ((centered ? 1 : Math.sign(dx) || 1) * BURST_SPIN * strength) /
              speed,
          -MAX_SPIN,
          MAX_SPIN,
        ),
      );
      markBallPlay(l);
    }
    lastBurst.axisLeadAt = Math.min(
      ...letters.filter((l) => l.glyph).map((l) => l.axisBurstAt),
    );
    lastBurst.axisCrestAt = null;
    const ring = document.createElement("div");
    ring.className = "physics-ripple";
    ring.setAttribute("aria-hidden", "true");
    ring.style.left = `${clientX}px`;
    ring.style.top = `${clientY}px`;
    ring.style.setProperty("--ripple-size", `${rippleSize}px`);
    document.body.append(ring);
    const animation = ring.animate(
      [
        { transform: "scale(0.08)", opacity: 0.55 },
        { transform: "scale(1)", opacity: 0 },
      ],
      { duration: RIPPLE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    ripples.set(ring, animation);
    animation.finished.then(
      scope.guard(() => {
        ring.remove();
        ripples.delete(ring);
      }),
      () => {},
    );
    quietFrames = 0;
    wake();
  }

  // Preserve drag/collision headroom on small type; let desktop bursts scale fully.
  function letterSpeedLimit() {
    return MAX_LETTER_SPEED * Math.max(1, typeScale);
  }

  function containBallLetters() {
    for (const l of letters) {
      const b = l.body;
      // Only constrain an axis if its home glyph fits in that viewport axis. Offscreen footer
      // letters keep their document positions, including during scrolling.
      const bx = l.homeBounds,
        margin = EDGE_MARGIN;
      let dx = 0,
        dy = 0;
      if (
        bx.min.x >= viewport.x + margin &&
        bx.max.x <= viewport.x + viewport.width - margin
      )
        dx =
          Math.max(0, viewport.x + margin - b.bounds.min.x) +
          Math.min(0, viewport.x + viewport.width - margin - b.bounds.max.x);
      if (
        !l.falling &&
        bx.min.y >= viewport.y + margin &&
        bx.max.y <= viewport.y + viewport.height - margin
      )
        dy =
          Math.max(0, viewport.y + margin - b.bounds.min.y) +
          Math.min(0, viewport.y + viewport.height - margin - b.bounds.max.y);
      if (dx || dy) {
        bodyVector.x = b.position.x + dx;
        bodyVector.y = b.position.y + dy;
        Body.setPosition(b, bodyVector);
        bodyVector.x = dx ? 0 : b.velocity.x;
        bodyVector.y = dy ? 0 : b.velocity.y;
        Body.setVelocity(b, bodyVector);
        Body.setAngularVelocity(b, b.angularVelocity * 0.5);
      }
      const speedLimit = letterSpeedLimit();
      if (b.speed > speedLimit) {
        bodyVector.x = (b.velocity.x * speedLimit) / b.speed;
        bodyVector.y = (b.velocity.y * speedLimit) / b.speed;
        Body.setVelocity(b, bodyVector);
      }
      if (Math.abs(b.angularVelocity) > MAX_SPIN)
        Body.setAngularVelocity(
          b,
          clamp(b.angularVelocity, -MAX_SPIN, MAX_SPIN),
        );
    }
  }

  // A parked proximity field can keep a glyph wider than its home slot. Its quiet
  // contact group may rest displaced, just like letters supporting the cursor ball.
  function restingContacts(contacts = ballContacts()) {
    const supported = new Set(contacts);
    // Proximity alone is not physical support. Free puffed letters still need
    // the exact-home snap; only actual contacts may preserve a displaced pose.
    for (const pair of engine.pairs.list)
      if (pair.isActive) {
        if (pair.collision.parentA === floor || pair.collision.parentB === floor) continue;
        const a = letterOf.get(pair.collision.parentA),
          b = letterOf.get(pair.collision.parentB);
        if (a?.axes.puff.value > 0.01) supported.add(a.body);
        if (b?.axes.puff.value > 0.01) supported.add(b.body);
      }
    let changed;
    do {
      changed = false;
      for (const pair of engine.pairs.list)
        if (pair.isActive) {
          const a = pair.collision.parentA,
            b = pair.collision.parentB;
          if (a === floor || b === floor) continue;
          if (supported.has(a) && letterOf.has(b) && !supported.has(b)) {
            supported.add(b);
            changed = true;
          }
          if (supported.has(b) && letterOf.has(a) && !supported.has(a)) {
            supported.add(a);
            changed = true;
          }
        }
    } while (changed);
    return supported;
  }
  function simulationActive(previousBall) {
    const contacts = ballContacts(),
      supported = restingContacts(contacts);
    let moving = !!held || !!ballEscape || hullChanging;
    const blocked = letters.some((l) => contacts.has(l.body));
    // A settled compound can have several simultaneous contacts around a counter.
    // Dissipate slow residual rocking after input stops, even while the last
    // proximity changes finish.
    // Keep fast approaches and free flight under the ordinary spring dynamics.
    if (
      ball &&
      (blocked || letters.some((l) => supported.has(l.body))) &&
      !held &&
      !ballEscape &&
      performance.now() > axisInputUntil &&
      ballSpring().distance < heroFontSize * 0.5
    ) {
      const parked = ball.speed < BALL_REST_SPEED &&
        !letters.some((l) => l.axisBurstStage >= 0);
      Body.setVelocity(ball, {
        x: ball.velocity.x * 0.5,
        y: ball.velocity.y * 0.5,
      });
      for (const l of letters)
        if (supported.has(l.body)) {
          const b = l.body;
          // A stationary cursor's supported group must dissipate faster
          // residual jitter too, rather than stay above this cutoff forever.
          if (parked || (
            b.speed < Math.max(1, typeScale) &&
            Math.abs(b.angularVelocity) * l.motionRadius <
              Math.max(1, typeScale)
          )) {
            Body.setVelocity(b, {
              x: b.velocity.x * 0.5,
              y: b.velocity.y * 0.5,
            });
            Body.setAngularVelocity(b, b.angularVelocity * 0.5);
          }
        }
    }
    // After a drag, a settled cluster can keep exchanging tiny collision
    // impulses while every spring is already in its home neighbourhood. Apply
    // the same contact dissipation used for a parked ball before the final
    // quiet-frame snap. Free flight, active waves and held letters keep their
    // original response; no body is moved by this damping.
    if (
      !ball &&
      !held &&
      performance.now() > axisInputUntil &&
      swapTick - dragEndedAt > 30 &&
      swapTick - dragEndedAt < 600 &&
      !letters.some((l) => l.axisBurstStage >= 0) &&
      letters.every(
        (l) =>
          Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
            Math.abs(l.body.angle) * l.size <
          heroFontSize * 0.25,
      )
    ) {
      for (const l of letters)
        // Free letters already use a critically damped home spring. Stacking
        // contact dissipation on top makes their last few pixels decay slowly.
        if (!l.nudged && hullPairsByBody.has(l.body)) {
          const b = l.body;
          Body.setVelocity(b, {
            x: b.velocity.x * 0.65,
            y: b.velocity.y * 0.65,
          });
          Body.setAngularVelocity(b, b.angularVelocity * 0.65);
        }
    }
    // Square corners retain slightly more subpixel contact chatter than a circle.
    // Free flight keeps the stricter threshold; solved contacts freeze once quiet.
    const contactQuiet = Math.max(QUIET_MOTION, 0.25 * typeScale);
    // Contact resolution can leave a normalized velocity on a visibly stationary body.
    // Judge solved contacts by pose change; free flight also needs speed/distance to settle.
    if (
      ball &&
      (Math.hypot(
        ball.position.x - previousBall.x,
        ball.position.y - previousBall.y,
      ) > (blocked ? contactQuiet : QUIET_MOTION) ||
        (!blocked &&
          (ball.speed > BALL_REST_SPEED ||
            ballSpring().distance > BALL_REST_DISTANCE)))
    )
      moving = true;
    for (const l of letters) {
      const b = l.body,
        prev = l.prev;
      const motion =
        Math.hypot(b.position.x - prev.x, b.position.y - prev.y) +
        Math.abs(b.angle - prev.angle) * l.motionRadius;
      const away =
        Math.hypot(b.position.x - l.hx, b.position.y - l.hy) +
        Math.abs(b.angle) * l.size;
      // At home, neighbouring glyphs can produce subpixel solver chatter. Let the final
      // 3px settle together, then freeze/snap once quiet for half a second.
      const homeRest =
        away < LETTER_REST_AWAY &&
        b.speed < LETTER_REST_SPEED &&
        Math.abs(b.angularVelocity) * l.size < LETTER_REST_SPEED;
      if (
        l.falling ||
        l.nudged ||
        (!homeRest &&
          (motion > (supported.has(b) ? contactQuiet : QUIET_MOTION) ||
            (!supported.has(b) && away > 0.5)))
      )
        moving = true;
    }
    quietFrames = moving ? 0 : quietFrames + 1;
    if (quietFrames < QUIET_FRAMES) return true;
    // Freeze the solved contact pose, preserving a letter displaced by the stationary ball.
    // Only unblocked letters already at home get the final subpixel snap. There is no scheduled
    // frame after this; pointer movement, scroll, click, touch, or layout changes wake the engine.
    for (const l of letters) {
      const b = l.body;
      if (!supported.has(b)) {
        Body.setPosition(b, { x: l.hx, y: l.hy });
        Body.setAngle(b, 0);
      }
      Body.setVelocity(b, { x: 0, y: 0 });
      Body.setAngularVelocity(b, 0);
      l.ax = l.ay = l.aa = 0;
    }
    if (ball) Body.setVelocity(ball, { x: 0, y: 0 });
    return false;
  }

  // Real forces let the solver balance home springs and parked-ball contacts together.
  if (engine)
    Matter.Events.on(engine, "beforeUpdate", ({ delta }) => {
      chaseBall(delta);
      if (held && grab) {
        const b = held.body,
          bottom = Math.max(...b.vertices.map((v) => v.y));
        grab.pointA.x = touchPointer.x + viewport.x;
        // Project the spring target, never the body. Recheck each substep as the glyph
        // rotates, so an unreachable pointer cannot fight the final contact solve.
        grab.pointA.y =
          held.isHero && floor
            ? Math.min(
                touchPointer.y + viewport.y,
                floor.bounds.min.y -
                  (bottom - b.position.y - grab.pointB.y) -
                  b.slop,
              )
            : touchPointer.y + viewport.y;
      }
      for (const l of letters) {
        l.body.force.x += (l.body.mass * l.ax) / (FRAME_MS * FRAME_MS);
        l.body.force.y += (l.body.mass * l.ay) / (FRAME_MS * FRAME_MS);
        l.body.torque += (l.body.inertia * l.aa) / (FRAME_MS * FRAME_MS);
      }
    });
  const floorPairs = [],
    floorBodies = [];
  function solveFloor(delta) {
    if (!floor) return;
    floorPairs.length = floorBodies.length = 0;
    for (const l of letters) {
      const b = l.body;
      if (
        !l.isHero ||
        !b.vertices.some((v) => v.y > floor.bounds.min.y + 0.001)
      )
        continue;
      let deepest = null;
      for (const part of b.parts.length > 1 ? b.parts.slice(1) : b.parts) {
        if (part.vertices.length < 3 || part.bounds.max.y <= floor.bounds.min.y ||
          part.bounds.max.x < floor.bounds.min.x || part.bounds.min.x > floor.bounds.max.x) continue;
        const collision = Collision.collides(part, floor);
        if (collision && (!deepest || collision.depth > deepest.depth))
          deepest = collision;
      }
      if (!deepest) continue;
      // All parts share one rigid body. Solving differing floor depths together
      // averages them, leaving the lowest part below the surface; use its contact.
      const pair = Pair.create(deepest, engine.timing.timestamp);
      pair.slop = 0;
      floorPairs.push(pair);
      // Fresh contacts must not apply the main solve's cached position impulse twice.
      b.positionImpulse.x = b.positionImpulse.y = b.totalContacts = 0;
      floorBodies.push(b);
    }
    if (!floorPairs.length) return;
    floorBodies.push(floor);
    // Refine the actual surface contacts after the shared solve/last grab pass. This
    // is Matter's contact solver, not a body clamp, and retains impact velocities.
    Resolver.preSolvePosition(floorPairs);
    for (let i = 0; i < 20; i++) Resolver.solvePosition(floorPairs, delta, 0.5);
    Resolver.postSolvePosition(floorBodies);
  }
  if (engine)
    Matter.Events.on(engine, "afterUpdate", ({ delta }) => {
      containBallLetters();
      solveFloor(delta);
      noteBallHits();
      // First impact hands the letter back to its home spring. A falling letter can also
      // land on a settled neighbour, so a crowded entrance still finishes naturally.
      for (const pair of engine.pairs.list)
        if (pair.isActive) {
          const a = letterOf.get(pair.collision.parentA),
            b = letterOf.get(pair.collision.parentB);
          if (a) a.axisCollision = true;
          if (b) b.axisCollision = true;
          const relative =
            Math.hypot(
              (a?.axisVX ?? pair.collision.parentA.velocity.x) -
                (b?.axisVX ?? pair.collision.parentB.velocity.x),
              (a?.axisVY ?? pair.collision.parentA.velocity.y) -
                (b?.axisVY ?? pair.collision.parentB.velocity.y),
            ) / typeScale;
          if (a)
            a.axisCollisionSpeed = Math.max(a.axisCollisionSpeed, relative);
          if (b)
            b.axisCollisionSpeed = Math.max(b.axisCollisionSpeed, relative);
          if (
            a?.falling &&
            (pair.collision.parentB === floor || (b && !b.falling))
          )
            a.falling = false;
          if (
            b?.falling &&
            (pair.collision.parentA === floor || (a && !a.falling))
          )
            b.falling = false;
        }
    });

  function simulateLetters() {
    if (ball) {
      previousBall.x = ball.position.x;
      previousBall.y = ball.position.y;
    }
    for (const l of letters) {
      l.axisVX = l.body.velocity.x;
      l.axisVY = l.body.velocity.y;
      l.axisCollision = false;
      l.axisCollisionSpeed = 0;
    }
    const contacts = ballContacts(),
      supported = restingContacts(contacts);
    if (ball) {
      const spring = ballSpring(),
        blocked = letters.some((l) => contacts.has(l.body));
      if (ballEscape) {
        const { x, y, blockers } = ballEscape;
        const progress = x * ball.position.x + y * ball.position.y,
          radius =
            (Math.abs(x) * ballWidth + Math.abs(y) * ballHeight) / 2 +
            EDGE_MARGIN;
        const cleared =
          !blocked &&
          blockers.every((body) => {
            const bounds = body.bounds;
            return (
              progress >
              x * (x >= 0 ? bounds.max.x : bounds.min.x) +
                y * (y >= 0 ? bounds.max.y : bounds.min.y) +
                radius
            );
          });
        // A one-substep gap inside a concave glyph is not an escape. Retain the
        // tangent force until the whole square clears the moving blocking row.
        if (
          --ballEscape.frames <= 0 ||
          cleared ||
          spring.distance < BALL_ESCAPE_DISTANCE * typeScale
        ) {
          ballEscape = null;
          ballStallFrames = 0;
          ballProgressDistance = spring.distance;
        }
      } else if (
        !blocked ||
        spring.distance < BALL_ESCAPE_DISTANCE * typeScale
      ) {
        ballStallFrames = 0;
        ballProgressDistance = spring.distance;
        ballEscape = null;
      } else {
        if (++ballStallFrames >= BALL_STALL_FRAMES) {
          const stalled =
            ballProgressDistance - spring.distance <
            BALL_ESCAPE_PROGRESS * typeScale;
          ballProgressDistance = spring.distance;
          ballStallFrames = 0;
          if (stalled) {
            const x = -spring.dy / spring.distance,
              y = spring.dx / spring.distance;
            let minX = Infinity,
              maxX = -Infinity,
              minY = Infinity,
              maxY = -Infinity;
            const ux = spring.dx / spring.distance,
              uy = spring.dy / spring.distance,
              reach =
                (Math.abs(ux) * ballWidth + Math.abs(uy) * ballHeight) / 2;
            const blockers = [];
            for (const l of letters) {
              // Include nearby glyphs across the escape lane, not just the first
              // contact. A floor-backed row otherwise sends a square cursor sideways
              // into each next letter before discovering the nearer clear edge.
              const bounds = l.body.bounds;
              const along =
                ux * ((bounds.min.x + bounds.max.x) / 2 - ball.position.x) +
                uy * ((bounds.min.y + bounds.max.y) / 2 - ball.position.y);
              const extent =
                (Math.abs(ux) * (bounds.max.x - bounds.min.x) +
                  Math.abs(uy) * (bounds.max.y - bounds.min.y)) /
                2;
              if (!contacts.has(l.body) && Math.abs(along) > extent + reach)
                continue;
              blockers.push(l.body);
              minX = Math.min(minX, l.body.bounds.min.x);
              maxX = Math.max(maxX, l.body.bounds.max.x);
              minY = Math.min(minY, l.body.bounds.min.y);
              maxY = Math.max(maxY, l.body.bounds.max.y);
            }
            // Take the nearer outside edge of the blocking cluster, even outside the viewport.
            const direction =
              x * (ball.position.x - (minX + maxX) / 2) +
                y * (ball.position.y - (minY + maxY) / 2) >=
              0
                ? 1
                : -1;
            ballEscape = {
              x: x * direction,
              y: y * direction,
              blockers,
              frames: BALL_ESCAPE_FRAMES,
            };
            ballEscapes++;
          }
        }
      }
    }
    if (++swapTick % 15 === 0) swapIdenticalHomes();
    const burstReturning = lastBurst && performance.now() < lastBurst.at + 2600;
    const burstAnimating = letters.some((l) => l.axisBurstStage >= 0);
    // A recovery push is needed only while its pair is blocked. Continuing the
    // full 90-frame orbit after separation can throw a freed glyph into the
    // next row, creating another jam and an expensive recovery cascade.
    for (const l of letters) {
      const n = l.nudged;
      if (!n || n.a !== l || n.untwist) continue;
      let touching = false;
      for (const pair of hullPairsByBody.get(n.a.body) ?? engine.pairs.list) {
        if (
          pair.isActive &&
          ((pair.collision.parentA === n.a.body &&
            pair.collision.parentB === n.b.body) ||
            (pair.collision.parentB === n.a.body &&
              pair.collision.parentA === n.b.body))
        ) {
          touching = true;
          break;
        }
      }
      n.clearFrames = touching ? 0 : (n.clearFrames ?? 0) + 1;
      if (n.clearFrames >= 6) n.a.nudged = n.b.nudged = null;
    }
    for (const l of letters) {
      const b = l.body,
        { x, y } = b.position;
      // Retain the original pop with precise counters, then resume normal drag.
      // Tight entrance contacts reduce visible ink overlap. Once play/recovery
      // takes over, retain the established slop that prevents parked buzzing.
      b.slop = l.entering ? 0.05 : BODY_OPTIONS.slop;
      b.frictionAir =
        engine.timing.timestamp < (l.burstImpulseAt ?? -Infinity) + 120
          ? 0.05
          : BODY_OPTIONS.frictionAir;
      // Gravity owns the drop; a damped home spring catches it on approach. This
      // avoids piling two rows into an unreadable heap before they can find home.
      if (l.falling && y >= l.hy - heroFontSize * 0.4) l.falling = false;
      // Accelerations this frame (px/frame², rad/frame²). They're applied as real forces before
      // every physics substep, so the engine weighs them together with
      // collisions instead of fighting a velocity we overwrote. That's what kept pressed letters buzzing.
      let ax = 0,
        ay = 0,
        aa =
          -b.angle * LETTER_ANGLE_SPRING -
          b.angularVelocity * LETTER_ANGLE_DAMPING;
      // In contact with, or just bumped by the cursor ball? Then it's being played with, not stuck.
      l.mouseNear =
        supported.has(b) || swapTick - (l.ballHitAt ?? -Infinity) < 30;
      if (l === held) {
        // Held by a spring at the grab point (see pointerdown), also solved inside the engine.
        // Just move the spring's other end to the cursor, and cap speed so a fast flick
        // can't tunnel a letter into another.
        const speed = b.speed;
        if (speed > MAX_DRAG_SPEED)
          Body.setVelocity(b, {
            x: (b.velocity.x * MAX_DRAG_SPEED) / speed,
            y: (b.velocity.y * MAX_DRAG_SPEED) / speed,
          });
      } else {
        const settling = l.entering && !l.falling;
        ax +=
          (l.hx - x) * (settling ? 0.04 : LETTER_SPRING) -
          (settling ? b.velocity.x * 0.3 : 0);
        ay += l.falling
          ? heroFontSize * 0.012
          : (l.hy - y) * (settling ? 0.04 : LETTER_SPRING) -
            (settling ? b.velocity.y * 0.3 : 0);
        if (l.entering) aa = -b.angle * 0.025 - b.angularVelocity * 0.2;
        // A recovery nudge must shed momentum once a counter clears: a freed
        // thin glyph otherwise overshoots home into another jam. Use critical
        // damping throughout passive recovery, as well as the final approach
        // after a burst/drag. Active play keeps its original spring response.
        if (
          !l.falling &&
          !l.entering &&
          !held &&
          !ballEscape &&
          performance.now() > axisInputUntil &&
          (l.recovering || (
            !l.nudged &&
            (burstReturning || swapTick - dragEndedAt < 600) &&
            Math.hypot(l.hx - x, l.hy - y) < heroFontSize * 0.2 &&
            b.speed < 3 * Math.max(1, typeScale)
          ))
        ) {
          ax -= b.velocity.x * 0.18;
          ay -= b.velocity.y * 0.18;
          aa -= b.angularVelocity * 0.07;
        }
        if (l.nudged) {
          const n = l.nudged,
            A = n.a.body.position,
            B = n.b.body.position;
          const cx = (A.x + B.x) / 2,
            cy = (A.y + B.y) / 2,
            rx = x - cx,
            ry = y - cy,
            r = Math.hypot(rx, ry) || 1;
          // Swells up and fades out (a sine hump), so it never feels like a bump.
          const f = n.strength * Math.sin(Math.PI * (1 - n.frames / n.total));
          if (n.untwist) {
            // Make room to straighten a rotated glyph caught behind its neighbour.
            ay -= f * l.size * NUDGE_CLEARANCE_SCALE;
            aa -=
              Math.sign(b.angle) * Math.min(Math.abs(b.angle), 1) * f * 0.006;
          } else {
            // Linear travel must scale with type, as bursts and the size-based
            // untwist lift do. A desktop-sized nudge throws small glyphs into
            // the next row; angular acceleration stays independent of font size.
            const push = f * Math.min(1, typeScale);
            ax -= (ry / r) * n.dir * push;
            ay += (rx / r) * n.dir * push;
            aa += n.dir * f * 0.0015;
          }
        }
      }
      l.ax = ax;
      l.ay = ay;
      l.aa = aa;
      if (l.nudged && l.nudged.a === l && --l.nudged.frames <= 0) {
        const n = l.nudged;
        n.a.nudged = n.b.nudged = null;
      }
      // Stuck = not getting any closer to home. A wedged letter jitters rather than sitting still,
      // so judge it by progress over time, not by speed.
      // Tilt counts too: a thin letter jammed at an angle near home is just as stuck.
      const away = Math.hypot(x - l.hx, y - l.hy) + Math.abs(b.angle) * l.size;
      // A letter that landed against a neighbour must eventually use normal unblocking.
      if (
        l.entering &&
        !l.falling &&
        ((away < LETTER_REST_AWAY && b.speed < LETTER_REST_SPEED) ||
          ++l.settleFrames >= ENTRANCE_SETTLE_FRAMES)
      )
        l.entering = false;
      // Leave letters alone while you're playing with them: held, contacted, or anything
      // during a drag and for half a second after (shoved by the dragged letter, or still flying).
      const playing =
        l.entering ||
        burstAnimating ||
        l === held ||
        l.mouseNear ||
        held ||
        swapTick - dragEndedAt < 30;
      if ((l === held || l.mouseNear) && l.nudged) {
        const n = l.nudged;
        n.a.nudged = n.b.nudged = null;
      }
      if (playing || away < LETTER_REST_AWAY) {
        l.stuck = false;
        l.noProgress = 0;
        l.lastAway = away;
        if (away < LETTER_REST_AWAY) l.attempts = 0;
      } else if (l.nudged) {
        l.noProgress = 0;
      } else if (++l.tick % 30 === 0) {
        // Compare against the best distance, so rocking back toward the same
        // blocked pose cannot repeatedly masquerade as progress toward home.
        const improved = away < (l.lastAway ?? Infinity) - 3;
        l.noProgress =
          away >= LETTER_REST_AWAY && !improved ? (l.noProgress || 0) + 1 : 0;
        if (improved) l.lastAway = away;
        l.stuck = l.noProgress >= 2;
        if (l.stuck) nudgeStuck(l, x, y);
      }
    }
    // Predict a conservative upper bound (ignore damping) before choosing solver resolution.
    // At the integrity ceiling, 128 substeps keep relative travel below 6px.
    let remaining = 1;
    const growth = Math.max(
      0,
      ...letters.map((l) => (l.hull?.changed ? l.hull.travel : 0)),
    );
    // Keep the six-pixel world bound. Thin precision belongs to each nearby
    // pair: an unrelated fast ball must not refine every body to one pixel.
    const thinTravelLimit = Math.max(0.4, typeScale);
    const motionBodies = ball ? [...letters, { body: ball, collisionWeight: 1000 }] : letters;
    const geometrySteps = Math.max(
      1,
      ...letters.map((l) => l.hull?.changed ? Math.ceil(l.hull.travel / l.hull.stageTravel) : 1),
    );
    // Bound displacement over the candidate interval, not velocity after a
    // whole frame. A blocked ball has little velocity but a large spring force;
    // using its whole-frame predicted velocity made every contact require up to
    // 128 tiny updates. Solve v*t + a*t² <= distance and recheck after impulses.
    const interval = (speed, acceleration, distance) =>
      2 * distance / (speed + Math.sqrt(speed * speed + 4 * acceleration * distance) || 1);
    while (remaining > 1e-8) {
      const spring = ball && ballSpring(),
        ballAcceleration = ball ? spring.distance * spring.stiffness *
          (ballEscape ? 1 + BALL_ESCAPE_STRENGTH : 1) : 0;
      let letterSpeed = 0, letterAcceleration = 0;
      for (const l of letters) {
        const b = l.body;
        letterSpeed = Math.max(letterSpeed,
          (l === held ? Math.max(MAX_DRAG_SPEED, b.speed) : b.speed) +
          Math.abs(b.angularVelocity) * l.motionRadius);
        letterAcceleration = Math.max(letterAcceleration,
          Math.hypot(l.ax, l.ay) + Math.abs(l.aa) * l.motionRadius);
      }
      let fraction = Math.min(remaining, 1 / MIN_SUBSTEPS, 1 / geometrySteps,
        interval(Math.max(ball?.speed ?? 0, letterSpeed) + growth,
          Math.max(ballAcceleration, letterAcceleration), MAX_SUBSTEP_TRAVEL));
      // Bound relative motion only for pairs that can approach within this
      // update. Summing the fastest unrelated bodies made every letter pay for
      // opposite directions even when those bodies were nowhere near contact.
      for (let ai = 0; ai < motionBodies.length; ai++) for (let bi = ai + 1; bi < motionBodies.length; bi++) {
        const a = motionBodies[ai], b = motionBodies[bi], A = a.body, B = b.body,
          ga = a.hull?.changed ? a.hull.travel : 0, gb = b.hull?.changed ? b.hull.travel : 0,
          gapX = Math.max(0, A.bounds.min.x - B.bounds.max.x, B.bounds.min.x - A.bounds.max.x),
          gapY = Math.max(0, A.bounds.min.y - B.bounds.max.y, B.bounds.min.y - A.bounds.max.y);
        if (Math.max(gapX, gapY) > 2 * MAX_SUBSTEP_TRAVEL + ga + gb) continue;
        let speed = Math.hypot(A.velocity.x - B.velocity.x, A.velocity.y - B.velocity.y) + ga + gb,
          acceleration = 0;
        for (let i = 0; i < 2; i++) {
          const l = i ? b : a;
          if (l.body === ball) acceleration += ballAcceleration;
          else {
            speed += Math.abs(l.body.angularVelocity) * l.motionRadius;
            acceleration += Math.hypot(l.ax, l.ay) + Math.abs(l.aa) * l.motionRadius;
          }
        }
        const weight = Math.min(a.collisionWeight, b.collisionWeight),
          // A wide cursor or a regular-weight stroke cannot tunnel through a
          // thin stroke in a six-pixel relative step: their combined contact
          // width is larger. Reserve fine rigid stepping for two thin strokes;
          // morph stages stay fine around either thin participant.
          twoThin = A !== ball && B !== ball &&
            (a.hull && b.hull ? Math.max(a.collisionWeight, b.collisionWeight) < 400 : weight < 400),
          normalTravel = A === ball || B === ball ? MAX_SUBSTEP_TRAVEL : Math.min(MAX_SUBSTEP_TRAVEL, 6 * typeScale),
          strokeTravel = twoThin ?
            thinTravelLimit * clamp(1 + (weight - 120) / 80, 1, 4.5) : normalTravel;
        fraction = Math.min(fraction, interval(speed, acceleration, strokeTravel + Math.hypot(gapX, gapY)));
      }
      fraction = Math.min(remaining, Math.max(1 / MAX_SUBSTEPS, fraction));
      updateHulls(remaining - fraction < 1e-8 ? 1 : 1 - remaining + fraction);
      // Keep the ordinary two-update solve unchanged. Extra tiny updates
      // already solve contacts repeatedly, so use at least Matter's default
      // iterations instead of multiplying the full 20/12 solve up to 128 times.
      engine.positionIterations = Math.max(6, Math.ceil(40 * fraction));
      engine.velocityIterations = Math.max(4, Math.ceil(24 * fraction));
      Engine.update(engine, FRAME_MS * fraction);
      remaining -= fraction;
    }
    engine.positionIterations = 20;
    engine.velocityIterations = 12;
    return simulationActive(previousBall);
  }

  scope.listen(
    window,
    "pointermove",
    (e) => {
      if (touch?.id === e.pointerId) {
        const now = performance.now(),
          dt = Math.max(FRAME_MS, now - (touch.movedAt ?? touch.at));
        touch.vx = ((e.clientX - touchPointer.x) / dt) * FRAME_MS;
        touch.vy = ((e.clientY - touchPointer.y) / dt) * FRAME_MS;
        touch.movedAt = now;
        touchPointer.x = e.clientX;
        touchPointer.y = e.clientY;
        touch.distance = Math.max(
          touch.distance,
          Math.hypot(e.clientX - touch.x, e.clientY - touch.y),
        );
        quietFrames = 0;
        wake();
      } else aimMouse(e);
    },
    { passive: true },
  );
  scope.listen(document.documentElement, "pointerenter", aimMouse);
  // Window exit deliberately preserves the last target, body, momentum, and visibility.
  scope.listen(document, "pointerdown", (e) => {
    if (reduceMotion.matches || !engine || e.button !== 0 || !e.isPrimary)
      return;
    if (e.pointerType !== "touch" && finePointer.matches) {
      aimMouse(e);
      return;
    }
    if (touch) return;
    // Read scroll before changing touch styles; their layout invalidation must
    // not be synchronously flushed just to place the grab constraint.
    const gx = e.clientX + scrollX, gy = e.clientY + scrollY;
    // A hybrid device can switch from mouse to touch without losing its fine
    // pointer media query. The stale mouse spring must not fight a finger drag.
    if (ball) {
      Composite.remove(engine.world, ball);
      ball = null;
      ballEscape = null;
      ballStallFrames = 0;
      ballProgressDistance = Infinity;
      ballEl?.classList.remove("is-visible");
    }
    touchLayoutPending = !document.documentElement.hasAttribute("data-physics-touch");
    document.documentElement.setAttribute("data-physics-touch", "");
    touch = {
      id: e.pointerId,
      at: performance.now(),
      x: e.clientX,
      y: e.clientY,
      distance: 0,
      target: null,
    };
    touchPointer.x = e.clientX;
    touchPointer.y = e.clientY;
    const el = e.target.closest(".char"),
      l = letters.find((l) => l.el === el);
    if (l) {
      held = l;
      l.falling = l.entering = false;
      l.held = true;
      markBallPlay(l);
      el.classList.add("is-held");
      grab = Constraint.create({
        pointA: { x: gx, y: gy },
        bodyB: l.body,
        pointB: { x: gx - l.body.position.x, y: gy - l.body.position.y },
        length: 0,
        stiffness: GRAB_STIFFNESS,
        damping: GRAB_DAMPING,
      });
      Composite.add(engine.world, grab);
      touch.target = el;
      el.setPointerCapture?.(e.pointerId);
    }
    quietFrames = 0;
    wake();
  });
  function releaseTouch() {
    if (held) {
      held.el.classList.remove("is-held");
      held.held = false;
      markBallPlay(held);
      Composite.remove(engine.world, grab);
      grab = null;
      held = null;
      dragEndedAt = swapTick;
    }
    if (touch?.target?.hasPointerCapture?.(touch.id))
      touch.target.releasePointerCapture(touch.id);
    touch = null;
    if (!signal.aborted) {
      if (measurePending) remeasure();
      else if (translationPending) {
        translationPending = false;
        if (!translateLayout()) remeasure();
      }
    }
    quietFrames = 0;
    wake();
  }
  scope.listen(window, "pointerup", (e) => {
    if (touch?.id !== e.pointerId) return;
    const tap =
      performance.now() - touch.at < TAP_MS &&
      Math.max(
        touch.distance,
        Math.hypot(e.clientX - touch.x, e.clientY - touch.y),
      ) < TAP_DISTANCE;
    touchClick = {
      at: performance.now(),
      dragged: touch.distance >= TAP_DISTANCE,
      target: touch.target,
    };
    releaseTouch();
    if (tap) burst(e.clientX, e.clientY, "touch");
  });
  scope.listen(window, "pointercancel", (e) => {
    if (touch?.id === e.pointerId) releaseTouch();
  });
  scope.listen(window, "blur", releaseTouch);
  scope.listen(
    document,
    "click",
    (e) => {
      const fromTouch =
        e.pointerType === "touch" ||
        e.sourceCapabilities?.firesTouchEvents ||
        (!e.pointerType &&
          touchClick &&
          performance.now() - touchClick.at < 700);
      if (fromTouch) {
        // Preserve native tap links; suppress only the click generated after dragging a glyph link.
        if (touchClick?.dragged && touchClick.target?.closest("a"))
          e.preventDefault();
        touchClick = null;
        return;
      }
      if (e.button === 0 && e.detail > 0) burst(e.clientX, e.clientY, "mouse");
    },
    true,
  );
  scope.listen(
    window,
    "scroll",
    () => {
      viewportDirty = true;
      quietFrames = 0;
      wake();
    },
    { passive: true },
  );
  scope.listen(reduceMotion, "change", () => {
    syncActive();
    if (reduceMotion.matches) {
      releaseTouch();
      touchClick = null;
      cancelAnimationFrame(frame);
      frame = last = acc = 0;
      for (const [el, animation] of ripples) {
        animation.cancel();
        el.remove();
      }
      ripples.clear();
      if (ball) Composite.remove(engine.world, ball);
      ball = null;
      ballEscape = null;
      ballEl?.classList.remove("is-visible");
      for (const el of chars) {
        el.style.transform = "none";
        el.style.removeProperty("font-variation-settings");
        el.style.removeProperty("width");
        el.style.removeProperty("visibility");
      }
      for (const l of letters) if (l.nativeGlyph) restoreNativeGlyph(l);
      for (const el of chars) {
        const glyph = el.querySelector(".char-glyph");
        glyph?.style.removeProperty("transform");
        glyph?.style.removeProperty("font-variation-settings");
      }
      Composite.clear(engine.world, false);
      clearHullPairs();
      floorPairs.length = floorBodies.length = 0;
      letters = [];
      floor = null;
      letterOf.clear();
      layoutKey = "";
      entered = true;
    } else remeasure();
  });

  // One initial measure after fonts/load; later layout requests coalesce and survive a grab.
  let resizeTimer;
  const remeasure = () => {
    viewportDirty = true;
    measurePending = true;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, 120);
  };
  const loaded =
    document.readyState === "complete"
      ? Promise.resolve()
      : new Promise((resolve) =>
          scope.listen(window, "load", resolve, { once: true }),
        );
  let startingLetters = false;
  const startLetters = async () => {
    if (startingLetters) return;
    startingLetters = true;
    prepareLetters();
    const hero = document.querySelector(".hero-name");
    if (engine && hero) {
      // Split the lightweight DOM first. Loading the font model must not delay
      // hydration layout or native scroll restoration for the rest of the page.
      ({
        createGlyphBody,
        glyphGeometryMetrics,
        glyphHullTarget,
        planGlyphHull,
        applyGlyphHull,
        renderGlyphOutline,
        restoreNativeGlyph,
      } = await import("./glyph-hulls.js"));
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    fontsReady = true;
    prepareLetters();
    remeasure();
  };
  Promise.all([typographyReady(), loaded])
    .then(scope.guard(startLetters))
    .catch(
      scope.guard(() => {
        // A failed font download leaves readable static text; loadingdone can retry setup.
        for (const [el] of originals) el.setAttribute("data-font-ready", "");
        for (const el of chars) el.style.removeProperty("visibility");
      }),
    );
  scope.listen(document.fonts, "loadingdone", (event) => {
    if (
      !event.fontfaces.some(
        (face) => face.family.replaceAll(/['"]/g, "") === "Google Sans Flex",
      )
    )
      return;
    typographyReady().then(
      scope.guard(() => {
        if (fontsReady) {
          prepareLetters();
          remeasure();
        } else return startLetters();
      }),
    );
  });
  scope.listen(window, "resize", remeasure);
  function translateLayout() {
    if (!fontsReady || !letters.length || letters.length !== chars.length) return false;
    viewportDirty = true;
    readViewport();
    const anchors = letters.map((l) => l.el.parentElement.getBoundingClientRect());
    for (let i = 0; i < letters.length; i++) {
      const l = letters[i], a = anchors[i], old = l.layoutAnchor;
      if (!old || Math.abs(a.width - old.width) > 0.1 || Math.abs(a.height - old.height) > 0.1 ||
        l.el.parentElement.getAnimations().some((animation) => animation.playState === "running")) return false;
    }
    // Body-height changes (for example the first-touch scroll link) usually
    // translate the footer only. Parent layout boxes ignore the inner physics
    // transform; preserve bodies and poses when their dimensions are unchanged.
    for (let i = 0; i < letters.length; i++) {
      const l = letters[i], a = anchors[i], old = l.layoutAnchor,
        x = a.left + viewport.x, y = a.top + viewport.y,
        dx = x - old.left, dy = y - old.top;
      if (dx || dy) {
        if (l !== held) {
          Body.setPosition(l.body, { x: l.body.position.x + dx, y: l.body.position.y + dy });
          l.prev.x += dx; l.prev.y += dy;
        }
        l.hx += dx; l.hy += dy; l.ox += dx; l.oy += dy;
        l.homeBounds.min.x += dx; l.homeBounds.max.x += dx;
        l.homeBounds.min.y += dy; l.homeBounds.max.y += dy;
        old.left = x; old.top = y;
      }
    }
    const foot = document.querySelector(".hero-foot"), y = foot?.getBoundingClientRect().top + viewport.y;
    if (floor && Number.isFinite(y) && measuredFloorY !== null) {
      const dy = y - measuredFloorY;
      if (dy) Body.setPosition(floor, { x: floor.position.x, y: floor.position.y + dy });
      measuredFloorY = y;
    }
    wake();
    return true;
  }
  const observer = new ResizeObserver(() => {
    if (held) translationPending = true;
    else if (!translateLayout()) remeasure();
  });
  observer.observe(document.body);
  scope.cleanup(() => observer.disconnect());

  scope.cleanup(() => {
    releaseTouch();
    Matter.Events.off(engine);
    Composite.clear(engine.world, false);
    clearHullPairs();
    Engine.clear(engine);
    floorPairs.length = floorBodies.length = 0;
    letters = [];
    letterOf.clear();
    ball = null;
    ballEscape = null;
    floor = null;
  });
  return {
    engine,
    scope,
    typography: () => ({ ready: fontsReady && !initializingBodies && (reduceMotion.matches || letters.length > 0), measuredWithFont }),
    ...(timeHulls
      ? {
          queueInitialMeasure() {
            if (!letters.length && fontsReady) remeasure();
          },
          forceGlyphPose(l, pose, frames = 1) {
            planGlyphHull(l.hull, glyphHullTarget(l.hull, pose), Infinity, frames);
            applyGlyphHull(l.hull, 1, Bounds);
            l.renderedTransform = null;
            render(1, l);
          },
        }
      : {}),
    hullMetrics: () => ({
      ...hullStats,
      ...glyphGeometryMetrics,
      inputQuietMs: performance.now() - axisInputUntil,
      activeHullPairs: hullContactPairs.size,
      retainedPairs: engine.pairs.list.length,
      allActiveSteps: allActiveTimes.length,
      allActiveMaxMs: Math.max(0, ...allActiveTimes),
      allActiveMeanMs:
        allActiveTimes.reduce((a, b) => a + b, 0) /
        (allActiveTimes.length || 1),
      allActiveP95Ms: allActiveTimes.length
        ? [...allActiveTimes].sort((a, b) => a - b)[
            Math.floor(allActiveTimes.length * 0.95)
          ]
        : 0,
      meanMs: hullStats.totalMs / (hullStats.steps || 1),
      meanUpdateMs: hullStats.changedMs / (hullStats.changedSteps || 1),
      p95Ms: hullTimes.length
        ? [...hullTimes].sort((a, b) => a - b)[
            Math.floor(hullTimes.length * 0.95)
          ]
        : 0,
    }),
    letters: () => letters,
    floor: () => floor,
    ball: () => ball && { body: ball, solid: true },
    interaction: () => ({
      distance: ball ? ballSpring().distance : 0,
      speed: (ball?.speed ?? 0) * 60,
      springForce,
      lastBurst,
      held: !!held,
      escaping: !!ballEscape,
      ballEscapes,
    }),
    isRunning: () => frame !== 0,
  };
}
