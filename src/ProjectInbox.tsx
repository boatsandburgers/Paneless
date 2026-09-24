import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { command, native, type OpenResult } from "./types";
import "./inbox.css";

type Entry = {
  root: string; // which folder this document belongs to
  path: string; // path relative to that folder's root
  title: string;
  preview: string;
  modified: number;
  changed: number;
  fingerprint: string;
  seen: string | null;
  pinned: boolean;
};
type Folder = {
  root: string;
  name: string;
  online: boolean;
  count: number;
  warnings: string[];
};
type Multi = {
  folders: Folder[];
  entries: Entry[];
  version: number;
};
type View = "Recent" | "Unread" | "Updated" | "Pinned";
const status = (entry: Entry) =>
  entry.seen === null
    ? "Unread"
    : entry.seen !== entry.fingerprint
      ? "Updated"
      : "Read";
function age(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
const norm = (p: string) => p.replaceAll("\\", "/");
const key = (e: { root: string; path: string }) => `${e.root}/${e.path}`;

// Persisted across launches: which folders were added, and which are toggled off.
function loadRoots(): string[] {
  try {
    return JSON.parse(localStorage.getItem("paneless-folders") || "[]");
  } catch {
    return [];
  }
}
function loadHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem("paneless-hidden") || "[]");
  } catch {
    return [];
  }
}

