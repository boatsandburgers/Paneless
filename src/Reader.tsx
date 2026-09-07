import { useEffect, useRef } from "react";
import { command, type OpenResult } from "./types";
export interface Metrics {
  firstRenderMs: number;
  completeMs?: number;
}
export function Reader({
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
    let enhancer: typeof import("./highlight") | undefined;
    const queue: HTMLElement[] = [];
    let scheduled = false;
    const work = () => {
      if (cancelled || !enhancer) return;
      const code = queue.shift();
      if (code?.isConnected) enhancer.highlight(code);
      if (queue.length) setTimeout(work, 24);
      else scheduled = false;
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            queue.push(entry.target as HTMLElement);
          }
        if (queue.length && !scheduled) {
          scheduled = true;
          import("./highlight")
            .then((m) => {
              enhancer = m;
              if (!cancelled) setTimeout(work, 150);
            })
            .catch(() => {
              scheduled = false;
            });
        }
      },
      { rootMargin: "250px" },
    );
    const insert = (html: string) => {
      const section = document.createElement("section");
      section.className = "document-chunk";
      section.innerHTML = html; // HTML exclusively produced by our Rust parser; raw HTML is disabled.
      for (const img of section.querySelectorAll("img")) {
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", () => {
          img.classList.add("image-unavailable");
          img.title =
            "Image unavailable. Only local raster images inside this document’s folder are loaded.";
        });
      }
      for (const table of section.querySelectorAll("table")) {
        const wrapper = document.createElement("div");
        wrapper.className = "table-scroll";
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute("aria-label", "Table");
        table.replaceWith(wrapper);
        wrapper.append(table);
      }
      root.append(section);
      for (const code of section.querySelectorAll<HTMLElement>("pre code"))
        observer.observe(code);
    };
    const anchor = (e: Event) =>
      root
        .querySelector(
          `[id="${CSS.escape((e as CustomEvent<string>).detail)}"]`,
        )
        ?.scrollIntoView({ block: "start" });
    window.addEventListener("paneless:anchor", anchor);
    insert(doc.first);
    if (!doc.first)
      root.innerHTML =
        '<p class="empty-document">This document is empty.<br><span>Switch to source to write something.</span></p>';
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(resolve, 0)),
      );
    void (async () => {
      await nextFrame();
      if (cancelled) return;
      const metrics: Metrics = { firstRenderMs: performance.now() - openedAt };
      onMetrics(metrics);
      for (let offset = 1; offset < doc.info.chunks && !cancelled;) {
        const chunks = await command<string[]>("document_chunks", {
          id: doc.info.id,
          offset,
        });
        if (cancelled) return;
        if (!chunks.length)
          throw new Error(
            "Document loading was interrupted. Please reopen it.",
          );
        let sliceStart = performance.now();
        for (const chunk of chunks) {
          if (cancelled) return;
          insert(chunk);
          offset++;
          if (performance.now() - sliceStart > 6) {
            await nextFrame();
            sliceStart = performance.now();
          }
        }
        await nextFrame();
      }
      if (!cancelled) {
        onMetrics({ ...metrics, completeMs: performance.now() - openedAt });
        onDone();
      }
    })().catch((e) => {
      if (!cancelled) onError(e);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("paneless:anchor", anchor);
      observer.disconnect();
      queue.length = 0;
    };
  }, [doc]);
  return (
    <article
      ref={ref}
      className="prose"
      aria-label={doc.info.name}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest("a");
        if (!link) return;
        e.preventDefault();
        const href = link.getAttribute("href");
        if (!href) return;
        if (href.startsWith("#")) {
          try {
            ref.current
              ?.querySelector(
                `[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`,
              )
              ?.scrollIntoView({ block: "start" });
          } catch {
            /* malformed anchors are inert */
          }
        } else onLink(href);
      }}
    />
  );
}
