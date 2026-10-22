import { waitForPhysicsFontReady } from "./verify-physics-ready.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";

type Watch = (page: Page, label: string) => () => string[];
export async function verifyHulls(browser: Browser, url: string, watch: Watch) {
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: true,
        isMobile: width === 390,
      }),
      check = watch(page, `hulls ${width}`);
    try {
      await page.clock.install({ time: new Date("2026-10-20T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-20T00:00:01Z"));
      await page.goto(url + "/?verify&debug");
      await waitForPhysicsFontReady(page);
      await page.clock.runFor(180);
      const original = await page.evaluate(() =>
        (window as any).__portfolioPhysics
          .letters()
          .filter((l: any) => l.hull)
          .map((l: any) => ({
            id: l.body.id,
            parts: l.body.parts.map((b: any) => b.id),
            mass: l.body.mass,
            inertia: l.body.inertia,
          })),
      );
      let settledAfterMs = 0,
        maxTravel = 0;
      for (let t = 32; t <= 10000; t += 32) {
        await page.clock.runFor(32);
        const state = await page.evaluate(() => {
          const p = (window as any).__portfolioPhysics;
          return {
            running: p.isRunning(),
            travel: Math.max(
              ...p.letters().map((l: any) => l.hull?.travel ?? 0),
            ),
          };
        });
        maxTravel = Math.max(maxTravel, state.travel);
        if (!state.running) {
          settledAfterMs = t;
          break;
        }
      }
      assert.ok(settledAfterMs, "Entrance returns home and sleeps");
      const typeScale = await page
        .locator(".hero-name")
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) / 268.8);
      assert.ok(
        maxTravel <= 12 * typeScale + 0.001,
        `Every entrance hull change respects the boundary travel limit: ${maxTravel} / ${12 * typeScale}`,
      );
      const stability = await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics,
          letters = p.letters().filter((l: any) => l.hull);
        const momentum = () =>
          JSON.stringify(
            letters.map((l: any) => {
              const b = l.body;
              return {
                position: b.position,
                previous: b.positionPrev,
                velocity: b.velocity,
                angle: b.angle,
                previousAngle: b.anglePrev,
                spin: b.angularVelocity,
                masses: b.parts.map((b: any) => [
                  b.mass,
                  b.inverseMass,
                  b.inertia,
                  b.inverseInertia,
                ]),
              };
            }),
          );
        const before = momentum();
        let degenerateParts = 0,
          maxCompactionAreaError = 0;
        const inspectParts = (l: any) => {
          const M = (window as any).Matter;
          for (let i = 0; i < l.hull.mesh.polygons.length; i++) {
            const expected = M.Vertices.area(
                l.hull.mesh.polygons[i].map((id: number) => l.hull.points[id]),
              ),
              actual = M.Vertices.area(l.body.parts[i + 1].vertices);
            maxCompactionAreaError = Math.max(
              maxCompactionAreaError,
              Math.abs(expected - actual) / Math.max(1, expected),
            );
          }
          for (const part of l.body.parts.slice(1))
            if (
              part.vertices.length >= 3 &&
              !((window as any).Matter.Vertices.area(part.vertices) > 0.000001)
            )
              degenerateParts++;
        };
        for (let i = 0; i < 24; i++)
          for (const l of letters) {
            p.forceGlyphPose(l, {
              width: [25, 75, 100, 151][i % 4],
              weight: [120, 400, 760, 1000][i % 4],
              round: (i % 2) * 100,
              grade: i % 3 ? 0 : 100,
              slant: i % 2 ? -10 : 0,
              sx: i % 2 ? 0.72 : 1,
              sy: i % 2 ? 0.8 : 1.2,
              skew: i % 2 ? 20 : 0,
            });
            inspectParts(l);
          }
        // Two almost-coincident corners previously disappeared together in
        // SAT cleanup on a narrow, heavy R under mobile squash/shear.
        for (const l of letters)
          for (const grade of [0, 100]) {
            p.forceGlyphPose(l, {
              width: 25,
              weight: 760,
              round: 0,
              grade,
              slant: 0,
              sx: 0.72,
              sy: 0.8,
              skew: 20,
            });
            inspectParts(l);
          }
        for (const l of letters) {
          p.forceGlyphPose(l, {
            width: 100,
            weight: 760,
            round: 30,
            grade: 0,
            slant: 0,
            sx: 1,
            sy: 1,
            skew: 0,
          });
          inspectParts(l);
        }
        return {
          degenerateParts,
          maxCompactionAreaError,
          momentumPreserved: before === momentum(),
          homeError: Math.max(
            ...letters.map(
              (l: any) =>
                Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
                Math.abs(l.body.angle) * l.size,
            ),
          ),
          current: letters.map((l: any) => ({
            id: l.body.id,
            parts: l.body.parts.map((b: any) => b.id),
            mass: l.body.mass,
            inertia: l.body.inertia,
          })),
        };
      });
      assert.equal(
        stability.degenerateParts,
        0,
        "Collapsed faces cannot remain active SAT barriers",
      );
      assert.ok(
        stability.maxCompactionAreaError < 1e-5,
        "SAT cleanup preserves each baked convex face's filled area",
      );
      assert.ok(
        stability.momentumPreserved,
        "Morphs preserve pose, momentum, mass and inertia",
      );
      assert.deepEqual(
        stability.current,
        original,
        "Bodies and all part slots retain their identities",
      );
      assert.equal(stability.homeError, 0, "Resting letters are exactly home");
      // Restore rest before recording idle writes; forcing poses is a debug-only operation.
      const before = await page.evaluate(
        () => (window as any).__portfolioPhysics.hullMetrics().updates,
      );
      await page.clock.runFor(600);
      assert.equal(
        await page.evaluate(
          () => (window as any).__portfolioPhysics.hullMetrics().updates,
        ),
        before,
        "Sleeping hulls write no vertices",
      );
      await page.screenshot({ path: `.verify/name-hulls-debug-${width}.png` });
      results.push({
        width,
        settledAfterMs,
        maxTravel,
        maxReferenceTravel: maxTravel / typeScale,
        ...stability,
        browserErrors: check(),
      });
    } finally {
      await page.close();
    }
  }
  return results;
}

