import { useEffect, useRef } from "react";
import { command, navigateToHeading, type OpenResult } from "./types";
import type { Metrics } from "./Reader";
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
      // Keep an actively selected section intact while copying text.
      const selection = getSelection();
      if (
        selection &&
        !selection.isCollapsed &&
        (section.contains(selection.anchorNode) ||
          section.contains(selection.focusNode))
      )
        return;
      section.style.height = `${Math.max(100, section.getBoundingClientRect().height)}px`;
      section.replaceChildren();
      mounted.delete(index);
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
        const isAboveViewport =
          before.bottom <= scroller.getBoundingClientRect().top;
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
        if (isAboveViewport) {
          scroller.scrollTop +=
            section.getBoundingClientRect().height - before.height;
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
    const reveal = async (index: number, anchor?: string) => {
      if (!sections[index]) return;
      wanted.add(index);
      await mount(index);
      if (cancelled) return;
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
    const search = (e: Event) => {
      const { chunk, query } = (
        e as CustomEvent<{ chunk: number; query: string }>
      ).detail;
      void reveal(chunk)
        .then(() => {
          requestAnimationFrame(() => {
            const section = sections[chunk];
            const walker = document.createTreeWalker(
              section,
              NodeFilter.SHOW_TEXT,
            );
            let node;
            while ((node = walker.nextNode())) {
              const index = node
                .textContent!.toLowerCase()
                .indexOf(query.toLowerCase());
              if (index >= 0) {
                const range = document.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + query.length);
                const selection = getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                node.parentElement?.scrollIntoView({ block: "center" });
                break;
              }
            }
          });
        })
        .catch(onError);
    };
    window.addEventListener("paneless:anchor", anchor);
    window.addEventListener("paneless:search", search);
    return () => {
      cancelled = true;
      observer.disconnect();
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
