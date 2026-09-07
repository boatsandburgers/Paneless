import { chromium, webkit } from "playwright";
import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
await mkdir("test-results", { recursive: true });
const results = [];
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await type.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1060, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.__frameGaps = [];
    let last = performance.now();
    function frame(now) {
      const gap = now - last;
      if (gap > 50) window.__frameGaps.push(gap);
      last = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    try {
      new PerformanceObserver((list) =>
        window.__longTasks.push(...list.getEntries().map((e) => e.duration)),
      ).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  const open = async (path) => {
    await page.goto(
      `http://127.0.0.1:1420/?file=${encodeURIComponent(resolve(path))}`,
    );
    await page.waitForFunction(
      () => window.__panelessMetrics?.completeMs,
      undefined,
      { timeout: 180000 },
    );
  };
  await page.goto("http://127.0.0.1:1420");
  await page.screenshot({ path: `test-results/${engine}-empty.png` });
  await open("fixtures/welcome.md");
  assert.equal(
    await page.locator(".prose h1").innerText(),
    "The pleasure of a plain text file",
  );
  assert.equal(await page.locator(".prose table").count(), 1);
  await page.getByRole("button", { name: "Toggle outline" }).click();
  await page
    .getByRole("button", { name: "Follow your curiosity", exact: true })
    .click();
  await page.waitForTimeout(200);
  assert.ok(
    (await page.locator(".reading-scroll").evaluate((e) => e.scrollTop)) > 300,
  );
  await page.getByRole("button", { name: "Close outline" }).click();
  await page.locator(".reading-scroll").evaluate((e) => (e.scrollTop = 0));
  for (const theme of ["Light", "Dark"]) {
    await page.locator('[aria-label="Reading appearance"]').click();
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.locator('[aria-label="Close appearance"]').click();
    for (const width of [480, 1060, 1800]) {
      await page.setViewportSize({ width, height: 800 });
      await page.screenshot({
        path: `test-results/${engine}-${theme.toLowerCase()}-${width}.png`,
      });
      assert.ok(
        await page
          .locator(".reading-scroll")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
    }
  }
  await page.setViewportSize({ width: 1060, height: 800 });
  await copyFile("fixtures/welcome.md", "test-results/edit.md");
  await open("test-results/edit.md");
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Markdown source" })
    .fill("# Saved successfully\n\nAn edit.");
  await page.getByRole("button", { name: /^Save / }).click();
  await page.waitForTimeout(150);
  assert.equal(
    await readFile("test-results/edit.md", "utf8"),
    "# Saved successfully\n\nAn edit.",
  );
  await page
    .getByRole("button", { name: "Read document", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".prose h1")?.textContent === "Saved successfully",
  );
  // Saving must detect an external edit, including an atomic replacement.
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Markdown source" })
    .fill("# Local changes");
  await writeFile("test-results/edit.md", "# External changes");
  await page.getByRole("button", { name: /^Save / }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await readFile("test-results/edit.md", "utf8"),
    "# External changes",
  );
  // Deliberately hostile Markdown must never become executable markup.
  await writeFile(
    "test-results/hostile.md",
    '# Safety\n\n<script>window.pwned=true</script>\n\n<img src=x onerror="window.pwned=true">\n\n[click](javascript:alert(1))\n\n![file](file:///etc/passwd)',
  );
  await open("test-results/hostile.md");
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(
    await page.locator(".prose script,.prose iframe,.prose [onerror]").count(),
    0,
  );
  await writeFile("test-results/empty.md", "");
  await open("test-results/empty.md");
  assert.ok(await page.getByText("This document is empty.").isVisible());
  for (const size of ["100kb", "1mb", "5mb", "20mb"]) {
    await open(`benchmarks/generated/${size}.md`);
    const metrics = await page.evaluate(() => ({
      ...window.__panelessMetrics,
      longTasks: window.__longTasks.length,
      maxLongTaskMs: Math.max(0, ...window.__longTasks),
      maxFrameGapMs: Math.max(0, ...window.__frameGaps),
      nodes: document.querySelectorAll(".prose *").length,
    }));
    const t = Date.now();
    await page.locator('[aria-label="Reading appearance"]').click();
    await page.locator(".theme-switch button").first().click();
    await page.locator('[aria-label="Close appearance"]').click();
    metrics.interactionMs = Date.now() - t;
    await page.waitForTimeout(300);
    Object.assign(
      metrics,
      await page.evaluate(() => ({
        maxFrameGapAfterThemeMs: Math.max(0, ...window.__frameGaps),
        maxLongTaskAfterThemeMs: Math.max(0, ...window.__longTasks),
      })),
    );
    await page.getByRole("button", { name: "Toggle outline" }).click();
    assert.ok((await page.locator(".outline-item").count()) <= 40);
    await page.getByRole("button", { name: "Close outline" }).click();
    await page
      .locator(".reading-scroll")
      .evaluate((e) => (e.scrollTop = e.scrollHeight));
    await page.waitForTimeout(250);
    assert.ok(
      await page
        .locator(".reading-scroll")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    if (["5mb", "20mb"].includes(size)) {
      assert.ok(
        (await page.locator(".prose *").count()) < 30000,
        "DOM must remain bounded",
      );
      await page.locator(".reading-scroll").evaluate((e) => (e.scrollTop = 0));
      await page.waitForTimeout(150);
      await page.locator('[aria-label="Toggle outline"]').click();
      await page
        .getByRole("textbox", { name: "Filter headings" })
        .fill(size === "20mb" ? "Details 6018" : "Details 1514");
      await page.locator(".outline-item").first().click();
      await page.waitForTimeout(350);
      const target = await page
        .locator(size === "20mb" ? "#details-6018" : "#details-1514")
        .boundingBox();
      assert.ok(
        target && target.y >= 50 && target.y < 160,
        `Anchor drifted: ${JSON.stringify(target)}`,
      );
      await page.locator('[aria-label="Close outline"]').click();
      await page.waitForTimeout(200);
      assert.ok(
        (await page.locator(".reading-scroll").evaluate((e) => e.scrollTop)) >
          10000,
      );
      await page.keyboard.press("Meta+f");
      await page
        .getByRole("textbox", { name: "Find in document" })
        .fill(size === "20mb" ? "Section 6000" : "Section 1500");
      await page.locator(".findbar button").nth(1).click();
      await page.waitForTimeout(300);
      assert.ok(
        (await page.locator(".findbar span").innerText()) !== "No match",
      );
      await page.locator('[aria-label="Close find"]').click();
    }
    results.push({ engine, size, ...metrics });
    console.log(JSON.stringify(results.at(-1)));
  }
  assert.deepEqual(errors, []);
  await browser.close();
}
await writeFile(
  "docs/benchmark-results.json",
  JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2),
);
console.log("All UI and benchmark checks passed.");
