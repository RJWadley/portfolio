import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";

type Watch = (page: Page, label: string) => () => string[];
const rest = { wght: 760, wdth: 100, GRAD: 0, ROND: 30, slnt: 0 };
async function axes(page: Page, selector = ".hero-name .char") {
  return page
    .locator(selector)
    .first()
    .evaluate((el) =>
      Object.fromEntries(
        [
          ...((el.querySelector(".char-glyph") ?? el).getAttribute("data-font-axes") ??
            getComputedStyle(el.querySelector(".char-glyph") ?? el).fontVariationSettings).matchAll(
            /"(\w+)"\s+(-?[\d.]+)/g,
          ),
        ].map((m) => [m[1], Number(m[2])]),
      ),
    );
}
async function asleep(page: Page) {
  await page
    .waitForFunction(
      () => !(window as any).__portfolioPhysics.isRunning(),
      null,
      { timeout: 20000 },
    )
    .catch(async (error) => {
      console.log(
        "Typography sleep failure",
        await page.evaluate(() => ({
          width: innerWidth,
          letters: (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({
              char: l.el.textContent,
              away: Math.hypot(
                l.hx - l.body.position.x,
                l.hy - l.body.position.y,
              ),
              angle: l.body.angle,
              speed: l.body.speed,
              falling: l.falling,
              entering: l.entering,
              nudged: !!l.nudged,
              axes: l.axes,
              pose: l.hull?.pose,
              stage: l.axisBurstStage,
            })),
        })),
      );
      await page.screenshot({ path: ".verify/typography-sleep-failure.png" });
      throw error;
    });
}
export async function verifyFontFamily(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const families = await page
    .locator(
      "body, h1, h2, h3, p, a, .mono, .facts dt, .archive-list small, .sign b, .sign small, .roller-track span",
    )
    .evaluateAll((elements) => [
      ...new Set(elements.map((el) => getComputedStyle(el).fontFamily)),
    ]);
  assert.deepEqual(families, ['"Google Sans Flex"']);
  assert.ok(
    await page.evaluate(() =>
      [...document.fonts].some(
        (face) =>
          face.family.includes("Google Sans Flex") && face.status === "loaded",
      ),
    ),
  );
}

