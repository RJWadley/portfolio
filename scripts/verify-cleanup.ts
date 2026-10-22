import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, firefox, webkit, type Page } from "playwright";
import { startPreview } from "./preview.ts";

// Kept separate from the physics verifier so both shared-checkout tasks own their checks.
const engineName = process.env.CLEANUP_BROWSER ?? "chromium";
assert.ok(engineName === "chromium" || engineName === "firefox" || engineName === "webkit");
const output = `.verify/cleanup${engineName === "chromium" ? "" : `/${engineName}`}`;
await mkdir(output, { recursive: true });
const preview = process.env.CLEANUP_BASE_URL ? undefined : await startPreview();
const base = process.env.CLEANUP_BASE_URL ?? preview!.url;
const browser = await ({ chromium, firefox, webkit })[engineName].launch({ headless: true });
const report: Record<string, unknown> = { base, engine: engineName, viewports: [], disclosures: [], outlines: [], failures: [] };
const browserErrors: string[] = [];

async function ready(page: Page, js = true) {
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`); });
  await page.goto(base);
  // Firefox disables promise callbacks in no-JS documents, including fonts.ready.
  // Keep that path entirely native; all screenshot and pixel checks use JS pages.
  if (js) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.documentElement.dataset.hydrated === "true");
  }
}
async function archiveView(page: Page) {
  await page.locator(".archive summary").evaluate((summary) => {
    window.scrollTo({ top: summary.getBoundingClientRect().top + scrollY - 110, behavior: "instant" });
  });
  await page.waitForTimeout(1200); // Finish the existing section reveal before measuring layout.
  await page.locator(".archive summary").focus();
}
async function disclosure(page: Page, label: string) {
  await archiveView(page);
  const result = await page.evaluate(async () => {
    const details = document.querySelector<HTMLDetailsElement>(".archive")!;
    const summary = details.querySelector<HTMLElement>("summary")!;
    const closed = details.getBoundingClientRect().height;
    const scroll = scrollY;
    const stages: { action: string; heights: number[]; scrolls: number[] }[] = [];
    for (const [action, duration] of [["open", 600], ["close", 600], ["interrupt-open", 150], ["interrupt-close", 90], ["reopen", 650], ["final-close", 600]] as const) {
      summary.click();
      const start = performance.now();
      const heights: number[] = [], scrolls: number[] = [];
      while (performance.now() - start < duration) {
        await new Promise(requestAnimationFrame);
        heights.push(details.getBoundingClientRect().height);
        scrolls.push(scrollY);
      }
      stages.push({ action, heights, scrolls });
    }
    return { closed, scroll, stages, open: details.open, focused: document.activeElement === summary };
  });
  const openHeight = result.stages[0].heights.at(-1)!;
  assert.ok(openHeight > result.closed + 500, `${label}: full project index opens`);
  assert.ok(result.stages[0].heights.some((h) => h > result.closed + 20 && h < openHeight - 20), `${label}: opening has intermediate heights`);
  assert.ok(result.stages[1].heights.some((h) => h > result.closed + 20 && h < openHeight - 20), `${label}: closing has intermediate heights`);
  assert.ok(Math.abs(result.stages[1].heights.at(-1)! - result.closed) < 1, `${label}: closes completely`);
  assert.ok(Math.abs(result.stages[4].heights.at(-1)! - openHeight) < 1, `${label}: interrupted transition reopens completely`);
  const drift = Math.max(...result.stages.flatMap((stage) => stage.scrolls.map((y) => Math.abs(y - result.scroll))));
  assert.ok(drift <= 1, `${label}: scroll stays fixed (${drift}px)`);
  assert.equal(result.open, false, `${label}: ends closed`);
  assert.ok(result.focused, `${label}: summary retains focus`);
  return { label, closedHeight: result.closed, openHeight, maxScrollDrift: drift, frames: result.stages.map((stage) => ({ action: stage.action, count: stage.heights.length, first: stage.heights[0], last: stage.heights.at(-1) })) };
}

async function outlineProof(page: Page) {
  // Render real marquee words at 120px using their actual styles. Compare with the
  // native filled glyph union; dark pixels inside its eroded interior are stray strokes.
  await page.evaluate(() => {
    const proof = document.createElement("div");
    proof.id = "outline-proof";
    proof.className = "marquee-track";
    proof.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:9999;animation:none;display:grid;gap:0;width:1100px;padding:24px;background:var(--paper);font-size:120px;line-height:1.4";
    for (const name of ["Fluid", "Response", "Galileo Financial"]) {
      const word = document.querySelector(`.marquee-outline` )!.cloneNode(true) as HTMLElement;
      word.textContent = name;
      proof.append(word);
    }
    document.body.append(proof);
  });
  const outline = await page.locator("#outline-proof").screenshot({ path: `${output}/marquee-outlines-zoom.png` });
  await page.locator("#outline-proof span").evaluateAll((words) => words.forEach((word) => (word as HTMLElement).style.cssText = "color:var(--ink);-webkit-text-stroke:0"));
  const solid = await page.locator("#outline-proof").screenshot();
  const proof = await page.evaluate(async ({ outline, solid }) => {
    async function pixels(encoded: string) {
      const response = await fetch(`data:image/png;base64,${encoded}`);
      const image = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return { data: ctx.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
    }
    const a = await pixels(outline), b = await pixels(solid);
    let interior = 0, artifacts = 0;
    const dark = (data: Uint8ClampedArray, x: number, y: number) => data[(y * a.width + x) * 4] < 100;
    for (let y = 4; y < a.height - 4; y++) for (let x = 4; x < a.width - 4; x++) {
      if (!dark(b.data, x, y)) continue;
      let inside = true;
      for (let dy = -3; dy <= 3 && inside; dy++) for (let dx = -3; dx <= 3; dx++) if (!dark(b.data, x + dx, y + dy)) { inside = false; break; }
      if (inside) { interior++; if (dark(a.data, x, y)) artifacts++; }
    }
    return { interiorPixels: interior, strayInteriorPixels: artifacts };
  }, { outline: outline.toString("base64"), solid: solid.toString("base64") });
  assert.ok(proof.interiorPixels > 10000, "Outline proof samples the native glyph interiors");
  assert.equal(proof.strayInteriorPixels, 0, "Outlined logos have no strokes inside overlapping glyph contours");
  await page.locator("#outline-proof").evaluate((proof) => proof.remove());
  return proof;
}

try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await ready(page);
    // Hide fixed chrome only for isolated section captures; the production page is unchanged.
    await page.addStyleTag({ content: ".site-header,.sign-rig,.skip-link,.cursor,.cursor-ball { visibility:hidden!important }" });
    await page.locator(".work-grid").scrollIntoViewIfNeeded();
    // Firefox can reject decode() before an offscreen lazy image has a request.
    // Visit each image first, then require a real, successfully loaded resource.
    for (const image of await page.locator(".work-grid img").all()) await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".work-grid img")].every((image) => image.complete && image.naturalWidth > 0));
    const bounds = await page.locator(".work-grid").evaluate((grid) => {
      const rect = grid.getBoundingClientRect();
      return { width: rect.width, scrollWidth: grid.scrollWidth, tiles: [...grid.children].map((tile) => { const box = tile.getBoundingClientRect(); return { left: box.left - rect.left, right: box.right - rect.left, width: box.width }; }) };
    });
    assert.ok(bounds.scrollWidth <= bounds.width + 1, `Bento ${width}: no horizontal overflow`);
    assert.ok(bounds.tiles.every((tile) => tile.left >= -1 && tile.right <= bounds.width + 1), `Bento ${width}: every tile fits`);
    if (width === 390) assert.ok(bounds.tiles[1].width < bounds.width / 2 && bounds.tiles[2].width < bounds.width, "Mobile bento retains a two-tile row");
    assert.equal(await page.locator(".work-link").count(), 3);
    await page.locator(".work-link").first().focus();
    assert.equal(await page.locator(".work-link").first().evaluate((link) => link.matches(":focus-visible")), true);
    await page.locator(".work-link").first().blur();
    await page.locator(".work-grid").screenshot({ path: `${output}/bento-${width}.png` });
    await archiveView(page);
    await page.locator(".archive summary").blur();
    await page.locator(".archive").screenshot({ path: `${output}/marquee-${width}.png` });
    const transform = await page.locator(".marquee-track").evaluate((track) => getComputedStyle(track).transform);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".marquee-track").evaluate((track) => getComputedStyle(track).transform), transform, "Reduced-motion marquee is static");
    assert.ok(await page.locator("video").evaluateAll((videos) => videos.every((video) => video instanceof HTMLVideoElement && video.paused)), "Reduced-motion media stays paused");
    await page.locator(".archive summary").press("Enter");
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".archive-list li").count(), 32);
    assert.equal(await page.locator(".archive").getAttribute("open"), "");
    await page.locator(".archive summary").blur();
    await page.locator(".archive").screenshot({ path: `${output}/projects-${width}.png` });
    await page.locator(".archive summary").press("Space");
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".archive").getAttribute("open"), null);
    (report.viewports as unknown[]).push({ viewportWidth: width, ...bounds });
    await page.close();

    const noJS = await browser.newPage({ viewport: { width, height: 900 }, javaScriptEnabled: false });
    await ready(noJS, false);
    await archiveView(noJS);
    await noJS.locator(".archive summary").press("Enter");
    await noJS.waitForTimeout(600);
    assert.equal(await noJS.locator(".archive").getAttribute("open"), "");
    assert.ok(await noJS.locator(".archive-list").isVisible());
    await noJS.locator(".archive summary").press("Space");
    await noJS.waitForTimeout(600);
    assert.equal(await noJS.locator(".archive").getAttribute("open"), null);
    await noJS.close();

    const motion = await browser.newPage({ viewport: { width, height: 900 } });
    await ready(motion);
    (report.disclosures as unknown[]).push(await disclosure(motion, `native-${width}`));
    await motion.close();
  }
  const fallback = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await fallback.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args: [string, string?]) => args[0] === "interpolate-size: allow-keywords" ? false : args.length === 2 ? supports(args[0], args[1]!) : supports(args[0]);
  });
  await ready(fallback);
  (report.disclosures as unknown[]).push(await disclosure(fallback, "fallback-390"));
  await fallback.emulateMedia({ reducedMotion: "reduce" });
  await fallback.locator(".archive summary").press("Enter");
  await fallback.waitForTimeout(30);
  assert.equal(await fallback.locator(".archive-content").evaluate((content) => (content as HTMLElement).style.height), "auto", "Fallback honors live reduced motion");
  await fallback.locator(".archive summary").press("Space");
  await fallback.waitForTimeout(30);
  assert.equal(await fallback.locator(".archive").getAttribute("open"), null);
  await fallback.close();

  const logoPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await ready(logoPage);
  await archiveView(logoPage);
  await logoPage.locator(".archive summary").blur();
  await logoPage.mouse.move(1, 1);
  const loop = await logoPage.locator(".marquee-track").evaluate((track) => {
    const words = [...track.children];
    const half = words.length / 2;
    return { distance: words[half].getBoundingClientRect().left - words[0].getBoundingClientRect().left, halfWidth: track.getBoundingClientRect().width / 2, repeat: words.slice(0, half).every((word, i) => word.textContent === words[i + half].textContent && word.className === words[i + half].className), animation: getComputedStyle(track).animationPlayState };
  });
  assert.ok(loop.repeat && Math.abs(loop.distance - loop.halfWidth) < 0.1, "Marquee copies match at the exact loop boundary");
  assert.equal(loop.animation, "running");
  const before = await logoPage.locator(".marquee-track").evaluate((track) => getComputedStyle(track).transform);
  await logoPage.waitForTimeout(150);
  assert.notEqual(await logoPage.locator(".marquee-track").evaluate((track) => getComputedStyle(track).transform), before, "Marquee moves smoothly");
  await logoPage.locator(".archive summary").focus();
  assert.equal(await logoPage.locator(".marquee-track").evaluate((track) => getComputedStyle(track).animationPlayState), "paused", "Keyboard focus pauses the marquee");
  report.marquee = loop;
  report.outlines = await outlineProof(logoPage);
  await logoPage.close();

  const recording = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output, size: { width: 1440, height: 900 } } });
  const film = await recording.newPage();
  await ready(film);
  await film.addStyleTag({ content: ".site-header,.sign-rig,.skip-link,.cursor,.cursor-ball { visibility:hidden!important }" });
  await archiveView(film);
  await film.locator(".archive summary").blur();
  await film.waitForTimeout(350);
  for (const action of ["open", "close"]) {
    await film.locator(".archive summary").press("Enter");
    for (const [index, delay] of [0, 120, 120, 360].entries()) {
      await film.waitForTimeout(delay);
      await film.screenshot({ path: `${output}/projects-${action}-${index}.png` });
    }
    await film.waitForTimeout(250);
  }
  await film.locator(".archive summary").press("Enter");
  await film.waitForTimeout(150);
  await film.locator(".archive summary").press("Enter");
  await film.waitForTimeout(90);
  await film.locator(".archive summary").press("Enter");
  await film.waitForTimeout(650);
  await recording.close();
  await film.video()!.saveAs(`${output}/projects-open-close.webm`);
  await film.video()!.delete();
  assert.deepEqual(browserErrors, [], "Cleanup flow: no browser errors");
  console.log("Cleanup verified: bento 1440/390, native/no-JS/reduced-motion/fallback disclosure, fixed scroll, seamless marquee, zero interior outline artifacts.");
} catch (error) {
  (report.failures as string[]).push(error instanceof Error ? error.stack ?? error.message : String(error));
  throw error;
} finally {
  report.browserErrors = browserErrors;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  await preview?.close();
}
