// Browser UI + official Tauri IPC/events mock, using the real Rust index and parser.
import { chromium, webkit } from "playwright";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rename,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
await mkdir("test-results", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paneless-inbox-")));
  await mkdir(join(root, "reports"));
  await mkdir(join(root, "plans"));
  await mkdir(join(root, "node_modules"));
  const plan = join(root, "plans", "launch.md");
  await writeFile(
    plan,
    "# Launch plan\n\nPrepare the next release with clear ownership and evidence.\n\n## Decisions\n\nShip the smallest useful workflow.",
  );
  await writeFile(
    join(root, "README.md"),
    "# Project home\n\nA calm overview of our work.",
  );
  await writeFile(join(root, "node_modules", "ignored.md"), "# Ignore me");
  const browser = await type.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1240, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://127.0.0.1:1420/", async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        /<script type="module" src="\/src\/bootstrap\.tsx[^\"]*"><\/script>/,
        `<script type="module">
        import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
        mockWindows('main');
        mockIPC(async (name,args) => {
          if(name === 'take_pending') return null;
          if(name === 'set_dirty') return;
          if(name === 'plugin:dialog|open') return ${JSON.stringify(root)};
          if(name === 'plugin:dialog|confirm') return false;
          if(name.startsWith('plugin:window|')) return;
          const response=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
          const result=await response.json(); if(!response.ok) throw Error(result.error); return result;
        },{shouldMockEvents:true});
        await import('/src/bootstrap.tsx');
      </script>`,
      );
      await route.fulfill({ response, body: html });
    });
    const button = (name) => page.getByRole("button", { name, exact: true });
    const count = async (view, expected) => {
      await page
        .waitForFunction(
          ({ view, expected }) =>
            [...document.querySelectorAll(".inbox-tabs button")].some(
              (e) => e.textContent === view + expected,
            ),
          { view, expected },
        )
        .catch(async (error) => {
          console.log(
            engine,
            view,
            expected,
            await page.locator("body").innerText(),
            errors,
          );
          throw error;
        });
    };
    const refresh = async () => {
      await button("Refresh project").click();
      await page.waitForFunction(() => !document.querySelector(".inbox-hint"));
    };
    const changed = async (path) =>
      page.evaluate(async (path) => {
        const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
        await emit("file-changed", path);
      }, path);
    const openEntry = async (title) => {
      await page
        .locator(".inbox-open")
        .filter({ has: page.locator("strong", { hasText: title }) })
        .click();
      await page.waitForFunction(
        (title) => document.querySelector(".prose h1")?.textContent === title,
        title,
      );
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs);
    };
    await page.goto("http://127.0.0.1:1420/");
    assert.equal(
      await page.locator(".inbox").count(),
      0,
      "Single-file startup doesn't mount the inbox",
    );
    await button("Toggle project inbox").click();
    await button("Choose Project Folder").click();
    await count("Recent", 2);
    await count("Unread", 0);
    assert.equal(await page.locator(".inbox-row").count(), 2);
    const report = join(root, "reports", "daily.md");
    const reportText =
      "# Daily briefing\n\nThe reader is ready. Two decisions need your attention before the next release.\n\n[Read the launch plan](../plans/launch.md#decisions)\n\n" +
      Array.from(
        { length: 30 },
        (_, i) =>
          `## Progress ${i + 1}\n\nThe team completed another useful part of the work. Evidence is available in the repository.\n\n`,
      ).join("");
    await writeFile(report, reportText);
    await writeFile(
      join(root, "reports", "research.md"),
      "# Research notes\n\nThree approaches to review, with tradeoffs and supporting evidence.",
    );
    await writeFile(
      join(root, "plans", "handoff.md"),
      "# Next session\n\nStart with the outstanding review and continue from the linked evidence.",
    );
    await refresh();
    await count("Unread", 3);
    await button("Pin Daily briefing").click();
    await count("Pinned", 1);
    await openEntry("Daily briefing");
    await count("Unread", 2);
    await page.locator(".prose a").click();
    await page.waitForFunction(
      () => document.querySelector(".prose h1")?.textContent === "Launch plan",
    );
    await button("Back").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".prose h1")?.textContent === "Daily briefing",
    );
    await page.locator(".reading-scroll").evaluate((e) => (e.scrollTop = 650));
    await writeFile(
      report + ".tmp",
      reportText + "\nAdditional evidence has arrived.",
    );
    await rename(report + ".tmp", report);
    await changed(report);
    await page.waitForFunction(() =>
      document
        .querySelector(".prose")
        ?.textContent.includes("Additional evidence has arrived."),
    );
    await page.waitForTimeout(150);
    assert.ok(
      Math.abs(
        (await page.locator(".reading-scroll").evaluate((e) => e.scrollTop)) -
          650,
      ) < 3,
      "Auto-refresh preserves reading position",
    );
    await refresh();
    await count("Updated", 0);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await writeFile(
      report,
      reportText + "\nAn update arrived while you were away.",
    );
    await changed(report);
    await refresh();
    await count("Updated", 1);
    assert.equal(
      await page
        .locator(".prose")
        .innerText()
        .then((t) => t.includes("while you were away")),
      false,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await button("Reload").click();
    await page.waitForFunction(() =>
      document
        .querySelector(".prose")
        ?.textContent.includes("while you were away"),
    );
    await count("Updated", 0);
    await utimes(plan, new Date(), new Date());
    await refresh();
    await count("Updated", 0);
    await writeFile(
      plan,
      "# Launch plan\n\nThe release now needs one more review.",
    );
    await refresh();
    await count("Updated", 1);
    await page
      .locator(".inbox-tabs button")
      .filter({ hasText: "Updated" })
      .click();
    assert.equal(await page.locator(".inbox-row").count(), 1);
    await openEntry("Launch plan");
    await count("Updated", 0);
    await button("Edit source").click();
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill("# My unsaved review");
    await writeFile(plan, "# Launch plan\n\nChanged while editing.");
    await changed(plan);
    await page
      .getByText("This file changed on disk. Your edits are safe here.")
      .waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Markdown source" }).inputValue(),
      "# My unsaved review",
    );
    await refresh();
    await count("Updated", 1);
    await button("Mark all read").click();
    await count("Updated", 0);
    await count("Unread", 0);
    await page.waitForTimeout(150);
    await count("Updated", 0);
    // Reopen to discard this test editor without touching the user's files.
    await page.goto("http://127.0.0.1:1420/");
    await button("Toggle project inbox").click();
    await count("Pinned", 1);
    await count("Unread", 0);
    await page
      .locator(".inbox-tabs button")
      .filter({ hasText: "Pinned" })
      .click();
    await openEntry("Daily briefing");
    await page.locator(".reading-scroll").evaluate((e) => (e.scrollTop = 0));
    await page.screenshot({ path: `test-results/${engine}-inbox-light.png` });
    await button("Reading appearance").click();
    await button("Dark").click();
    await button("Close appearance").click();
    await page
      .locator(".inbox-tabs button")
      .filter({ hasText: "Recent" })
      .click();
    await page.screenshot({ path: `test-results/${engine}-inbox-dark.png` });
    await page.setViewportSize({ width: 480, height: 800 });
    await page.screenshot({ path: `test-results/${engine}-inbox-narrow.png` });
    assert.ok(
      await page
        .locator(".app")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
      "No horizontal overflow",
    );
    await page.setViewportSize({ width: 1240, height: 850 });
    await page
      .getByRole("combobox", { name: "Project folder filter" })
      .selectOption("reports");
    assert.equal(await page.locator(".inbox-row").count(), 2);
    await page
      .getByRole("combobox", { name: "Project folder filter" })
      .selectOption("");
    await Promise.all(
      Array.from({ length: 125 }, (_, i) =>
        writeFile(
          join(root, `note-${i}.md`),
          `# Working note ${i}\n\nA short handoff.`,
        ),
      ),
    );
    await refresh();
    await count("Unread", 125);
    assert.equal(
      await page.locator(".inbox-row").count(),
      100,
      "Long lists mount a bounded first page",
    );
    await page
      .getByRole("textbox", { name: "Filter project documents" })
      .fill("Working note 124");
    assert.equal(await page.locator(".inbox-row").count(), 1);
    await page
      .getByRole("textbox", { name: "Filter project documents" })
      .fill("");
    await page.locator(".inbox-open").first().focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page
        .locator(".inbox-open")
        .nth(1)
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await button("Close project").click();
    await button("Choose Project Folder").waitFor();
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: inbox baseline, new/updated/read, pin persistence, filters, navigation, live refresh, edit protection, bounded list and keyboard passed`,
    );
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
}
