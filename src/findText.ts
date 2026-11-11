// One matcher for every find in the app, so the count the find box shows and the places
// Enter steps through are the same list. Case-insensitive only: folding accents would make
// Estonian õ match o and ä match a, and Russian й match и, which are different letters.
export type Match = { from: number; to: number };

// Spaces in the query match any run of whitespace, so a phrase still matches where the source
// wraps the line or a block ends. search_document in lib.rs counts the same way; White_Space is
// the set Rust's split_whitespace uses (JavaScript's \s also holds U+FEFF).
export function findMatches(text: string, query: string): Match[] {
  const words = query.split(/\p{White_Space}+/u).filter(Boolean);
  if (!words.length) return [];
  // A query too long for the engine's regular expressions finds nothing rather than throwing.
  // Chromium compiles lazily, so that error comes from matchAll, not from new RegExp.
  try {
    const pattern = new RegExp(
      words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\p{White_Space}+"),
      "giu",
    );
    return [...text.matchAll(pattern)].map((m) => ({
      from: m.index,
      to: m.index + m[0].length,
    }));
  } catch {
    return [];
  }
}

// Elements whose text is its own block: a match never runs from one into the next as if the
// words touched, and a space between them mirrors the text the Rust search reads (document.rs).
const BLOCK =
  "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,caption,figcaption,summary,div,section,article,table,tr,ul,ol,dl";

// The rendered text under `root` as one string, plus where each text node starts in it.
export function indexText(root: Element) {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let block: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    if (!t.data) continue;
    const owner = t.parentElement?.closest(BLOCK) ?? null;
    if (text && owner !== block) text += " ";
    block = owner;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  return { text, nodes, starts };
}

// The DOM range for a match found in indexText's string.
export function rangeFor(index: ReturnType<typeof indexText>, match: Match) {
  const locate = (at: number) => {
    let lo = 0;
    let hi = index.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return { node: index.nodes[lo], offset: at - index.starts[lo] };
  };
  const start = locate(match.from);
  // The last character of the match, so an end that falls on a node boundary stays in its node.
  const end = locate(match.to - 1);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

// Selects a match and scrolls it to the middle of `pane` when it is off screen. Sections off
// screen are laid out at an estimated height (content-visibility: auto), so it measures again
// for 12 frames. A newer call, or the reader's own wheel, touch, click or key in the pane, stops it. Not a
// scrollTop comparison: the browser's own scroll anchoring moves scrollTop while the heights
// settle.
let revealToken = 0;
let markToken = 0;
// Bumped only by clearMatch. A jump over 2 MiB marks its match after an await (the count from
// Rust, the section's HTML, a frame), so it carries the value from when Enter was pressed and is
// refused if the query, the bar, the mode or the document changed meanwhile.
let clearToken = 0;
export const matchGeneration = () => clearToken;
const STOPS = ["wheel", "touchstart", "pointerdown", "keydown"];
const MARK = "find-match";
type Highlights = { set(name: string, h: unknown): void; delete(name: string): void };
const highlights = () =>
  (globalThis as { CSS?: { highlights?: Highlights } }).CSS?.highlights;
const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

// The match is painted with a CSS highlight (::highlight(find-match)), not the page selection:
// keys follow the selection, so selecting the word in the page left the find box deaf until it was
// clicked, and ⌘A selected the whole page. Browsers' own find works the same way.
// A WebKit without the API (before Safari 17.2) gets no mark at all, only the scroll: selecting
// the word there would bring the deaf box back.
let marked: Range | null = null;
const matchWatchers = new Set<() => void>();
function mark(range: Range) {
  marked = range;
  const store = highlights();
  if (store && HighlightCtor) store.set(MARK, new HighlightCtor(range));
  matchWatchers.forEach((watcher) => watcher());
}
export function clearMatch() {
  markToken++;
  clearToken++;
  marked = null;
  highlights()?.delete(MARK);
  matchWatchers.forEach((watcher) => watcher());
}
// Called whenever the current match moves or goes away. Returns the way to stop.
export function onMatchChange(watcher: () => void) {
  matchWatchers.add(watcher);
  return () => {
    matchWatchers.delete(watcher);
  };
}
// Whether the current match is inside `el`: LargeReader keeps that section mounted, as it does a
// section holding the selection, or the mark would be gone on scrolling back.
export function holdsMatch(el: Element) {
  return !!marked && el.contains(marked.startContainer);
}

export function showMatch(
  pane: HTMLElement,
  root: Element,
  match: Match,
  generation = clearToken,
) {
  if (generation !== clearToken) return;
  const first = indexText(root);
  const expected = first.text.slice(match.from, match.to);
  let range = rangeFor(first, match);
  mark(range);
  const marked = ++markToken;
  const token = ++revealToken;
  // The reader's own wheel, touch, click or key in the pane ends the re-measure, so the page stops
  // moving under the reader.
  const stop = () => {
    if (token === revealToken) revealToken++;
  };
  STOPS.forEach((e) => pane.addEventListener(e, stop, { once: true, passive: true }));
  // Highlighting a code block replaces its text nodes, which empties the mark a moment after the
  // jump. The text stays the same, so the same offsets find the match again. A code block waiting
  // in the highlight queue can be reached many seconds later, after the reader has scrolled through
  // hundreds of them, so a match in one is watched until it is highlighted. Only a newer search,
  // a new query or closing the bar ends it; the mark does not take the reader's own selection.
  const waitingCode = () =>
    range.startContainer.parentElement?.closest("code[class*='language-']:not(.hljs)");
  const observer = new MutationObserver(() => {
    if (marked !== markToken) return finish();
    if (range.toString() === expected) return;
    const fresh = indexText(root);
    if (fresh.text.slice(match.from, match.to) !== expected) return;
    range = rangeFor(fresh, match);
    mark(range);
    if (!waitingCode()) finish();
  });
  const timer = setTimeout(() => finish(), waitingCode() ? 60000 : 3000);
  const finish = () => {
    clearTimeout(timer);
    observer.disconnect();
  };
  observer.observe(root, { childList: true, subtree: true });
  reveal(pane, token, () => range, () =>
    STOPS.forEach((e) => pane.removeEventListener(e, stop)),
  );
}

function reveal(
  pane: HTMLElement,
  token: number,
  current: () => Range,
  done: () => void,
) {
  let frames = 12;
  const step = () => {
    if (token !== revealToken) return done();
    const match = measure(current());
    const box = pane.getBoundingClientRect();
    if (match.top < box.top || match.bottom > box.bottom)
      pane.scrollTop += match.top - box.top - (box.height - match.height) / 2;
    if (--frames > 0) requestAnimationFrame(step);
    else done();
  };
  step();
}

// WebKit lays out a skipped section (content-visibility: auto) when the selection is inside it,
// not when a highlight is, so the match measures as an empty box at 0,0 until the section is on
// screen. Until then aim at the nearest enclosing element that has a size: the section itself,
// at its estimated height. Once it is on screen it is laid out and the next frame finds the word.
function measure(range: Range) {
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height) return rect;
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const outer = el.getBoundingClientRect();
    if (outer.width || outer.height) return outer;
  }
  return rect;
}

// What the find box says: "3 of 12" after a jump, "12 matches" before one, "0 of 0" at none.
export function countLabel(total: number, current: number) {
  if (!total) return "0 of 0";
  return current < 0
    ? `${total} ${total === 1 ? "match" : "matches"}`
    : `${current + 1} of ${total}`;
}
