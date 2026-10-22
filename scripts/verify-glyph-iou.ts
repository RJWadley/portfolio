import { waitForPhysicsFontReady } from "./verify-physics-ready.ts";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";
import { verifyNameAxes } from "./verify-name-axes.ts";
const moduleUrl = async (path: string) =>
  "data:text/javascript;base64," +
  Buffer.from(await readFile(path, "utf8")).toString("base64");
export async function installOracle(page: Page) {
  const source = await moduleUrl("app/ui/public/glyph-iou.js");
  await page.evaluate(async (source) => {
    const module = await import(source);
    (window as any).__glyphOracleFactory = module.createGlyphOracle;
    (window as any).__glyphOracle = await module.createGlyphOracle();
  }, source);
}
export function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    p5: sorted[Math.floor(sorted.length * 0.05)],
    median: sorted[Math.floor(sorted.length * 0.5)],
  };
}
export async function verifyGlyphIoU(
  browser: Browser,
  url: string,
  baseline = false,
) {
  const results = [];
  const liveByWidth = new Map<number, any[]>(),
    overlays: any[] = [];
  const installed = new WeakSet<Page>();
  const probe = async (page: Page, scene: string) => {
    if (!installed.has(page)) {
      await installOracle(page);
      installed.add(page);
    }
    const width = page.viewportSize()!.width;
    const samples = await page.evaluate((scene) => {
      const w = window as any;
      w.__glyphWorst ??= [];
      const lower = w.__portfolioPhysics
        .letters()
        .filter((l: any) => l.glyph)
        .slice(6, 9);
      const overlap =
        scene === "drop-impact" &&
        lower.some((l: any) => l.axisImpactFrames > 0)
          ? w.__glyphOracle.overlap(lower)
          : undefined;
      return w.__portfolioPhysics
        .letters()
        .filter((l: any) => l.glyph)
        .map((l: any) => {
          const sample = { ...w.__glyphOracle.sample(l), scene, overlap };
          if (
            w.__glyphWorst.length < 5 ||
            sample.iou < w.__glyphWorst.at(-1).iou
          ) {
            w.__glyphWorst.push({ ...w.__glyphOracle.sample(l, true), scene });
            w.__glyphWorst.sort((a: any, b: any) => a.iou - b.iou);
            w.__glyphWorst.length = Math.min(5, w.__glyphWorst.length);
          }
          return sample;
        });
    }, scene);
    liveByWidth.set(width, [...(liveByWidth.get(width) ?? []), ...samples]);
    const worst = await page.evaluate(() => (window as any).__glyphWorst);
    for (const sample of worst)
      if (
        !overlays.some(
          (s) =>
            s.width === width &&
            s.axes === sample.axes &&
            s.char === sample.char &&
            s.iou === sample.iou,
        )
      )
        overlays.push({ ...sample, width });
  };
  let scenesError: string | undefined, axisScenes;
  try {
    axisScenes = await verifyNameAxes(
      browser,
      url,
      (page, label) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(label + ": " + e.message));
        return () => {
          assert.deepEqual(errors, []);
          return errors;
        };
      },
      probe,
    );
  } catch (error) {
    scenesError = String(error);
  }

  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: true,
      isMobile: width === 390,
    });
    try {
      await page.clock.install({ time: new Date("2026-10-20T00:00:00Z") });
      await page.clock.pauseAt(new Date("2026-10-20T00:00:01Z"));
      await page.goto(url + "/?verify");
      await waitForPhysicsFontReady(page);
      await page.clock.runFor(180);
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics?.letters().length === 18,
      );
      await installOracle(page);
      if (baseline) {
        const oldModel = await moduleUrl(".verify/baseline/glyph-hulls.js");
        await page.evaluate(async (source) => {
          (window as any).__oldHull = await import(source);
        }, oldModel);
      }
      const live: any[] = [...(liveByWidth.get(width) ?? [])];
      for (let i = 0; i < 90; i++) {
        await page.clock.runFor(32);
        live.push(
          ...(await page.evaluate(() =>
            (window as any).__portfolioPhysics
              .letters()
              .filter((l: any) => l.glyph)
              .map((l: any) => ({
                ...(window as any).__glyphOracle.sample(l),
                scene: "entrance",
              })),
          )),
        );
      }
      for (
        let i = 0;
        i < 20 &&
        (await page.evaluate(() =>
          (window as any).__portfolioPhysics.isRunning(),
        ));
        i++
      )
        await page.clock.runFor(1000);
      const rest = await page.evaluate(() =>
        (window as any).__portfolioPhysics
          .letters()
          .filter((l: any) => l.glyph)
          .map((l: any) => (window as any).__glyphOracle.sample(l)),
      );
      const gridSamples = await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics,
          M = (window as any).Matter,
          model = (window as any).__oldHull,
          oracle = (window as any).__glyphOracle,
          out: any[] = [];
        for (const l of p.letters().filter((l: any) => l.glyph)) {
          M.Body.setPosition(l.body, { x: l.ox, y: l.oy });
          M.Body.setAngle(l.body, 0);
          l.el.style.transform = "none";
          for (const width of [25, 75, 100, 151])
            for (const weight of [120, 400, 760, 1000])
              for (const round of [0, 100])
                for (const grade of [0, 100])
                  for (const slant of [0, -10])
                    for (const [sx, sy, skew] of [
                      [1, 1, 0],
                      [1, 1.2, 0],
                      [0.72, 0.8, 20],
                      [0.66, 0.8, 20],
                      [1, 1.2, 20],
                      [1, 0.3, 0],
                    ]) {
                      const pose = {
                        width,
                        weight,
                        round,
                        grade,
                        slant,
                        sx,
                        sy,
                        skew,
                      };
                      if (p.forceGlyphPose) p.forceGlyphPose(l, pose);
                      else {
                        const h = l.hull,
                          t = model.glyphHullTarget(h, pose);
                        model.planGlyphHull(h, t, Infinity, 0.000001);
                        model.applyGlyphHull(h, 1, M.Bounds);
                        l.glyph.style.fontVariationSettings = `"wght" ${weight},"wdth" ${width},"ROND" ${round},"GRAD" ${grade},"slnt" ${slant}`;
                        l.glyph.style.transform = `skewX(${skew}deg) scale(${sx},${sy})`;
                      }
                      const sample = { ...oracle.sample(l), pose };
                      out.push(sample);
                      if (sy === 0.3) continue;
                      (window as any).__staticWorst ??= [];
                      const worst = (window as any).__staticWorst;
                      if (worst.length < 5 || sample.iou < worst.at(-1).iou) {
                        worst.push({ ...oracle.sample(l, true), pose });
                        worst.sort((a: any, b: any) => a.iou - b.iou);
                        worst.length = Math.min(5, worst.length);
                      }
                    }
        }
        return out;
      });
      // Keep the original grid statistics comparable. The added passive escape
      // affine has its own full-axis sweep and independently enforced IoU gate.
      const staticSamples = gridSamples.filter((s: any) => s.pose.sy !== 0.3);
      const recoverySamples = gridSamples.filter((s: any) => s.pose.sy === 0.3);
      const shots = await page.evaluate(() => (window as any).__staticWorst);
      for (const sample of shots) overlays.push({ ...sample, width });
      // Diagnose raster quantization independently. These numbers never replace
      // the primary 4x result or change any pass/fail assertion.
      const highResolutionDiagnostics = baseline
        ? []
        : await page.evaluate(async () => {
            const w = window as any,
              out = [];
            for (const resolution of [8, 16]) {
              const oracle = await w.__glyphOracleFactory(
                undefined,
                resolution,
              );
              for (const sample of w.__staticWorst.filter(
                (s: any) => s.iou < 0.95,
              )) {
                const l = w.__portfolioPhysics
                  .letters()
                  .filter((l: any) => l.glyph)[sample.letterIndex];
                w.__portfolioPhysics.forceGlyphPose(l, sample.pose);
                out.push({
                  ...oracle.sample(l),
                  pose: sample.pose,
                  resolution,
                  primaryIoU: sample.iou,
                });
              }
              oracle.dispose();
            }
            return out;
          });
      const result = {
        highResolutionDiagnostics,
        width,
        scenesError,
        static: stats(staticSamples.map((r: any) => r.iou)),
        recovery: stats(recoverySamples.map((r: any) => r.iou)),
        recoveryWorst: [...recoverySamples].sort((a, b) => a.iou-b.iou).slice(0, 5),
        staticBelow95: staticSamples.filter((s: any) => s.iou < 0.95).length,
        staticWorst: staticSamples
          .sort((a: any, b: any) => a.iou - b.iou)
          .slice(0, 5),
        rest: stats(rest.map((r: any) => r.iou)),
        live: stats(live.map((r) => r.iou)),
        byScene: Object.fromEntries(
          [...new Set(live.map((s) => s.scene))].map((scene) => [
            scene,
            stats(live.filter((s) => s.scene === scene).map((s) => s.iou)),
          ]),
        ),
        peakInkOverlap: Math.max(
          0,
          ...live.map((r) => r.overlap?.overlapArea ?? 0),
        ),
        worst: [...live, ...rest].sort((a, b) => a.iou - b.iou).slice(0, 5),
        references: Object.fromEntries(["nativeIoU", "renderFidelityIoU"].map(field => [field, {
          rest: stats(rest.map((s: any) => s[field] ?? s.iou)),
          static: stats(staticSamples.map((s: any) => s[field] ?? s.iou)),
          recovery: stats(recoverySamples.map((s: any) => s[field] ?? s.iou)),
          live: stats(live.map((s: any) => s[field] ?? s.iou)),
          byScene: Object.fromEntries([...new Set(live.map((s: any) => s.scene))].map(scene => [scene,
            stats(live.filter((s: any) => s.scene === scene).map((s: any) => s[field] ?? s.iou))])),
        }])),
      };
      results.push(result);
      await writeFile(
        `.verify/glyph-iou-${baseline ? "baseline" : "new"}-${width}.json`,
        JSON.stringify({ result, rest, live, staticSamples, recoverySamples }, null, 2),
      );
      console.log(JSON.stringify(result));
    } finally {
      await page.close();
    }
  }
  const name = baseline ? "baseline" : "new";
  for (const width of [1440, 390]) {
    const liveWorst = overlays
      .filter((s) => s.width === width && s.scene)
      .sort((a, b) => a.iou - b.iou)[0];
    if (liveWorst)
      await writeFile(
        `.verify/glyph-iou-${name}-${width}-live-worst.png`,
        Buffer.from(liveWorst.png.split(",")[1], "base64"),
      );
    const worst = overlays
      .filter((s) => s.width === width)
      .sort((a, b) => a.iou - b.iou)
      .slice(0, 5);
    for (const [i, shot] of worst.entries())
      await writeFile(
        `.verify/glyph-iou-${name}-${width}-worst-${i + 1}.png`,
        Buffer.from(shot.png.split(",")[1], "base64"),
      );
  }
  await writeFile(
    `.verify/glyph-iou-${name}.json`,
    JSON.stringify(
      {
        alphaThreshold: 128,
        rasterPixelsPerDevicePixel: 4,
        percentileDefinition: "sorted[floor(N * p)]",
        affinePoses: [
          [1, 1, 0],
          [1, 1.2, 0],
          [0.72, 0.8, 20],
          [0.66, 0.8, 20],
          [1, 1.2, 20],
        ],
        recoveryAffinePoses: [[1, 0.3, 0]],
        metric:
          "IoU = pixels(glyph ∩ union(Matter parts)) / pixels(glyph ∪ union(Matter parts)); alpha >= 128; 4 raster pixels per device pixel; computed font axes and nested CSS transforms; no viewport clipping",
        results,
        scenesError,
        axisScenes,
      },
      null,
      2,
    ),
  );
  if (!baseline) {
    for (const r of results) {
      assert.ok(r.rest.min! >= 0.95, "Rest glyph IoU >= .95");
      assert.ok(r.static.p5! >= 0.95, "Static grid p5 glyph IoU >= .95");
      assert.ok(r.recovery.p5! >= 0.95, "Passive recovery grid p5 glyph IoU >= .95");
      assert.ok(r.live.p5! >= 0.95, "Live p5 glyph IoU >= .95");
      assert.ok(
        Object.values(r.byScene).every(
          (scene) => (scene as ReturnType<typeof stats>).p5! >= 0.95,
        ),
        "Each live scene independently reaches p5 glyph IoU >= .95",
      );
      // Keep the original native-font/collision bars, and independently verify
      // that baked contour rendering still represents that font. The primary
      // metric above always measures what the DOM actually draws.
      for (const [name, metric] of Object.entries(r.references)) {
        assert.ok(metric.rest.min! >= .95, `${name}: rest minimum >= .95`);
        for (const sweep of [metric.static, metric.recovery, metric.live,
          ...(Object.values(metric.byScene) as ReturnType<typeof stats>[])])
          assert.ok(sweep.p5! >= .95, `${name}: every sweep/scene p5 >= .95`);
      }
      const reference = JSON.parse(
        await readFile("scripts/fixtures/glyph-iou-baseline.json", "utf8"),
      ).results.find((b: any) => b.width === r.width);
      assert.ok(
        r.peakInkOverlap <= reference.peakInkOverlap,
        "Rendered entrance impact overlap does not regress from the preserved baseline",
      );
    }
    assert.equal(scenesError, undefined, "Existing axis scenes complete");
  }
  return { results, axisScenes };
}
if (import.meta.main) {
  await mkdir(".verify", { recursive: true });
  const preview = await startPreview({
      directory: process.argv.includes("--baseline")
        ? ".verify/baseline/dist"
        : undefined,
    }),
    browser = await chromium.launch({ headless: true });
  try {
    await verifyGlyphIoU(
      browser,
      preview.url,
      process.argv.includes("--baseline"),
    );
  } finally {
    await browser.close();
    await preview.close();
  }
}