export async function verifyGlyphTweenBuffers(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.clock.install({ time: new Date("2026-10-20T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-20T00:00:01Z"));
    await page.goto(url + "/?verify");
    await waitForPhysicsFontReady(page);
    await page.clock.runFor(5000);
    const result = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics, l = p.letters()[0], h = l.hull,
        rest = { width: 100, weight: 760, round: 30, grade: 0, slant: 0, sx: 1, sy: 1, skew: 0 };
      p.forceGlyphPose(l, rest);
      p.forceGlyphPose(l, { ...rest, width: 25, weight: 120 }, 4);
      const old = h.points.slice(h.mesh.visibleStart).map((v: any) => ({ ...v }));
      p.forceGlyphPose(l, { ...rest, width: 151, weight: 1000 }, 4);
      let actual = 0, previousError = 0;
      for (let i = 0; i < old.length; i++) {
        const next = h.points[i + h.mesh.visibleStart], previous = h.previous[i + h.mesh.visibleStart];
        actual = Math.max(actual, Math.hypot(next.x - old[i].x, next.y - old[i].y));
        previousError = Math.max(previousError, Math.hypot(previous.x - old[i].x, previous.y - old[i].y));
      }
      return { actualTravel: actual, reportedTravel: h.travel, previousError };
    });
    assert.ok(result.actualTravel > 1, "Reversal exercises a real changing contour");
    assert.ok(Math.abs(result.actualTravel - result.reportedTravel) < 1e-6,
      `Retargeted contour travel stays measurable: ${JSON.stringify(result)}`);
    assert.equal(result.previousError, 0, "Retargeting never overwrites the previous contour");
    return result;
  } finally { await page.close(); }
}

