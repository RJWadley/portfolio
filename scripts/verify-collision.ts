import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { startPreview } from "./preview.ts";

export async function verifyCollisionPerformance(
  browser: Browser,
  url: string,
) {
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: width===390,
      isMobile: width === 390,
    });
    try {
      await page.goto(url + "/?verify");
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics?.letters().length === 18,
      );
      await page.waitForTimeout(3000);
      await page.evaluate(() => {
        const w = window as any,
          M = w.Matter;
        const detector = M.Detector.collisions,
          update = M.Engine.update;
        w.__collisionInitialParts = w.__portfolioPhysics
          .letters()
          .map((l: any) => ({
            char: l.el.textContent,
            hero: !!l.hull,
            parts: (l.body.parts.length > 1
              ? l.body.parts.slice(1)
              : l.body.parts
            ).filter((p: any) => p.vertices.length >= 3).length,
            allocatedParts:
              l.body.parts.length > 1 ? l.body.parts.length - 1 : 1,
          }));
        const samples: any[] = (w.__collisionSamples = []);
        let collision = 0;
        M.Detector.collisions = function (...args: any[]) {
          const at = performance.now();
          try {
            return detector.apply(this, args);
          } finally {
            collision += performance.now() - at;
          }
        };
        M.Engine.update = function (...args: any[]) {
          collision = 0;
          const at = performance.now(),
            timestamp = args[0].timing.timestamp;
          try {
            return update.apply(this, args);
          } finally {
            samples.push({
              collision,
              engine: performance.now() - at,
              step: Math.floor((timestamp + 1e-6) / (1000 / 60)),
            });
          }
        };
      });
      for (let wave = 0; wave < 2; wave++) {
        if(width===390)await page.touchscreen.tap(width*.45,280);
        else await page.mouse.click(width*.45,315);
        await page.waitForTimeout(2400);
      }
      results.push(
        await page.evaluate((width) => {
          const w = window as any,
            samples = w.__collisionSamples;
          const fixed = new Map<
            number,
            { collision: number; engine: number }
          >();
          for (const s of samples) {
            const group = fixed.get(s.step) ?? { collision: 0, engine: 0 };
            group.collision += s.collision;
            group.engine += s.engine;
            fixed.set(s.step, group);
          }
          const stats = (key: string, rows = samples) => {
            const a = rows
              .map((s: any) => s[key])
              .sort((a: number, b: number) => a - b);
            return {
              count: a.length,
              mean: a.reduce((sum: number, n: number) => sum + n, 0) / a.length,
              p95: a[Math.floor(a.length * 0.95)],
              max: a.at(-1),
            };
          };
          return {
            width,
            initialLetters: w.__collisionInitialParts,
            collisionMs: stats("collision"),
            engineMs: stats("engine"),
            fixedCollisionMs: stats("collision", [...fixed.values()]),
            fixedEngineMs: stats("engine", [...fixed.values()]),
            timingMethod:
              "Real clock, two burst waves. Engine calls are solver substeps; fixed-step values sum their work in 1000/60ms simulation-time buckets.",
            letters: w.__portfolioPhysics.letters().map((l: any) => ({
              char: l.el.textContent,
              hero: !!l.hull,
              parts: (l.body.parts.length > 1
                ? l.body.parts.slice(1)
                : l.body.parts
              ).filter((p: any) => p.vertices.length >= 3).length,
              allocatedParts:
                l.body.parts.length > 1 ? l.body.parts.length - 1 : 1,
              vertices: l.body.parts
                .slice(1)
                .reduce((n: number, p: any) => n + p.vertices.length, 0),
            })),
            hull: w.__portfolioPhysics.hullMetrics(),
          };
        }, width),
      );
    } finally {
      await page.close();
    }
  }
  await writeFile(
    `.verify/collision-${process.env.COLLISION_LABEL ?? "after"}.json`,
    JSON.stringify(results, null, 2),
  );
  return results;
}
if (import.meta.main) {
  const preview = await startPreview({
      directory: process.env.COLLISION_DIRECTORY,
    }),
    browser = await chromium.launch({ headless: true });
  try {
    console.log(
      JSON.stringify(
        await verifyCollisionPerformance(browser, preview.url),
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    await preview.close();
  }
}
