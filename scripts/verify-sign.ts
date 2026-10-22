import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";

async function pose(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).__portfolioSign();
    const rig = state.rig.getBoundingClientRect();
    const sign = state.rig.querySelector(".sign").getBoundingClientRect();
    const svg = state.rig.querySelector(".sign-ropes") as SVGSVGElement;
    const path = svg.querySelector(".rope-edge") as SVGPathElement;
    const first = path.getPointAtLength(0);
    const matrix = svg.getScreenCTM()!;
    return {
      scroll: scrollY,
      viewport: innerHeight,
      sign: { x: sign.x, y: sign.y, width: sign.width, height: sign.height },
      anchors: state.anchors.map((a: any) => ({
        x: rig.left + scrollX + a.x,
        y: rig.top + scrollY + a.y,
      })),
      renderedAnchorY:
        new DOMPoint(first.x, first.y).matrixTransform(matrix).y + scrollY,
      lengths: state.lengths.slice() as number[],
      targetLength: state.ropeLen as number,
      ropeExtent: svg.getBBox().height,
      detailBytes: svg.querySelector(".rope-twist")!.getAttribute("d")!.length,
      running: state.running as boolean,
      frames: state.scope.frames.size as number,
    };
  });
}

async function asleep(page: Page) {
  await page.waitForFunction(
    () => {
      const state = (window as any).__portfolioSign?.();
      return (
        state &&
        !state.running &&
        state.scope.timers.size === 0 &&
        state.pageScroll === Math.max(0, scrollY)
      );
    },
    null,
    { timeout: 20000 },
  );
}