export async function verifyHullPerformance(
  browser: Browser,
  url: string,
  watch: Watch,
) {
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: true,
      isMobile: width === 390,
    });
    const check = watch(page, `hull performance ${width}`);
    try {
      // Deliberately use the real clock: Playwright's fixed clock rounds CPU timings to zero.
      await page.goto(url + "/?verify");
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics?.letters().length === 18,
      );
      await page.waitForTimeout(3000);
      // Two full waves provide enough changed steps at the busy-name cadence.
      for (let wave = 0; wave < 2; wave++) {
        await page.evaluate(() =>
          document.dispatchEvent(
            new MouseEvent("click", {
              clientX: innerWidth * 0.45,
              clientY: innerHeight * 0.35,
              detail: 1,
              bubbles: true,
            }),
          ),
        );
        await page.waitForTimeout(2400);
      }
      const metrics = await page.evaluate(() =>
        (window as any).__portfolioPhysics.hullMetrics(),
      );
      assert.ok(
        metrics.changedSteps > 60 &&
          metrics.updates > 100 &&
          metrics.allActiveSteps > 60,
      );
      await writeFile(
        `.verify/hull-performance-${width}.json`,
        JSON.stringify({ width, ...metrics }, null, 2),
      );
      results.push({ width, ...metrics, browserErrors: check() });
    } finally {
      await page.close();
    }
  }
  await writeFile(
    ".verify/hull-performance.json",
    JSON.stringify(results, null, 2),
  );
  for (const metrics of results) {
    assert.ok(
      metrics.meanMs <= 0.3 + 1e-6 &&
        metrics.allActiveMeanMs <= 0.3 + 1e-6 &&
        metrics.p95Ms <= 1 + 1e-6 &&
        metrics.allActiveP95Ms <= 1 + 1e-6,
      `Hull work per physics step stays below 0.3ms mean / 1ms p95, including when all letters animate: ${JSON.stringify(metrics)}`,
    );
  }
  return results;
}

