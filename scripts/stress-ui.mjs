import { chromium, webkit } from "playwright";
import { resolve } from "node:path";
for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.gaps = [];
    window.tasks = [];
    let last = performance.now();
    function f(now) {
      if (now - last > 50) window.gaps.push(now - last);
      last = now;
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
    try {
      new PerformanceObserver((es) =>
        window.tasks.push(...es.getEntries().map((e) => e.duration)),
      ).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  await page.goto(
    "http://127.0.0.1:1420/?file=" +
      encodeURIComponent(resolve("benchmarks/generated/20mb.md")),
  );
  await page.waitForFunction(
    () => window.__panelessMetrics?.completeMs,
    undefined,
    { timeout: 180000 },
  );
  console.log(
    name,
    "load",
    await page.evaluate(() => ({
      ...window.__panelessMetrics,
      gaps: window.gaps,
      tasks: window.tasks,
    })),
  );
  await page.locator('[aria-label="Reading appearance"]').click();
  await page.locator(".theme-switch button").nth(1).click();
  await page.locator('[aria-label="Close appearance"]').click();
  await page.waitForTimeout(1000);
  console.log(
    name,
    "after theme",
    await page.evaluate(() => ({
      gaps: window.gaps,
      tasks: window.tasks,
      bg: getComputedStyle(
        document.querySelector(".document-chunk"),
      ).getPropertyValue("--bg"),
    })),
  );
  await browser.close();
}
