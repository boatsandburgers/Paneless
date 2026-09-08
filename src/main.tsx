import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Reader, type Metrics } from "./Reader";
import {
  command,
  native,
  LARGE_DOCUMENT_BYTES,
  navigateToHeading,
  type OpenResult,
} from "./types";
import "./style.css";
import LargeReader from "./LargeReader";
import Outline from "./Outline";
const ProjectInbox = lazy(() => import("./ProjectInbox"));
type Settings = {
  theme: "light" | "dark" | "system";
  font: number;
  width: number;
};
function initialSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem("paneless-settings") || "{}");
    return {
      theme: ["light", "dark", "system"].includes(s.theme) ? s.theme : "system",
      font: Math.max(13, Math.min(26, Number(s.font) || 16)),
      width: Math.max(580, Math.min(1100, Number(s.width) || 780)),
    };
  } catch {
    return { theme: "system", font: 16, width: 780 };
  }
}
function Icon({
  name,
}: {
  name: "open" | "outline" | "inbox" | "type" | "source" | "read";
}) {
  const paths = {
    open: (
      <>
        <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9v11H3Z" />
        <path d="M3 9h17" />
      </>
    ),
    inbox: (
      <>
        <path d="M5 4h14l3 12v4H2v-4Z" />
        <path d="M2 15h6l2 3h4l2-3h6M8 8h8m-9 3h10" />
      </>
    ),
    outline: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16m4-11h5m-5 4h5m-5 4h3" />
      </>
    ),
    type: (
      <>
        <path d="m3 18 6-13 6 13M5 14h8m3-3h5m-2-3v10" />
      </>
    ),
    source: (
      <>
        <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
      </>
    ),
    read: (
      <>
        <path d="M3 5h6l3 2 3-2h6v14h-6l-3 2-3-2H3Zm9 2v14" />
      </>
    ),
  };
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export default function App() {
  const [active, setActive] = useState(
    () => document.hasFocus() && document.visibilityState === "visible",
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const focus = () => setActive(document.visibilityState === "visible");
    const blur = () => setActive(false);
    const visibility = () =>
      setActive(document.hasFocus() && document.visibilityState === "visible");
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const [doc, setDoc] = useState<OpenResult | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const [settings, setSettings] = useState(initialSettings);
  const [preferences, setPreferences] = useState(false);
  const [outline, setOutline] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const showInbox = () => {
    setInboxLoaded(true);
    setInbox(true);
    setOutline(false);
  };
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [source, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const history = useRef<{ paths: string[]; index: number }>({
    paths: [],
    index: -1,
  });
  const positions = useRef(new Map<string, number>());
  const pendingPosition = useRef<{
    path: string;
    top: number;
    anchor?: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>();
  const [find, setFind] = useState(false);
  const [search, setSearch] = useState("");
  const [findMessage, setFindMessage] = useState("");
  const openedAt = useRef(0);
  const generation = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const modifier = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const report = useCallback(
    (e: unknown) => setError(String(e).replace(/^Error: /, "")),
    [],
  );
  const confirmDiscard = async () =>
    !dirtyRef.current ||
    (native
      ? (await import("@tauri-apps/plugin-dialog")).confirm(
          "Discard your unsaved changes?",
          { title: "Unsaved changes", kind: "warning" },
        )
      : window.confirm("Discard your unsaved changes?"));
  const openPath = useCallback(
    async (
      path: string,
      bypass = false,
      navigation?: { index?: number; anchor?: string },
    ) => {
      if (!bypass && !(await confirmDiscard())) return;
      if (docRef.current)
        positions.current.set(
          docRef.current.info.path,
          editingRef.current
            ? savedScroll.current
            : scrollRef.current?.scrollTop || 0,
        );
      const attempt = ++generation.current;
      setBusy(true);
      setError("");
      openedAt.current = performance.now();
      try {
        const result = await command<OpenResult>("open_document", { path });
        if (attempt !== generation.current) return;
        dirtyRef.current = false;
        setDirty(false);
        setChanged(false);
        setEditing(false);
        setLoaded(false);
        setMetrics(undefined);
        pendingPosition.current = {
          path: result.info.path,
          top: positions.current.get(result.info.path) || 0,
          anchor: navigation?.anchor,
        };
        if (navigation?.index !== undefined)
          history.current.index = navigation.index;
        else if (
          history.current.paths[history.current.index] !== result.info.path
        ) {
          history.current.paths = history.current.paths.slice(
            0,
            history.current.index + 1,
          );
          history.current.paths.push(result.info.path);
          history.current.index = history.current.paths.length - 1;
        }
        setDoc(result);
        scrollRef.current?.scrollTo(0, 0);
        if (native)
          await (
            await import("@tauri-apps/api/window")
          )
            .getCurrentWindow()
            .setTitle(`${result.info.name} — Paneless`);
        document.title = `${result.info.name} — Paneless`;
        return true;
      } catch (e) {
        if (attempt === generation.current) report(e);
      } finally {
        if (attempt === generation.current) setBusy(false);
      }
    },
    [report],
  );
  const navigateHistory = (delta: number) => {
    const index = history.current.index + delta;
    const path = history.current.paths[index];
    if (path) void openPath(path, false, { index });
  };
  const pick = async () => {
    try {
      if (native) {
        const path = await (
          await import("@tauri-apps/plugin-dialog")
        ).open({
          multiple: false,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
        if (typeof path === "string") await openPath(path);
      } else {
        const path = window.prompt(
          "Development preview: absolute Markdown file path",
        );
        if (path) await openPath(path);
      }
    } catch (e) {
      report(e);
    }
  };
  const save = async () => {
    if (!doc || !editing || !dirtyRef.current) return;
    setBusy(true);
    try {
      const text = editRef.current!.value;
      await command("save_document", { id: doc.info.id, source: text });
      setSource(text);
      dirtyRef.current = false;
      setDirty(false);
      setChanged(false);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const toggleEdit = async () => {
    if (!doc) return;
    if (editing) {
      if (!(await confirmDiscard())) return;
      const position = savedScroll.current;
      await openPath(doc.info.path, true);
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, position));
    } else {
      try {
        savedScroll.current = scrollRef.current?.scrollTop || 0;
        setSource(
          await command<string>("document_source", { id: doc.info.id }),
        );
        setEditing(true);
      } catch (e) {
        report(e);
      }
    }
  };
  const openLink = async (url: string) => {
    try {
      if (!/^(https?:|mailto:)/i.test(url)) {
        if (doc) {
          const [path, anchor] = await command<[string, string]>(
            "resolve_document_link",
            { id: doc.info.id, href: url },
          );
          await openPath(path, false, { anchor });
        }
        return;
      }
      if (native)
        await (await import("@tauri-apps/plugin-opener")).openUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      report(e);
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    try {
      localStorage.setItem("paneless-settings", JSON.stringify(settings));
    } catch {
      /* unavailable storage does not block reading */
    }
  }, [settings]);
  useEffect(() => {
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const register = (fn: () => void) => {
      if (disposed) fn();
      else cleanup.push(fn);
    };
    if (native)
      void (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        const pending = async () => {
          const path = await command<string | null>("take_pending");
          if (path && !disposed) await openPath(path);
        };
        register(
          await listen("confirm-quit", async () => {
            if (await confirmDiscard()) await command("quit");
          }),
        );
        register(await listen("open-file", pending));
        await pending();
        register(
          await listen<string>("file-changed", (e) => {
            if (e.payload !== docRef.current?.info.path) return;
            if (
              activeRef.current &&
              !editingRef.current &&
              !dirtyRef.current &&
              !busyRef.current &&
              !globalThis.getSelection()?.toString()
            )
              void openPath(e.payload, true);
            else setChanged(true);
          }),
        );
        const window = (
          await import("@tauri-apps/api/window")
        ).getCurrentWindow();
        register(
          await window.onDragDropEvent((e) => {
            setDragging(
              e.payload.type === "enter" || e.payload.type === "over",
            );
            if (e.payload.type === "drop" && e.payload.paths[0])
              void openPath(e.payload.paths[0]);
          }),
        );
        register(
          await window.onCloseRequested(async (e) => {
            if (dirtyRef.current) {
              e.preventDefault();
              if (await confirmDiscard()) {
                dirtyRef.current = false;
                await window.close();
              }
            }
          }),
        );
      })().catch(report);
    else if (import.meta.env.DEV) {
      const path = new URLSearchParams(location.search).get("file");
      if (path) void openPath(path);
    }
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
    };
  }, [openPath, report]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPreferences(false);
        setFind(false);
      }
      if (!e.metaKey && !e.ctrlKey) return;
      if (["o", "s", "+", "=", "-", "0", "f"].includes(e.key.toLowerCase()))
        e.preventDefault();
      switch (e.key.toLowerCase()) {
        case "[":
          e.preventDefault();
          navigateHistory(-1);
          break;
        case "]":
          e.preventDefault();
          navigateHistory(1);
          break;
        case "o":
          if (e.shiftKey) showInbox();
          else void pick();
          break;
        case "s":
          void save();
          break;
        case "+":
        case "=":
          setSettings((s) => ({ ...s, font: Math.min(26, s.font + 1) }));
          break;
        case "-":
          setSettings((s) => ({ ...s, font: Math.max(13, s.font - 1) }));
          break;
        case "0":
          setSettings((s) => ({ ...s, font: 16 }));
          break;
        case "f":
          setFind(true);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    if (native) void command("set_dirty", { dirty }).catch(report);
  }, [dirty, report]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const hitsRef = useRef<{
    query: string;
    id: number;
    hits: number[];
    index: number;
  }>({ query: "", id: 0, hits: [], index: -1 });
  const searchDocument = async (backwards = false) => {
    if (doc && doc.info.bytes > LARGE_DOCUMENT_BYTES) {
      if (!search) return;
      try {
        let result = hitsRef.current;
        if (result.query !== search || result.id !== doc.info.id)
          result = {
            query: search,
            id: doc.info.id,
            hits: await command<number[]>("search_document", {
              id: doc.info.id,
              query: search,
            }),
            index: -1,
          };
        if (!result.hits.length) {
          setFindMessage("No match");
          return;
        }
        result.index =
          (result.index + (backwards ? -1 : 1) + result.hits.length) %
          result.hits.length;
        hitsRef.current = result;
        window.dispatchEvent(
          new CustomEvent("paneless:search", {
            detail: { chunk: result.hits[result.index], query: search },
          }),
        );
        setFindMessage(`${result.index + 1} / ${result.hits.length} sections`);
      } catch (e) {
        report(e);
      }
      return;
    }
    const fn = (
      window as unknown as {
        find?: (
          text: string,
          caseSensitive: boolean,
          backwards: boolean,
          wrap: boolean,
        ) => boolean;
      }
    ).find;
    setFindMessage(fn?.(search, false, backwards, true) ? "" : "No match");
  };
  const DocumentReader =
    doc && doc.info.bytes > LARGE_DOCUMENT_BYTES ? LargeReader : Reader;
  return (
    <div
      className="app"
      style={
        {
          "--reading-size": `${settings.font}px`,
          "--reading-width": `${settings.width}px`,
        } as React.CSSProperties
      }
    >
      <header className="topbar">
        <div className="bar-left">
          {doc && (
            <>
              <button
                className="icon-button history-button"
                aria-label="Back"
                title={`Back (${modifier}[)`}
                disabled={busy || history.current.index <= 0}
                onClick={() => navigateHistory(-1)}
              >
                ‹
              </button>
              <button
                className="icon-button history-button"
                aria-label="Forward"
                title={`Forward (${modifier}])`}
                disabled={
                  busy ||
                  history.current.index >= history.current.paths.length - 1
                }
                onClick={() => navigateHistory(1)}
              >
                ›
              </button>
            </>
          )}
          <button
            className="icon-button"
            title={`Open file (${modifier}O)`}
            aria-label="Open file"
            onClick={() => void pick()}
          >
            <Icon name="open" />
          </button>
          <button
            className={`icon-button inbox-toggle ${inbox ? "selected" : ""}`}
            title={`Project inbox (${modifier}Shift+O)`}
            aria-label="Toggle project inbox"
            aria-pressed={inbox}
            onClick={() => (inbox ? setInbox(false) : showInbox())}
          >
            <Icon name="inbox" />
            {inboxCount > 0 && <span className="inbox-dot" />}
          </button>
          {doc && (
            <button
              className={`icon-button ${outline ? "selected" : ""}`}
              title="Document outline"
              aria-label="Toggle outline"
              aria-pressed={outline}
              onClick={() => {
                setOutline(!outline);
                setInbox(false);
              }}
            >
              <Icon name="outline" />
            </button>
          )}
        </div>
        <div className="file-title">
          {doc ? (
            <>
              {doc.info.name}
              <span className="dirty-dot">{dirty ? " •" : ""}</span>
            </>
          ) : (
            <span className="wordmark">paneless</span>
          )}
        </div>
        <div className="bar-right">
          {doc && (
            <button
              className={`icon-button ${editing ? "selected" : ""}`}
              title={editing ? "Read document" : "Edit source"}
              aria-label={editing ? "Read document" : "Edit source"}
              disabled={busy}
              onClick={() => void toggleEdit()}
            >
              <Icon name={editing ? "read" : "source"} />
            </button>
          )}
          <button
            className={`icon-button ${preferences ? "selected" : ""}`}
            title="Reading appearance"
            aria-label="Reading appearance"
            aria-expanded={preferences}
            onClick={() => setPreferences(!preferences)}
          >
            <Icon name="type" />
          </button>
        </div>
      </header>
      {preferences && (
        <>
          <button
            className="popover-backdrop"
            aria-label="Close appearance"
            onClick={() => setPreferences(false)}
          />
          <div className="preferences">
            <div className="popover-label">READING APPEARANCE</div>
            <div className="theme-switch">
              {(["light", "dark", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  className={settings.theme === theme ? "active" : ""}
                  onClick={() => setSettings((s) => ({ ...s, theme }))}
                >
                  {theme[0].toUpperCase() + theme.slice(1)}
                </button>
              ))}
            </div>
            <label>
              Text size <span>{settings.font} px</span>
              <input
                aria-label="Text size"
                type="range"
                min="13"
                max="26"
                value={settings.font}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, font: +e.target.value }))
                }
              />
            </label>
            <label>
              Page width{" "}
              <span>
                {settings.width < 700
                  ? "Focused"
                  : settings.width > 900
                    ? "Wide"
                    : "Comfortable"}
              </span>
              <input
                aria-label="Page width"
                type="range"
                min="580"
                max="1100"
                step="20"
                value={settings.width}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, width: +e.target.value }))
                }
              />
            </label>
            <button
              className="reset-button"
              onClick={() =>
                setSettings({ theme: "system", font: 16, width: 780 })
              }
            >
              Reset to defaults
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {changed && (
        <div className="notice">
          <span>
            {dirty
              ? "This file changed on disk. Your edits are safe here."
              : "This file changed on disk."}
          </span>
          <button onClick={() => doc && void openPath(doc.info.path)}>
            Reload
          </button>
          <button
            onClick={() => setChanged(false)}
            aria-label="Dismiss file change"
          >
            ×
          </button>
        </div>
      )}
      {find && (
        <form
          className="findbar"
          onSubmit={(e) => {
            e.preventDefault();
            searchDocument();
          }}
        >
          <input
            autoFocus
            aria-label="Find in document"
            placeholder="Find in document…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span>{!loaded ? "Still loading…" : findMessage}</span>
          <button type="button" onClick={() => searchDocument(true)}>
            Previous
          </button>
          <button>Next</button>
          <button
            type="button"
            onClick={() => setFind(false)}
            aria-label="Close find"
          >
            ×
          </button>
        </form>
      )}
      <div className="body">
        {inboxLoaded && (
          <Suspense
            fallback={
              inbox ? (
                <aside className="outline">
                  <p className="loading-document">Opening inbox…</p>
                </aside>
              ) : null
            }
          >
            <ProjectInbox
              visible={inbox}
              active={active}
              doc={doc}
              loaded={loaded}
              onOpen={openPath}
              onClose={() => setInbox(false)}
              onCount={setInboxCount}
            />
          </Suspense>
        )}
        {doc && outline && !editing && (
          <Suspense fallback={null}>
            <Outline
              headings={doc.info.headings}
              loaded={loaded}
              close={() => setOutline(false)}
            />
          </Suspense>
        )}
        <main className="reading-scroll" ref={scrollRef}>
          {!doc ? (
            <div className="empty-state">
              <div className="page-symbol">
                <svg
                  width="42"
                  height="50"
                  viewBox="0 0 42 50"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 2h18l10 10v34H8V2Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M26 2v11h10M15 23h14M15 29h14M15 35h9"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </div>
              <p className="eyebrow">A LITTLE SPACE TO READ</p>
              <h1>Just you and the words.</h1>
              <p className="empty-description">
                Drop a Markdown file here.
                <br />
                Make yourself comfortable.
              </p>
              <button className="primary-button" onClick={() => void pick()}>
                <Icon name="open" />
                Open File<span>{modifier}O</span>
              </button>
              <button className="project-empty-action" onClick={showInbox}>
                Browse a project’s Markdown →
              </button>
              <p className="file-types">.md &nbsp; / &nbsp; .markdown</p>
            </div>
          ) : editing ? (
            <div className="editor-wrap">
              <div className="editor-heading">
                <span>MARKDOWN SOURCE</span>
                <button disabled={!dirty || busy} onClick={() => void save()}>
                  Save <kbd>{modifier}S</kbd>
                </button>
              </div>
              <textarea
                ref={editRef}
                key={doc.info.id}
                defaultValue={source}
                aria-label="Markdown source"
                className="source-editor"
                readOnly={busy}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={() => {
                  dirtyRef.current = true;
                  setDirty(true);
                }}
              />
            </div>
          ) : (
            <Suspense
              fallback={<p className="loading-document">Preparing document…</p>}
            >
              <DocumentReader
                doc={doc}
                openedAt={openedAt.current}
                onMetrics={(m) => {
                  setMetrics(m);
                  if (import.meta.env.DEV)
                    (
                      window as unknown as { __panelessMetrics: unknown }
                    ).__panelessMetrics = {
                      ...m,
                      readMs: doc.info.readMs,
                      parseMs: doc.info.parseMs,
                      bytes: doc.info.bytes,
                      renderMode:
                        doc.info.bytes > LARGE_DOCUMENT_BYTES
                          ? "bounded"
                          : "full",
                    };
                }}
                onDone={() => {
                  setLoaded(true);
                  const restore = pendingPosition.current;
                  pendingPosition.current = null;
                  if (restore?.path === doc.info.path)
                    requestAnimationFrame(() => {
                      if (docRef.current?.info.id !== doc.info.id) return;
                      if (restore.anchor) navigateToHeading(restore.anchor);
                      else scrollRef.current?.scrollTo(0, restore.top);
                    });
                }}
                onError={report}
                onLink={(url) => void openLink(url)}
              />
            </Suspense>
          )}
        </main>
      </div>
      <footer className="statusbar">
        <span>
          {busy
            ? "Opening…"
            : doc
              ? `${(doc.info.bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB`
              : "Markdown, beautifully at ease."}
        </span>
        <span>
          {doc
            ? editing
              ? dirty
                ? "Unsaved changes"
                : "Source"
              : loaded
                ? doc.info.bytes > LARGE_DOCUMENT_BYTES
                  ? "Large document · Sections load as you read"
                  : "Markdown"
                : "Rendering…"
            : "LOCAL FILES. QUIET MIND."}
        </span>
        {import.meta.env.DEV && metrics && (
          <span
            className="dev-timing"
            title="Development open-to-readable timing"
          >
            {Math.round(metrics.firstRenderMs)} ms
          </span>
        )}
      </footer>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="open" />
            <h2>Drop to open</h2>
            <p>Your next good read.</p>
          </div>
        </div>
      )}
    </div>
  );
}