async function scrollFlight(page: Page, top: number) {
  return page.evaluate(async (top) => {
    const read = () => {
      const state = (window as any).__portfolioSign();
      const sign = document.querySelector(".sign")!.getBoundingClientRect();
      return {
        y: sign.y,
        x: sign.x,
        worldY: (state.ends[0].y + state.ends[1].y) / 2,
        scroll: scrollY,
        running: state.running,
        lengths: state.lengths.slice() as number[],
        target: state.ropeLen as number,
        reel: state.reel.slice() as number[],
      };
    };
    const before = read();
    scrollTo({ top, behavior: "instant" });
    const immediate = read();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const samples = [];
    for (let i = 0; i < 90; i++) {
      samples.push(read());
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    return { before, immediate, samples };
  }, top);
}

async function scrollSequence(page: Page) {
  const before = await pose(page);
  const startPath = ".verify/sign-fall-start.png";
  await page.screenshot({
    path: startPath,
    clip: { x: 1040, y: 0, width: 400, height: 300 },
  });
  const started = Date.now();
  await page.evaluate(() => scrollTo({ top: 240, behavior: "instant" }));
  const frames = [{ elapsedMs: -1, path: startPath, state: before }];
  for (const [i, ms] of [0, 350, 600, 800, 1300].entries()) {
    const wait = ms - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
    const state = await pose(page);
    const path = `.verify/sign-fall-${i}.png`;
    await page.screenshot({
      path,
      clip: { x: 1040, y: 0, width: 400, height: 300 },
    });
    frames.push({ elapsedMs: Date.now() - started, path, state });
  }
  await asleep(page);
  return frames;
}

// Construct the crossed-rope equilibrium through the existing diagnostic pose,
// then let the production solver notice and recover it (no rescue-only action).
async function invert(page: Page) {
  await page.evaluate(() => {
    const s = (window as any).__portfolioSign();
    const [a, b] = s.ends;
    const bar = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = (a.x + b.x) / 2;
    const y = Math.sqrt(s.ropeLen ** 2 - bar ** 2);
    Object.assign(a, { x: mid + bar / 2, ox: mid + bar / 2, y, oy: y });
    Object.assign(b, { x: mid - bar / 2, ox: mid - bar / 2, y, oy: y });
  });
}

export async function verifyCrew(browser: Browser, url: string) {
  const reports = [];
  await mkdir(".verify/sign-crew", { recursive: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      recordVideo: { dir: ".verify/sign-crew", size: { width, height: 900 } },
    });
    const page = await context.newPage();
    const video = page.video()!;
    try {
      await page.goto(url + "?verify&signSeed=137");
      await page.waitForFunction(() => !!(window as any).__portfolioSign);
      await asleep(page);
      const replay = await page.evaluate(() => {
        const samples = [];
        for (let step = 0; step < 420; step++) {
          if (step < 180) scrollTo({ top: step * 6, behavior: "instant" });
          const active = (window as any).__portfolioSign().verify.advance();
          const s = (window as any).__portfolioSign();
          samples.push({ step, lengths: s.lengths.slice() as number[], target: s.ropeLen as number,
            speeds: s.reel.map((v: number) => -v) as number[],
            y: (s.ends[0].y + s.ends[1].y) / 2 - scrollY, active });
        }
        const hoist = [];
        for (let step = 0; step < 600; step++) {
          if (step < 180) scrollTo({ top: 1074 - step * 4, behavior: "instant" });
          const active = (window as any).__portfolioSign().verify.advance();
          const s = (window as any).__portfolioSign();
          hoist.push({ step, lengths: s.lengths.slice() as number[], speeds: s.reel.slice() as number[],
            target: s.ropeLen as number, active });
          if (step > 180 && !active) break;
        }
        return { samples, hoist };
      });
      const speeds = replay.samples.flatMap((s) => s.speeds);
      const maxAcceleration = Math.max(...replay.samples.slice(1).flatMap((s, n) =>
        s.speeds.map((v, i) => Math.abs(v - replay.samples[n]!.speeds[i]!))));
      const maxLag = Math.max(...replay.samples.map((s) => s.target - Math.min(...s.lengths)));
      assert.ok(Math.min(...speeds) >= 0 && Math.max(...speeds) <= 34, "Payout speed stays bounded");
      assert.ok(maxAcceleration <= 0.66, `Payout never jerks: ${maxAcceleration}`);
      assert.ok(maxLag < 100, `Continuous payout has bounded lag: ${maxLag}`);
      assert.ok(replay.samples.every((s) => s.y > -120 && s.y < 200), "Payout keeps the board near the viewport top");
      assert.ok(replay.samples.filter((s) => Math.abs(s.speeds[0]! - s.speeds[1]!) > 0.25).length > 60,
        "Operators feed at different rates over time");
      const starts = [0, 1].map((i) => replay.hoist.filter((s, n, all) =>
        s.speeds[i]! > 0.01 && (n === 0 || all[n - 1]!.speeds[i]! <= 0.01)).map((s) => s.step));
      for (let i = 0; i < 2; i++) {
        assert.ok(starts[i]!.length >= 8, "Each hoist contains many distinct pulls");
        const rests = replay.hoist.filter((s, n, all) => n > 0 && s.speeds[i] === 0 &&
          all[n - 1]!.speeds[i] === 0 && s.lengths[i]! > s.target + 1);
        assert.ok(rests.length >= 20, "Pulls have real rests while rope remains to wind in");
      }
      assert.ok(starts[0]!.filter((n) => !starts[1]!.includes(n)).length >= 5,
        "Left and right pulls are independently timed");
      assert.ok(replay.hoist.at(-1)!.lengths.every((l) => Math.abs(l - replay.hoist.at(-1)!.target) < 0.1),
        "Hoisting catches up to the final target");
      await page.evaluate(() => (window as any).__portfolioSign().verify.wake());
      await asleep(page);

      // Height-only browser-chrome resize must retain pose arrays and operator state.
      await page.evaluate(() => { (window as any).__crewBeforeResize = (window as any).__portfolioSign(); });
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => {
        const before = (window as any).__crewBeforeResize, after = (window as any).__portfolioSign();
        return before.ends === after.ends && before.crew === after.crew && !after.running;
      }), "Height-only resizing leaves the sleeping rig intact");

      // Recorded scenes run the same fixed solver at real-time cadence. Cropped
      // frames show the sign clearly on desktop as well as in the full video.
      const frames: { scene: string; step: number; path: string }[] = [];
      const capture = async (scene: string, step: number) => {
        const path = `.verify/sign-crew/${width}-${scene}-${String(step).padStart(3, "0")}.png`;
        await page.screenshot({ path, clip: { x: Math.max(0, width - 400), y: 0, width: Math.min(width, 400), height: 300 } });
        frames.push({ scene, step, path });
      };
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
      await asleep(page);
      for (const scene of ["payout", "hoist"]) {
        for (let step = 0; step <= 120; step += 6) {
          await page.evaluate(async ({ scene, step }) => {
            for (let n = 0; n < 6; n++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const progress = Math.min(120, step + n) * 5;
              scrollTo({ top: scene === "payout" ? progress : 600 - progress, behavior: "instant" });
              (window as any).__portfolioSign().verify.advance();
            }
          }, { scene, step });
          if (step % 12 === 0) await capture(scene, step);
        }
        await page.evaluate(() => (window as any).__portfolioSign().verify.wake());
        await asleep(page);
      }
      await page.evaluate(() => scrollTo({ top: 900, behavior: "instant" }));
      await asleep(page);
      await invert(page);
      const rescue = [];
      let finished = false;
      for (let step = 0; step <= 1800; step += 6) {
        const sample = await page.evaluate(async () => {
          let active = true;
          for (let n = 0; n < 6; n++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            active = (window as any).__portfolioSign().verify.advance();
            if (!active) break;
          }
          const s = (window as any).__portfolioSign(), [a, b] = s.ends;
          return { active, angle: Math.atan2(b.y - a.y, b.x - a.x), tugs: s.rescue.tugs,
            attempts: s.rescue.attempts, lengths: s.lengths.slice() as number[] };
        });
        rescue.push({ step, ...sample });
        if (step % 24 === 0) await capture("rescue", step);
        if (!sample.active) { finished = true; break; }
      }
      assert.ok(finished, "An inverted equilibrium recovers and sleeps within 30 simulated seconds");
      assert.ok(rescue.some((s) => s.step <= 900 && Math.abs(s.angle) < 0.1),
        "Rescue flips upright within 15 simulated seconds");
      assert.ok(Math.abs(rescue.at(-1)!.angle) < 0.05, "Rescue leaves the board upright");
      const rescueTugs = rescue.at(-1)!.tugs;
      assert.ok(rescueTugs >= 1 && rescueTugs <= 5, `Rescue uses a bounded number of pulls: ${rescueTugs}`);
      assert.ok(rescue.filter((s) => s.tugs === 0).length >= 5, "Crew waits a beat before rescue");
      await page.evaluate(() => (window as any).__portfolioSign().verify.wake());
      await asleep(page);
      const sleeping = await page.evaluate(async () => {
        const s = (window as any).__portfolioSign();
        let writes = 0;
        const observer = new MutationObserver((records) => { writes += records.length; });
        observer.observe(s.rig, { subtree: true, attributes: true, childList: true });
        await new Promise((resolve) => setTimeout(resolve, 350));
        observer.disconnect();
        return { writes, frames: s.scope.frames.size, timers: s.scope.timers.size, tugs: s.rescue.tugs };
      });
      assert.deepEqual(sleeping, { writes: 0, frames: 0, timers: 0, tugs: rescueTugs }, "Settled crew owns no work and makes no writes");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => !(window as any).__portfolioSign);
      const reduced = await page.evaluate(async () => {
        scrollBy({ top: -180, behavior: "instant" });
        let writes = 0;
        const rig = document.querySelector(".sign-rig")!;
        const observer = new MutationObserver((records) => { writes += records.length; });
        observer.observe(rig, { subtree: true, attributes: true, childList: true });
        await new Promise((resolve) => setTimeout(resolve, 350));
        observer.disconnect();
        return { writes, live: rig.classList.contains("is-live"), state: !!(window as any).__portfolioSign,
          paths: rig.querySelectorAll("path").length };
      });
      assert.deepEqual(reduced, { writes: 0, live: false, state: false, paths: 0 }, "Reduced motion has no crew, swaying, or random tugs");
      const report = { width, maxAcceleration, maxLag, starts, replay, rescue, sleeping, reduced, frames,
        video: `.verify/sign-crew/${width}-crew.webm` };
      await writeFile(`.verify/sign-crew/${width}-report.json`, JSON.stringify(report, null, 2));
      reports.push(report);
    } finally {
      await context.close();
      await video.saveAs(`.verify/sign-crew/${width}-crew.webm`);
      await video.delete();
    }
  }
  return reports;
}

