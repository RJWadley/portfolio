import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startPreview } from "./preview.ts";

type Watch = (page: Page, label: string) => () => string[];

async function settled(page: Page) {
  await page
    .waitForFunction(
      () => !(window as any).__portfolioPhysics.isRunning(),
      null,
      { timeout: 20000 },
    )
    .catch(async (error) => {
      console.log(
        "Hero sleep timeout",
        await page.evaluate(() => ({
          width: innerWidth,
          interaction: (window as any).__portfolioPhysics.interaction(),
          pairs: (window as any).__portfolioPhysics.engine.pairs.list
            .filter((q: any) => q.isActive)
            .map((q: any) => [q.collision.parentA.id, q.collision.parentB.id]),
          letters: (window as any).__portfolioPhysics
            .letters()
            .map((l: any) => ({
              char: l.el.textContent,
              id: l.body.id,
              mouseNear: l.mouseNear,
              noProgress: l.noProgress,
              tick: l.tick,
              attempts: l.attempts,
              lastAway: l.lastAway,
              axes: l.axes,
              pose: l.hull?.pose,
              burstStage: l.axisBurstStage,
              impactFrames: l.axisImpactFrames,
              changing: l.hull?.changed,
              away: Math.hypot(
                l.hx - l.body.position.x,
                l.hy - l.body.position.y,
              ),
              angle: l.body.angle,
              speed: l.body.speed,
              entering: l.entering,
              falling: l.falling,
              nudged: !!l.nudged,
              stuck: l.stuck,
            })),
        })),
      );
      await page.screenshot({
        path: `.verify/hero-sleep-failure-${page.viewportSize()?.width}.png`,
      });
      await writeFile(`.verify/hero-sleep-state-${page.viewportSize()?.width}.json`,JSON.stringify(await page.evaluate(()=>{const p=(window as any).__portfolioPhysics;return{interaction:p.interaction(),letters:p.letters().map((l:any)=>{let at=0;const cos=Math.cos(l.body.angle),sin=Math.sin(l.body.angle);return{char:l.el.textContent,id:l.body.id,position:l.body.position,home:[l.hx,l.hy],angle:l.body.angle,loops:l.hull?.work[0].loops.map((loop:any[])=>l.hull.points.slice(at,(at+=loop.length)).map((q:any)=>({x:l.body.position.x+q.x*cos-q.y*sin,y:l.body.position.y+q.x*sin+q.y*cos}))),parts:l.body.parts.slice(1).filter((q:any)=>q.vertices.length>=3).map((q:any)=>q.vertices.map((v:any)=>({x:v.x,y:v.y}))),axes:l.axes,pose:l.hull?.pose,attempts:l.attempts};})};}),null,2));
      throw error;
    });
}