export async function verifyTypography(
  browser: Browser,
  url: string,
  watch: Watch,
) {
  const results = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: true,
      isMobile: width === 390,
    });
    const page = await context.newPage(),
      check = watch(page, `typography ${width}`);
    let releaseFont!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFont = resolve;
    });
    await page.route("**/*.woff2", async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.addInitScript(() => {
        (window as any).__unmeasuredHeroFlash = false;
        function sample() {
          const p = (window as any).__portfolioPhysics;
          const char = document.querySelector(".hero-name .char");
          if (p?.letters().length) return;
          if (
            char &&
            !matchMedia("(prefers-reduced-motion: reduce)").matches &&
            getComputedStyle(char).visibility === "visible"
          )
            (window as any).__unmeasuredHeroFlash = true;
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      await page.goto(url + "/?verify", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!(window as any).__portfolioPhysics);
      assert.equal(
        await page.locator(".char").count(),
        0,
        "Splitting waits for the font",
      );
      assert.equal(
        await page
          .locator(".hero-name .line")
          .first()
          .evaluate((el) => getComputedStyle(el).visibility),
        "hidden",
      );
      assert.equal(
        await page
          .locator(".sign-rig")
          .evaluate((el) => el.classList.contains("is-live")),
        false,
        "Sign also waits for the font",
      );
      releaseFont();
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics.letters().length === 18,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          (window as any).__portfolioPhysics.typography(),
        ),
        { ready: true, measuredWithFont: true },
      );
      assert.equal(
        await page.evaluate(() => (window as any).__unmeasuredHeroFlash),
        false,
        "No rest-pose flash before the measured entrance",
      );
      await verifyFontFamily(page);
      const homes = () =>
        page.evaluate(() =>
          (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({ id: l.body.id, x: l.ox, y: l.oy })),
        );
      const before = await homes();
      const fall = await page.evaluate(async () => {
        const values = new Set<string>();
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          document
            .querySelectorAll(".hero-name .char")
            .forEach((el) =>
              values.add((el.querySelector(".char-glyph") ?? el).getAttribute("data-font-axes") ??
                getComputedStyle(el.querySelector(".char-glyph") ?? el).fontVariationSettings),
            );
        }
        return [...values];
      });
      assert.ok(
        fall.length > 1 &&
          fall.some(
            (value) =>
              Number(value.match(/"wdth"\s+([\d.]+)/)?.[1]) !== rest.wdth,
          ),
        "Falling changes the rest width",
      );
      // Exercise font completion while the fall is still changing advance widths.
      await page.evaluate(() =>
        document.fonts.dispatchEvent(
          new FontFaceSetLoadEvent("loadingdone", {
            fontfaces: [...document.fonts],
          }),
        ),
      );
      await page.waitForTimeout(300);
      assert.deepEqual(
        await homes(),
        before,
        "Font completion never measures animated advances or rebuilds stable homes",
      );
      await asleep(page);
      const point = await page.evaluate(() => {
        const l = (window as any).__portfolioPhysics
          .letters()
          .find((l: any) => l.el.textContent === "y");
        return { x: l.body.position.x, y: l.body.position.y };
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await page.waitForTimeout(100);
      assert.equal(await page.locator(".char.is-held").count(), 1);
      assert.equal(
        (await axes(page, ".char.is-held")).ROND,
        100,
        "Grab softens roundness",
      );
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: point.x - 15, y: point.y - 40 }],
      });
      await page.waitForTimeout(100);
      const drag = await axes(page, ".char.is-held");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await asleep(page);
      const burstArrivalDelay = await page.evaluate(
        ({ x, y }) => {
          const p = (window as any).__portfolioPhysics,
            previous = p.interaction().lastBurst?.count ?? 0;
          document.dispatchEvent(
            new PointerEvent("click", {
              clientX: x,
              clientY: y - 20,
              pointerType: "mouse",
              detail: 1,
              bubbles: true,
            }),
          );
          const wave = p.interaction().lastBurst;
          if (wave?.input !== "mouse" || wave.count !== previous + 1)
            throw new Error("Typography fixture fires a new mouse burst");
          // Wave arrival is delayed 100ms per em. Measure the same amplitude
          // 100ms after its leading arrival, rather than before a mobile wave
          // has had that interval to advance its bounded collision pose.
          return Math.max(0, wave.axisLeadAt + 100 - performance.now());
        },
        point,
      );
      await page.waitForTimeout(burstArrivalDelay);
      const burst = await page
        .locator(".hero-name .char")
        .evaluateAll((elements) =>
          elements.map((el) => (el.querySelector(".char-glyph") ?? el).getAttribute("data-font-axes") ??
            getComputedStyle(el.querySelector(".char-glyph") ?? el).fontVariationSettings),
        );
      assert.ok(
        burst.some(
          (value) =>
            Math.abs(
              Number(value.match(/"wght"\s+([\d.]+)/)?.[1]) - rest.wght,
            ) > 150,
        ),
        `Burst makes a dramatic weight change (${width}): ${JSON.stringify(burst)}`,
      );
      await page.screenshot({ path: `.verify/hero-burst-${width}.png` });
      await asleep(page);
      const idleAxisWrites = await page.evaluate(async () => {
        let writes = 0;
        const observer = new MutationObserver((records) => {
          writes += records.length;
        });
        document
          .querySelectorAll(".hero-name .char, .hero-name .char-glyph, .hero-name .char-glyph path")
          .forEach((el) =>
            observer.observe(el, {
              attributes: true,
              attributeFilter: ["style", "d", "data-font-axes"],
            }),
          );
        await new Promise((resolve) => setTimeout(resolve, 600));
        observer.disconnect();
        return writes;
      });
      assert.equal(
        idleAxisWrites,
        0,
        "Sleeping letters schedule no style writes",
      );
      assert.deepEqual(await axes(page), rest);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics.letters().length === 0,
      );
      assert.equal(await page.locator("svg.char-glyph").count(), 0, "Reduced motion restores native text");
      assert.deepEqual(
        await axes(page),
        rest,
        "Live reduced motion restores every rest axis",
      );
      assert.ok(
        await page
          .locator(".hero-name .char")
          .evaluateAll((elements) =>
            elements.every(
              (el) => !((el.querySelector(".char-glyph") ?? el) as HTMLElement).style.fontVariationSettings,
            ),
          ),
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth),
        width,
        "Type fits the viewport",
      );
      for (const id of ["work", "stack", "about", "contact"]) {
        await page
          .locator(`#${id}`)
          .evaluate((el) =>
            el.scrollIntoView({ block: "start", behavior: "instant" }),
          );
        await page.waitForTimeout(1100);
        await page.screenshot({ path: `.verify/type-${id}-${width}.png` });
      }
      results.push({
        width,
        delayedFont: true,
        noUnmeasuredFlash: true,
        fallSamples: fall.length,
        drag,
        burst,
        stableHomes: true,
        idleAxisWrites,
        reducedAxes: await axes(page),
        browserErrors: check(),
      });
    } finally {
      releaseFont();
      await context.close();
    }
  }
  return results;
}
