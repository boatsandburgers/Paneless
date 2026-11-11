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
  // Selected source text stays readable: every syntax colour, as drawn inside the selection,
  // reaches WCAG AA 4.5:1 on the selection with the active-line tint on top. Measured
  // focused, and again after a click on the status bar: in WebKit that click drops the DOM
  // selection while CodeMirror keeps drawing its own, so ::selection alone cannot be relied on.
  await writeFile(
    "test-results/selection.md",
    "# Heading one\n\nPlain text with **bold words**, *italic* and `inline code`.\n\n## Heading two\n\n[a link](https://example.com) and <https://example.org>\n\n> a quoted line\n\n---\n",
  );
  const measureSelection = () =>
    page.evaluate(() => {
      const rgba = (s) => {
        const m = s.match(/[\d.]+/g).map(Number);
        const k = s.startsWith("color(") ? 255 : 1;
        return [m[0] * k, m[1] * k, m[2] * k, m.length > 3 ? m[3] : 1];
      };
      const over = (f, b) =>
        f.map((v, i) => (i < 3 ? v * f[3] + b[i] * (1 - f[3]) : 1));
      const lum = (c) =>
        [0.2126, 0.7152, 0.0722].reduce((sum, w, i) => {
          const v = c[i] / 255;
          return (
            sum + w * (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const css = (e) => getComputedStyle(e);
      const editor = document.querySelector(".cm-editor");
      const layer = document.querySelector(".cm-selectionBackground");
      const active = document.querySelector(".cm-activeLine");
      if (!layer) return { ratio: 0, text: "no selection drawn" };
      const selection = over(
        rgba(css(layer).backgroundColor),
        rgba(css(editor).backgroundColor),
      );
      const backs = [
        selection,
        over(
          rgba(active ? css(active).backgroundColor : "rgba(0,0,0,0)"),
          selection,
        ),
      ];
      // The element's own colour is what is painted: selected text is coloured by a decoration,
      // and no ::selection rule sets a colour. getComputedStyle(e, "::selection") is not used
      // because, with no such rule, it does not report the painted colour (checked by pixels).
      // `highlighted` collects only syntax-highlight spans (CodeMirror's generated ͼ classes),
      // so the token check below fails if a guarded kind sits in no highlight span at all.
      let low = { ratio: Infinity, highlighted: "" };
      for (const e of document.querySelectorAll(".cm-line, .cm-line span")) {
        if (!e.textContent.trim()) continue;
        if (e.tagName === "SPAN" && e.className.includes("ͼ"))
          low.highlighted += e.textContent + " ";
        for (const back of backs) {
          const value = ratio(over(rgba(css(e).color), back), back);
          if (value < low.ratio)
            low = { ...low, ratio: value, text: e.textContent.slice(0, 30) };
        }
      }
      return low;
    });
  for (const theme of ["Light", "Dark"]) {
    await page.locator('[aria-label="Reading appearance"]').click();
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.locator('[aria-label="Close appearance"]').click();
    await open("test-results/selection.md");
    await page
      .getByRole("button", { name: "Edit source", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .press("ControlOrMeta+a");
    await page.waitForTimeout(150);
    for (const state of ["focused", "after a click outside"]) {
      if (state !== "focused") {
        await page.locator(".statusbar").click();
        await page.waitForTimeout(150);
      }
      const worst = await measureSelection();
      // Finite as well: an empty scan would leave Infinity and pass without measuring.
      assert.ok(
        Number.isFinite(worst.ratio) && worst.ratio >= 4.5,
        `${theme} ${state}: selection contrast ${worst.ratio.toFixed(2)}:1 on "${worst.text}"`,
      );
      for (const token of [
        "Heading",
        "bold",
        "inline code",
        "a link",
        "quoted",
      ])
        assert.ok(
          worst.highlighted.includes(token),
          `${theme} ${state}: "${token}" not measured`,
        );
    }
    await page.screenshot({
      path: `test-results/${engine}-selection-${theme.toLowerCase()}.png`,
    });
    await page
      .getByRole("button", { name: "Read document", exact: true })
      .click();
  }
  await copyFile("fixtures/welcome.md", "test-results/edit.md");
  await open("test-results/edit.md");
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  // Replace the text the way a person does, ⌘A and typing (ControlOrMeta, as the selection test above). Playwright's fill races CodeMirror in WebKit
  // about 1 time in 100 and saves a leading blank line; real keys gave 0 in about 1,770 runs.
  const replaceSource = async (text) => {
    await page.getByRole("textbox", { name: "Markdown source" }).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(text);
  };
  await replaceSource("# Saved successfully\n\nAn edit.");
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
  await replaceSource("# Local changes");
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