// Attach before mount so the entrance and every solver contact are covered, not just
// the final pose. Rendered hulls are checked too, including interpolated rotation.
async function watchFloor(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener("portfolio:physics", ((event: CustomEvent) => {
      const p = event.detail;
      if (!p) return;
      const sample = {
        solverOverflow: 0,
        renderedOverflow: 0,
        contacts: 0,
        steps: 0,
        worst: null as null | {
          char: string;
          held: boolean;
          falling: boolean;
          speed: number;
        },
      };
      (window as any).__heroFloorSample = sample;
      (window as any).Matter.Events.on(p.engine, "afterUpdate", () => {
        const floor = p.floor();
        if (!floor) return;
        sample.steps++;
        for (const l of p.letters())
          if (l.isHero) {
            const vertices =
              l.body.parts.length > 1
                ? l.body.parts.slice(1).flatMap((part: any) => part.vertices)
                : l.body.vertices;
            const overflow = Math.max(
              ...vertices.map((v: any) => v.y - floor.bounds.min.y),
            );
            if (overflow > sample.solverOverflow) {
              sample.solverOverflow = overflow;
              sample.worst = {
                char: l.el.textContent,
                held: !!l.held,
                falling: !!l.falling,
                speed: l.body.speed,
              };
            }
          }
        for (const pair of p.engine.pairs.list)
          if (
            pair.isActive &&
            (pair.collision.parentA === floor ||
              pair.collision.parentB === floor)
          )
            sample.contacts++;
      });
      function renderSample() {
        if (p.scope.signal.aborted) return;
        const floor = p.floor();
        if (floor)
          for (const l of p.letters())
            if (l.isHero) {
              // Geometry changes with the axes. Read today's local hull, not the
              // first entrance frame's shape, before checking the drawing transform.
              const cos = Math.cos(l.body.angle),
                sin = Math.sin(l.body.angle);
              // The hull is already squashed/sheared. The promoted HTML layer
              // now composes that same affine, so apply only its rigid prefix
              // when drawing today's local collision surface for this check.
              const matrix = new DOMMatrix(l.el.style.transform.replace(/(?:skewX|scale)\([^)]*\)/g, ""));
              // The parent rectangle is broadphase only; these are the collision surfaces.
              const vertices =
                l.body.parts.length > 1
                  ? l.body.parts.slice(1).flatMap((part: any) => part.vertices)
                  : l.body.vertices;
              for (const vertex of vertices) {
                const dx = vertex.x - l.body.position.x,
                  dy = vertex.y - l.body.position.y;
                const x = dx * cos + dy * sin,
                  y = -dx * sin + dy * cos;
                sample.renderedOverflow = Math.max(
                  sample.renderedOverflow,
                  l.oy +
                    matrix.m42 +
                    matrix.m12 * x +
                    matrix.m22 * y -
                    floor.bounds.min.y,
                );
              }
            }
        requestAnimationFrame(renderSample);
      }
      requestAnimationFrame(renderSample);
    }) as EventListener);
  });
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const p = (window as any).__portfolioPhysics,
      floor = p.floor();
    const hero = p.letters().filter((l: any) => l.isHero);
    const dot = document.querySelector(".hero-name .dot .char")!,
      ball = document.querySelector(".cursor-ball")!;
    const dotStyle = getComputedStyle(dot),
      style = getComputedStyle(ball),
      body = p.ball()?.body;
    return {
      fontSize: parseFloat(
        getComputedStyle(document.querySelector(".hero-name")!).fontSize,
      ),
      floorY: floor.bounds.min.y,
      ruleY:
        document.querySelector(".hero-foot")!.getBoundingClientRect().top +
        scrollY,
      homeClearance: Math.min(
        ...hero.map((l: any) => floor.bounds.min.y - l.homeBounds.max.y),
      ),
      homeError: Math.max(
        ...hero.map((l: any) =>
          Math.hypot(l.body.position.x - l.hx, l.body.position.y - l.hy),
        ),
      ),
      dotWidth: parseFloat(dotStyle.width),
      dotHeight: parseFloat(dotStyle.height),
      width: parseFloat(style.width),
      height: parseFloat(style.height),
      radius: style.borderTopLeftRadius,
      dotRadius: dotStyle.borderTopLeftRadius,
      fill: style.backgroundColor,
      dotFill: dotStyle.backgroundColor,
      shadow: style.boxShadow,
      border: parseFloat(style.borderTopWidth),
      bodyWidth:
        body &&
        Math.max(...body.vertices.map((v: any) => v.x)) -
          Math.min(...body.vertices.map((v: any) => v.x)),
      bodyHeight:
        body &&
        Math.max(...body.vertices.map((v: any) => v.y)) -
          Math.min(...body.vertices.map((v: any) => v.y)),
      squareBody: body && !body.circleRadius && body.inertia === Infinity,
    };
  });
}

