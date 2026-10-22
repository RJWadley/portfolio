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
      "Scrolling does not inject sideways motion",
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
    return {
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
