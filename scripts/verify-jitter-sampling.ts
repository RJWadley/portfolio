import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { assertJitter, installSampler, runJitterFor, summarizeJitter } from "./verify-jitter.ts";
import { startPreview } from "./preview.ts";

async function audit(page: Page, scene: string, from: number) {
  const pairs = await page.evaluate((from) => {
    const w = window as any;
    return w.__glyphJitter.samples.slice(from).map((sample: any) => ({
      sample, completed: w.__completedJitterFrames[sample.at],
    }));
  }, from);
  assert.ok(pairs.length > 0, `The sampler observes ${scene} frames`);
  for (const { sample, completed } of pairs) {
    assert.ok(completed, `An independent completed-frame witness exists at ${sample.at}`);
    assert.equal(sample.at, completed.at, "Raster and completed render have the same frame timestamp");
    assert.equal(sample.scene, scene, "A completed frame keeps its input scene");
    assert.ok(sample.at >= sample.sceneAt, "No previous rendered pose is relabeled with a later scene");
    assert.equal(sample.solver, completed.solver, "Raster sampling follows the completed solver tick");
    for (const [i, row] of sample.rows.entries()) {
      const rendered = completed.rows[i];
      assert.deepEqual(row.body, rendered.body, "The sampled body matches the completed frame");
      assert.equal(row.glyphTransform, rendered.transform, "Raster sampling sees the completed DOM transform");
      assert.equal(row.held, rendered.held, "Capture retains the completed grab/release state");
      assert.ok(rendered.anchorGap < .01, "First-touch layout correction precedes raster sampling");
    }
  }
  return pairs;
}