export async function verifyHeroPhysics(
  browser: Browser,
  url: string,
  watch: Watch,
  onlyWidth?: number,
) {
  const results = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ].filter((size) => !onlyWidth || size.width === onlyWidth)) {
    const mobile = viewport.width === 390;
    const context = await browser.newContext({
      viewport,
      hasTouch: mobile,
      isMobile: mobile,
    });
    const page = await context.newPage(),
      check = watch(page, `hero physics ${viewport.width}`);
    try {
      await watchFloor(page);
      await page.goto(url + "/?verify");
      await page.waitForFunction(
        () => (window as any).__portfolioPhysics?.letters().length === 18,
      );
      const entrance = await page.evaluate(() => {
        const letters = (window as any).__portfolioPhysics.letters();
        return {
          hero: letters
            .filter((l: any) => l.isHero)
            .map((l: any) => ({
              falling: l.falling,
              bottom: Math.max(...l.body.vertices.map((v: any) => v.y)),
            })),
          footerFalling: letters
            .filter((l: any) => !l.isHero)
            .some((l: any) => l.falling),
          heroAnimation: getComputedStyle(
            document.querySelector(".hero-name .char-in")!,
          ).animationName,
        };
      });
      assert.ok(
        entrance.hero.every((l: any) => l.falling && l.bottom < 0),
        "Hero bodies spawn above the page",
      );
      assert.equal(
        entrance.footerFalling,
        false,
        "Footer keeps its home behavior",
      );
      assert.equal(
        entrance.heroAnimation,
        "none",
        "CSS rise does not compete with physics",
      );
      await page.waitForTimeout(550);
      await page.screenshot({
        path: `.verify/hero-fall-${viewport.width}.png`,
      });
      const cdp = await context.newCDPSession(page);
      // Input is live before the drop finishes.
      let entranceTouch = null;
      if (mobile) {
        const falling = await page.evaluate(() => {
          for (const l of (window as any).__portfolioPhysics.letters()) {
            if (!l.isHero || !l.entering || l.el.textContent === ".") continue;
            const rect = l.el.getBoundingClientRect(),
              x = rect.left + rect.width / 2,
              y = rect.top + rect.height / 2;
            if (
              rect.top > 80 &&
              rect.bottom < innerHeight - 80 &&
              document.elementFromPoint(x, y)?.closest(".char") === l.el
            )
              return { x, y, char: l.el.textContent };
          }
          return null;
        });
        assert.ok(
          falling,
          "A dropping letter is available for touch interaction",
        );
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: falling.x, y: falling.y }],
        });
        assert.equal(
          await page.locator(".char.is-held").count(),
          1,
          "A falling letter can be grabbed",
        );
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: falling.x + 10, y: falling.y + 30 }],
        });
        await page.waitForTimeout(100);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        entranceTouch = falling.char;
      } else {
        await page.mouse.move(20, 100);
        await page.mouse.click(20, 100);
        assert.ok(
          await page.evaluate(
            () => (window as any).__portfolioPhysics.interaction().lastBurst,
          ),
        );
      }
      await settled(page);
      if (!mobile) await page.mouse.move(20, 100);
      await settled(page);
      const initial = await geometry(page);
      assert.ok(
        initial.homeClearance > 2,
        `Descenders clear the rule: ${initial.homeClearance}px`,
      );
      assert.ok(
        initial.homeError < 0.1,
        `Entrance settles precisely at home: ${JSON.stringify(initial)}`,
      );
      assert.ok(
        Math.abs(initial.floorY - initial.ruleY) < 0.01,
        "Floor is the visible rule",
      );
      assert.ok(
        Math.abs(initial.width - initial.dotWidth) < 0.1 &&
          Math.abs(initial.height - initial.dotHeight) < 0.1,
      );
      assert.equal(initial.radius, initial.dotRadius);
      assert.equal(initial.fill, initial.dotFill);
      assert.equal(initial.shadow, "none");
      assert.equal(initial.border, 0);
      if (!mobile) {
        assert.equal(initial.squareBody, true);
        assert.ok(
          Math.abs(initial.bodyWidth - initial.width) < 0.2 &&
            Math.abs(initial.bodyHeight - initial.height) < 0.2,
        );
        // A cursor can cross the letter floor and retain its solid shape.
        await page.mouse.move(20, initial.floorY + 100);
        await settled(page);
        assert.ok(
          await page.evaluate(
            () =>
              (window as any).__portfolioPhysics.ball().body.position.y >
              (window as any).__portfolioPhysics.floor().bounds.min.y + 50,
          ),
        );
        await page.mouse.move(20, 100);
        await settled(page);
        const aboveY = await page.evaluate(
          () =>
            (window as any).__portfolioPhysics.letters()[11].homeBounds.min.y -
            70,
        );
        await page.mouse.move(
          await page.evaluate(
            () => (window as any).__portfolioPhysics.letters()[11].hx,
          ),
          aboveY,
        );
        await settled(page);
        await page.mouse.move(
          await page.evaluate(
            () => (window as any).__portfolioPhysics.letters()[11].hx,
          ),
          initial.floorY + 100,
        );
        await settled(page);
        await page.mouse.move(20, 100);
        await settled(page);
      }
      // Touch dragging works on both pointer profiles. Pull the actual descender far
      // below the rule, keep pulling, and release; no body position is set by the test.
      const point = await page.evaluate(() => {
        const l = (window as any).__portfolioPhysics
          .letters()
          .find((l: any) => l.el.textContent === "y");
        return { x: l.body.position.x, y: l.body.position.y };
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      assert.equal(await page.locator(".char.is-held").count(), 1);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: point.x,
            y: Math.min(viewport.height - 10, initial.floorY + 180),
          },
        ],
      });
      await page.waitForTimeout(650);
      await page.screenshot({
        path: `.verify/hero-floor-drag-${viewport.width}.png`,
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await settled(page);
      // A downward burst above the lower row followed by one next to the rule.
      await page.evaluate(() => {
        const p = (window as any).__portfolioPhysics,
          l = p.letters().find((l: any) => l.el.textContent === "y");
        document.dispatchEvent(
          new MouseEvent("click", {
            clientX: l.hx,
            clientY: l.homeBounds.min.y - 8,
            detail: 1,
            bubbles: true,
          }),
        );
      });
      await page.waitForTimeout(200);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: point.x, y: initial.floorY - 4 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      const burst = await page.evaluate(
        () => (window as any).__portfolioPhysics.interaction().lastBurst,
      );
      assert.ok(Math.abs(burst.range / burst.fontSize - 240 / 268.8) < 0.00001);
      assert.ok(Math.abs(burst.speed / burst.fontSize - 38 / 268.8) < 0.00001);
      const rippleWidth = await page
        .locator(".physics-ripple")
        .last()
        .evaluate((el) => parseFloat(getComputedStyle(el).width));
      assert.ok(Math.abs(rippleWidth / burst.fontSize - 144 / 268.8) < 0.001);
      await settled(page);
      await page.screenshot({
        path: `.verify/hero-settled-${viewport.width}.png`,
      });
      const floor = await page.evaluate(
        () => (window as any).__heroFloorSample,
      );
      assert.ok(
        floor.steps > 0 && floor.contacts > 0,
        "Letters actually land against the static floor",
      );
      assert.ok(
        floor.solverOverflow < 0.01,
        `Every solver step stays above the floor: ${JSON.stringify(floor)}`,
      );
      assert.ok(
        floor.renderedOverflow < 0.1,
        `Rendered letters stay above the floor within transform rounding: ${floor.renderedOverflow}px`,
      );
      const resized = [];
      if (!mobile) {
        // The preceding touch input suspends the hybrid mouse ball. Resume
        // actual mouse input before checking that resize preserves its body.
        await page.mouse.move(20, 100);
        await settled(page);
        assert.ok(await page.evaluate(() => (window as any).__portfolioPhysics.ball()),
          "Real mouse input restores the cursor after touch");
      }
      if (!mobile)
        for (const size of [
          { width: 1280, height: 800 },
          { width: 320, height: 568 },
          { width: 768, height: 1024 },
          { width: 1920, height: 1080 },
        ]) {
          const before = await page.evaluate(() => {
            const b = (window as any).__portfolioPhysics.ball().body;
            return { id: b.id, x: b.position.x, y: b.position.y };
          });
          await page.setViewportSize(size);
          await page.waitForTimeout(300);
          const after = await geometry(page);
          const ball = await page.evaluate(() => {
            const b = (window as any).__portfolioPhysics.ball().body;
            return { id: b.id, x: b.position.x, y: b.position.y };
          });
          assert.deepEqual(
            ball,
            before,
            "Resize retains the resting cursor body and position",
          );
          assert.ok(
            Math.abs(after.floorY - after.ruleY) < 0.01 &&
              after.homeClearance > 2,
          );
          assert.ok(
            Math.abs(after.bodyWidth - after.dotWidth) < 0.2 &&
              Math.abs(after.bodyHeight - after.dotHeight) < 0.2,
          );
          resized.push({ viewport: size, geometry: after });
        }
      results.push({
        viewport,
        entrance,
        entranceTouch,
        geometry: initial,
        burst,
        floor,
        resized,
        browserErrors: check(),
      });
    } finally {
      await context.close();
    }
  }
  return results;
}

if (import.meta.main) {
  const preview = await startPreview();
  const browser = await chromium.launch({ headless: true });
  try {
    const widthArg = process.argv.find((arg) => arg.startsWith("--width="));
    if (widthArg)
      assert.ok(
        [390, 1440].includes(Number(widthArg.slice("--width=".length))),
        "--width must be 390 or 1440",
      );
    const results = await verifyHeroPhysics(
      browser,
      preview.url,
      (page, label) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        return () => {
          assert.deepEqual(errors, [], label);
          return errors;
        };
      },
      widthArg ? Number(widthArg.slice("--width=".length)) : undefined,
    );
    await writeFile(
      ".verify/hero-physics.json",
      JSON.stringify(results, null, 2),
    );
    console.log(
      "Verified physics entrance, floor contacts, period-shaped cursor, typography-scaled bursts, and resizing.",
    );
  } finally {
    await browser.close();
    await preview.close();
  }
}
