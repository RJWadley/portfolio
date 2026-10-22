import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { chromium, type Browser, type Page, type CDPSession } from "playwright";
import { startPreview } from "./preview.ts";

type Scene = "drop" | "proximity" | "drag" | "burst";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}
async function record(page: Page) {
  await page.addInitScript(() => {
    const state: any = {
      scene: "startup",
      frames: [],
      longTasks: [],
      cadence: [],
      previous: 0,
      evidence:{ballSeen:false,mouseBallResumed:false,fieldRows:[0,0],heldFrames:0,touchBallFrames:0,heldStart:null,maxHeldDistance:0,burstFrames:0},
      marks: [{ scene: "startup", at: 0 }],
    };
    (window as any).__frameRecord = state;
    let previousSolver: number | null = null, previouslyChanging = false;
    let completedFrame: { at: number; ms: number; scene: string } | null = null;
    const tick = (now: number) => {
      // Keep cold hydration/font/model/body creation visible as startup. The
      // actual drop starts at the first frame containing the 18 live bodies.
      if (
        state.scene === "startup" &&
        (window as any).__portfolioPhysics?.letters().length === 18
      ) {
        state.scene = "drop";
        state.marks.push({ scene: "drop", at: performance.now() });
        performance.mark("frame-scene:drop");
      }
      const p=(window as any).__portfolioPhysics;
      if(p&&state.scene==='proximity'){
        state.evidence.ballSeen ||= !!p.ball();
        const letters=p.letters();for(let i=0;i<12;i++)if(letters[i]?.glyph){const row=i<6?0:1;state.evidence.fieldRows[row]=Math.max(state.evidence.fieldRows[row],letters[i].axes.puff.value);}
      }
      if(p&&state.scene==='drag'){
        const held=p.letters().find((l:any)=>l.held);if(held){state.evidence.heldFrames++;if(p.ball())state.evidence.touchBallFrames++;state.evidence.heldStart??={...held.body.position};state.evidence.maxHeldDistance=Math.max(state.evidence.maxHeldDistance,Math.hypot(held.body.position.x-state.evidence.heldStart.x,held.body.position.y-state.evidence.heldStart.y));}
      }
      if(p&&state.scene==='burst'){state.evidence.mouseBallResumed ||= !!p.ball();if(p.letters().some((l:any)=>l.axisBurstStage>=0))state.evidence.burstFrames++;}
      // This observer is registered before the application. Read the previous
      // completed rAF batch at the start of the next one, and retain its label.
      // Chromium can defer timers for ~100ms during touch input: setTimeout(0)
      // would then read several ticks at once and fabricate a grab-time stall.
      if (p?.letters().length === 18) {
        const solver = p.engine.timing.timestamp,
          changing = p.letters().some((l: any) => l.hull &&
            Math.abs((l.hull.requestedPose?.width ?? l.hull.pose.width) - l.hull.pose.width) > 1);
        if (previousSolver !== null && completedFrame) state.cadence.push({
          ...completedFrame, ticks: Math.round((solver - previousSolver) / (1000 / 60)),
          changing: previouslyChanging && changing });
        previousSolver = solver;
        previouslyChanging = changing;
      }
      completedFrame = { at: now, ms: state.previous ? now - state.previous : 0, scene: state.scene };
      if (state.previous)
        state.frames.push({
          scene: state.scene,
          at: now,
          ms: now - state.previous,
        });
      state.previous = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        state.longTasks.push({
          at: e.startTime,
          ms: e.duration,
          scene:
            state.marks.findLast((m: any) => m.at <= e.startTime)?.scene ??
            state.scene,
        });
    }).observe({ type: "longtask", buffered: true });
  });
}
async function scene(page: Page, name: Scene) {
  await page.evaluate((name) => {
    const state = (window as any).__frameRecord;
    state.scene = name;
    state.marks.push({ scene: name, at: performance.now() });
    performance.mark("frame-scene:" + name);
  }, name);
}
export async function runScenes(page: Page, cdp: CDPSession, url: string) {
  await record(page);
  await page.goto(url);
  await page.waitForFunction(
    () => (window as any).__portfolioPhysics?.letters().length === 18,
  );
  assert.ok(await page.evaluate(()=>matchMedia('(pointer:fine)').matches),'Mouse scenes run with a real fine pointer');
  await page.waitForTimeout(3000);
  const area = await page.locator(".hero-name").boundingBox();
  assert.ok(area);
  const sweepStarted = performance.now();
  await scene(page, "proximity");
  while (performance.now() - sweepStarted < 3200) {
    const t = (performance.now() - sweepStarted) / 3200,
      phase = (t * 4) % 1;
    await page.mouse.move(
      area.x +
        area.width *
          (0.08 + 0.84 * (Math.floor(t * 4) % 2 ? 1 - phase : phase)),
      area.y + area.height * (Math.floor(t * 4) < 2 ? 0.23 : 0.73),
    );
    await sleep(16);
  }
  await scene(page, "drag");
  const glyph = await page.locator(".hero-name .char").nth(2).boundingBox();
  assert.ok(glyph);
  const dragBodyIds = await page.evaluate(() => (window as any).__portfolioPhysics.letters().map((l: any) => l.body.id));
  const x = glyph.x + glyph.width * 0.5,
    y = glyph.y + glyph.height * 0.5;
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    document.addEventListener("pointerdown", e => {
      (window as any).__frameRecord.evidence.dragPointerDown = { at: performance.now(), x: e.clientX, y: e.clientY,
        target: (e.target as Element).outerHTML.slice(0, 600) };
    }, { once: true });
    return el?.outerHTML.slice(0, 600);
  }, { x, y });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, id: 1 }],
  });
  await page.waitForTimeout(80);
  const held = await page.evaluate(() => (window as any).__portfolioPhysics.interaction().held);
  if (!held) await writeFile(".verify/frame-grab-failure.json", JSON.stringify({ x, y, glyph, hit,
    after: await page.evaluate(() => (window as any).__frameRecord.evidence.dragPointerDown) }, null, 2));
  assert.ok(held, "Frame scenario holds a real glyph");
  const dragStarted = performance.now();
  while (performance.now() - dragStarted < 1400) {
    const t = Math.min(1, (performance.now() - dragStarted) / 1400);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: x + 180 * Math.sin(t * Math.PI * 2),
          y: y - 100 * Math.sin(t * Math.PI),
          id: 1,
        },
      ],
    });
    await sleep(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  // Let the real touch-generated compatibility-click suppression expire.
  await page.waitForTimeout(800);
  await page.evaluate((ids) => {
    (window as any).__frameRecord.evidence.dragBodyIdentitiesPreserved =
      (window as any).__portfolioPhysics.letters().every((l: any, i: number) => l.body.id === ids[i]);
  }, dragBodyIds);
  const burstBefore=await page.evaluate(()=>(window as any).__portfolioPhysics.interaction().lastBurst?.count??0);
  await scene(page, "burst");
  await page.mouse.click(
    area.x + area.width * 0.45,
    area.y + area.height * 0.45,
  );
  await page.waitForFunction(before=>{const b=(window as any).__portfolioPhysics.interaction().lastBurst;return b?.count>before&&b.input==='mouse';},burstBefore);
  await page.waitForTimeout(2600);
  return page.evaluate(() => {
    const s = (window as any).__frameRecord;
    s.scene = "done";
    return { frames: s.frames, longTasks: s.longTasks, cadence: s.cadence, marks: s.marks, evidence:s.evidence, paint: performance.getEntriesByType("paint").map(e => ({name:e.name, at:e.startTime})) };
  });
}
// Real early input must survive a staged cold build without inserting the same
// cursor body twice. Keep this separate from the unchanged frame scenarios.
export async function verifyStartupInput(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url + "/");
    await page.waitForFunction(() => (window as any).__portfolioPhysics &&
      (window as any).__portfolioPhysics.letters().length === 0 &&
      (window as any).__portfolioPhysics.hullMetrics().initializationMs > 0);
    await page.mouse.move(20, 100);
    const id = await page.evaluate(() => (window as any).__portfolioPhysics.ball().body.id);
    await page.waitForFunction(() => (window as any).__portfolioPhysics.letters().length === 18);
    const result = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics, b = p.ball().body;
      return { id: b.id, worldCopies: p.engine.world.bodies.filter((body: any) => body === b).length };
    });
    assert.equal(result.id, id, "Initial body construction retains the early cursor");
    assert.equal(result.worldCopies, 1, "Initial body construction inserts the early cursor only once");
    return result;
  } finally { await page.close(); }
}
// A render stall must not consume the physical burst's easing window.
export async function verifyBurstEasing(browser: Browser, url: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(url + "/");
    await page.waitForFunction(() => (window as any).__portfolioPhysics?.letters().length === 18);
    await page.waitForFunction(() => !(window as any).__portfolioPhysics.isRunning());
    const point = await page.evaluate(() => {
      const p = (window as any).__portfolioPhysics, l = p.letters()[2],
        state = { start: null as number | null, samples: [] as { elapsed: number; friction: number }[] };
      (window as any).__burstEasing = state;
      document.addEventListener("click", () => { state.start = p.engine.timing.timestamp; }, { once: true });
      (window as any).Matter.Events.on(p.engine, "beforeUpdate", ({ delta }: any) => {
        if (state.start === null) return;
        const elapsed = p.engine.timing.timestamp - delta - state.start;
        if (elapsed < 100) state.samples.push({ elapsed, friction: l.body.frictionAir });
      });
      return { x: l.ox, y: l.homeBounds.max.y + 25 };
    });
    await page.mouse.click(point.x, point.y);
    await page.evaluate(() => {
      const until = performance.now() + 140;
      while (performance.now() < until) { /* deliberate render stall */ }
    });
    await page.waitForTimeout(300);
    const samples = await page.evaluate(() => (window as any).__burstEasing.samples as { elapsed: number; friction: number }[]);
    assert.ok(samples.length > 0, "The stalled burst advances real physics steps");
    assert.ok(samples.every(s => s.friction === 0.05), "A render stall preserves the first 100ms of physical burst easing");
    return { deliberateStallMs: 140, samples };
  } finally { await page.close(); }
}
export async function verifyFrames(
  browser: Browser,
  url: string,
  options: { baseline?: boolean; trace?: boolean; label?: string } = {},
) {
  const results = [];
  for (const debug of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      hasTouch: false,
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      const samples = await runScenes(
        page,
        cdp,
        url + (debug ? "/?debug" : "/"),
      );
      assert.ok(samples.evidence.ballSeen&&samples.evidence.fieldRows.every((v:number)=>v>.5),'The cursor ball activates proximity on both lines');
      assert.ok(samples.evidence.heldFrames>0&&samples.evidence.maxHeldDistance>10,'The real grabbed body moves during the drag');
      assert.ok(samples.evidence.burstFrames>0&&samples.evidence.mouseBallResumed,'The final mouse click restores its ball and drives a live font burst');
      if (!options.baseline) assert.equal(samples.evidence.touchBallFrames, 0,
        "A real touch drag suspends the stale mouse ball on hybrid input");
      if (!options.baseline) assert.ok(samples.evidence.dragBodyIdentitiesPreserved,
        "First-touch layout changes preserve existing collision bodies");
      const scenes = ["startup", "drop", "proximity", "drag", "burst"].map(
        (name) => ({
          scene: name,
          ...summary(
            samples.frames
              .filter((f: any) => f.scene === name)
              .map((f: any) => f.ms),
          ),
          longTasks: samples.longTasks.filter((f: any) => f.scene === name),
          cadence: (() => {
            const rows = samples.cadence.filter((f: any) => f.scene === name &&
              f.changing && f.ms >= 15 && f.ms <= 18.5);
            return { eligibleFrames: rows.length,
              holds: rows.filter((f: any) => f.ticks === 0).length,
              doubles: rows.filter((f: any) => f.ticks >= 2).length };
          })(),
        }),
      );
      const result = {
        page: debug ? "/?debug" : "/",
        dpr: 2,
        cpuThrottle: 4,
        frameAssignment:
          "Every completed rAF interval is retained, including scene boundaries, and labeled by its ending scene. Cold startup is reported separately; drop starts at the first frame with 18 bodies.",
        scenes,
        errors,
        evidence:samples.evidence,
        samples,
        afterFirstContentfulPaint: (() => {
          const firstPaint = samples.paint.find((p: any) => p.name === "first-contentful-paint")?.at ?? 0;
          return { firstPaint, ...summary(samples.frames.filter((f: any) => f.at - f.ms >= firstPaint).map((f: any) => f.ms)),
            longTasks: samples.longTasks.filter((t: any) => t.at >= firstPaint) };
        })(),
      };
      results.push(result);
      console.log(
        JSON.stringify({
          page: result.page,
          scenes: scenes.map((s) => ({ ...s, longTasks: s.longTasks.length })),
        }),
      );
    } finally {
      await page.close();
    }
  }
  const label = options.label ?? (options.baseline ? "before" : "after");
  await mkdir(".verify", { recursive: true });
  await writeFile(
    `.verify/frames-${label}.json`,
    JSON.stringify(results, null, 2),
  );
  if (options.trace) await captureFrameTrace(browser, url, label);
  if (!options.baseline)
    for (const r of results) {
      assert.deepEqual(r.errors, []);
      assert.ok(r.scenes.reduce((sum, s) => sum + s.cadence.eligibleFrames, 0) >= 60,
        "Real-clock cadence observes enough changing letter frames");
      for (const s of r.scenes) {
        if (s.scene === "startup") continue;
        if (s.scene === "drag") assert.ok(s.cadence.eligibleFrames >= 30,
          `Enough changing drag frames: ${r.page} ${JSON.stringify(s.cadence)}`);
        if (s.cadence.eligibleFrames >= 30) {
          assert.ok(s.cadence.holds / s.cadence.eligibleFrames <= .01,
            `Changing glyphs do not hold on nominal 60Hz frames: ${r.page} ${s.scene} ${JSON.stringify(s.cadence)}`);
          assert.ok(s.cadence.doubles / s.cadence.eligibleFrames <= .01,
            `Changing glyphs do not jump two ticks on nominal 60Hz frames: ${r.page} ${s.scene} ${JSON.stringify(s.cadence)}`);
        }
        assert.ok(s.count >= 30, `Enough frame samples: ${r.page} ${s.scene}`);
        assert.ok(
          s.p95 <= (r.page === "/" ? 17.5 : 20),
          `Full-frame p95 ${r.page} ${s.scene}: ${s.p95}ms`,
        );
        if (r.page === "/" && s.scene !== "drop")
          assert.ok(
            s.max <= 50 + 1e-6,
            `No post-drop frame above 50ms: ${s.scene} ${s.max}ms`,
          );
      }
    }
  return results.map(({ samples, ...rest }) => rest);
}
export async function captureFrameTrace(
  browser: Browser,
  url: string,
  label: string,
) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    hasTouch: false,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    await cdp.send("Tracing.start", {
      categories:
        "devtools.timeline,v8,blink,blink.user_timing,cc,disabled-by-default-devtools.timeline,disabled-by-default-v8.gc",
      transferMode: "ReturnAsStream",
    });
    const samples = await runScenes(page, cdp, url + "/?debug");
    await writeFile(`.verify/frames-${label}-trace-frames.json`, JSON.stringify(samples, null, 2));
    const complete = new Promise<any>((resolve) =>
      cdp.once("Tracing.tracingComplete", resolve),
    );
    await cdp.send("Tracing.end");
    const { stream } = await complete;
    let json = "";
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream });
      json += chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64").toString()
        : chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await writeFile(`.verify/frames-${label}-trace.json.gz`, gzipSync(json));
    const trace = JSON.parse(json);
    const breakdown = traceBreakdown(trace.traceEvents);
    await writeFile(
      `.verify/frames-${label}-trace-summary.json`,
      JSON.stringify(breakdown, null, 2),
    );
  } finally {
    await page.close();
  }
}
export function traceBreakdown(events: any[]) {
  const classify = (name: string) =>
    /GC|GarbageCollect/.test(name)
      ? "gc"
      : /RasterTask|Rasterize/.test(name)
        ? "raster"
        : /^(Layout)$/.test(name)
          ? "layout"
          : /UpdateLayoutTree|RecalculateStyles/.test(name)
            ? "style"
            : /^(Paint|PrePaint|PaintImage|Layerize|UpdateLayer|CompositeLayers)$/.test(
                  name,
                )
              ? "paint"
              : /FunctionCall|EvaluateScript|RunMicrotasks|EventDispatch|TimerFire|FireAnimationFrame|V8.Execute/.test(
                    name,
                  )
                ? "script"
                : undefined;
  const ranks: Record<string, number> = {
      script: 1,
      raster: 2,
      paint: 3,
      style: 4,
      layout: 5,
      gc: 6,
    },
    threads = new Map<string, any[]>(),
    names = new Map<string, string>();
  let first = Infinity,
    last = 0;
  for (const e of events) {
    const key = e.pid + ":" + e.tid;
    if (e.ph === "M" && e.name === "thread_name")
      names.set(key, e.args?.name ?? key);
    if (e.ph !== "X" || !e.dur) continue;
    first = Math.min(first, e.ts);
    last = Math.max(last, e.ts + e.dur);
    const kind = classify(e.name ?? "");
    if (!kind) continue;
    if (!threads.has(key)) threads.set(key, []);
    threads
      .get(key)!
      .push(
        { at: e.ts, kind, delta: 1 },
        { at: e.ts + e.dur, kind, delta: -1 },
      );
  }
  const zero = () =>
    ({ script: 0, style: 0, layout: 0, paint: 0, raster: 0, gc: 0 }) as Record<
      string,
      number
    >;
  const totals = zero(),
    main = zero(),
    perThread = [];
  for (const [key, marks] of threads) {
    const values = zero();
    marks.sort((a, b) => a.at - b.at);
    const active: Record<string, number> = {};
    let prev = marks[0]?.at ?? 0;
    for (const m of marks) {
      let selected: string | undefined;
      for (const k of Object.keys(active))
        if (active[k]! > 0 && (!selected || ranks[k]! > ranks[selected]!))
          selected = k;
      if (selected) values[selected]! += (m.at - prev) / 1000;
      active[m.kind] = (active[m.kind] ?? 0) + m.delta;
      prev = m.at;
    }
    for (const k of Object.keys(values)) {
      totals[k]! += values[k]!;
      if (names.get(key) === "CrRendererMain") main[k]! += values[k]!;
    }
    perThread.push({ id: key, name: names.get(key), milliseconds: values });
  }
  const durationMs = (last - first) / 1000;
  return {
    durationMs,
    milliseconds: totals,
    mainThreadMilliseconds: main,
    millisecondsPerSecond: Object.fromEntries(
      Object.entries(totals).map(([k, v]) => [k, (v * 1000) / durationMs]),
    ),
    perThread,
    method:
      "Union of classified spans within each thread, with nested GC/layout/style/paint taking precedence over script. Main-thread and worker totals are separate; raster workers can overlap script and paint. Paint/raster include all page content and cannot isolate font work alone.",
  };
}

if (import.meta.main) {
  const preview = process.env.FRAME_URL
      ? null
      : await startPreview({ directory: process.env.FRAME_DIRECTORY }),
    browser = await chromium.launch({ headless: true });
  try {
    await verifyFrames(browser, process.env.FRAME_URL ?? preview!.url, {
      baseline: process.argv.includes("--baseline"),
      trace: process.argv.includes("--trace"),
      label: process.env.FRAME_LABEL,
    });
  } finally {
    await browser.close();
    await preview?.close();
  }
}
