import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { verifyHeroPhysics } from "./verify-hero-physics.ts";
import { startPreview } from "./preview.ts";
import { verifyTouchReturns } from "./verify-touch-return.ts";

type Watch = (page: Page, label: string) => () => string[];
async function ready(page: Page, url: string) {
  await page.goto(url + "/?verify");
  await page.waitForFunction(
    () => (window as any).__portfolioPhysics?.letters().length === 18,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2700);
}
async function home(page: Page, index = 2) {
  return page.evaluate((i) => {
    const l = (window as any).__portfolioPhysics.letters()[i];
    // Identical glyph bodies can trade targets. Input fixtures name a visible layout slot.
    return { x: l.ox - scrollX, y: l.oy - scrollY };
  }, index);
}
async function asleep(page: Page) {
  // Scroll and touch defaults queue their wake event after the input task.
  await page.waitForTimeout(60);
  await page
    .waitForFunction(
      () => !(window as any).__portfolioPhysics.isRunning(),
      {},
      { timeout: 20000 },
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
          interaction: (window as any).__portfolioPhysics.interaction(),
          hulls: (window as any).__portfolioPhysics.hullMetrics(),
          letters: (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({
              char: l.el.textContent,
              index: l.index,
              pose: l.hull?.pose,
              recovering: l.recovering,
              recoverUntil: l.recoverUntil,
              mouseNear: l.mouseNear,
              proximityTarget: l.proximityTarget,
              axisBurstStage: l.axisBurstStage,
              attempts: l.attempts,
              velocity: { ...l.body.velocity },
              angularVelocity: l.body.angularVelocity,
              away: Math.hypot(
                l.body.position.x - l.hx,
                l.body.position.y - l.hy,
              ),
              angle: l.body.angle,
              speed: l.body.speed,
              hull: l.hull && [l.hull.sx, l.hull.sy, l.hull.shear],
              axes: l.axes,
              nudged: !!l.nudged,
              stuck: l.stuck,
              noProgress: l.noProgress,
              x: l.body.position.x,
              y: l.body.position.y,
              hx: l.hx,
              hy: l.hy,
            })),
        }));
      console.log("Sleep timeout", state);
      await writeFile(".verify/sleep-failure-state.json", JSON.stringify(state, null, 2));
      await page.screenshot({ path: ".verify/sleep-failure.png" });
      throw error;
    });
}
async function idleSample(page: Page) {
  return page.evaluate(async () => {
    const p = (window as any).__portfolioPhysics;
    let steps = 0,
      maxMotion = 0;
    const onStep = () => steps++;
    (window as any).Matter.Events.on(p.engine, "afterUpdate", onStep);
    const positions = [
      ...p.letters().map((l: any) => ({ ...l.body.position })),
      p.ball() && { ...p.ball().body.position },
    ];
    await new Promise((resolve) => setTimeout(resolve, 1000));
    [
      ...p.letters().map((l: any) => l.body.position),
      p.ball()?.body.position,
    ].forEach((pos, i) => {
      if (pos && positions[i])
        maxMotion = Math.max(
          maxMotion,
          Math.hypot(pos.x - positions[i].x, pos.y - positions[i].y),
        );
    });
    (window as any).Matter.Events.off(p.engine, "afterUpdate", onStep);
    return {
      steps,
      maxMotion,
      awake: p.isRunning(),
      solid: p.ball()?.solid ?? false,
      displaced: Math.max(
        ...p
          .letters()
          .map((l: any) =>
            Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy),
          ),
      ),
    };
  });
}
// Observe the actual body before/after EVERY solver update, plus every rendered frame.
// An out-of-engine placement is a discontinuity regardless of its distance or timing.
async function startFlight(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).__portfolioPhysics,
      M = (window as any).Matter,
      body = p.ball().body;
    const start = performance.now(),
      origin = { ...body.position };
    let previous = { ...origin },
      before = { ...origin },
      framePosition = { ...origin };
    const sample = {
      peakSpeed: 0,
      maxStepTravel: 0,
      maxFrameTravel: 0,
      externalJump: 0,
      contacts: 0,
      hitSpeed: 0,
      identityChanged: false,
      reach95Ms: 0,
      settledMs: 0,
      frames: [] as any[],
    };
    const onBefore = () => {
      sample.externalJump = Math.max(
        sample.externalJump,
        Math.hypot(body.position.x - previous.x, body.position.y - previous.y),
      );
      before = { ...body.position };
    };
    const onAfter = () => {
      sample.peakSpeed = Math.max(sample.peakSpeed, body.speed * 60);
      sample.maxStepTravel = Math.max(
        sample.maxStepTravel,
        Math.hypot(body.position.x - before.x, body.position.y - before.y),
      );
      previous = { ...body.position };
      for (const pair of p.engine.pairs.list)
        if (
          pair.isActive &&
          (pair.collision.parentA === body || pair.collision.parentB === body)
        ) {
          sample.contacts++;
          sample.hitSpeed = Math.max(sample.hitSpeed, body.speed * 60);
        }
    };
    M.Events.on(p.engine, "beforeUpdate", onBefore);
    M.Events.on(p.engine, "afterUpdate", onAfter);
    let frame = 0;
    function tick() {
      const at = performance.now() - start,
        distance = p.interaction().distance;
      const targetTravel =
        Math.hypot(body.position.x - origin.x, body.position.y - origin.y) +
        distance;
      sample.maxFrameTravel = Math.max(
        sample.maxFrameTravel,
        Math.hypot(
          body.position.x - framePosition.x,
          body.position.y - framePosition.y,
        ),
      );
      framePosition = { ...body.position };
      sample.identityChanged ||= body !== p.ball()?.body;
      if (at > 30 && !sample.reach95Ms && distance < targetTravel * 0.05)
        sample.reach95Ms = at;
      if (at > 30 && !sample.settledMs && distance < 0.3 && body.speed < 0.08)
        sample.settledMs = at;
      sample.frames.push({
        at,
        x: body.position.x,
        y: body.position.y,
        distance,
        speed: body.speed * 60,
      });
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    (window as any).__flightStop = () => {
      cancelAnimationFrame(frame);
      M.Events.off(p.engine, "beforeUpdate", onBefore);
      M.Events.off(p.engine, "afterUpdate", onAfter);
      return { ...sample, finalDistance: p.interaction().distance };
    };
  });
}
async function stopFlight(page: Page) {
  return page.evaluate(() => (window as any).__flightStop());
}
function continuous(flight: any) {
  assert.equal(
    flight.identityChanged,
    false,
    "Scroll/entry/layout keeps the same ball",
  );
  assert.ok(
    flight.externalJump < 0.01,
    `Ball has no out-of-engine position changes: ${flight.externalJump}px`,
  );
  assert.ok(flight.peakSpeed <= 36001, "Integrity speed ceiling");
}
async function startMotion(page: Page) {
  await page.evaluate(() => {
    const p = (window as any).__portfolioPhysics,
      start = performance.now();
    const peaks = p.letters().map(() => 0);
    let viewportOverflow = 0,
      maxSpeed = 0,
      lastAway = 0,
      frame = 0,
      heldStarted = 0,
      heldMs = 0;
    function sample() {
      const now = performance.now();
      if (p.interaction().held) heldStarted ||= now;
      else if (heldStarted) {
        heldMs += now - heldStarted;
        heldStarted = 0;
      }
      let away = 0;
      p.letters().forEach((l: any, i: number) => {
        const b = l.body,
          d = Math.hypot(b.position.x - l.hx, b.position.y - l.hy);
        peaks[i] = Math.max(peaks[i], d);
        away = Math.max(away, d + Math.abs(b.angle) * l.size);
        maxSpeed = Math.max(maxSpeed, b.speed);
        const h = l.homeBounds;
        // Verify the actual compound surfaces. The parent rectangle and swept
        // broadphase bounds can extend beyond the rendered glyph after rotation.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        // Same union bounds without allocating a flattened vertex list and
        // four mapped arrays every frame while observing real-time motion.
        for (let k = b.parts.length > 1 ? 1 : 0; k < b.parts.length; k++)
          for (const v of b.parts[k].vertices) {
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
          }
        if (h.min.x >= scrollX + 6 && h.max.x <= scrollX + innerWidth - 6)
          viewportOverflow = Math.max(
            viewportOverflow,
            scrollX - minX,
            maxX - scrollX - innerWidth,
          );
        if (h.min.y >= scrollY + 6 && h.max.y <= scrollY + innerHeight - 6)
          viewportOverflow = Math.max(
            viewportOverflow,
            scrollY - minY,
            maxY - scrollY - innerHeight,
          );
      });
      if (away > 3) lastAway = performance.now() - start;
      frame = requestAnimationFrame(sample);
    }
    sample();
    (window as any).__motionStop = () => {
      cancelAnimationFrame(frame);
      return {
        peak: Math.max(...peaks),
        peaks,
        maxSpeed,
        viewportOverflow,
        typeScale:
          parseFloat(
            getComputedStyle(document.querySelector(".hero-name")!).fontSize,
          ) / 268.8,
        homeAfterMs: Math.round(lastAway),
        heldMs: Math.round(heldMs),
        returnAfterReleaseMs: Math.round(Math.max(0, lastAway - heldMs)),
        finalAway: Math.max(
          ...p
            .letters()
            .map(
              (l: any) =>
                Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
                Math.abs(l.body.angle) * l.size,
            ),
        ),
      };
    };
  });
}
async function stopMotion(page: Page) {
  return page.evaluate(() => (window as any).__motionStop());
}
function returned(sample: any, deadline = 2600) {
  assert.ok(
    sample.finalAway < 3,
    `Letters return home: ${sample.finalAway}px remaining`,
  );
  assert.ok(
    sample.returnAfterReleaseMs < deadline,
    `Letters return within ${deadline}ms after release: ${sample.returnAfterReleaseMs}ms`,
  );
  assert.equal(
    sample.viewportOverflow,
    0,
    "Visible glyphs stay in the viewport",
  );
  assert.ok(
    sample.maxSpeed <= 38 * Math.max(1, sample.typeScale) + 0.01,
    "Letter velocity stays bounded",
  );
}
async function burstCount(page: Page) {
  return page.evaluate(
    () =>
      (window as any).__portfolioPhysics.interaction().lastBurst?.count ?? 0,
  );
}

