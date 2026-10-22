import { waitForPhysicsFontReady } from "./verify-physics-ready.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { startPreview } from "./preview.ts";

// Pin the frame clock while delivering real CDP touch events. Varying movement
// timing covers the different release poses that made the original drag flaky.
export async function verifyTouchReturn(
  browser: Browser,
  url: string,
  stepMs = 35,
  setup: "full" | "tap" | "plain" = "full",
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const clockStart = new Date("2026-10-13T00:00:00Z");
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
    await page.goto(url + "/?verify");
    await waitForPhysicsFontReady(page);
    await page.clock.runFor(3000);
    await page.waitForFunction(
      () => (window as any).__portfolioPhysics?.letters().length === 18,
    );
    const cdp = await context.newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      points: { x: number; y: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const point = await page.evaluate(() => {
      const l = (window as any).__portfolioPhysics.letters()[2];
      return { x: l.hx, y: l.hy };
    });
    if (setup !== "plain") {
      await touch("touchStart", [point]);
      await page.clock.runFor(35);
      await touch("touchEnd", []);
    }
    await page.clock.runFor(3135);
    if (setup === "full") {
      await touch("touchStart", [point]);
      await page.clock.runFor(350);
      await touch("touchEnd", []);
    }
    await page.clock.runFor(1350);
    await touch("touchStart", [point]);
    assert.equal(await page.locator(".char.is-held").count(), 1);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", [{ x: point.x + i * 5, y: point.y - i * 12 }]);
      await page.clock.runFor(stepMs);
    }
    await touch("touchEnd", []);
    const release = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics;
      return p.letters().map((l: any) => ({
        char: l.el.textContent,
        x: l.body.position.x,
        y: l.body.position.y,
        hx: l.hx,
        hy: l.hy,
        angle: l.body.angle,
        velocity: { ...l.body.velocity },
        angularVelocity: l.body.angularVelocity,
        entering: !!l.entering,
        falling: !!l.falling,
        nudged: !!l.nudged,
        attempts: l.attempts ?? 0,
      }));
    });
    const samples = [];
    for (let seconds = 1; seconds <= 10; seconds++) {
      await page.clock.runFor(1000);
      const sample = await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics;
        return {
          running: p.isRunning(),
          letters: p
            .letters()
            .slice(0, 13)
            .map((l: any) => ({
              char: l.el.textContent,
              away:
                Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy) +
                Math.abs(l.body.angle) * l.size,
              angle: l.body.angle,
              speed: l.body.speed,
              entering: !!l.entering,
              falling: !!l.falling,
              nudged: !!l.nudged,
              attempts: l.attempts ?? 0,
              noProgress: l.noProgress ?? 0,
              pose: l.hull?.pose,
              stage: l.axisBurstStage,
              impact: l.axisImpactFrames,
              travel: l.hull?.travel,
              hullChanged: l.hull?.changed,
              axes: l.axes,
            })),
          floorContacts: p.engine.pairs.list.filter(
            (pair: any) =>
              pair.isActive &&
              (pair.collision.parentA === p.floor() ||
                pair.collision.parentB === p.floor()),
          ).length,
        };
      });
      samples.push({ seconds, ...sample });
      if (!sample.running) break;
    }
    const result = { stepMs, setup, release, samples, browserErrors: errors };
    await writeFile(
      `.verify/touch-return-${setup}-${stepMs}.json`,
      JSON.stringify(result, null, 2),
    );
    await page.screenshot({
      path: `.verify/touch-return-${setup}-${stepMs}.png`,
    });
    assert.deepEqual(errors, []);
    const last = samples.at(-1)!;
    assert.ok(
      !last.running && last.letters.every((l: { away: number }) => l.away < 3),
      `Touch drag ${setup}/${stepMs}ms steps returns home within 10s: ${JSON.stringify(last)}`,
    );
    return { setup, stepMs, homeAfterMs: last.seconds * 1000 };
  } finally {
    await context.close();
  }
}

export async function verifyTouchReturns(
  browser: Browser,
  url: string,
  repeat = 1,
) {
  const results = [],
    failures: string[] = [];
  for (let run = 1; run <= repeat; run++) {
    for (const setup of ["full", "tap", "plain"] as const)
      for (const stepMs of [35, 30, 40, 25, 50, 20]) {
        try {
          results.push({
            run,
            ...(await verifyTouchReturn(browser, url, stepMs, setup)),
          });
        } catch (error) {
          failures.push(`run ${run}: ${setup}/${stepMs}: ${error}`);
        }
      }
  }
  await writeFile(
    ".verify/touch-return-report.json",
    JSON.stringify({ results, failures }, null, 2),
  );
  assert.deepEqual(
    failures,
    [],
    `Touch return failures: ${failures.join("\n")}`,
  );
  return results;
}

if (import.meta.main) {
  const preview = await startPreview(),
    browser = await chromium.launch({ headless: true });
  try {
    const repeat = Number(
      process.argv
        .find((arg) => arg.startsWith("--repeat="))
        ?.slice("--repeat=".length) ?? 1,
    );
    assert.ok(
      Number.isInteger(repeat) && repeat > 0,
      "--repeat must be a positive integer",
    );
    const results = await verifyTouchReturns(browser, preview.url, repeat);
    console.log(
      `Verified ${results.length} touch-return cases; longest settle: ${Math.max(...results.map((r) => r.homeAfterMs))}ms.`,
    );
  } finally {
    await browser.close();
    await preview.close();
  }
}