export async function verifyJitterSampling(browser: Browser, url: string) {
  await mkdir(".verify", { recursive: true });
  const results = [];
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const start = new Date("2026-10-15T00:00:00Z");
      await page.clock.install({ time: start });
      await page.clock.pauseAt(new Date(+start + 1000));
      await page.goto(url + "/?verify");
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => (window as any).__portfolioPhysics?.letters().length ?? 0), 0,
        "The observer is installed before the initial world is published");
      // Observe the real DOM/body state after every application rAF callback,
      // including its promise continuations. Later callbacks overwrite the same
      // frame's witness. This never reads the sampler or assumes callback order.
      await page.evaluate(() => {
        const w = window as any, raf = window.requestAnimationFrame.bind(window);
        w.__completedJitterFrames = {};
        window.requestAnimationFrame = callback => raf(now => {
          callback(now);
          queueMicrotask(() => {
            const p = w.__portfolioPhysics;
            if (p?.letters().length !== 18) return;
            w.__completedJitterFrames[now] = { at: now, solver: p.engine.timing.timestamp,
              rows: p.letters().filter((l: any) => l.glyph).map((l: any) => ({
                body: { ...l.body.position }, held: !!l.held,
                transform: getComputedStyle(l.el).transform,
                anchorTop: l.layoutAnchor.top,
                anchorGap: Math.abs(l.el.parentElement.getBoundingClientRect().top + scrollY - l.layoutAnchor.top),
              })) };
          });
        });
      });
      await installSampler(page);
      for (let elapsed = 0; elapsed < 2000; elapsed += 32) {
        await runJitterFor(page, 32);
        if (await page.evaluate(() => (window as any).__glyphJitter.samples.length >= 2)) break;
      }
      const startup = await audit(page, "drop-impact", 0);
      // Advance uncaptured idle time only in this ordering regression. The full
      // jitter suite uses runJitterFor for every frame of every existing scene.
      await page.clock.runFor(10000);
      assert.equal(await page.evaluate(() => (window as any).__portfolioPhysics.isRunning()), false,
        "The grab wakes an actually sleeping engine");
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute("data-physics-touch")), false);
      // Make first-touch layout correction observable on both viewport sizes.
      await page.addStyleTag({ content: "[data-physics-touch] .hero-name { translate: 0 12px; }" });
      const point = await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics, l = p.letters()[11];
        return { x: l.body.position.x, y: l.body.position.y, size: l.size,
          anchorTop: l.layoutAnchor.top, solver: p.engine.timing.timestamp };
      });
      const scene = (name: string) => page.evaluate(name => {
        const s = (window as any).__glyphJitter;
        s.scene = name; s.sceneAt = performance.now();
        return s.samples.length;
      }, name);
      const dragStart = await scene("grab-drag"), cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
      assert.equal(await page.locator(".char.is-held").count(), 1);
      const provisionalGap = await page.evaluate(() => {
        const l = (window as any).__portfolioPhysics.letters()[11];
        return l.el.parentElement.getBoundingClientRect().top + scrollY - l.layoutAnchor.top;
      });
      assert.ok(Math.abs(provisionalGap) > 1, "First touch creates a real layout/body mismatch before its frame");
      await runJitterFor(page, 16);
      const wake = await audit(page, "grab-drag", dragStart);
      assert.equal(wake.length, 1, "The first wake frame is retained");
      assert.ok(wake[0].sample.solver > point.solver, "The first grab sample includes the woken physics step");
      assert.ok(Math.abs(wake[0].completed.rows[11].anchorTop - point.anchorTop) > 1,
        "The first touch actually corrects a changed layout origin");
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
          x: point.x + i * point.size * .02, y: point.y - i * point.size * .04,
        }] });
        await runJitterFor(page, 32);
      }
      const sustained = await audit(page, "grab-drag", dragStart);
      assert.equal(sustained.length, 17, "Every sustained drag frame is captured");
      assert.ok(sustained.every(({ sample }: any) => sample.rows[11].held));
      await page.screenshot({ path: `.verify/jitter-sampling-${width}-drag.png` });
      // Inject visible DOM jitter, not fabricated samples. Physics still renders
      // normally; the existing pixel oracle and unchanged gate must detect it.
      await page.evaluate(() => {
        const w = window as any; w.__shakeJitter = true;
        let direction = 1;
        const shake = () => {
          if (!w.__shakeJitter) return;
          direction *= -1;
          for (const l of w.__portfolioPhysics.letters().filter((l: any) => l.glyph))
            l.el.style.translate = `${direction * 24}px 0`;
          requestAnimationFrame(shake);
        };
        requestAnimationFrame(shake);
      });
      await runJitterFor(page, 16 * 24);
      const injected = await audit(page, "grab-drag", dragStart);
      const dragSummary = summarizeJitter(injected.map(({ sample }: any) => sample))[0]!;
      assert.throws(() => assertJitter([{ width, scenes: [dragSummary] }]), /Whole-screen centroid high-pass RMS/,
        "The unchanged RMS assertion detects actual visible frame jitter");
      await page.screenshot({ path: `.verify/jitter-sampling-${width}-injected.png` });
      const lastDrag = injected.at(-1)!.sample;
      await runJitterFor(page, 7);
      assert.equal(await page.evaluate(() => (window as any).__glyphJitter.samples.length), dragStart + injected.length,
        "A partial frame adds no duplicate or provisional raster sample");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const returnStart = await scene("return-home");
      await page.evaluate(() => {
        const w = window as any; w.__shakeJitter = false;
        for (const l of w.__portfolioPhysics.letters()) l.el.style.removeProperty("translate");
      });
      await runJitterFor(page, 32);
      const returning = await audit(page, "return-home", returnStart);
      assert.equal(returning[0].sample.at - lastDrag.at, 16, "No frame is lost at the drag/return boundary");
      assert.ok(returning.every(({ sample }: any) => !sample.rows[11].held));
      const retained = await page.evaluate(index => (window as any).__glyphJitter.samples[index], returnStart - 1);
      assert.deepEqual(retained, lastDrag, "The final painted drag pose stays in the drag scene");
      assert.deepEqual(errors, []);
      const result = { width, startupFrames: startup.length, wakeFrames: wake.length,
        provisionalLayoutGap: provisionalGap, completedLayoutGap: wake[0].completed.rows[11].anchorGap,
        sustainedDragFrames: sustained.length, injectedFrames: injected.length - sustained.length,
        injectedScreenRms: dragSummary.screenHighPassRms, returnFrames: returning.length,
        lastDragAt: lastDrag.at, firstReturnAt: returning[0].sample.at, browserErrors: errors };
      await writeFile(`.verify/jitter-sampling-${width}.json`, JSON.stringify({ ...result,
        evidence: [...startup, ...injected, ...returning] }, null, 2));
      results.push(result);
    } finally { await page.close(); }
  }
  await writeFile(".verify/jitter-sampling.json", JSON.stringify(results, null, 2));
  return results;
}

if (import.meta.main) {
  const preview = await startPreview(), browser = await chromium.launch();
  try { console.log(JSON.stringify(await verifyJitterSampling(browser, preview.url), null, 2)); }
  finally { await browser.close(); await preview.close(); }
}