export async function verifyBall(browser: Browser, url: string, watch: Watch) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const check = watch(page, "unified mouse");
  try {
    await ready(page, url);
    await page.mouse.move(20, 100);
    await asleep(page);
    const idle = await idleSample(page);
    assert.equal(idle.steps, 0);
    assert.equal(idle.solid, true);
    await startFlight(page);
    await page.mouse.move(320, 100);
    await asleep(page);
    const flick300 = await stopFlight(page);
    continuous(flick300);
    assert.ok(flick300.peakSpeed > 1500 && flick300.reach95Ms < 1000);
    assert.ok(
      Math.max(...flick300.frames.map((f: any) => f.x)) <= 320.3,
      "Damped free flight has no overshoot",
    );
    const flickIdle = await idleSample(page);
    assert.equal(flickIdle.steps, 0);
    assert.equal(flickIdle.maxMotion, 0);
    await startFlight(page);
    const beforeScroll = await page.evaluate(() => ({
      ...(window as any).__portfolioPhysics.ball().body.position,
    }));
    const immediatelyScrolled = await page.evaluate(() => {
      scrollTo({ top: 2000, behavior: "instant" });
      return { ...(window as any).__portfolioPhysics.ball().body.position };
    });
    assert.deepEqual(
      immediatelyScrolled,
      beforeScroll,
      "Scroll changes the target, never the ball position",
    );
    await asleep(page);
    const scroll2000 = await stopFlight(page);
    await writeFile(
      ".verify/ball-scroll-flight.json",
      JSON.stringify(scroll2000, null, 2),
    );
    continuous(scroll2000);
    assert.ok(scroll2000.peakSpeed > flick300.peakSpeed * 3);
    assert.ok(
      scroll2000.reach95Ms > 0 && scroll2000.reach95Ms < 1500,
      `Scroll flight reaches its cursor in 1500ms: ${scroll2000.reach95Ms}ms, ${scroll2000.finalDistance}px remaining`,
    );
    await startFlight(page);
    await page.mouse.move(-20, -20);
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(
        () => (window as any).__portfolioPhysics.ball().solid,
      ),
      true,
    );
    await page.mouse.move(1300, 200);
    await asleep(page);
    const exitReentry = await stopFlight(page);
    continuous(exitReentry);
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.mouse.move(20, 100);
    await asleep(page);

    // Flick across the full viewport through the first row, then back out of the word.
    const collisionY = (await home(page, 2)).y;
    await page.mouse.move(1, collisionY);
    await asleep(page);
    await startFlight(page);
    await page.mouse.move(1439, collisionY);
    await page.waitForTimeout(1000);
    const collision = await stopFlight(page);
    continuous(collision);
    assert.ok(
      collision.contacts > 0 && collision.hitSpeed > 2000,
      "High-speed flight collides with real glyph outlines",
    );
    await page.mouse.move(1, 1);
    await asleep(page);

    const point = await home(page);
    await page.mouse.move(point.x, point.y);
    await asleep(page);
    const parked = await idleSample(page);
    assert.equal(
      parked.steps,
      0,
      "Letter resting on a solid parked ball sleeps",
    );
    assert.equal(parked.maxMotion, 0, "Parked contact has zero oscillation");
    assert.ok(parked.displaced > 5);
    await page.screenshot({ path: ".verify/ball-parked.png" });
    await page.mouse.down();
    await page.mouse.move(point.x + 60, point.y - 100, { steps: 12 });
    const noGrab = await page.evaluate(() => ({
      constraints: (window as any).__portfolioPhysics.engine.world.constraints
        .length,
      held: document.querySelectorAll(".char.is-held").length,
    }));
    assert.deepEqual(noGrab, { constraints: 0, held: 0 });
    await page.mouse.up();
    await page.mouse.move(1, 1);
    await asleep(page);

    const popPoint = await page.evaluate(() => {
      const l = (window as any).__portfolioPhysics.letters()[2];
      return { x: l.ox, y: l.homeBounds.max.y + 25 };
    });
    await page.mouse.move(popPoint.x, popPoint.y);
    await asleep(page);
    const burstInitial = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics;
      return {
        time: performance.now(),
        solverTime: p.engine.timing.timestamp,
        ball: p.ball()?.body.position,
        letters: p
          .letters()
          .map((l: any) => ({
            char: l.el.textContent,
            position: l.body.position,
            home: [l.hx, l.hy],
            velocity: l.body.velocity,
            angle: l.body.angle,
            pose: l.hull?.pose,
          })),
      };
    });
    await startMotion(page);
    await page.mouse.click(popPoint.x, popPoint.y);
    assert.equal(await page.locator(".physics-ripple").count(), 1);
    await page.waitForTimeout(85);
    await page.screenshot({ path: ".verify/mouse-ripple.png" });
    await page.mouse.move(1, 1);
    await page.waitForTimeout(3100);
    const burst = await stopMotion(page);
    await writeFile(
      ".verify/mouse-burst.json",
      JSON.stringify(
        {
          popPoint,
          initial: burstInitial,
          burst,
          final: await page.evaluate(() => {
            const p = (window as any).__portfolioPhysics;
            return {
              time: performance.now(),
              solverTime: p.engine.timing.timestamp,
              letters: p
                .letters()
                .map((l: any) => ({
                  char: l.el.textContent,
                  away: Math.hypot(
                    l.body.position.x - l.hx,
                    l.body.position.y - l.hy,
                  ),
                  angle: l.body.angle,
                  speed: l.body.speed,
                  attempts: l.attempts,
                  nudged: !!l.nudged,
                  axes: l.axes,
                  pose: l.hull?.pose,
                })),
            };
          }),
        },
        null,
        2,
      ),
    );
    returned(burst);
    assert.ok(
      burst.peak / burst.typeScale >= 150 &&
        burst.peak / burst.typeScale <= 300,
      `Type-scaled burst displacement: ${burst.peak}px`,
    );
    await page.mouse.click(1300, 100);
    assert.equal(
      await page.locator(".physics-ripple").count(),
      1,
      "Empty-space click still ripples",
    );
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".physics-ripple").count(), 0);

    await startFlight(page);
    await page.locator(".contact-big a").scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await asleep(page);
    const fullPageFlight = await stopFlight(page);
    continuous(fullPageFlight);
    assert.ok(
      fullPageFlight.finalDistance < 0.3,
      "A full-page flight escapes glyph notches and reaches its free target",
    );
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (e) => {
          if (!(e.target as Element).closest(".contact-big a")) return;
          (window as any).__mailtoDefault = {
            prevented: e.defaultPrevented,
            href: (
              document.querySelector(".contact-big a") as HTMLAnchorElement
            ).href,
          };
          e.preventDefault();
        },
        { once: true },
      );
    });
    const linkPoint = await home(page, 16);
    await page.mouse.click(linkPoint.x, linkPoint.y);
    const mailto = await page.evaluate(() => (window as any).__mailtoDefault);
    assert.equal(mailto?.prevented, false);
    assert.ok(mailto.href.startsWith("mailto:"));
    // A real document navigation, in addition to the mailto default-action check.
    await page.goto(url + "/work/new-form?verify");
    await page.waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
    );
    await page.locator(".wordmark").click();
    await page.waitForURL("**/#top");
    await page.waitForFunction(
      () => document.documentElement.dataset.hydrated === "true",
    );
    check();
    return {
      idle,
      flickIdle,
      hero: await verifyHeroPhysics(browser, url, watch),
      integrity: await verifyIntegrity(browser, url, watch),
      flick300,
      scroll2000,
      exitReentry,
      fullPageFlight,
      collision,
      parked,
      noGrab,
      burst,
      mailto,
      touch: await verifyBallTouch(browser, url, watch),
      touchReturn: await verifyTouchReturns(browser, url),
      reduced: await verifyReduced(browser, url, watch),
      browserErrors: check(),
    };
  } finally {
    await page.close();
  }
}

