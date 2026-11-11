import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Find in a document under 2 MiB. The browser's own window.find searches the whole page,
// and the find box holds the query, so a search could stop on the word inside the box: nothing
// scrolled and nothing was said. The case: the word appears once, near the end, off screen.
const temp = await realpath(await mkdtemp(join(tmpdir(), "paneless-find-")));
try {
  // Uneven sections, as in real documents: off-screen ones are laid out at an estimated height,
  // so a jump measured against that estimate drifts once the real heights arrive. The İ
  // lowercases to two characters; the editor's search must stay case-insensitive anyway.
  const file = join(temp, "long.md");
  const body = Array.from(
    { length: 60 },
    (_, i) =>
      `## Section ${i + 1}\n\n` +
      "Plain words about the plan and its evidence. ".repeat(i % 3 ? 12 : 120) +
      "\n",
  ).join("\n");
  await writeFile(
    file,
    "# Long document from İstanbul\n\n" +
      body +
      "\n## Ending\n\nA split\nphrase wraps in the source. Sõda is war. A bom\uFEFFjoined pair.\n\n" +
      "```js\nconst zebraToken = 1;\n```\n\nThe word converge appears only here.\n",
  );
  // The word at the end of a paragraph taller than the pane: centring the paragraph instead of
  // the word would leave the word off screen.
  const tallFile = join(temp, "tall.md");
  await writeFile(
    tallFile,
    "# Tall paragraph from İstanbul\n\n" + "Plain words about the plan and its evidence. ".repeat(400) + "The word\nconverge ends it.\n",
  );
  // Over 2 MiB the Rust side counts (search_document). A word split by bold counts once, as the
  // page shows it; an image's alt text is not on the page and does not count.
  const bigFile = join(temp, "big.md");
  await writeFile(
    bigFile,
    "# Big document\n\n![converge](nothing.png)\n\n5 µm and 5 μm.\n\n" +
      Array.from(
        { length: 400 },
        (_, k) =>
          `## Part ${k + 1}\n\n` +
          "Plain words about the plan and its evidence. ".repeat(130) +
          (k % 50 === 7 ? "\n\nHere con**verge** meets, and converge again.\n" : "\n"),
      ).join("\n"),
  );
  // Hundreds of code blocks queued for highlighting: the last one is reached more than 3 s after
  // the jump, and the match in it must still be selected then.
  const queueFile = join(temp, "queue.md");
  const blocks = (n) =>
    Array.from({ length: n }, (_, i) => "```js\nconst v" + i + " = " + i + ";\n```\n").join("\n");
  await writeFile(
    queueFile,
    "# Queue\n\n" + blocks(400) + "\n```js\nconst zebraToken = 1;\n```\n\n" + blocks(5) + "\n",
  );
  // Every section as tall as many panes, each match at the start or deep inside one, and a last
  // section shorter than the pane, so the jump there cannot bring it to the top.
  const lateFile = join(temp, "late.md");
  const lateParagraph = "Plain words about the plan and its evidence. ".repeat(40) + "\n\n";
  await writeFile(
    lateFile,
    "# Late neighbours\n\n" +
      Array.from(
        { length: 8 },
        (_, k) => `## Part ${k + 1}\n\n` + lateParagraph.repeat(150) + `converge at the end of part ${k + 1}.\n\n`,
      ).join("") +
      "Last, converge ends it.\n",
  );
  // The same, with comment blocks before the last line: the section above it renders far shorter
  // than its placeholder, so what mounts late can shrink as well as grow.
  const shrinkFile = join(temp, "shrink.md");
  await writeFile(
    shrinkFile,
    "# Late neighbours that shrink\n\n" +
      Array.from(
        { length: 8 },
        (_, k) => `## Part ${k + 1}\n\n` + lateParagraph.repeat(150) + `converge at the end of part ${k + 1}.\n\n`,
      ).join("") +
      Array.from({ length: 8 }, (_, i) => `<!-- block ${i} ${"x".repeat(1000)} -->\n\n`).join("") +
      "Last, converge ends it.\n",
  );
  // A long stretch of sections that render at nothing, between real ones. Without a height to hold
  // them apart they are all near each other, whatever the pane is looking at.
  const emptyFile = join(temp, "empty.md");
  const fewParts = Array.from(
    { length: 4 },
    (_, k) => `## Part ${k + 1}\n\n` + lateParagraph.repeat(150) + "\n\n",
  ).join("");
  await writeFile(
    emptyFile,
    "# Sections with nothing in them\n\n" +
      fewParts +
      Array.from({ length: 400 }, (_, i) => `<!-- block ${i} ${"x".repeat(20000)} -->\n\n`).join("") +
      fewParts,
  );
  for (const [name, engine] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 1100, height: 800 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(
        `http://127.0.0.1:1420/?file=${encodeURIComponent(file)}`,
      );
      await page.locator(".prose h1").first().waitFor({ timeout: 60000 });
      await page.waitForFunction(
        () => window.__panelessMetrics?.completeMs,
        undefined,
        { timeout: 60000 },
      );
      await page.keyboard.press("Meta+f");
      const box = page.getByRole("textbox", { name: "Find in document" });
      const count = async () => {
        await page.waitForTimeout(300);
        return page.evaluate(() => document.querySelector(".find-count").textContent);
      };
      await box.waitFor();
      await box.pressSequentially("converge");
      // The count follows the query as it is typed, before any jump.
      assert.equal(await count(), "1 match", `${name} count while typing`);
      // Where the match landed, and whether the reading pane moved to it.
      const state = () =>
        page.evaluate(() => {
          // The jump paints a CSS highlight and leaves the selection alone.
          const [range] = CSS.highlights.get("find-match") ?? [];
          const node = range?.startContainer;
          const el = node && (node.nodeType === 1 ? node : node.parentElement);
          const pane = document.querySelector(".reading-scroll").getBoundingClientRect();
          const match = range?.getBoundingClientRect();
          return {
            text: range ? range.toString() : "",
            selection: String(getSelection()),
            inDocument: !!el?.closest?.(".prose"),
            onScreen: !!match && match.top >= pane.top && match.bottom <= pane.bottom,
            scrollTop: document.querySelector(".reading-scroll").scrollTop,
            message: document.querySelector(".find-count").textContent,
          };
        });
      const expectFound = async (step, label = "1 of 1") => {
        await page.waitForTimeout(300);
        const s = await state();
        assert.equal(s.text, "converge", `${name} ${step}: ${JSON.stringify(s)}`);
        assert.ok(s.inDocument, `${name} ${step}: match not in the document ${JSON.stringify(s)}`);
        assert.ok(s.scrollTop > 2000, `${name} ${step}: page did not scroll ${JSON.stringify(s)}`);
        assert.ok(s.onScreen, `${name} ${step}: match off screen ${JSON.stringify(s)}`);
        assert.equal(s.message, label, `${name} ${step}: ${JSON.stringify(s)}`);
      };
      await page.keyboard.press("Enter");
      await expectFound("Enter");
      // The box keeps the keyboard after a jump: it used to go deaf until clicked.
      const typed = async (step) => {
        await page.keyboard.press("Backspace");
        assert.equal(await box.inputValue(), "converg", `${name} ${step}: Backspace after the jump`);
        await page.keyboard.type("e");
        assert.equal(await box.inputValue(), "converge", `${name} ${step}: typing after the jump`);
        assert.equal((await state()).selection, "", `${name} ${step}: the page took the selection`);
      };
      await typed("reading");
      await page.keyboard.press("Enter");
      await expectFound("Enter after typing");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expectFound("Next");
      await page.keyboard.press("Enter");
      await expectFound("Enter again");
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expectFound("Previous");
      // Back at the top, searching backwards from the box still lands in the document.
      await page.locator(".reading-scroll").evaluate((e) => (e.scrollTop = 0));
      await box.click();
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await expectFound("Previous from the top");
      // Many matches: the count is the real number, and "N of M" follows Next and Previous.
      // "plan" is in every sentence: 20 sections of 120 and 40 of 12.
      const plan = 20 * 120 + 40 * 12;
      await box.fill("plan");
      assert.equal(await count(), `${plan} matches`, `${name} plan count`);
      for (const [press, label] of [
        ["Enter", `1 of ${plan}`],
        ["Next", `2 of ${plan}`],
        ["Previous", `1 of ${plan}`],
        ["Previous", `${plan} of ${plan}`],
      ]) {
        if (press === "Enter") await page.keyboard.press("Enter");
        else await page.getByRole("button", { name: press, exact: true }).click();
        await page.waitForTimeout(300);
        const s = await state();
        assert.equal(s.message, label, `${name} plan ${press}: ${JSON.stringify(s)}`);
        assert.equal(s.text.toLowerCase(), "plan", `${name} plan ${press}: ${JSON.stringify(s)}`);
        assert.ok(s.inDocument && s.onScreen, `${name} plan ${press}: ${JSON.stringify(s)}`);
      }
      // A phrase the source wraps over two lines is still one match.
      await box.fill("split phrase");
      assert.equal(await count(), "1 match", `${name} wrapped phrase`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      assert.equal((await state()).text.replace(/\s+/g, " "), "split phrase", `${name} wrapped phrase`);
      // Case is ignored, letters are not: õ is not o.
      await box.fill("SÕDA");
      assert.equal(await count(), "1 match", `${name} case folded`);
      await box.fill("soda");
      assert.equal(await count(), "0 of 0", `${name} õ is not o`);
      // U+FEFF is not a space, here or in the Rust count.
      await box.fill("bom joined");
      assert.equal(await count(), "0 of 0", `${name} BOM is not a space`);
      // A match in a code block highlighted after the jump keeps its selection.
      await box.fill("zebraToken");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      assert.equal((await state()).text, "zebraToken", `${name} code block after highlighting`);
      // A five-digit count never covers the typed text.
      await page.evaluate(() => {
        const c = document.querySelector(".find-count");
        c.textContent = "12999 of 13000";
      });
      const [input, label] = await page.evaluate(() =>
        [".findbar input", ".find-count"].map((q) => document.querySelector(q).getBoundingClientRect().toJSON()),
      );
      assert.ok(label.left >= input.right, `${name} count overlaps the query ${JSON.stringify([input, label])}`);
      // The tall paragraph: the word itself must end up on screen.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(tallFile)}`);
      await page.locator(".prose h1").first().waitFor({ timeout: 60000 });
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("converge");
      await page.keyboard.press("Enter");
      await expectFound("tall paragraph");
      // A word that is nowhere in the document says so, even though the box contains it.
      await box.fill("zanzibarquux");
      assert.equal(await count(), "0 of 0", `${name} missing word while typing`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      assert.equal((await state()).message, "0 of 0", `${name} missing word`);
      await page.locator('[aria-label="Close find"]').click();
      // In the source editor: a word far below the rendered lines is found, and pressing Enter
      // again must not type into the document (it used to replace the word with a line break).
      await page.getByRole("button", { name: "Edit source", exact: true }).click();
      await page.getByRole("textbox", { name: "Markdown source" }).waitFor();
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("CONVERGE");
      assert.equal(await count(), "1 match", `${name} editor count while typing`);
      for (const step of ["Enter", "Enter again", "Enter a third time"]) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => ({
          message: document.querySelector(".find-count").textContent,
          selected: document.querySelector(".cm-selectedText")?.textContent,
          focus: document.activeElement?.getAttribute("aria-label"),
          status: document.querySelector(".statusbar, footer")?.textContent ?? "",
        }));
        assert.equal(s.message, "1 of 1", `${name} editor ${step}: ${JSON.stringify(s)}`);
        assert.equal(s.selected, "converge", `${name} editor ${step}: ${JSON.stringify(s)}`);
        assert.equal(s.focus, "Find in document", `${name} editor ${step}: ${JSON.stringify(s)}`);
        assert.doesNotMatch(s.status, /Unsaved/, `${name} editor ${step}: ${JSON.stringify(s)}`);
      }
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => document.querySelector(".cm-selectedText")?.textContent),
        "converge",
        `${name} editor Previous`,
      );
      await box.fill("word converge");
      assert.equal(await count(), "1 match", `${name} editor wrapped phrase`);
      // Switching to reading and back with the find bar open: Enter searches, never types.
      await page.getByRole("button", { name: "Read document", exact: true }).click();
      await page.locator(".prose h1").first().waitFor();
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      assert.equal((await state()).message, "1 of 1", `${name} Enter after Read document`);
      await page.getByRole("button", { name: "Edit source", exact: true }).click();
      await page.getByRole("textbox", { name: "Markdown source" }).waitFor();
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const edit = await page.evaluate(() => ({
        message: document.querySelector(".find-count").textContent,
        focus: document.activeElement?.getAttribute("aria-label"),
        status: document.querySelector(".statusbar, footer")?.textContent ?? "",
      }));
      assert.equal(edit.message, "1 of 1", `${name} Enter after Edit source ${JSON.stringify(edit)}`);
      assert.equal(edit.focus, "Find in document", `${name} focus after Edit source`);
      assert.doesNotMatch(edit.status, /Unsaved/, `${name} Enter after Edit source typed`);
      // ⌘N with the find bar open: the new note takes what is typed, not the find box.
      await page.keyboard.press("Meta+n");
      await page.getByRole("textbox", { name: "Markdown source" }).waitFor();
      await page.waitForTimeout(300);
      await page.keyboard.type("hello note");
      assert.equal(await box.inputValue(), "word converge", `${name} new note left the query alone`);
      assert.equal(
        await page.evaluate(() => document.querySelector(".cm-content")?.textContent),
        "hello note",
        `${name} new note took the typing`,
      );
      // Find in that unsaved note counts and steps (it said "0 of 0").
      await page.keyboard.press("Meta+f");
      await box.fill("hello");
      assert.equal(await count(), "1 match", `${name} new note count`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      assert.equal(await count(), "1 of 1", `${name} new note step`);
      // Writing in the source updates the count without pressing Enter.
      await page.locator(".cm-content").click();
      await page.keyboard.press("End");
      await page.keyboard.type(" hello again");
      assert.equal(await count(), "2 matches", `${name} count follows the edit`);
      assert.match(
        await page.evaluate(() => document.querySelector(".cm-content")?.textContent),
        /hello again/,
        `${name} typing went into the note`,
      );
      // The document over 2 MiB: 8 sections hold the word twice each.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(bigFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("converge");
      assert.equal(await count(), "16 matches", `${name} big count`);
      // The micro sign and Greek mu are one letter to the page, so to the Rust count as well.
      await box.fill("μm");
      assert.equal(await count(), "2 matches", `${name} big micro sign`);
      await box.fill("converge");
      for (const [press, label] of [
        ["Enter", "1 of 16"],
        ["Next", "2 of 16"],
        ["Next", "3 of 16"],
        ["Previous", "2 of 16"],
      ]) {
        if (press === "Enter") await page.keyboard.press("Enter");
        else await page.getByRole("button", { name: press, exact: true }).click();
        await page.waitForTimeout(600);
        const s = await state();
        assert.equal(s.message, label, `${name} big ${press}: ${JSON.stringify(s)}`);
        assert.equal(s.text, "converge", `${name} big ${press}: ${JSON.stringify(s)}`);
        assert.ok(s.inDocument && s.onScreen, `${name} big ${press}: ${JSON.stringify(s)}`);
      }
      // Enter from the box itself: a click on Previous above left the focus on that button.
      await box.click();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await typed("over 2 MiB");
      // Scrolled away and back, the marked section was evicted and came back unmarked.
      // Typing above cleared the mark, so jump again first.
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      const marked = await state();
      assert.equal(marked.text, "converge", `${name} mark before scrolling away`);
      const scroller = page.locator(".reading-scroll");
      // Away longer than showMatch's 3 s watch, which would otherwise re-mark the remounted section.
      await scroller.evaluate((e) => e.scrollTo(0, 0));
      await page.waitForTimeout(3500);
      await scroller.evaluate((e, top) => e.scrollTo(0, top), marked.scrollTop);
      await page.waitForTimeout(1500);
      assert.equal((await state()).text, "converge", `${name} mark after scrolling away and back`);
      // Mounted sections beyond the observer's 1800 px margin. A section spared for the mark must
      // be emptied once the mark moves or closes, with no scrolling past it.
      const farSections = () =>
        page.evaluate(() => {
          const pane = document.querySelector(".reading-scroll").getBoundingClientRect();
          return [...document.querySelectorAll(".document-chunk")]
            .filter((s) => {
              const r = s.getBoundingClientRect();
              return (
                s.childNodes.length &&
                (r.bottom < pane.top - 1802 || r.top > pane.bottom + 1802)
              );
            })
            .map((s) => Number(s.dataset.chunk));
        });
      const leaveMarkBehind = async (step) => {
        await scroller.evaluate((e) => e.scrollTo(0, 0));
        await page.waitForTimeout(1000);
        assert.equal((await farSections()).length, 1, `${name} ${step}: the marked section is spared`);
      };
      await leaveMarkBehind("before Next");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.waitForTimeout(900);
      assert.deepEqual(await farSections(), [], `${name} scroll away, then Next`);
      await leaveMarkBehind("before closing");
      // Reopened, the bar counts again instead of naming a match that is no longer marked.
      await page.locator('[aria-label="Close find"]').click();
      await page.waitForTimeout(300);
      assert.deepEqual(await farSections(), [], `${name} scroll away, then close`);
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      assert.equal(await count(), "16 matches", `${name} label after reopening`);
      // A step whose section is still loading when the bar closes: no scroll, no mark.
      await scroller.evaluate((e) => e.scrollTo(0, 0));
      await page.waitForTimeout(1500);
      await page.route("**/api/document_chunks", async (route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(100);
      await page.locator('[aria-label="Close find"]').click();
      await page.waitForTimeout(1500);
      const closed = await page.evaluate(() => ({
        marks: CSS.highlights.get("find-match")?.size ?? 0,
        scrollTop: document.querySelector(".reading-scroll").scrollTop,
      }));
      const leftover = await farSections();
      await page.unroute("**/api/document_chunks");
      assert.deepEqual(closed, { marks: 0, scrollTop: 0 }, `${name} step after closing the bar`);
      assert.deepEqual(leftover, [], `${name} dropped step leaves no section behind`);
      // A section spared for the selection goes too, once the selection clears.
      await page.evaluate(() => {
        getSelection().selectAllChildren(document.querySelector('.document-chunk[data-chunk="0"] p'));
      });
      await scroller.evaluate((e) => e.scrollTo(0, e.scrollHeight / 2));
      await page.waitForTimeout(1000);
      assert.ok((await farSections()).includes(0), `${name} the selected section is spared`);
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.waitForTimeout(300);
      assert.deepEqual(await farSections(), [], `${name} selection cleared`);
      // Steps whose sections arrive in one frame: the last scroll hides the earlier sections from
      // the observer, so nothing ever reports them off screen and they must not stay.
      await scroller.evaluate((e) => e.scrollTo(0, 0));
      await page.waitForTimeout(1000);
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      assert.equal(await count(), "16 matches", `${name} count before the quick steps`);
      const held = [];
      let holding = true;
      await page.route("**/api/document_chunks", (route) => {
        if (holding) held.push(route);
        else void route.continue();
      });
      for (let i = 0; i < 6; i++) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(300);
      holding = false;
      assert.ok(held.length >= 3, `${name} quick steps wait on ${held.length} sections`);
      await Promise.all(held.map((route) => route.continue()));
      await page.waitForTimeout(1500);
      const quick = await state();
      const quickLeft = await farSections();
      await page.unroute("**/api/document_chunks");
      assert.equal(quick.text, "converge", `${name} mark after quick steps`);
      assert.deepEqual(quickLeft, [], `${name} quick steps leave no section behind`);
      await page.locator('[aria-label="Close find"]').click();
      // A neighbour section that mounts after the jump has settled grows, and what is below it must
      // stay where it is: the word was pushed off screen when its bottom edge was inside the pane.
      // One fetch delay is longer than showMatch's 12 frames of re-measuring.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(lateFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page.route("**/api/document_chunks", async (route) => {
        await new Promise((r) => setTimeout(r, 300));
        await route.continue();
      });
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("converge");
      assert.equal(await count(), "9 matches", `${name} late neighbours count`);
      for (const label of ["1 of 9", "2 of 9", "3 of 9", "4 of 9"]) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
        const s = await state();
        assert.equal(s.message, label, `${name} late neighbours ${label}: ${JSON.stringify(s)}`);
        assert.ok(s.onScreen, `${name} late neighbours ${label}: ${JSON.stringify(s)}`);
      }
      // Reopened, Previous goes to the last match, in the section shorter than the pane.
      await page.locator('[aria-label="Close find"]').click();
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(1500);
      const last = await state();
      const lastTop = await page.evaluate(() => {
        const [range] = CSS.highlights.get("find-match") ?? [];
        const section = range?.startContainer.parentElement.closest(".document-chunk");
        const pane = document.querySelector(".reading-scroll").getBoundingClientRect();
        return section ? section.getBoundingClientRect().top - pane.top : null;
      });
      await page.unroute("**/api/document_chunks");
      assert.equal(last.message, "9 of 9", `${name} late neighbours, last: ${JSON.stringify(last)}`);
      assert.ok(last.onScreen, `${name} late neighbours, last: ${JSON.stringify(last)}`);
      // Its neighbour's bottom edge is inside the pane, or this was not the case being tested.
      assert.ok(lastTop > 50, `${name} late neighbours, the last section starts at ${lastTop}`);
      await page.locator('[aria-label="Close find"]').click();
      // Quick steps whose sections load out of order: the mark sits on the match the counter names,
      // not on whichever section finished last. Each of these matches has a section of its own.
      await scroller.evaluate((e) => e.scrollTo(0, 0));
      await page.waitForTimeout(1000);
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      assert.equal(await count(), "9 matches", `${name} count before out-of-order steps`);
      const markedChunk = () =>
        page.evaluate(() => {
          const [range] = CSS.highlights.get("find-match") ?? [];
          return range?.startContainer.parentElement.closest(".document-chunk").dataset.chunk;
        });
      const oneByOne = [];
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(600);
        oneByOne.push(await markedChunk());
      }
      assert.equal(new Set(oneByOne).size, 3, `${name} three matches in three sections: ${oneByOne}`);
      await page.locator('[aria-label="Close find"]').click();
      await scroller.evaluate((e) => e.scrollTo(0, 0));
      await page.waitForTimeout(1000);
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      assert.equal(await count(), "9 matches", `${name} count after reopening`);
      const outOfOrder = [];
      let holdingSteps = true;
      await page.route("**/api/document_chunks", (route) => {
        if (holdingSteps) outOfOrder.push(route);
        else void route.continue();
      });
      for (let i = 0; i < 3; i++) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(300);
      holdingSteps = false;
      assert.equal(outOfOrder.length, 3, `${name} three steps wait on three sections`);
      for (const route of outOfOrder.reverse()) {
        await route.continue();
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(1000);
      const named = await state();
      const namedChunk = await markedChunk();
      await page.unroute("**/api/document_chunks");
      assert.equal(named.message, "3 of 9", `${name} out-of-order steps: ${JSON.stringify(named)}`);
      assert.equal(namedChunk, oneByOne[2], `${name} the mark is on the match the counter names`);
      assert.ok(named.onScreen, `${name} out-of-order steps: ${JSON.stringify(named)}`);
      await page.locator('[aria-label="Close find"]').click();
      // A section at the end of the document that mounts shorter than its placeholder: the browser
      // already pulled the view up by the shrink when the document got shorter, so moving it again
      // left the last lines a screen and a half below the pane.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(lateFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page
        .locator(".reading-scroll")
        .evaluate((e) => e.scrollTo(0, e.scrollHeight));
      await page.waitForTimeout(1500);
      const shortOfEnd = () =>
        page.evaluate(() => {
          const pane = document.querySelector(".reading-scroll");
          return Math.round(pane.scrollHeight - pane.clientHeight - pane.scrollTop);
        });
      // A few pixels of slack: WebKit's whole-number scrollTop can settle 2 px short. The defect is 1500.
      assert.ok(
        Math.abs(await shortOfEnd()) <= 5,
        `${name} scrolled to the end, ${await shortOfEnd()} px short of it`,
      );
      // The same on a find jump: the short section above a short last one mounts after a slow fetch.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(shrinkFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page.route("**/api/document_chunks", async (route) => {
        await new Promise((r) => setTimeout(r, 300));
        await route.continue();
      });
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("converge");
      assert.equal(await count(), "9 matches", `${name} shrinking neighbour count`);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(2000);
      const shrunk = await state();
      const neighbour = await page.evaluate(() => {
        const [range] = CSS.highlights.get("find-match") ?? [];
        const section = range?.startContainer.parentElement.closest(".document-chunk");
        return section?.previousElementSibling?.getBoundingClientRect().height;
      });
      await page.unroute("**/api/document_chunks");
      assert.equal(shrunk.message, "9 of 9", `${name} shrinking neighbour: ${JSON.stringify(shrunk)}`);
      assert.ok(shrunk.onScreen, `${name} shrinking neighbour: ${JSON.stringify(shrunk)}`);
      // It really did shrink, or this was not the case being tested.
      assert.ok(neighbour < 300, `${name} the neighbour above the last section is ${neighbour} px`);
      await page.locator('[aria-label="Close find"]').click();
      // A short section evicted while a step is overtaken comes back at its placeholder's height. It
      // must be its real height, or it shrinks below the word and the document's end pulls the word
      // up, a third of a second after the jump.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(shrinkFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page.route("**/api/document_chunks", async (route) => {
        await new Promise((r) => setTimeout(r, 300));
        await route.continue();
      });
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("converge");
      assert.equal(await count(), "9 matches", `${name} twitch case count`);
      await box.press("Enter");
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(100);
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.getByText("8 of 9").waitFor({ timeout: 20000 });
      // Every frame for a second and a half from the moment the word is marked in part 8.
      const tops = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const seen = [];
            const deadline = performance.now() + 15000;
            let started = 0;
            const frame = (now) => {
              const [range] = CSS.highlights.get("find-match") ?? [];
              const text = range?.startContainer.parentElement?.textContent ?? "";
              if (range && text.includes("end of part 8")) {
                started ||= now;
                seen.push(Math.round(range.getBoundingClientRect().top));
              }
              if (started && now - started > 1500) resolve(seen);
              else if (now > deadline) resolve(seen);
              else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          }),
      );
      await page.unroute("**/api/document_chunks");
      assert.ok(tops.length > 10, `${name} the word was never marked in part 8: ${tops.length} frames`);
      // One pixel of slack: WebKit's scrollTop is a whole number.
      const moved = Math.max(...tops) - Math.min(...tops);
      assert.ok(moved <= 1, `${name} the word moved ${moved} px after it was placed: ${tops[0]} to ${tops.at(-1)}`);
      await page.locator('[aria-label="Close find"]').click();
      // Sections that render at nothing are not fetched again on every visit.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(emptyFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      let fetches = 0;
      const countFetch = (request) => {
        if (request.url().includes("document_chunks")) fetches++;
      };
      page.on("request", countFetch);
      const goToStretch = () =>
        page.evaluate(() => {
          const all = document.querySelectorAll(".virtual-chunk");
          all[Math.floor(all.length / 2)].scrollIntoView({ block: "start" });
        });
      const toTop = () =>
        page.locator(".reading-scroll").evaluate((e) => e.scrollTo(0, 0));
      // Twice: each section in the stretch collapses only once its own HTML arrives.
      for (let pass = 0; pass < 2; pass++) {
        await goToStretch();
        await page.waitForTimeout(1500);
      }
      const nothing = await page.evaluate(
        () =>
          [...document.querySelectorAll(".virtual-chunk")].filter(
            (s) => s.getBoundingClientRect().height === 0,
          ).length,
      );
      assert.ok(nothing >= 50, `${name} only ${nothing} sections render at nothing`);
      await toTop();
      await page.waitForTimeout(1000);
      fetches = 0;
      await goToStretch();
      await page.waitForTimeout(1000);
      assert.ok(fetches < nothing / 2, `${name} ${fetches} fetches on a return to ${nothing} empty sections`);
      page.off("request", countFetch);
      // The code block highlighted long after the jump keeps its match selected.
      await page.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(queueFile)}`);
      await page.waitForFunction(() => window.__panelessMetrics?.completeMs, undefined, {
        timeout: 60000,
      });
      await page.mouse.move(550, 500);
      const height = await page.evaluate(
        () => document.querySelector(".reading-scroll").scrollHeight,
      );
      for (let y = 0; y < height; y += 1000) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(8);
      }
      await page.evaluate(() => document.querySelector(".reading-scroll").scrollTo(0, 0));
      await page.keyboard.press("Meta+f");
      await box.waitFor();
      await box.fill("zebraToken");
      await page.waitForTimeout(300);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("pre code.hljs")].some((c) =>
            c.textContent.includes("zebraToken"),
          ),
        undefined,
        { timeout: 30000 },
      );
      await page.waitForTimeout(300);
      assert.equal((await state()).text, "zebraToken", `${name} late-highlighted code match`);
      // Still typing into the box once the late highlight has re-marked the match.
      await page.keyboard.type("X");
      assert.equal(await box.inputValue(), "zebraTokenX", `${name} typing after a late highlight`);
      // A WebKit without the highlight API gets the scroll and no mark: selecting the word there
      // would take the keyboard from the box again.
      const old = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      old.on("pageerror", (e) => errors.push(e.message));
      await old.addInitScript(() => {
        Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true });
        globalThis.Highlight = undefined;
      });
      await old.goto(`http://127.0.0.1:1420/?file=${encodeURIComponent(tallFile)}`);
      await old.locator(".prose h1").first().waitFor({ timeout: 60000 });
      await old.keyboard.press("Meta+f");
      const oldBox = old.getByRole("textbox", { name: "Find in document" });
      await oldBox.waitFor();
      await oldBox.pressSequentially("converge");
      await old.waitForTimeout(300);
      await old.keyboard.press("Enter");
      await old.waitForTimeout(300);
      await old.keyboard.press("Backspace");
      assert.equal(await oldBox.inputValue(), "converg", `${name} no highlight API: typing after the jump`);
      assert.equal(await old.evaluate(() => String(getSelection())), "", `${name} no highlight API: selection`);
      assert.ok(
        await old.evaluate(() => document.querySelector(".reading-scroll").scrollTop > 0),
        `${name} no highlight API: the page still scrolls to the match`,
      );
      await old.close();
      assert.deepEqual(errors, []);
      console.log(
        `${name}: the count follows the query; Enter, Next, Previous land on screen and say N of M, in reading, the editor and over 2 MiB`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
