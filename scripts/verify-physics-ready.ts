import assert from "node:assert/strict";
import type { Page } from "playwright";

// Idle callbacks use the browser's real scheduler even when the simulation clock
// is paused. Wait from Node, then advance the deterministic 120ms layout timer.
export async function waitForPhysicsFontReady(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  for (let attempt = 0; attempt < 250; attempt++) {
    if (
      await page.evaluate(
        () => (window as any).__portfolioPhysics?.typography().ready,
      )
    ) {
      await page.evaluate(() =>
        (window as any).__portfolioPhysics.queueInitialMeasure?.(),
      );
      return;
    }
    await page.waitForTimeout(20);
    await page.clock.runFor(20);
  }
  assert.fail("Physics font geometry becomes ready within five seconds");
}