export async function verifyBallTouch(
  browser: Browser,
  url: string,
  watch: Watch,
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const check = watch(page, "unified touch");
  try {
    await ready(page, url);
    assert.equal(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      true,
    );
    assert.equal(
      await page
        .locator(".hero-name .char")
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      "none",
    );
    assert.equal(
      await page
        .locator(".hero-name .line")
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      "auto",
    );
    assert.equal(
      await page.evaluate(() => (window as any).__portfolioPhysics.ball()),
      null,
      "Touch has no ball",
    );
    const button = await page.locator(".hero-scroll").boundingBox();
    assert.ok(
      button && button.y >= 0 && button.y + button.height <= 844,
      "Scroll anchor is visible on the first screen",
    );
    await page.screenshot({ path: ".verify/touch-scroll-button-390x844.png" });
    const cdp = await context.newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { x: number; y: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const point = await home(page);
    let count = await burstCount(page);
    await startMotion(page);
    await touch("touchStart", [point]);
    await page.waitForTimeout(35);
    await page.evaluate(() =>
      window.addEventListener(
        "pointerup",
        () => {
          const p = (window as any).__portfolioPhysics;
          (window as any).__tapImpulse = {
            ...p.letters()[2].body.velocity,
            speed: p.interaction().lastBurst.speed,
          };
        },
        { once: true },
      ),
    );
    assert.equal(await page.locator(".char.is-held").count(), 1);
    await touch("touchEnd", []);
    assert.equal(await page.locator(".char.is-held").count(), 0);
    assert.equal(await burstCount(page), ++count);
    const impulse = await page.evaluate(() => (window as any).__tapImpulse);
    assert.ok(
      Math.abs(impulse.x) < 0.1 && impulse.y < -impulse.speed * 0.9,
      "Centered native taps pop upward despite coordinate rounding",
    );
    assert.equal(await page.locator(".physics-ripple").count(), 1);
    await page.waitForTimeout(85);
    await page.screenshot({ path: ".verify/touch-ripple.png" });
    await page.waitForTimeout(3100);
    const tapBurst = await stopMotion(page);
    await writeFile(".verify/touch-burst.json", JSON.stringify(tapBurst, null, 2));
    returned(tapBurst);
    assert.ok(
      tapBurst.peak / tapBurst.typeScale >= 150 &&
        tapBurst.peak / tapBurst.typeScale <= 300,
      `Type-scaled touch burst displacement: ${tapBurst.peak}px`,
    );
    await asleep(page);

    await touch("touchStart", [point]);
    await page.waitForTimeout(350);
    await touch("touchEnd", []);
    assert.equal(await burstCount(page), count, "Long press does not burst");
    await asleep(page);
    await startMotion(page);
    await touch("touchStart", [point]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [{ x: point.x + i * 5, y: point.y - i * 12 }]);
      await page.waitForTimeout(35);
    }
    const dragged = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics,
        l = p.letters().find((l: any) => l.held);
      return {
        scroll: scrollY,
        displacement:
          l && Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy),
        constraints: p.engine.world.constraints.length,
      };
    });
    assert.equal(dragged.scroll, 0, "Letter swipe captures scrolling");
    assert.ok(dragged.displacement > 50);
    assert.equal(dragged.constraints, 1);
    await touch("touchEnd", []);
    assert.equal(await burstCount(page), count, "Drag does not burst");
    await asleep(page);
    const dragReturn = await stopMotion(page);
    returned(dragReturn, 10000);

    // Actual touch input starting in the line gap, not on a glyph.
    const gap = await page.evaluate(() => {
      const r = document.querySelector(".hero-name")!.getBoundingClientRect();
      return { x: innerWidth - 8, y: r.top + r.height / 2 };
    });
    assert.equal(
      await page.evaluate(
        (p) => !!document.elementFromPoint(p.x, p.y)?.closest(".char"),
        gap,
      ),
      false,
    );
    await touch("touchStart", [gap]);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", [{ x: gap.x, y: gap.y - i * 18 }]);
      await page.waitForTimeout(25);
    }
    await touch("touchEnd", []);
    await page.waitForTimeout(500);
    const gapScroll = await page.evaluate(() => scrollY);
    assert.ok(gapScroll > 100, "Gap swipe scrolls normally");
    assert.equal(await burstCount(page), count);
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await page.locator(".hero-scroll").tap();
    await page.waitForFunction(
      () =>
        location.hash === "#work" &&
        Math.abs(document.querySelector("#work")!.getBoundingClientRect().top) <
          2,
    );
    const scrollButton = await page.evaluate(() => ({
      y: scrollY,
      hash: location.hash,
    }));
    count = await burstCount(page);
    assert.ok(
      count > 1,
      "Tap on anchor also bursts without interfering with navigation",
    );
    await page.touchscreen.tap(375, 120);
    assert.equal(
      await page.locator(".physics-ripple").count(),
      1,
      "Empty-space touch tap ripples away from letters",
    );
    assert.equal(await burstCount(page), ++count);
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    await page.screenshot({ path: ".verify/touch-contact-390x844.png" });
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (e) => {
          if (!(e.target as Element).closest(".contact-big a")) return;
          (window as any).__touchMailto = !e.defaultPrevented;
          e.preventDefault();
        },
        { once: true },
      );
    });
    const contactPoint = await home(page, 16);
    await touch("touchStart", [contactPoint]);
    await page.waitForTimeout(40);
    await touch("touchEnd", []);
    assert.equal(
      await page.evaluate(() => (window as any).__touchMailto),
      true,
      "Glyph tap preserves its native mailto link",
    );
    // Footer has ordinary scrollable area below and to the right of the letters.
    const footerGap = { x: 380, y: 740 };
    const bottomBefore = await page.evaluate(() => scrollY);
    await touch("touchStart", [footerGap]);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [{ x: 380, y: 740 + i * 10 }]);
      await page.waitForTimeout(30);
    }
    await touch("touchEnd", []);
    await page.waitForTimeout(500);
    const bottomAfter = await page.evaluate(() => scrollY);
    assert.ok(
      bottomAfter < bottomBefore - 20,
      "Footer gap permits scrolling back out",
    );
    await asleep(page);
    const idle = await idleSample(page);
    assert.equal(idle.steps, 0);
    return {
      tapBurst,
      dragged,
      dragReturn,
      gapScroll,
      scrollButton,
      bottomBefore,
      bottomAfter,
      idle,
      browserErrors: check(),
    };
  } finally {
    await context.close();
  }
}
// Controlled integrity fixture: launch at the ceiling into the real small dot glyph.
// Only the fixture's letter home and initial velocity are changed; ball position stays untouched.
async function verifyIntegrity(browser: Browser, url: string, watch: Watch) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const check = watch(page, "ball integrity stress");
  try {
    await ready(page, url);
    await page.mouse.move(20, 100);
    await asleep(page);
    await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics,
        M = (window as any).Matter,
        dot = p.letters()[12];
      dot.hx = 110;
      dot.hy = 100;
      M.Body.setPosition(dot.body, { x: 110, y: 100 });
      dot.homeBounds = {
        min: { ...dot.body.bounds.min },
        max: { ...dot.body.bounds.max },
      };
      M.Body.setVelocity(p.ball().body, { x: 600, y: 0 });
    });
    await startFlight(page);
    await page.mouse.move(320, 100);
    await asleep(page);
    const flight = await stopFlight(page);
    continuous(flight);
    assert.ok(flight.peakSpeed > 33000 && flight.hitSpeed > 25000);
    assert.ok(
      flight.contacts > 0 && flight.maxStepTravel < 6,
      "Ceiling-speed launch hits a small glyph without tunneling",
    );
    check();
    return { ...flight, initialSpeed: 36000, browserErrors: [] };
  } finally {
    await page.close();
  }
}
async function verifyReduced(browser: Browser, url: string, watch: Watch) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage(),
    check = watch(page, "reduced motion physics");
  try {
    await page.goto(url + "/?verify");
    await page.waitForFunction(() => (window as any).__portfolioPhysics);
    await page.mouse.click(150, 150);
    await page.touchscreen.tap(150, 300);
    assert.equal(await page.locator(".physics-ripple").count(), 0);
    assert.equal(
      await page.evaluate(() => (window as any).__portfolioPhysics.ball()),
      null,
    );
    assert.equal(
      await page.evaluate(() => (window as any).__portfolioPhysics.isRunning()),
      false,
    );
    assert.equal(
      await page
        .locator(".char")
        .first()
        .evaluate((el) => getComputedStyle(el).touchAction),
      "auto",
    );
    await page.locator(".hero-scroll").tap();
    await page.waitForFunction(() => location.hash === "#work");
    check();
    return { physics: false, ripple: false, touchCapture: false, anchor: true };
  } finally {
    await context.close();
  }
}

