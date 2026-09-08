// Exercise the production Tauri frontend path with Tauri's official event mock.
// Files still run through the real Rust reader. This does not synthesize an OS drag.
import { chromium } from "playwright";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const welcome = resolve("fixtures/welcome.md");
const edge = resolve("fixtures/edge-cases.md");
await page.route("http://127.0.0.1:1420/", async (route) => {
  const response = await route.fetch();
  let html = await response.text();
  html = html.replace(
    /<script type="module" src="\/src\/bootstrap\.tsx[^\"]*"><\/script>/,
    `<script type="module">
    import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
    mockWindows('main'); window.testCalls = []; window.testPending = null; window.testOpenedURL = null;
    mockIPC(async (name,args) => {
      window.testCalls.push(name);
      if(name === 'take_pending') {const p=window.testPending;window.testPending=null;return p;}
      if(name === 'set_dirty') return;
      if(name === 'plugin:dialog|open') return ${JSON.stringify(welcome)};
      if(name === 'plugin:dialog|confirm') return false;
      if(name === 'plugin:opener|open_url') {window.testOpenedURL=args.url;return;}
      if(name.startsWith('plugin:window|')) return;
      const response=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
      const result=await response.json(); if(!response.ok) throw Error(result.error); return result;
    },{shouldMockEvents:true});
    await import('/src/bootstrap.tsx');
  </script>`,
  );
  await route.fulfill({ response, body: html });
});
await page.goto("http://127.0.0.1:1420/");
await page.locator('[aria-label="Open file"]').click();
await page
  .locator(".prose h1")
  .waitFor({ timeout: 5000 })
  .catch(async (e) => {
    console.log(await page.locator("body").innerText(), errors);
    throw e;
  });
assert.equal(await page.locator(".file-title").innerText(), "welcome.md");
await page.evaluate(async () => {
  const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
  await emit("tauri://drag-enter", { paths: [], position: { x: 100, y: 100 } });
});
await page.locator(".drop-overlay").waitFor({ state: "visible" });
await page.evaluate(async (path) => {
  const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
  await emit("tauri://drag-drop", {
    paths: [path],
    position: { x: 100, y: 100 },
  });
}, edge);
await page
  .waitForFunction(
    () =>
      document.querySelector(".file-title")?.textContent === "edge-cases.md",
    undefined,
    { timeout: 5000 },
  )
  .catch(async (e) => {
    console.log(await page.locator("body").innerText(), errors);
    throw e;
  });
assert.equal(await page.locator(".drop-overlay").count(), 0);
await page.waitForFunction(
  () =>
    document.querySelector(".prose h1")?.textContent ===
    "Edges, handled with care",
);
await page.evaluate(async (path) => {
  window.testPending = path;
  const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
  await emit("open-file", null);
}, welcome);
await page
  .waitForFunction(
    () => document.querySelector(".file-title")?.textContent === "welcome.md",
  )
  .catch(async (error) => {
    console.log(
      await page.locator("body").innerText(),
      errors,
      await page.evaluate(() => ({
        calls: window.testCalls,
        pending: window.testPending,
      })),
    );
    throw error;
  });
await page.waitForFunction(
  () =>
    document.querySelector(".prose h1")?.textContent ===
    "The pleasure of a plain text file",
);
await page.locator(".prose a").first().click();
await page.waitForFunction(
  () =>
    window.testOpenedURL ===
    "https://daringfireball.net/projects/markdown/syntax",
);
assert.deepEqual(errors, []);
await browser.close();
console.log(
  "Desktop picker, drag enter/drop, queued file delivery, and external-link IPC tests passed.",
);