export async function verifySign(
  browser: Browser,
  url: string,
  watch: (
    page: Page,
    label: string,
    scriptsDisabled?: boolean,
  ) => () => string[],
) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const check = watch(page, "document-anchored sign");
  try {
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__portfolioSign);
    await asleep(page);
    const top = await pose(page);
    const maxScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - innerHeight,
    );
    const positions = [];
    for (const [label, target] of [
      ["drop", 180],
      ["wind-in", 0],
      ["middle", maxScroll / 2],
      ["bottom", maxScroll],
      ["top", 0],
    ] as const) {
      const started = Date.now();
      const flight = await scrollFlight(page, target);
      const dy = flight.immediate.scroll - flight.before.scroll;
      assert.ok(
        flight.samples.some((p) => p.running),
        "Scrolling wakes the sign",
      );
      assert.equal(
        flight.immediate.worldY,
        flight.before.worldY,
        "Scroll leaves the board's page-space pose unchanged",
      );
      assert.ok(
        Math.abs(flight.samples[0]!.worldY - flight.before.worldY) <
          Math.max(20, Math.abs(dy) * 0.08),
        `${label}: physics starts from the previous pose without scroll compensation`,
      );
      assert.ok(
        Math.abs(flight.samples[0]!.y - top.sign.y) > 80,
        `${label}: the board initially travels with the page`,
      );
      if (dy > 0) {
        assert.ok(
          flight.samples.some((p) => p.worldY > flight.before.worldY + 50),
          `${label}: gravity pulls the board down after payout`,
        );
        assert.ok(
          flight.samples.some((p) =>
            p.lengths.every((n) => Math.abs(n - p.target) < 0.1),
          ),
          "Reels pay out to the longer target",
        );
      } else {
        const speeds = flight.samples.flatMap((p) => p.reel);
        assert.ok(
          Math.max(...speeds) > 3 && Math.max(...speeds) <= 34,
          "Wind-in accelerates within the shared reel speed limit",
        );
        assert.ok(
          flight.samples.some((p) => p.worldY < flight.before.worldY - 50),
          `${label}: winding lifts the board`,
        );
      }
      await asleep(page);
      const settledMs = Date.now() - started;
      assert.ok(
        settledMs < 12000,
        `${label}: even large jumps settle promptly`,
      );
      const settled = await pose(page);
      assert.ok(
        settled.sign.y > 10 &&
          settled.sign.y + settled.sign.height < settled.viewport,
        `${label}: sign remains in view`,
      );
      assert.ok(
        settled.anchors.every((a: { y: number }) => Math.abs(a.y) < 0.1),
        `${label}: both anchors stay at page top`,
      );
      assert.ok(
        Math.abs(settled.renderedAnchorY) < 0.1,
        `${label}: SVG starts at page top`,
      );
      settled.lengths.forEach((length, i) =>
        assert.ok(
          Math.abs(length - top.lengths[i]! - settled.scroll) < 0.1,
          `${label}: payout matches document scroll`,
        ),
      );
      assert.ok(
        settled.ropeExtent >= settled.scroll + 20,
        `${label}: ropes render their full document length`,
      );
      assert.ok(
        settled.detailBytes < 10000,
        "Offscreen rope detail does not grow with page length",
      );
      assert.equal(settled.frames, 0, "Settled sign owns no animation frames");
      const before = await page.locator(".sign-ropes").innerHTML();
      await page.waitForTimeout(300);
      assert.equal(
        await page.locator(".sign-ropes").innerHTML(),
        before,
        "Sleeping ropes do not render",
      );
      await page.screenshot({ path: `.verify/sign-scroll-${label}.png` });
      positions.push({ label, settledMs, flight, settled });
    }
    const sequence = await scrollSequence(page);

    // Replay persisted scroll at DOM readiness. This exercises hydration timing without
    // depending on Chromium's automatic restoration after an automated scroll tour.
    await page.addInitScript((top) => {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          const navigation = performance.getEntriesByType("navigation")[0] as
            PerformanceNavigationTiming | undefined;
          if (navigation?.type === "reload")
            scrollTo({ top, behavior: "instant" });
        },
        { once: true },
      );
    }, maxScroll / 2);
    await page.reload();
    await page.waitForFunction((minScroll) => {
      const state = (window as any).__portfolioSign?.();
      return state && scrollY > minScroll && state.pageScroll === scrollY;
    }, maxScroll / 3);
    const restored = await pose(page);
    await writeFile(
      ".verify/sign-restored.json",
      JSON.stringify({ top, restored }, null, 2),
    );
    assert.ok(
      restored.sign.y >= 0 && restored.sign.y < 90,
      "Reload mid-page starts in view without a long drop",
    );
    assert.ok(
      restored.lengths.every(
        (length, i) => Math.abs(length - top.lengths[i]! - restored.scroll) < 9,
      ),
      `Reload initializes already-paid-out ropes: ${JSON.stringify({ top: top.lengths, restored })}`,
    );

    await page.goto(url + "?sign-anchor#contact");
    await page.waitForFunction(
      () => !!(window as any).__portfolioSign && scrollY > 0,
    );
    await asleep(page);
    const anchorNavigation = await pose(page);
    assert.ok(
      anchorNavigation.sign.y > 10 && anchorNavigation.sign.y < 90,
      "Direct anchor navigation starts the sign near viewport top",
    );

    const signRect = (await page.locator(".sign").boundingBox())!;
    const pointer = {
      x: signRect.x + signRect.width / 2,
      y: signRect.y + signRect.height / 2,
    };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    await page.evaluate(() =>
      scrollTo({ top: scrollY - 180, behavior: "instant" }),
    );
    await page.waitForTimeout(180);
    const heldAfterScroll = await pose(page);
    assert.ok(
      Math.abs(heldAfterScroll.sign.y - signRect.y) < 8,
      "The grab constraint keeps the held board at the pointer during scroll",
    );
    await page.evaluate((pointer) => {
      scrollTo({ top: scrollY + 90, behavior: "instant" });
      document.querySelector(".sign")!.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: pointer.x,
          clientY: pointer.y + 20,
          pointerId: 1,
        }),
      );
    }, pointer);
    await page.waitForTimeout(180);
    const coalescedDrag = await pose(page);
    assert.ok(
      Math.abs(coalescedDrag.sign.y - signRect.y - 20) < 8,
      "Pointer movement before the scroll rAF does not count scrolling twice",
    );
    await page.mouse.move(pointer.x, pointer.y + 100, { steps: 6 });
    await page.waitForTimeout(180);
    const dragged = await pose(page);
    assert.ok(
      dragged.lengths.some((n) => n > dragged.targetLength + 50),
      "Dragging after scroll still pays out rope",
    );
    await page.mouse.up();
    await page.mouse.move(1, 1);
    await asleep(page);
    const dragSettled = await pose(page);
    assert.ok(
      dragSettled.lengths.every(
        (n) => Math.abs(n - dragSettled.targetLength) < 0.1,
      ),
      "Release winds back to the current scroll target",
    );

    await page.evaluate(() =>
      scrollTo({ top: scrollY - 180, behavior: "instant" }),
    );
    await page.waitForFunction(() => (window as any).__portfolioSign().running);
    const oldScope = await page.evaluate(() => {
      (window as any).__oldSignScope = (window as any).__portfolioSign().scope;
      return (window as any).__oldSignScope.frames.size;
    });
    assert.ok(
      oldScope > 0,
      "Motion preference changes during an active sign simulation",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () => !document.querySelector(".sign-rig")?.classList.contains("is-live"),
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const scope = (window as any).__oldSignScope;
        return {
          aborted: scope.signal.aborted,
          frames: scope.frames.size,
          timers: scope.timers.size,
        };
      }),
      { aborted: true, frames: 0, timers: 0 },
    );
    await page.waitForFunction(() => {
      const r = document.querySelector(".sign")!.getBoundingClientRect();
      return r.y > 10 && r.y < 90;
    });
    const reduced = await page.locator(".sign").boundingBox();
    assert.ok(
      reduced && reduced.y > 10 && reduced.y < 90,
      `Reduced motion remains fixed and visible when scrolled: ${JSON.stringify(reduced)}`,
    );
    assert.equal(
      await page.locator(".sign-ropes path").count(),
      0,
      "Reduced motion removes simulated ropes",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => !!(window as any).__portfolioSign);
    const resumed = await pose(page);
    assert.ok(
      resumed.sign.y >= 0 && resumed.sign.y < 90,
      "Restoring animation while scrolled starts at the right payout",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    await asleep(page);
    const continuous = await page.evaluate(async () => {
      const samples = [];
      const bottom = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= bottom + 180; y += 180) {
        scrollTo({ top: y, behavior: "instant" });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const r = document.querySelector(".sign")!.getBoundingClientRect();
        samples.push({ x: r.x, y: r.y, right: r.right });
      }
      return { samples, width: innerWidth };
    });
    assert.ok(
      continuous.samples.some((p) => p.y < -100),
      "During sustained scrolling the mobile board moves out of view with the content",
    );
    assert.ok(
      continuous.samples.every((p) => p.x >= 0 && p.right <= continuous.width),
      "The crew keeps the mobile board within the viewport",
    );
    await asleep(page);
    const mobileBottom = await pose(page);
    assert.ok(
      mobileBottom.sign.y > 10 && mobileBottom.sign.y < 90,
      "Mobile board returns into view after scrolling stops",
    );
    assert.ok(
      mobileBottom.anchors.every((a: { y: number }) => Math.abs(a.y) < 0.1),
      "Mobile rope anchors stay at document top",
    );
    await page.screenshot({ path: ".verify/sign-scroll-mobile.png" });
    const noJS = await browser.newPage({
      viewport: { width: 390, height: 844 },
      javaScriptEnabled: false,
    });
    const noJSCheck = watch(noJS, "no-JS sign", true);
    let fallback;
    try {
      await noJS.goto(url);
      await noJS.evaluate(() =>
        scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant",
        }),
      );
      fallback = await noJS.locator(".sign-rig").evaluate((el) => ({
        top: el.querySelector(".sign")!.getBoundingClientRect().top,
        position: getComputedStyle(el).position,
        ropes: ["::before", "::after"].map((p) =>
          parseFloat(getComputedStyle(el, p).height),
        ),
      }));
      assert.equal(fallback.position, "fixed");
      assert.ok(
        fallback.top > 10 &&
          fallback.top < 90 &&
          fallback.ropes.every((h) => h > 10),
        "No-JS sign and both static ropes remain visible",
      );
      await noJS.screenshot({ path: ".verify/sign-no-js-fallback.png" });
      noJSCheck();
    } finally {
      await noJS.close();
    }
    const crew = await verifyCrew(browser, url);
    return {
      crew,
      positions,
      sequence,
      restored,
      anchorNavigation,
      heldAfterScroll,
      coalescedDrag,
      dragged,
      dragSettled,
      resumed,
      continuous,
      mobileBottom,
      fallback,
      browserErrors: check(),
    };
  } finally {
    await page.close();
  }
}

if (import.meta.main) {
  await mkdir(".verify", { recursive: true });
  const preview = await startPreview();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const report = await verifySign(
      browser,
      preview.url,
      (page, label, scriptsDisabled) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("response", (response) => {
          if (response.status() >= 400)
            errors.push(`${response.url()}: ${response.status()}`);
        });
        page.on("requestfailed", (request) => {
          if (
            scriptsDisabled &&
            request.failure()?.errorText === "csp" &&
            /\.js$/.test(request.url())
          )
            return;
          errors.push(`${request.url()}: ${request.failure()?.errorText}`);
        });
        return () => {
          assert.deepEqual(errors, [], `${label}: browser errors`);
          return errors;
        };
      },
    );
    await writeFile(
      ".verify/sign-report.json",
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          positions: report.positions.map((p) => ({
            label: p.label,
            settledMs: p.settledMs,
            firstY: p.flight.samples[0]!.y,
            settledY: p.settled.sign.y,
            anchors: p.settled.anchors,
            frames: p.settled.frames,
          })),
          restored: report.restored.sign,
          mobile: report.mobileBottom.sign,
          browserErrors: report.browserErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    await preview.close();
  }
}
