import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { claudeCommand } from "../src/handoff.ts";

const temp = await realpath(await mkdtemp(join(tmpdir(), "paneless-handoff-")));
try {
  // Execute against a harmless shell function to verify argument boundaries.
  const prompt =
    'Explain "café" & $(echo UNSAFE) `echo UNSAFE`\nIt\'s <context> 第二行';
  const workspace = join(temp, "project ' & $(echo UNSAFE)");
  await mkdir(workspace);
  const shell = spawnSync(
    "/bin/sh",
    [
      "-c",
      `claude() { printf '%s' "$1"; }; ${claudeCommand(workspace, prompt, false)}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, prompt);
  assert.equal(
    claudeCommand("C:\\a'b", "it's $x", true),
    "Set-Location -LiteralPath 'C:\\a''b'; if ($?) { claude 'it''s $x' }",
  );
  const file = join(temp, "report.md");
  await writeFile(join(temp, ".git"), "gitdir: elsewhere");
  for (const [name, engine] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    await writeFile(
      file,
      "# Daily report\n\n## Deployment decision\n\nKeep the café service running while reviewing the rollout.\n\n## Follow-up\n\nReview tomorrow.\n",
    );
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1100, height: 820 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("http://127.0.0.1:1420/", async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          /<script type="module" src="\/src\/bootstrap\.tsx[^\"]*"><\/script>/,
          `<script type="module">
          import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
          mockWindows('main'); window.copied=''; window.opened=null; window.failCodex=false;
          mockIPC(async (name,args) => {
            if(name==='take_pending')return ${JSON.stringify(file)};
            if(name==='set_dirty'||name.startsWith('plugin:window|'))return;
            if(name==='plugin:clipboard-manager|write_text'){window.copied=args.text;return;}
            if(name==='open_codex'){ if(window.failCodex)throw Error('Codex unavailable. Context copied.'); window.opened=args; return false; }
            const r=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)}); const value=await r.json();if(!r.ok)throw Error(value.error);return value;
          }, {shouldMockEvents:true});
          await import('/src/bootstrap.tsx');
        </script>`,
        );
        await route.fulfill({ response, body: html });
      });
      await page.goto("http://127.0.0.1:1420/");
      await page.locator(".prose h2").first().waitFor();
      await page.evaluate(() => {
        const p = document.querySelector(".prose p");
        const range = document.createRange();
        range.selectNodeContents(p);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page
        .getByRole("button", { name: "Ask agent", exact: true })
        .click();
      const modal = page.getByRole("dialog");
      await modal.waitFor();
      assert.equal(
        await modal.locator("blockquote").textContent(),
        "Keep the café service running while reviewing the rollout.",
      );
      assert.match(
        await modal.locator(".handoff-document").textContent(),
        /Deployment decision/,
      );
      await modal
        .getByRole("textbox", { name: "What should the agent do?" })
        .fill(prompt);
      await modal
        .getByRole("button", { name: "Copy for agent", exact: true })
        .click();
      await page.waitForFunction(() =>
        window.copied.includes("renderedRevision"),
      );
      let copied = await page.evaluate(() => window.copied);
      assert.ok(copied.startsWith("User instruction:\n" + prompt));
      assert.match(copied, /#deployment-decision/);
      assert.ok(copied.includes(temp));
      await page.keyboard.press("Meta+f");
      assert.equal(
        await page.locator('[aria-label="Find in document"]').count(),
        0,
      );
      // The composer must retain its rendered snapshot while a writer changes the file.
      await writeFile(file, "# Changed by agent\n\nNew content.");
      await page.evaluate(async (path) => {
        const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
        await emit("file-changed", path);
      }, file);
      await modal
        .getByRole("button", { name: "Copy for agent", exact: true })
        .click();
      await page.waitForFunction(() =>
        window.copied.includes("Changed or unavailable"),
      );
      assert.equal(
        await page.locator(".prose h1").textContent(),
        "Daily report",
      );
      await modal
        .getByRole("button", { name: "Open in Codex", exact: true })
        .click();
      await page.waitForFunction(() => window.opened !== null);
      const opened = await page.evaluate(() => window.opened);
      assert.equal(opened.prompt, await page.evaluate(() => window.copied));
      assert.equal(opened.workspace, temp);
      await page.evaluate(() => {
        window.failCodex = true;
      });
      await modal
        .getByRole("button", { name: "Open in Codex", exact: true })
        .click();
      await modal.getByRole("alert").waitFor();
      assert.match(
        await modal.getByRole("alert").textContent(),
        /Context copied/,
      );
      await modal
        .getByRole("button", { name: "Copy Claude Code command", exact: true })
        .click();
      await page.waitForFunction(() => window.copied.startsWith("cd -- "));
      assert.ok((await page.evaluate(() => window.copied)).includes("'\\''"));
      await page.screenshot({ path: `test-results/handoff-${name}-light.png` });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await page.setViewportSize({ width: 480, height: 760 });
      await page.screenshot({
        path: `test-results/handoff-${name}-dark-narrow.png`,
      });
      assert.ok(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth));
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      await page.evaluate(() => getSelection().removeAllRanges());
      await page
        .getByRole("button", { name: "Ask agent", exact: true })
        .click();
      assert.equal(
        await page.getByRole("dialog").locator("blockquote").count(),
        0,
      );
      await page.getByRole("button", { name: "Close agent handoff" }).click();
      assert.deepEqual(errors, []);
      console.log(
        `${name}: selection, section, clipboard, stale snapshot, provider fallback, shell command, modal and narrow layout passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