export default function ProjectInbox({
  visible,
  active,
  doc,
  loaded,
  onOpen,
  onClose,
  onCount,
}: {
  visible: boolean;
  active: boolean;
  doc: OpenResult | null;
  loaded: boolean;
  onOpen: (path: string) => Promise<unknown>;
  onClose: () => void;
  onCount: (count: number) => void;
}) {
  const [multi, setMulti] = useState<Multi | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(loadHidden()));
  const marked = useRef("");
  const [view, setView] = useState<View>("Recent");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const report = (e: unknown) => setError(String(e).replace(/^Error: /, ""));

  // Accept a newer snapshot; ignore stale ones (a slow refresh landing after a newer change).
  const accept = useCallback((next: Multi) => {
    setMulti((current) =>
      !current || next.version >= current.version ? next : current,
    );
  }, []);
  const saveRoots = (roots: string[]) => {
    try {
      localStorage.setItem("paneless-folders", JSON.stringify(roots));
    } catch {
      /* history is stored natively; the list is a convenience */
    }
  };
  // Persist the UNION of what was saved and what the backend now holds. A folder that failed to
  // open this session (a corrupt cache returns an error, so it is in neither the online nor the
  // offline list) must NOT be dropped from the saved list — it is retried next launch. Removal is
  // explicit (removeFolder / closeAll), so a genuinely-removed folder never returns via the union.
  const persistRoots = (m: Multi) => {
    saveRoots([...new Set([...loadRoots(), ...m.folders.map((f) => f.root)])]);
  };
  const persistHidden = (set: Set<string>) => {
    try {
      localStorage.setItem("paneless-hidden", JSON.stringify([...set]));
    } catch {
      /* optional */
    }
  };

  const addFolder = useCallback(async (path: string) => {
    setBusy(true);
    setError("");
    setHint("");
    try {
      const next = await command<Multi>("projects_add", { path });
      setMulti(next);
      persistRoots(next);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }, []);
  const removeFolder = async (root: string) => {
    try {
      const next = await command<Multi>("projects_remove", { root });
      setMulti(next);
      // Explicit removal — drop just this root, keeping any that failed to open this session.
      saveRoots(loadRoots().filter((r) => r !== root));
    } catch (e) {
      report(e);
    }
  };
  const toggleFolder = (root: string) => {
    setHidden((prev) => {
      const set = new Set(prev);
      set.has(root) ? set.delete(root) : set.add(root);
      persistHidden(set);
      return set;
    });
  };
  const pick = async () => {
    try {
      const path = native
        ? await (
            await import("@tauri-apps/plugin-dialog")
          ).open({
            directory: true,
            multiple: false,
            title: "Add a Markdown folder",
          })
        : window.prompt("Development preview: absolute folder path");
      if (typeof path === "string" && path) await addFolder(path);
    } catch (e) {
      report(e);
    }
  };

  useEffect(() => {
    let disposed = false;
    const cleanup: (() => void)[] = [];
    const register = (fn: () => void) => (disposed ? fn() : cleanup.push(fn));
    void (async () => {
      if (native) {
        const { listen } = await import("@tauri-apps/api/event");
        register(await listen<Multi>("inbox-updated", (e) => accept(e.payload)));
        register(await listen<string>("inbox-error", (e) => report(e.payload)));
      }
      // Re-open every folder the user had added, in order.
      for (const root of loadRoots()) {
        if (disposed) break;
        await addFolder(root);
      }
    })().catch(report);
    const timer = window.setInterval(() => tick((v) => v + 1), 60_000);
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      clearInterval(timer);
    };
  }, [accept, addFolder]);

  // Entries the user is currently looking at = those whose folder is not toggled off.
  const shown = useMemo(
    () => multi?.entries.filter((e) => !hidden.has(e.root)) || [],
    [multi, hidden],
  );
  const counts = useMemo(
    () => ({
      Recent: shown.length,
      Unread: shown.filter((e) => status(e) === "Unread").length,
      Updated: shown.filter((e) => status(e) === "Updated").length,
      Pinned: shown.filter((e) => e.pinned).length,
    }),
    [shown],
  );
  useEffect(() => onCount(counts.Unread + counts.Updated), [counts, onCount]);

  // The row for the currently-open document, found across all folders by root + relative path.
  const openEntry = useMemo(() => {
    if (!doc || !multi) return null;
    const full = norm(doc.info.path);
    return (
      multi.entries.find((e) => full === norm(e.root) + "/" + e.path) || null
    );
  }, [doc, multi]);
  // Mark only the revision actually rendered. A newer watcher update stays unread.
  useEffect(() => {
    if (
      !active ||
      !loaded ||
      !doc ||
      !openEntry ||
      openEntry.seen === doc.info.revision
    )
      return;
    const k = `${openEntry.root}:${doc.info.id}:${doc.info.revision}`;
    if (marked.current === k) return;
    marked.current = k;
    void command<Multi>("project_mark", {
      root: openEntry.root,
      path: openEntry.path,
      revision: doc.info.revision,
    })
      .then(accept)
      .catch(report);
  }, [active, loaded, doc, openEntry, accept]);

  const filtered = useMemo(
    () =>
      shown.filter(
        (entry) =>
          (view === "Recent" ||
            (view === "Pinned" ? entry.pinned : status(entry) === view)) &&
          `${entry.title} ${entry.path} ${entry.preview}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [shown, view, query],
  );
  useEffect(() => {
    setLimit(100);
    listRef.current?.scrollTo(0, 0);
  }, [view, query, hidden]);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      accept(await command<Multi>("project_refresh"));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const markAll = async () => {
    if (!multi) return;
    try {
      // Mark every currently-shown (online, not hidden) folder read.
      const roots = multi.folders
        .filter((f) => f.online && !hidden.has(f.root))
        .map((f) => f.root);
      let latest: Multi | null = null;
      for (const root of roots) {
        latest = await command<Multi>("project_mark", {
          root,
          path: null,
          revision: null,
        });
      }
      if (latest) accept(latest);
      setHint("Shown folders marked read.");
    } catch (e) {
      report(e);
    }
  };
  const pin = async (entry: Entry) => {
    try {
      accept(
        await command<Multi>("project_pin", {
          root: entry.root,
          path: entry.path,
          pinned: !entry.pinned,
        }),
      );
    } catch (e) {
      report(e);
    }
  };
  const closeAll = async () => {
    try {
      await command("project_close");
      setMulti(null);
      saveRoots([]);
      setBusy(false);
      setError("");
      setHint("");
    } catch (e) {
      report(e);
    }
  };

  const hasFolders = !!multi && multi.folders.length > 0;
  return (
    <aside className="inbox" aria-label="Project inbox" hidden={!visible}>
      <div className="inbox-heading">
        <span>PROJECT INBOX</span>
        <div className="inbox-heading-actions">
          {hasFolders && (
            <button
              className="icon-button"
              disabled={busy}
              title="Add a folder"
              aria-label="Add a folder"
              onClick={() => void pick()}
            >
              +
            </button>
          )}
          {hasFolders && (
            <button
              className="icon-button"
              disabled={busy}
              title="Check all document contents"
              aria-label="Refresh folders"
              onClick={() => void refresh()}
            >
              ↻
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Hide project inbox"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      {error && (
        <div className="inbox-error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss inbox error">
            ×
          </button>
        </div>
      )}
      {busy && (
        <div className="inbox-hint" role="status">
          Checking Markdown documents…
        </div>
      )}

      {!hasFolders ? (
        <div className="inbox-welcome">
          <div className="inbox-glyph">▤</div>
          <h2>A place for what’s next.</h2>
          <p>
            Add one or more folders. Plans, reports and documents from all of
            them appear here — see what’s new, then settle in to read.
          </p>
          <button
            disabled={busy}
            className="primary-button"
            onClick={() => void pick()}
          >
            Add a folder
          </button>
          <p className="inbox-small">
            Local files. Personal reading history.
            <br />
            Your folders stay untouched.
          </p>
        </div>
      ) : (
        <>
          {/* Folder toggles: one per added folder; click to show/hide, × to remove. */}
          <div className="inbox-folders" aria-label="Folders">
            {multi!.folders.map((f) => (
              <span
                key={f.root}
                className={`inbox-folder ${hidden.has(f.root) ? "off" : ""} ${
                  f.online ? "" : "offline"
                }`}
              >
                <button
                  className="inbox-folder-toggle"
                  aria-pressed={!hidden.has(f.root)}
                  title={
                    f.online
                      ? `${f.root} — ${f.count} document${f.count === 1 ? "" : "s"}`
                      : `${f.root} — currently unavailable`
                  }
                  onClick={() => toggleFolder(f.root)}
                >
                  {f.name}
                  {!f.online && <span className="inbox-folder-warn"> ⚠</span>}
                </button>
                <button
                  className="inbox-folder-remove"
                  aria-label={`Remove ${f.name}`}
                  title={`Remove ${f.name}`}
                  onClick={() => void removeFolder(f.root)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          <div className="inbox-tabs" aria-label="Document views">
            {(["Recent", "Unread", "Updated", "Pinned"] as View[]).map(
              (item) => (
                <button
                  key={item}
                  aria-pressed={view === item}
                  className={view === item ? "active" : ""}
                  onClick={() => setView(item)}
                >
                  {item}
                  <span className={counts[item] === 0 ? "zero-count" : ""}>
                    {counts[item]}
                  </span>
                </button>
              ),
            )}
          </div>
          <div className="inbox-filters">
            <input
              aria-label="Filter documents"
              placeholder="Find a document…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div
            className="inbox-list"
            ref={listRef}
            aria-label={`${view} documents`}
            onKeyDown={(event) => {
              if (
                event.target instanceof HTMLButtonElement &&
                event.target.classList.contains("inbox-open") &&
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const buttons = Array.from(
                  listRef.current!.querySelectorAll<HTMLButtonElement>(
                    ".inbox-open",
                  ),
                );
                const current = buttons.indexOf(event.target);
                const index =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            buttons.length - 1,
                            current + (event.key === "ArrowDown" ? 1 : -1),
                          ),
                        );
                buttons[index]?.focus();
              }
            }}
          >
            {!filtered.length && (
              <div className="inbox-empty">
                <strong>
                  {query
                    ? "No matching documents"
                    : view === "Unread"
                      ? "You’re all caught up."
                      : view === "Updated"
                        ? "Nothing has changed."
                        : view === "Pinned"
                          ? "Keep the essentials close."
                          : "No Markdown in the shown folders."}
                </strong>
                <p>
                  {view === "Pinned"
                    ? "Pin a board, plan, or reference from Recent."
                    : "New and changed documents will appear here."}
                </p>
              </div>
            )}
            {filtered.slice(0, limit).map((entry) => (
              <div
                key={key(entry)}
                className={`inbox-row ${openEntry && key(entry) === key(openEntry) ? "current" : ""}`}
              >
                <button
                  className="inbox-open"
                  aria-current={
                    openEntry && key(entry) === key(openEntry)
                      ? "page"
                      : undefined
                  }
                  onClick={() => {
                    void onOpen(`${entry.root}/${entry.path}`).then((opened) => {
                      if (opened && window.innerWidth <= 760) onClose();
                    });
                  }}
                >
                  <span className="inbox-row-title">
                    <strong>{entry.title}</strong>
                    {status(entry) !== "Read" && (
                      <span
                        className={`inbox-state ${status(entry).toLowerCase()}`}
                      >
                        {status(entry)}
                      </span>
                    )}
                  </span>
                  {entry.preview && (
                    <span className="inbox-preview">{entry.preview}</span>
                  )}
                  <span className="inbox-row-meta">
                    <span
                      className="inbox-path"
                      title={`${entry.root}/${entry.path}`}
                    >
                      {entry.path.split("/").length > 2
                        ? "…/" + entry.path.split("/").slice(-2).join("/")
                        : entry.path}
                    </span>
                    <time
                      dateTime={new Date(entry.changed).toISOString()}
                      title={`Content change: ${new Date(entry.changed).toLocaleString()}`}
                    >
                      {age(entry.changed)}
                    </time>
                  </span>
                </button>
                <button
                  className={`inbox-pin ${entry.pinned ? "pinned" : ""}`}
                  aria-label={`${entry.pinned ? "Unpin" : "Pin"} ${entry.title}`}
                  aria-pressed={entry.pinned}
                  onClick={() => void pin(entry)}
                >
                  {entry.pinned ? "★" : "☆"}
                </button>
              </div>
            ))}
            {filtered.length > limit && (
              <button
                className="inbox-more"
                onClick={() => setLimit((n) => n + 100)}
              >
                Show 100 more · {filtered.length - limit} remaining
              </button>
            )}
          </div>
          <div className="inbox-footer">
            <div>
              <span title="Existing documents start read. New discoveries appear in Unread.">
                {filtered.length} document{filtered.length === 1 ? "" : "s"}
              </span>
            </div>
            {hint && <p>{hint}</p>}
            {multi!.folders
              .flatMap((f) =>
                f.warnings.map((warning, i) => ({ warning, key: `${f.root}:${i}` })),
              )
              .map(({ warning, key }) => (
                <p className="inbox-warning" key={key}>
                  {warning}
                </p>
              ))}
            <div className="inbox-footer-actions">
              <button
                className="inbox-action"
                disabled={!counts.Unread && !counts.Updated}
                onClick={() => void markAll()}
              >
                Mark all read
              </button>
              <button className="inbox-action" onClick={() => void closeAll()}>
                Remove all folders
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