// Minimal regression for contact motion feeding the axes feeding the contact solver.
// No preceding flick/scroll history is needed: hover a cursor into the b and park it.
export async function verifyParkedHulls(
  browser: Browser,
  url: string,
  watch: Watch,
) {
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const check = watch(page, `parked hulls ${width}`);
    try {
      const start = new Date("2026-10-16T00:00:00Z");
      await page.clock.install({ time: start });
      await page.clock.pauseAt(new Date(start.getTime() + 1000));
      await page.goto(url + "/?verify");
      await waitForPhysicsFontReady(page);
      // A field can puff a free letter without physically supporting it. Burst
      // during the entrance to leave a spring residual, then require the final
      // exact-home snap for letters with no active contact (not merely <0.1px).
      await page.clock.runFor(550);
      const fieldPoint = await page.evaluate((width) => {
        const l = (window as any).__portfolioPhysics.letters()[0];
        const em = parseFloat(
          getComputedStyle(document.querySelector(".hero-name")!).fontSize,
        );
        return { x: 20, y: width === 390 ? l.hy - 1.2 * em : 100 };
      }, width);
      await page.mouse.move(fieldPoint.x, fieldPoint.y);
      await page.mouse.click(fieldPoint.x, fieldPoint.y);
      for (
        let elapsed = 0;
        elapsed < 10000 &&
        (await page.evaluate(() =>
          (window as any).__portfolioPhysics.isRunning(),
        ));
        elapsed += 500
      )
        await page.clock.runFor(500);
      const freeField = await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics,
          touching = new Set();
        for (const pair of p.engine.pairs.list)
          if (pair.isActive) {
            touching.add(pair.collision.parentA);
            touching.add(pair.collision.parentB);
          }
        const free = p
          .letters()
          .filter(
            (l: any) => l.axes.puff.value > 0.01 && !touching.has(l.body),
          );
        return {
          asleep: !p.isRunning(),
          count: free.length,
          error: Math.max(
            0,
            ...free.map(
              (l: any) =>
                Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
                Math.abs(l.body.angle) * l.size,
            ),
          ),
        };
      });
      assert.ok(
        freeField.asleep && freeField.count > 0 && freeField.error < 1e-6,
        `Free puffed letters sleep at exact homes (${width}): ${JSON.stringify(freeField)}`,
      );
      const point = await page.evaluate(() => {
        const l = (window as any).__portfolioPhysics.letters()[2];
        return { x: l.ox, y: l.oy };
      });
      await page.mouse.move(point.x, point.y);
      let parkedAfterMs = 0;
      for (let elapsed = 500; elapsed <= 10000; elapsed += 500) {
        await page.clock.runFor(500);
        if (
          await page.evaluate(
            () => !(window as any).__portfolioPhysics.isRunning(),
          )
        ) {
          parkedAfterMs = elapsed;
          break;
        }
      }
      assert.ok(
        parkedAfterMs,
        "A parked ball and expanded contact group sleep within 10s",
      );
      const before = await page.evaluate(() => ({
        time: (window as any).__portfolioPhysics.engine.timing.timestamp,
        updates: (window as any).__portfolioPhysics.hullMetrics().updates,
      }));
      await page.clock.runFor(1000);
      assert.deepEqual(
        await page.evaluate(() => ({
          time: (window as any).__portfolioPhysics.engine.timing.timestamp,
          updates: (window as any).__portfolioPhysics.hullMetrics().updates,
        })),
        before,
        "Parked solver and hull vertices stay frozen",
      );
      await page.evaluate(() => scrollTo({ top: 2000, behavior: "instant" }));
      await page.mouse.move(20, 100);
      let homeAfterMs = 0;
      for (let elapsed = 500; elapsed <= 10000; elapsed += 500) {
        await page.clock.runFor(500);
        if (
          await page.evaluate(
            () => !(window as any).__portfolioPhysics.isRunning(),
          )
        ) {
          homeAfterMs = elapsed;
          break;
        }
      }
      const homeError = await page.evaluate(() =>
        Math.max(
          ...(window as any).__portfolioPhysics
            .letters()
            .filter((l: any) => l.hull)
            .map(
              (l: any) =>
                Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
                Math.abs(l.body.angle) * l.size,
            ),
        ),
      );
      assert.ok(
        homeAfterMs && homeError < 0.1,
        "Removing the field restores exact homes and sleep",
      );
      results.push({
        width,
        freeField,
        parkedAfterMs,
        homeAfterMs,
        homeError,
        idleVertexWrites: 0,
        browserErrors: check(),
      });
    } catch (error) {
      await page.screenshot({
        path: `.verify/hull-parked-failure-${width}.png`,
      });
      await writeFile(
        `.verify/hull-parked-failure-${width}.json`,
        JSON.stringify(
          await page.evaluate(() => {
            const p = (window as any).__portfolioPhysics;
            return {
              interaction: p.interaction(),
              letters: p.letters().map((l: any) => ({
                char: l.el.textContent,
                position: l.body.position,
                velocity: l.body.velocity,
                angle: l.body.angle,
                spin: l.body.angularVelocity,
                previous: l.prev,
                hx: l.hx,
                hy: l.hy,
                axes: l.axes,
                pose: l.hull?.pose,
                changing: l.hull?.changed,
                contacts: p.engine.pairs.list.filter(
                  (q: any) =>
                    q.isActive &&
                    (q.collision.parentA === l.body ||
                      q.collision.parentB === l.body),
                ).length,
              })),
            };
          }),
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await page.close();
    }
  }
  return results;
}

if (import.meta.main) {
  const preview = await startPreview(),
    browser = await chromium.launch({ headless: true });
  try {
    const watch: Watch = (page, label) => {
      const errors: string[] = [];
      page.on("pageerror", (error) =>
        errors.push(`${label}: ${error.message}`),
      );
      return () => {
        assert.deepEqual(errors, []);
        return errors;
      };
    };
    const parked = await verifyParkedHulls(browser, preview.url, watch);
    await writeFile(
      ".verify/hull-parked.json",
      JSON.stringify(parked, null, 2),
    );
    if (process.argv.includes("--parked-only")) {
      console.log(JSON.stringify(parked, null, 2));
    } else {
      const results = await verifyHulls(browser, preview.url, watch);
      const performance = await verifyHullPerformance(
        browser,
        preview.url,
        watch,
      );
      await writeFile(".verify/hulls.json", JSON.stringify(results, null, 2));
      await writeFile(
        ".verify/hull-performance.json",
        JSON.stringify(performance, null, 2),
      );
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
    await preview.close();
  }
}
