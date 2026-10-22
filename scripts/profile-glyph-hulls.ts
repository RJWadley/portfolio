import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { startPreview } from "./preview.ts";
const preview = await startPreview(),
  browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: true,
      isMobile: width === 390,
    });
    await page.goto(preview.url + "/?verify&profile-hulls");
    await page.waitForFunction(
      () => (window as any).__portfolioPhysics?.letters().length === 18,
    );
    await page.waitForTimeout(3000);
    const before = await page.evaluate(() => ({
      metrics: (window as any).__portfolioPhysics.hullMetrics(),
      costs: { ...(window as any).__glyphCosts },
    }));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    await cdp.send("Profiler.start");
    for (let wave = 0; wave < 2; wave++) {
      await page.evaluate(() =>
        document.dispatchEvent(
          new MouseEvent("click", {
            clientX: innerWidth * 0.45,
            clientY: innerHeight * 0.35,
            detail: 1,
            bubbles: true,
          }),
        ),
      );
      await page.waitForTimeout(2400);
    }
    const { profile }: any = await cdp.send("Profiler.stop");
    const after = await page.evaluate(() => ({
      metrics: (window as any).__portfolioPhysics.hullMetrics(),
      costs: (window as any).__glyphCosts,
    }));
    const costs = Object.fromEntries(
      Object.entries(after.costs).flatMap(([k, v]) =>
        typeof v === "number" ? [[k, v - Number(before.costs[k])]] : [],
      ),
    );
    const times = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      times.set(id, (times.get(id) ?? 0) + profile.timeDeltas[i]);
    }
    const top = profile.nodes
      .map((n: any) => ({
        name: n.callFrame.functionName,
        url: n.callFrame.url,
        line: n.callFrame.lineNumber,
        ms: (times.get(n.id) ?? 0) / 1000,
      }))
      .sort((a: any, b: any) => b.ms - a.ms)
      .slice(0, 35);
    const cpuProfile = `.verify/glyph-cpu-${width}.cpuprofile`;
    await writeFile(cpuProfile, JSON.stringify(profile));
    const result = { width, before, after, costs, top, cpuProfile };
    results.push(result);
    console.log(JSON.stringify({ width, costs, top }, null, 2));
    await page.close();
  }
} finally {
  await browser.close();
  await preview.close();
}
await writeFile(
  ".verify/glyph-profile-after.json",
  JSON.stringify(results, null, 2),
);
