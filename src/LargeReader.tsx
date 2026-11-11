import { useEffect, useRef } from "react";
import { command, navigateToHeading, type OpenResult } from "./types";
import type { Metrics } from "./Reader";
import {
  findMatches,
  holdsMatch,
  indexText,
  matchGeneration,
  onMatchChange,
  showMatch,
} from "./findText";
/** Only used after the measured full-DOM limit. HTML stays native within visible sections. */
export default function LargeReader({
  doc,
  openedAt,
  onMetrics,
  onDone,
  onError,
  onLink,
}: {
  doc: OpenResult;
  openedAt: number;
  onMetrics: (m: Metrics) => void;
  onDone: () => void;
  onError: (e: unknown) => void;
  onLink: (url: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current!;
    root.replaceChildren();
    let cancelled = false;
    const sections: HTMLElement[] = [];
    const wanted = new Set<number>();
    const mounted = new Set<number>();
    const loading = new Map<number, Promise<void>>();
    let highlighted: typeof import("./highlight") | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.chunk);
          if (entry.isIntersecting) {
            wanted.add(index);
            void mount(index).catch(onError);
          } else {
            wanted.delete(index);
            evict(index);
          }
        }
      },
      { root: root.parentElement, rootMargin: "1800px" },
    );
    function evict(index: number) {
      if (!mounted.has(index)) return;
      const section = sections[index];
      // Keep an actively selected section intact while copying text, and the section holding the
      // find match, or its mark is gone on scrolling back.
      if (holdsMatch(section)) return;
      const selection = getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        (section.contains(selection.anchorNode) ||
          section.contains(selection.focusNode))
      )
        return;
      // A section that measures nothing stays: only raw HTML was in it, and that renders empty. As
      // placeholders they would all sit at one spot, and each return there would fetch them all again.
      const { height } = section.getBoundingClientRect();
      if (!height) return;
      // Its real height, however short. A taller placeholder shrinks when it comes back, and at the
      // end of the document that pulls up whatever the reader is looking at.
      section.style.height = `${height}px`;
      section.replaceChildren();
      mounted.delete(index);
    }
    // The observer reports a section only when it crosses the margin, so one that evict spared,
    // already off screen, gets no second chance. This is it, once the reason to spare it is gone:
    // the match moved or closed, or the selection cleared.
    function sweep() {
      for (const index of [...mounted]) if (!wanted.has(index)) evict(index);
    }
    function mount(index: number): Promise<void> {
      if (mounted.has(index)) return Promise.resolve();
      const inFlight = loading.get(index);
      if (inFlight) return inFlight;
      const task = (async () => {
        const html =
          index === 0
            ? doc.first
            : (
                await command<string[]>("document_chunks", {
                  id: doc.info.id,
                  offset: index,
                })
              )[0];
        if (cancelled || !wanted.has(index)) return;
        const section = sections[index];
        const before = section.getBoundingClientRect();
        const scroller = root.parentElement!;
        const pane = scroller.getBoundingClientRect();
        // A section starting above the pane whose bottom edge is in view grows upward, so what is
        // below it stays where it is: the find match after a jump, or the lines being read.
        // Testing only for a section wholly above missed an edge a fraction of a pixel inside.
        // A section that fills the pane has nothing in view to hold still.
        const growsUpward = before.top < pane.top && before.bottom <= pane.bottom;
        section.innerHTML = html || "";
        section.style.height = "auto";
        mounted.add(index);
        for (const img of section.querySelectorAll("img")) {
          img.loading = "lazy";
          img.decoding = "async";
        }
        for (const table of section.querySelectorAll("table")) {
          const wrap = document.createElement("div");
          wrap.className = "table-scroll";
          wrap.tabIndex = 0;
          wrap.setAttribute("role", "region");
          wrap.setAttribute("aria-label", "Table");
          table.replaceWith(wrap);
          wrap.append(table);
        }
        // Where the bottom edge is now, not how much the height changed: a section that shrinks at
        // the end of the document has already been pulled up by the browser, which clamps scrollTop.
        if (growsUpward) {
          scroller.scrollTop += section.getBoundingClientRect().bottom - before.bottom;
        }
        setTimeout(() => {
          if (cancelled || !mounted.has(index)) return;
          void (
            highlighted ? Promise.resolve(highlighted) : import("./highlight")
          )
            .then((module) => {
              highlighted = module;
              const codes = [
                ...section.querySelectorAll<HTMLElement>("pre code"),
              ];
              const next = () => {
                if (cancelled || !mounted.has(index)) return;
                const code = codes.shift();
                if (code) module.highlight(code);
                if (codes.length) setTimeout(next, 24);
              };
              next();
            })
            .catch(() => {});
        }, 200);
      })().finally(() => loading.delete(index));
      loading.set(index, task);
      return task;
    }
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < doc.info.chunks; i++) {
      const section = document.createElement("section");
      section.className = "document-chunk virtual-chunk";
      section.dataset.chunk = String(i);
      section.style.height = "1600px";
      sections.push(section);
      fragment.append(section);
    }
    root.append(fragment);
    wanted.add(0);
    void mount(0)
      .then(() =>
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (!cancelled) {
              const time = performance.now() - openedAt;
              onMetrics({ firstRenderMs: time, completeMs: time });
              onDone();
            }
          }, 0),
        ),
      )
      .catch(onError);
    for (const section of sections) observer.observe(section);
    // `live` is asked again after the section's HTML arrives: a find step closed meanwhile stops.
    const reveal = async (index: number, anchor?: string, live = () => true) => {
      if (!sections[index]) return;
      wanted.add(index);
      await mount(index);
      if (cancelled) return;
      // Only the observer takes a section out of `wanted`, and it reports only a change. A step
      // dropped while its section loaded never scrolled there, and a later step's scroll in the
      // same frame hides this one's. Observing again delivers a fresh report either way, so the
      // observer decides: evicted if off screen, kept if the reader is there.
      observer.unobserve(sections[index]);
      observer.observe(sections[index]);
      if (!live()) return;
      sections[index].scrollIntoView({ block: "start" });
      if (anchor)
        requestAnimationFrame(() =>
          root
            .querySelector(`[id="${CSS.escape(anchor)}"]`)
            ?.scrollIntoView({ block: "start" }),
        );
    };
    const anchor = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const heading = doc.info.headings.find((h) => h.id === id);
      if (heading) void reveal(heading.chunk, id).catch(onError);
    };
    // The nth match inside one section, counted by the same matcher as the find box.
    let latestStep = 0;
    const search = (e: Event) => {
      const { chunk, query, nth, generation } = (
        e as CustomEvent<{ chunk: number; query: string; nth: number; generation: number }>
      ).detail;
      // The bar was closed or the query changed before this step arrived: no scroll, no mark.
      if (generation !== matchGeneration()) return;
      // Steps arrive in the order the counter moves, but their sections can finish loading in any
      // order. Only the newest may scroll and mark, so the mark is the match the counter names.
      const step = ++latestStep;
      const live = () => step === latestStep && generation === matchGeneration();
      void reveal(chunk, undefined, live)
        .then(() => {
          requestAnimationFrame(() => {
            if (!live()) return;
            const section = sections[chunk];
            const index = indexText(section);
            const matches = findMatches(index.text, query);
            if (!matches.length) return;
            const pane = section.closest<HTMLElement>(".reading-scroll");
            if (pane)
              showMatch(pane, section, matches[Math.min(nth, matches.length - 1)], generation);
          });
        })
        .catch(onError);
    };
    window.addEventListener("paneless:anchor", anchor);
    window.addEventListener("paneless:search", search);
    const stopWatching = onMatchChange(sweep);
    document.addEventListener("selectionchange", sweep);
    return () => {
      cancelled = true;
      observer.disconnect();
      stopWatching();
      document.removeEventListener("selectionchange", sweep);
      window.removeEventListener("paneless:anchor", anchor);
      window.removeEventListener("paneless:search", search);
    };
  }, [doc]);
  return (
    <article
      className="prose large-document"
      ref={ref}
      aria-label={doc.info.name}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest("a");
        if (!link) return;
        e.preventDefault();
        const href = link.getAttribute("href");
        if (!href) return;
        if (href.startsWith("#")) {
          try {
            navigateToHeading(decodeURIComponent(href.slice(1)));
          } catch {}
        } else onLink(href);
      }}
    />
  );
}