if (import.meta.main) {
  const preview = await startPreview();
  const browser = await chromium.launch({ headless: true });
  try {
    const watch: Watch = (page, label) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("requestfailed", (request) =>
        errors.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      return () => {
        assert.deepEqual(errors, [], label);
        return errors;
      };
    };
    const repeatArg = process.argv.find((arg) =>
      arg.startsWith("--touch-repeat="),
    );
    if (repeatArg) {
      const repeat = Number(repeatArg.slice("--touch-repeat=".length));
      assert.ok(
        Number.isInteger(repeat) && repeat > 0,
        "--touch-repeat must be a positive integer",
      );
      const results = [];
      for (let run = 1; run <= repeat; run++) {
        const result = await verifyBallTouch(browser, preview.url, watch);
        results.push({ run, ...result });
        console.log(
          `Touch run ${run}/${repeat}: returned in ${result.dragReturn.returnAfterReleaseMs}ms after release.`,
        );
      }
      await writeFile(
        ".verify/touch-native-report.json",
        JSON.stringify(results, null, 2),
      );
    } else {
      const report = await verifyBall(browser, preview.url, watch);
      await writeFile(
        ".verify/physics-report.json",
        JSON.stringify(report, null, 2),
      );
      console.log(
        "Verified mouse, touch, reduced motion, square cursor, floor, entrance, burst scaling, and high-speed integrity.",
      );
    }
  } finally {
    await browser.close();
    await preview.close();
  }
}
