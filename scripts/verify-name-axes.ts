import { waitForPhysicsFontReady } from "./verify-physics-ready.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";

type Watch = (page: Page, label: string) => () => string[];
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).__portfolioPhysics;
    return p
      .letters()
      .filter((l: any) => l.glyph)
      .map((l: any) => ({
        char: l.el.textContent as string,
        ...Object.fromEntries(
          [
            ...(l.glyph?.getAttribute("data-font-axes") ?? getComputedStyle(l.glyph ?? l.el).fontVariationSettings).matchAll(
              /"(\w+)"\s+(-?[\d.]+)/g,
            ),
          ].map((m) => [m[1], Number(m[2])]),
        ),
        falling: !!l.falling,
        held: !!l.held,
        impact: l.axisImpactFrames > 0,
        hullWidth: l.hull?.sx ?? 1,
        hullHeight: l.hull?.sy ?? 1,
        y: l.body.position.y,
        skew: Number(
          (l.glyph instanceof SVGElement ? l.el : l.glyph).style.transform.match(/skewX\(([-\d.]+)/)?.[1] ?? 0,
        ),
        distance: p.ball()
          ? Math.hypot(
              l.body.position.x - p.ball().body.position.x,
              l.body.position.y - p.ball().body.position.y,
            ) /
            parseFloat(
              getComputedStyle(document.querySelector(".hero-name")!).fontSize,
            )
          : null,
      })) as ({
      char: string;
      falling: boolean;
      held: boolean;
      impact: boolean;
      y: number;
      skew: number;
      distance: number | null;
    } & Record<string, any>)[];
  });
}
type Sample = Awaited<ReturnType<typeof snapshot>>;
function ranges(samples: Sample[]) {
  const values = samples.flat();
  return Object.fromEntries(
    ["wght", "wdth", "GRAD", "ROND", "slnt", "skew"].map((axis) => [
      axis,
      [
        Math.min(...values.map((v) => v[axis])),
        Math.max(...values.map((v) => v[axis])),
      ],
    ]),
  );
}
type Probe = (page: Page, scene: string) => Promise<void>;
async function sleep(page: Page, probe?: Probe, scene = "return-home") {
  const step = probe ? 32 : 1000;
  for (let elapsed = 0; elapsed < 20000; elapsed += step) {
    await page.clock.runFor(step);
    await probe?.(page, scene);
    if (
      await page.evaluate(() => !(window as any).__portfolioPhysics.isRunning())
    )
      return;
  }
  assert.fail("Name axes and physical bodies sleep within 20 seconds");
}
async function idleWrites(page: Page) {
  await page.evaluate(() => {
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
    });
    document
      .querySelectorAll(".hero-name .char, .hero-name .char-glyph, .hero-name .char-glyph path")
      .forEach((el) => observer.observe(el, { attributes: true }));
    (window as any).__axisIdleDone = () => {
      observer.disconnect();
      return writes;
    };
  });
  await page.clock.runFor(600);
  const writes = await page.evaluate(() => (window as any).__axisIdleDone());
  assert.equal(
    writes,
    0,
    "Resting glyphs and parked proximity fields write no styles",
  );
  return writes;
}
async function prepare(page: Page, url: string) {
  const start = new Date("2026-10-15T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  await page.goto(url + "/?verify");
  await waitForPhysicsFontReady(page);
  await page.clock.runFor(180);
  assert.equal(await page.locator(".char").count(), 18);
}

// Fixed-clock real touch/mouse input makes peak assertions reproducible. All axis
// assertions read computed styles; none prescribe a body position or spring value.
export async function verifyNameAxes(
  browser: Browser,
  url: string,
  watch: Watch,
  probe?: Probe,
) {
  const results = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: true,
      isMobile: width === 390,
    });
    const page = await context.newPage(),
      check = watch(page, `name axes ${width}`);
    try {
      await prepare(page, url);
      const homes = () =>
        page.evaluate(() =>
          (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({ id: l.body.id, x: l.ox, y: l.oy })),
        );
      const before = await homes();
      const entrance: Sample[] = [];
      let fallShot = false,
        impactShot = false;
      for (let i = 0; i < 80; i++) {
        await page.clock.runFor(32);
        const sample = await snapshot(page);
        entrance.push(sample);
        await probe?.(page, "drop-impact");
        if (
          !fallShot &&
          sample.filter((l) => l.falling && l.wdth <= 40 && l.y > 150).length >=
            3
        ) {
          await page.screenshot({ path: `.verify/name-fall-${width}.png` });
          fallShot = true;
        }
        if (
          !impactShot &&
          sample.some(
            (l) =>
              l.impact && l.wdth >= 145 && l.wght >= 950 && l.hullWidth > 1.05,
          )
        ) {
          await page.screenshot({ path: `.verify/name-impact-${width}.png` });
          impactShot = true;
        }
      }
      await writeFile(
        `.verify/name-entrance-${width}.json`,
        JSON.stringify(entrance, null, 2),
      );
      assert.ok(fallShot, "Visible fall reaches width <=40");
      assert.ok(
        entrance.flat().some((l) => l.falling && l.wght <= 450),
        "Falling becomes visibly lighter",
      );
      assert.ok(
        impactShot,
        "A real landing/collision reaches width >=145 and weight >=950",
      );
      await sleep(page, probe, "return-home");

      // Trigger just beyond the left viewport, outside the physical impulse radius.
      // Isolate the visual wave's spring overshoot from subsequent collisions.
      await page.evaluate(() =>
        document.dispatchEvent(
          new MouseEvent("click", {
            clientX: -parseFloat(
              getComputedStyle(document.querySelector(".hero-name")!).fontSize,
            ),
            clientY: 0,
            detail: 1,
            bubbles: true,
          }),
        ),
      );
      const burst: Sample[] = [],
        onsets = new Map<number, number>();
      let burstShot = false,
        deformingSolverFrames = 0,
        previousSolverTime = -1;
      for (let i = 0; i < 65; i++) {
        await page.clock.runFor(32);
        const sample = await snapshot(page);
        const solverTime = await page.evaluate(
          () => (window as any).__portfolioPhysics.engine.timing.timestamp,
        );
        if (
          solverTime > previousSolverTime &&
          sample.some((l) => l.wdth !== 100)
        )
          deformingSolverFrames++;
        previousSolverTime = solverTime;
        burst.push(sample);
        await probe?.(page, "burst");
        sample.forEach((l, index) => {
          if (l.wdth <= 45 && !onsets.has(index)) onsets.set(index, i * 32);
        });
        if (
          !burstShot &&
          sample.some((l) => l.wdth === 151 && l.wght === 1000) &&
          sample.some((l) => l.wdth <= 45)
        ) {
          await page.screenshot({ path: `.verify/name-burst-${width}.png` });
          burstShot = true;
        }
      }
      const burstRanges = ranges(burst);
      assert.ok(burstRanges.wdth![0]! <= 30 && burstRanges.wdth![1]! >= 150);
      assert.ok(burstRanges.wght![0]! <= 200 && burstRanges.wght![1]! === 1000);
      assert.equal(onsets.size, 12, "The shockwave reaches every name letter");
      const delaySpread =
        Math.max(...onsets.values()) - Math.min(...onsets.values());
      assert.ok(
        delaySpread >= 160,
        `The wave travels across the name: ${delaySpread}ms`,
      );
      assert.ok(
        burstShot,
        "Screenshot captures both thin leading edge and heavy crest",
      );
      assert.ok(
        deformingSolverFrames > 5,
        "Axis-driven hull changes run the contact solver",
      );
      const crest = burst.findIndex((sample) => sample[0]!.wdth >= 145);
      const rebound = burst.findIndex(
        (sample, i) => i > crest && sample[0]!.wdth <= 95,
      );
      assert.ok(
        crest >= 0 &&
          rebound > crest &&
          burst.some((sample, i) => i > rebound && sample[0]!.wdth >= 102),
        "Damped spring crosses rest and wobbles back again",
      );
      await sleep(page, probe, "return-home");

      const point = await page.evaluate(() => {
        const l = (window as any).__portfolioPhysics
          .letters()
          .find((l: any) => l.el.textContent === "y");
        return {
          x: l.body.position.x,
          y: l.body.position.y,
          size: parseFloat(getComputedStyle(l.el).fontSize),
        };
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: point.x, y: point.y }],
      });
      await page.clock.runFor(80);
      assert.equal(await page.locator(".char.is-held").count(), 1);
      // Lift the edge letter clear of its neighbours before testing two-way lean.
      // Pushing left through the e tests its collision hull, rather than free drag.
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: point.x, y: point.y - i * point.size * 0.1 }],
        });
        await page.clock.runFor(32);
      }
      const drag: Sample[] = [];
      let dragShot = false;
      for (let i = 1; i <= 24; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: point.x - Math.sin((i * Math.PI) / 12) * point.size * 0.4,
              y:
                point.y -
                point.size * (0.8 + Math.sin((i * Math.PI) / 12) * 0.08),
            },
          ],
        });
        await page.clock.runFor(32);
        const sample = (await snapshot(page)).filter((l) => l.held);
        drag.push(sample);
        await probe?.(page, "grab-drag");
        if (!dragShot && sample.some((l) => l.wdth >= 130)) {
          await page.screenshot({ path: `.verify/name-drag-${width}.png` });
          dragShot = true;
        }
      }
      const dragRanges = ranges(drag);
      await writeFile(
        `.verify/name-drag-${width}.json`,
        JSON.stringify(drag, null, 2),
      );
      assert.ok(
        drag.flat().every((l) => l.ROND === 100),
        "Grab is fully round throughout the gesture",
      );
      assert.ok(
        dragRanges.wdth![1]! - dragRanges.wdth![0]! >= 50,
        "Velocity-driven grab visibly squashes and stretches",
      );
      assert.ok(dragRanges.wght![1]! - dragRanges.wght![0]! >= 250);
      assert.equal(
        dragRanges.slnt![0],
        -10,
        "Modest sideways movement reaches full slant",
      );
      assert.ok(
        dragRanges.skew![1]! >= 15,
        "Leftward motion mirrors the font lean",
      );
      assert.ok(dragShot);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await sleep(page, probe, "return-home");
      assert.deepEqual(
        await homes(),
        before,
        "All effects preserve rest advances and collision-body identity",
      );
      const writes = await idleWrites(page);
      const settled = await snapshot(page);
      await probe?.(page, "rest");
      assert.ok(
        settled.every(
          (l) =>
            l.wght === 760 &&
            l.wdth === 100 &&
            l.GRAD === 0 &&
            l.ROND === 30 &&
            l.slnt === 0 &&
            l.skew === 0,
        ),
      );
      await page.screenshot({ path: `.verify/name-rest-${width}.png` });
      results.push({
        width,
        entrance: ranges(entrance),
        burst: burstRanges,
        delaySpread,
        springRebound: true,
        deformingSolverFrames,
        drag: dragRanges,
        stableHomes: true,
        idleWrites: writes,
        browserErrors: check(),
      });
    } finally {
      await context.close();
    }

    // A mouse at each viewport verifies the larger proximity field independently
    // of the touch-only grab scene, which intentionally has no cursor ball.
    const mouseContext = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const mousePage = await mouseContext.newPage(),
      mouseCheck = watch(mousePage, `name proximity ${width}`);
    try {
      await prepare(mousePage, url);
      await sleep(mousePage, probe, "proximity-return");
      const layout = () =>
        mousePage.evaluate(() => ({
          homes: (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({ id: l.body.id, x: l.ox, y: l.oy })),
          nameHeight:
            document.querySelector<HTMLElement>(".hero-name")!.offsetHeight,
          rule: document.querySelector<HTMLElement>(".hero-foot")!.offsetTop,
        }));
      const before = await layout();
      const point = await mousePage.evaluate(() => {
        const l = (window as any).__portfolioPhysics.letters()[2];
        return {
          x: l.ox,
          y: l.oy - parseFloat(getComputedStyle(l.el).fontSize) * 0.55,
        };
      });
      await mousePage.mouse.move(point.x, point.y);
      for (let sample = 0; sample < 50; sample++) {
        await mousePage.clock.runFor(32);
        await probe?.(mousePage, "proximity");
      }
      const proximity = await snapshot(mousePage);
      assert.ok(
        proximity.some((l) => l.GRAD === 100 && l.wght >= 980 && l.ROND >= 98),
        "Near the ball, grade/weight/roundness all reach the puffy extreme",
      );
      assert.ok(
        proximity.some((l) => l.distance! > 1 && l.GRAD > 0),
        "The proximity field extends beyond one em",
      );
      assert.deepEqual(
        await layout(),
        before,
        "Puffing preserves measured homes, name height, and the floor line",
      );
      await mousePage.screenshot({
        path: `.verify/name-proximity-${width}.png`,
      });
      await sleep(mousePage, probe, "proximity-return");
      const writes = await idleWrites(mousePage);
      await mousePage.emulateMedia({ reducedMotion: "reduce" });
      await mousePage.clock.runFor(100);
      await mousePage.waitForFunction(
        () => (window as any).__portfolioPhysics.letters().length === 0,
      );
      // Media invalidation also uses Chromium's real render clock.
      await mousePage.waitForTimeout(100);
      const reduced = await mousePage
        .locator(".hero-name .char")
        .evaluateAll((elements) =>
          elements.map((el) => ({
            axes: Object.fromEntries(
              [
                ...getComputedStyle(el.querySelector(".char-glyph") ?? el).fontVariationSettings.matchAll(
                  /"(\w+)"\s+(-?[\d.]+)/g,
                ),
              ].map((m) => [m[1], Number(m[2])]),
            ),
            inline: ((el.querySelector(".char-glyph") ?? el) as HTMLElement).style.fontVariationSettings,
            glyph:
              el.querySelector<HTMLElement>(".char-glyph")?.style.transform ??
              "",
            native: !(el.querySelector(".char-glyph") instanceof SVGElement),
          })),
        );
      assert.ok(reduced.every((l) => l.native && l.inline === "" && l.glyph === ""));
      await writeFile(
        `.verify/name-reduced-${width}.json`,
        JSON.stringify(reduced, null, 2),
      );
      for (const l of reduced)
        assert.deepEqual(l.axes, {
          wght: 760,
          wdth: 100,
          GRAD: 0,
          ROND: 30,
          slnt: 0,
        });
      assert.equal(
        await mousePage.evaluate(() =>
          (window as any).__portfolioPhysics.isRunning(),
        ),
        false,
      );
      results.push({
        width,
        proximity: ranges([proximity]),
        stableHomes: true,
        idleWrites: writes,
        reducedRest: true,
        browserErrors: mouseCheck(),
      });
    } finally {
      await mouseContext.close();
    }
  }
  return results;
}

if (import.meta.main) {
  const preview = await startPreview(),
    browser = await chromium.launch({ headless: true });
  try {
    const results = await verifyNameAxes(
      browser,
      preview.url,
      (page, label) => {
        const errors: string[] = [];
        page.on("pageerror", (error) =>
          errors.push(`${label}: ${error.message}`),
        );
        return () => {
          assert.deepEqual(errors, []);
          return errors;
        };
      },
    );
    await writeFile(".verify/name-axes.json", JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    await preview.close();
  }
}
