import { verifyJitter } from "./verify-jitter.ts";
import { verifyJitterSampling } from "./verify-jitter-sampling.ts";
import { verifyGlyphData } from "./verify-glyph-data.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";
import { verifyRecovery } from "./verify-recovery.ts";
import { verifyBall } from "./verify-ball.ts";
import { verifyTypography, verifyFontFamily } from "./verify-typography.ts";
import { verifyHulls, verifyHullPerformance, verifyParkedHulls, verifyGlyphTweenBuffers } from "./verify-hulls.ts";
import { verifyGlyphIoU } from "./verify-glyph-iou.ts";
import { verifySign } from "./verify-sign.ts";
import { verifyFrames, verifyStartupInput, verifyBurstEasing } from "./verify-frames.ts";
import { verifyCollisionPerformance } from "./verify-collision.ts";

await mkdir(".verify", { recursive: true });
const preview = await startPreview();
const built = preview.url;
let browser: Browser | undefined;
const report: Record<string, unknown> = {
  node: process.version,
  built,
  routes: [],
  interactions: {},
};
const failures: string[] = [];
function watch(page: Page, label: string, scriptsDisabled = false, expected404 = false) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // Chromium logs the intentional 404 document itself as a failed resource.
    if (expected404 && message.location().url === page.url() && /Failed to load resource.*404/.test(message.text())) return;
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    // Chromium reports blocked modulepreloads as "csp" when Playwright disables JavaScript.
    // These are deliberate policy blocks, not failed asset fetches.
    if (
      scriptsDisabled &&
      request.failure()?.errorText === "csp" &&
      /\.js$/.test(request.url())
    )
      return;
    errors.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (expected404 && response.request().isNavigationRequest() && response.status() === 404) return;
    if (response.status() >= 400)
      errors.push(`${response.url()}: ${response.status()}`);
  });
  return () => {
    assert.deepEqual(errors, [], `${label}: browser errors`);
    return errors;
  };
}
async function hydrated(page: Page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".char").length > 0,
  );
}
async function revealAll(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  for (
    let y = 0;
    y < (await page.evaluate(() => document.body.scrollHeight));
    y += 650
  ) {
    await page.evaluate(
      (y) => window.scrollTo({ top: y, behavior: "instant" }),
      y,
    );
    await page.waitForTimeout(90);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(1500);
}
try {
  browser = await chromium.launch({ headless: true });
  report.frames = await verifyFrames(browser, built, { trace: true, label: process.env.VERIFY_RUN_LABEL ?? "after" });
  report.startupInput = await verifyStartupInput(browser, built);
  report.burstEasing = await verifyBurstEasing(browser, built);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const check = watch(page, "built interactions");
  await page.addInitScript(() => {
    (window as any).__rasterizations = 0;
    const original = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof original>) {
      if (!this.canvas.dataset.hasOwnProperty("glyphOracle")) (window as any).__rasterizations++;
      return original.apply(this, args);
    };
  });
  await page.goto(built + "/?verify&debug");
  await hydrated(page);
  await page.waitForFunction(() => !!(window as any).__portfolioSign);
  const initialSign = await page.locator(".sign").boundingBox();
  await page.waitForFunction(() => (window as any).__portfolioPhysics.letters().length === 18);
  const initialBodies = await page.evaluate(() => (window as any).__portfolioPhysics.letters().map((l: any) => l.body.id));
  await page.waitForTimeout(2600);
  const loaded = await page.evaluate(() => ({
    physics: (window as any).__portfolioVerify.physics(),
    sign: (window as any)
      .__portfolioSign?.()
      .ends.map((p: any) => ({ x: p.x, y: p.y })),
    debug: !!document.querySelector(".physics-debug"),
    glyphRasters: (window as any).__rasterizations,
    bodies: (window as any).__portfolioPhysics.letters().map((l: any) => l.body.id),
    homeLayoutError: (window as any).__portfolioPhysics.letters().reduce((max: number, l: any) => {
      const transform = l.el.style.transform;
      l.el.style.transform = "none";
      const rect = l.el.getBoundingClientRect();
      const [x, y] = getComputedStyle(l.el).transformOrigin.split(" ").map(parseFloat);
      l.el.style.transform = transform;
      return Math.max(max, Math.hypot(rect.left + scrollX + x - l.ox, rect.top + scrollY + y - l.oy));
    }, 0),
  }));
  assert.equal(loaded.physics.engines, 1);
  assert.deepEqual(loaded.physics.bodies, [18]);
  assert.ok(loaded.debug);
  assert.equal(loaded.glyphRasters, 0, "All collision geometry is baked offline; startup performs no raster extraction");
  assert.deepEqual(loaded.bodies, initialBodies, "Startup does not rebuild the same layout");
  assert.ok(loaded.homeLayoutError < 0.1, "Homes match layout after entrance transforms finish");
  assert.ok(initialSign && initialSign.y < 0, "Sign starts above the viewport");
  const fallenSign = await page.locator(".sign").boundingBox();
  assert.ok(fallenSign && fallenSign.y > 10, "Sign falls into view");
  // The ref actually leaves the tree between mounts; retained old engines must be empty.
  const lifecycle = await page.evaluate(async () => {
    const old = [];
    for (let i = 0; i < 3; i++) {
      old.push((window as any).__portfolioPhysics);
      await (window as any).__portfolioVerify.remountPhysics();
    }
    const oldResources = old.map((p) => ({
      aborted: p.scope.signal.aborted,
      frames: p.scope.frames.size,
      timers: p.scope.timers.size,
      bodies: p.engine.world.bodies.length,
      pairs: p.engine.pairs.list.length,
    }));
    window.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 100, clientY: 400 }),
    );
    return { live: (window as any).__portfolioVerify.physics(), oldResources };
  });
  assert.equal(lifecycle.live.engines, 1);
  assert.equal(lifecycle.live.mounts, 4);
  assert.equal(lifecycle.live.disposals, 3);
  assert.equal(lifecycle.live.frames, 1);
  assert.equal(await page.evaluate(() => (window as any).__rasterizations), 0, "Remounts never rasterize collision geometry");
  assert.ok(
    lifecycle.oldResources.every(
      (p) =>
        p.aborted &&
        p.frames === 0 &&
        p.timers === 0 &&
        p.bodies === 0 &&
        p.pairs === 0,
    ),
  );
  await page.waitForTimeout(2200);
  await page.mouse.move(100, 100);
  assert.equal(await page.evaluate(() => (window as any).__portfolioPhysics.ball().solid), true);
  await page.mouse.move(1, 1);
  const restLengths = await page.evaluate(() =>
    (window as any).__portfolioSign().lengths.slice(),
  );
  const signRect = (await page.locator(".sign").boundingBox())!;
  await page.mouse.move(
    signRect.x + signRect.width / 2,
    signRect.y + signRect.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    signRect.x + signRect.width / 2,
    signRect.y + signRect.height / 2 + 160,
    { steps: 12 },
  );
  await page.waitForTimeout(350);
  const paidOut = await page.evaluate(() =>
    (window as any).__portfolioSign().lengths.slice(),
  );
  assert.ok(
    paidOut.some((n: number, i: number) => n > restLengths[i] + 40),
    "Sign ropes pay out during dragging",
  );
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await page.waitForFunction(
    (rest) =>
      (window as any)
        .__portfolioSign()
        .lengths.every((n: number, i: number) => Math.abs(n - rest[i]) < 0.1),
    restLengths,
    { timeout: 12000 },
  );
  await page.waitForTimeout(6000);
  await page.waitForFunction(() => !(window as any).__portfolioSign().running, null, { timeout: 20000 });
  const ropePaths = await page.locator(".sign-ropes path").evaluateAll(paths => paths.map(p => p.getAttribute("d")));
  const signBefore = await page.locator(".sign").boundingBox();
  await page.waitForTimeout(500);
  const signAfter = await page.locator(".sign").boundingBox();
  assert.deepEqual(await page.locator(".sign-ropes path").evaluateAll(paths => paths.map(p => p.getAttribute("d"))), ropePaths, "Sleeping ropes stay unchanged");
  assert.ok(
    signBefore && signAfter && Math.abs(signBefore.y - signAfter.y) < 0.5,
    "Sign settles",
  );
  const rollerBefore = await page
    .locator(".roller-track")
    .getAttribute("style");
  await page.waitForTimeout(2500);
  const rollerAfter = await page.locator(".roller-track").getAttribute("style");
  assert.notEqual(rollerBefore, rollerAfter);
  await page.locator(".card-media").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  const mediaRect = (await page.locator(".card-media").first().boundingBox())!;
  await page.mouse.move(
    mediaRect.x + mediaRect.width * 0.6,
    mediaRect.y + mediaRect.height * 0.6,
  );
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".cursor span").innerText(), "Watch it move");
  assert.ok(
    await page
      .locator(".cursor")
      .evaluate((el) => el.classList.contains("is-on")),
  );
  await page.waitForFunction(() =>
    document.querySelector("video")?.classList.contains("is-playing"),
  );
  await page.locator(".archive summary").click();
  assert.equal(await page.locator(".archive-list li").count(), 32);
  assert.equal(await page.locator(".archive-count").innerText(), "32 PROJECTS");
  assert.equal(await page.locator(".marquee-track span").count(), 62);
  await page.keyboard.press("d");
  assert.equal(await page.locator(".physics-debug").count(), 0);
  await page.keyboard.press("d");
  assert.equal(await page.locator(".physics-debug").count(), 1);
  await page.screenshot({ path: ".verify/interactions-debug.png" });
  const interactionErrors = check();
  report.interactions = {
    loaded,
    lifecycle,
    sign: {
      initialSign,
      fallenSign,
      restLengths,
      paidOut,
      signBefore,
      signAfter,
    },
    rollerChanged: true,
    videoPlaying: true,
    archiveItems: 32,
    marqueeSpans: 62,
    browserErrors: interactionErrors,
  };
  await page.close();
  report.glyphData = await verifyGlyphData();
  report.typography = await verifyTypography(browser, built, watch);
  report.jitterSampling = await verifyJitterSampling(browser, built);
  report.jitter = await verifyJitter(browser, built);
  const glyphReport = await verifyGlyphIoU(browser, built);
  report.glyphIoU=glyphReport.results;report.nameAxes=glyphReport.axisScenes;
  report.hulls = await verifyHulls(browser, built, watch);
  report.parkedHulls = await verifyParkedHulls(browser, built, watch);
  report.tweenBuffers = await verifyGlyphTweenBuffers(browser, built);
  report.hullPerformance = await verifyHullPerformance(browser, built, watch);
  report.collisionPerformance = await verifyCollisionPerformance(browser, built);
  report.signScroll = await verifySign(browser, built, watch);
  report.contactRecovery = await verifyRecovery(browser, built);
  report.physicsInteraction = await verifyBall(browser, built, watch);
  // Changes to the OS preference take effect without a reload and can be reversed.
  const motionPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const motionCheck = watch(motionPage, "live reduced-motion preference");
  await motionPage.goto(built);
  await hydrated(motionPage);
  await motionPage.locator(".card-media").first().scrollIntoViewIfNeeded();
  await motionPage.waitForFunction(() => document.querySelector("video")?.classList.contains("is-playing"));
  await motionPage.emulateMedia({ reducedMotion: "reduce" });
  await motionPage.waitForFunction(() => !document.querySelector(".sign-rig")?.classList.contains("is-live") && !document.querySelector(".roller")?.classList.contains("is-js") && (window as any).__portfolioPhysics.letters().length === 0);
  assert.ok(await motionPage.locator("video").evaluateAll(videos => videos.every(v => v instanceof HTMLVideoElement && v.paused && !v.classList.contains("is-playing"))));
  const reducedRoller = await motionPage.locator(".roller-track").getAttribute("style");
  await motionPage.waitForTimeout(2500);
  assert.equal(await motionPage.locator(".roller-track").getAttribute("style"), reducedRoller);
  await motionPage.emulateMedia({ reducedMotion: "no-preference" });
  await motionPage.waitForFunction(() => document.querySelector(".sign-rig")?.classList.contains("is-live") && document.querySelector(".roller")?.classList.contains("is-js") && (window as any).__portfolioPhysics.letters().length === 18);
  await motionPage.waitForFunction(() => document.querySelector("video")?.classList.contains("is-playing"));
  report.liveReducedMotion = { restored: true, browserErrors: motionCheck() };
  await motionPage.close();
  for (const reduced of [true, false]) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      javaScriptEnabled: reduced,
      hasTouch: true,
      isMobile: true,
    });
    const check = watch(page, reduced ? "reduced motion" : "no JS", !reduced);
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(built);
    if (reduced) await hydrated(page);
    assert.ok(
      await page
        .locator(".sign-rig")
        .evaluate((el) => !el.classList.contains("is-live")),
    );
    assert.equal(
      await page
        .locator(".sign")
        .evaluate((el) => getComputedStyle(el).visibility),
      "visible",
    );
    if (reduced)
      assert.equal(
        await page
          .locator(".cursor-ball")
          .evaluate((el) => getComputedStyle(el).display),
        "none",
      );
    else {
      assert.equal(
        await page
          .locator(".cursor-ball")
          .evaluate((el) => getComputedStyle(el).opacity),
        "0",
      );
      assert.equal(await page.locator(".char").count(), 0);
    }
    await page.locator(".hero-scroll").click();
    await page.waitForURL("**/#work");
    assert.equal(new URL(page.url()).hash, "#work");
    const fallbackSign = await page.locator(".sign").boundingBox();
    assert.ok(fallbackSign && fallbackSign.y > 10 && fallbackSign.y < 90, "Static sign stays in view when scrolled");
    assert.ok(await page.locator(".sign-rig").evaluate(el => ["::before", "::after"].every(pseudo => {
      const rope = getComputedStyle(el, pseudo);
      return rope.content !== "none" && parseFloat(rope.height) > 10;
    })), "Static fallback has both pseudo ropes");
    await revealAll(page);
    await page.screenshot({
      path: `.verify/${reduced ? "reduced-motion" : "no-js"}-fallback.png`,
      fullPage: true,
    });
    check();
    await page.close();
  }
  for (const base of [built]) {
    for (const route of ["/", "/work/new-form", "/work/new-form/"]) {
      const page = await browser.newPage();
      const check = watch(page, base + route);
      const response = await page.goto(base + route);
      assert.equal(response?.status(), 200);
      await hydrated(page);
      await verifyFontFamily(page);
      assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").some(e => e.name.includes("physics-debug"))), false, "Normal visitors never download debug code");
      await page.keyboard.press("d");
      assert.equal(await page.locator(".physics-debug").count(), 0, "D does nothing without ?debug");
      await revealAll(page);
      assert.equal(new URL(page.url()).pathname, route.replace(/\/$/, "") || "/");
      assert.equal(
        await page.locator('link[rel="canonical"]').getAttribute("href"),
        "https://www.robbiewadley.com" + (route.replace(/\/$/, "") || "/"),
      );
      assert.equal(
        await page.title(),
        route === "/"
          ? "Robbie Wadley — Full-stack engineer"
          : "New Form Capital — Robbie Wadley",
      );
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator('meta[property="og:title"]').getAttribute("content"), await page.title());
      assert.equal(await page.locator('meta[property="og:type"]').getAttribute("content"), "website");
      assert.equal(await page.locator('meta[name="twitter:card"]').getAttribute("content"), "summary_large_image");
      assert.equal(await page.locator('meta[name="twitter:title"]').getAttribute("content"), await page.title());
      assert.equal(await page.locator('meta[name="twitter:description"]').getAttribute("content"), await page.locator('meta[property="og:description"]').getAttribute("content"));
      assert.equal(await page.locator('meta[name="twitter:image"]').getAttribute("content"), await page.locator('meta[property="og:image"]').getAttribute("content"));
      if (route !== "/") assert.equal(await page.locator('meta[name="description"]').getAttribute("content"), await page.locator('meta[property="og:description"]').getAttribute("content"));
      for (const card of await page.locator(".card").all()) {
        const title = await card.locator("h3").innerText();
        assert.equal(await card.getByRole("link", { name: new RegExp(` — ${title}$`) }).count(), 1);
      }
      (report.routes as unknown[]).push({ route, url: page.url(), browserErrors: check() });
      await page.close();
    }
  }
  for (const path of ["/missing", "/work/missing", "/missing/nested"]) {
    const page = await browser.newPage();
    const check = watch(page, `not found ${path}`, false, true);
    const response = await page.goto(built + path);
    assert.equal(response?.status(), 404);
    await page.waitForFunction(() => document.documentElement.dataset.hydrated === "true");
    assert.equal(await page.locator("h1").innerText(), "Page not found.");
    assert.equal(await page.getByRole("link", { name: "Back home" }).getAttribute("href"), "/");
    await verifyFontFamily(page);
    if (path === "/missing") for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: `.verify/not-found-${width}.png`, fullPage: true });
    }
    check();
    await page.getByRole("link", { name: "Back home" }).click();
    await page.waitForURL(built + "/");
    await hydrated(page);
    check();
    await page.close();
  }
  const robots = await fetch(built + "/robots.txt");
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nAllow: /\nSitemap: https://www.robbiewadley.com/sitemap.xml\n");
  const sitemap = await fetch(built + "/sitemap.xml");
  assert.equal(sitemap.status, 200);
  const sitemapText = await sitemap.text();
  assert.ok(sitemapText.includes("https://www.robbiewadley.com/</loc>"));
  assert.ok(sitemapText.includes("https://www.robbiewadley.com/work/new-form</loc>"));
  assert.ok(!sitemapText.includes("/404"));
  // Verify canonical redirects without relying on the browser following them.
  for (const path of ["/work/new-form/", "/work/new-form.html"]) {
    const response = await fetch(built + path + "?check=1", { redirect: "manual" });
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("location"), "/work/new-form?check=1", path);
  }
  // Verify every recorded exported asset, beyond those requested in the tested viewports.
  const manifest = JSON.parse(
    await readFile(".verify/asset-manifest.json", "utf8"),
  );
  const assetPage = await browser.newPage();
  const assetCheck = watch(assetPage, "all exported assets");
  await assetPage.goto(built);
  await hydrated(assetPage);
  const assetResponses = await assetPage.evaluate(async (urls: string[]) => {
    return Promise.all(urls.map(async (url) => {
      const response = await fetch(url);
      const bytes = (await response.arrayBuffer()).byteLength;
      return { url, status: response.status, bytes, type: response.headers.get("content-type"), cache: response.headers.get("cache-control") };
    }));
  }, manifest.assets.map((asset: { url: string }) => asset.url.replace(/\.(?:tsx?|jsx)$/, ".js")));
  for (const [i, response] of assetResponses.entries()) {
    const asset = manifest.assets[i];
    assert.equal(response.status, 200, response.url);
    assert.ok(response.bytes > 0, response.url + ": nonempty");
    if (asset.type.includes("javascript"))
      assert.ok(response.type?.includes("javascript"), response.url + ": JavaScript MIME");
    if (/\.woff2$/.test(response.url))
      assert.ok(response.type?.includes("font/woff2"), response.url + ": font MIME");
    if (/\.webm$/.test(response.url))
      assert.ok(response.type?.includes("video/webm"), response.url + ": video MIME");
    const fingerprinted = /^\/assets\/.*\.@[A-Za-z0-9_-]+\.[^/]+$/.test(response.url);
    assert.equal(response.cache?.includes("immutable") ?? false, fingerprinted, response.url + ": cache policy");
  }
  assert.equal((await fetch(built)).headers.get("cache-control")?.includes("immutable") ?? false, false);
  assetCheck();
  await assetPage.close();
  assert.equal(manifest.assets.filter((asset: { url: string }) => /\.woff2$/.test(asset.url)).length, 1, "One variable font asset");
  assert.ok(!manifest.assets.some((asset: { url: string }) => /libtess|earcut|glyph-font|glyph-mesh|glyph-kernel|glyph-raster/.test(asset.url)), "Font preparation, tessellation and WASM helpers remain offline-only");
  assert.ok(!manifest.assets.some((asset: { url: string }) => /dm-|DM-Sans|\.ttf$/.test(asset.url)));
  report.assetsChecked = manifest.assets.length;
  console.log(`Verified ${report.assetsChecked} assets, both routes, branded 404, debug gating, and live reduced motion on ${process.version}; browser errors: 0.`);
} catch (error) {
  failures.push(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  throw error;
} finally {
  report.failures = failures;
  try {
    await writeFile(".verify/report.json", JSON.stringify(report, null, 2));
  } finally {
    try {
      await browser?.close();
    } finally {
      await preview.close();
    }
  }
}
