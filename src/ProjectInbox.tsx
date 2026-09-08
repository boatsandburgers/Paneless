import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { command, native, type OpenResult } from "./types";
import "./inbox.css";

type Entry = {
  path: string;
  title: string;
  preview: string;
  modified: number;
  changed: number;
  fingerprint: string;
  seen: string | null;
  pinned: boolean;
};
type Project = {
  root: string;
  name: string;
  version: number;
  session: string;
  entries: Entry[];
  warnings: string[];
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
  const [project, setProject] = useState<Project | null>(null);
  const marked = useRef("");
  const [view, setView] = useState<View>("Recent");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [limit, setLimit] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [, tick] = useState(0);
  const switching = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const accept = useCallback((next: Project) => {
    setProject((current) =>
      current?.root === next.root &&
      current.session === next.session &&
      next.version >= current.version
        ? next
        : current,
    );
  }, []);
  const report = (e: unknown) => setError(String(e).replace(/^Error: /, ""));
  const openProject = useCallback(async (path: string) => {
    const attempt = ++switching.current;
    setBusy(true);
    setError("");
    setHint("");
    try {
      const next = await command<Project>("project_open", { path });
      if (attempt !== switching.current) return;
      setProject(next);
      setFolder("");
      setQuery("");
      setView("Recent");
      try {
        localStorage.setItem("paneless-project", next.root);
      } catch {
        /* history is stored natively */
      }
      setHint("");
    } catch (e) {
      if (attempt === switching.current) report(e);
    } finally {
      if (attempt === switching.current) setBusy(false);
    }
  }, []);
  const pick = async () => {
    try {
      const path = native
        ? await (
            await import("@tauri-apps/plugin-dialog")
          ).open({
            directory: true,
            multiple: false,
            title: "Open a Markdown project",
          })
        : window.prompt("Development preview: absolute project folder path");
      if (typeof path === "string" && path) await openProject(path);
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
        register(
          await listen<Project>("project-updated", (e) => accept(e.payload)),
        );
        register(
          await listen<string>("project-error", (e) => report(e.payload)),
        );
      }
      let path: string | null = null;
      try {
        path = localStorage.getItem("paneless-project");
      } catch {
        /* optional */
      }
      if (path && !disposed) await openProject(path);
    })().catch(report);
    const timer = window.setInterval(() => tick((v) => v + 1), 60_000);
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
      clearInterval(timer);
    };
  }, [accept, openProject]);
  const counts = useMemo(
    () => ({
      Recent: project?.entries.length || 0,
      Unread:
        project?.entries.filter((e) => status(e) === "Unread").length || 0,
      Updated:
        project?.entries.filter((e) => status(e) === "Updated").length || 0,
      Pinned: project?.entries.filter((e) => e.pinned).length || 0,
    }),
    [project],
  );
  useEffect(() => onCount(counts.Unread + counts.Updated), [counts, onCount]);
  // Mark only the revision actually rendered. A newer watcher update stays unread.
  const relative =
    doc &&
    project &&
    doc.info.path
      .replaceAll("\\", "/")
      .startsWith(project.root.replaceAll("\\", "/") + "/")
      ? doc.info.path.replaceAll("\\", "/").slice(project.root.length + 1)
      : null;
  const entry = project?.entries.find((e) => e.path === relative);
  useEffect(() => {
    if (
      !active ||
      !loaded ||
      !doc ||
      !entry ||
      !project ||
      entry.seen === doc.info.revision
    )
      return;
    const key = `${project.session}:${doc.info.id}:${doc.info.revision}`;
    if (marked.current === key) return;
    marked.current = key;
    void command<Project>("project_mark", {
      root: project.root,
      path: entry.path,
      revision: doc.info.revision,
    })
      .then(accept)
      .catch(report);
  }, [
    active,
    loaded,
    doc,
    entry?.path,
    entry?.seen,
    project?.root,
    project?.session,
    accept,
  ]);
  const folders = useMemo(
    () =>
      [
        ...new Set(
          project?.entries.flatMap((e) => {
            const parts = e.path.split("/");
            parts.pop();
            return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
          }),
        ),
      ].sort(),
    [project],
  );
  const filtered = useMemo(
    () =>
      project?.entries.filter(
        (entry) =>
          (view === "Recent" ||
            (view === "Pinned" ? entry.pinned : status(entry) === view)) &&
          (!folder || entry.path.startsWith(folder + "/")) &&
          `${entry.title} ${entry.path} ${entry.preview}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) || [],
    [project, view, folder, query],
  );
  useEffect(() => {
    setLimit(100);
    listRef.current?.scrollTo(0, 0);
  }, [view, folder, query]);
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      accept(await command<Project>("project_refresh"));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const markAll = async () => {
    if (!project) return;
    try {
      accept(
        await command<Project>("project_mark", {
          root: project.root,
          path: null,
          revision: null,
        }),
      );
      setHint("All project documents marked read.");
    } catch (e) {
      report(e);
    }
  };
  const pin = async (entry: Entry) => {
    if (!project) return;
    try {
      accept(
        await command<Project>("project_pin", {
          root: project.root,
          path: entry.path,
          pinned: !entry.pinned,
        }),
      );
    } catch (e) {
      report(e);
    }
  };
  const closeProject = async () => {
    ++switching.current;
    try {
      await command("project_close");
      setProject(null);
      setBusy(false);
      setError("");
      setHint("");
      try {
        localStorage.removeItem("paneless-project");
      } catch {
        /* optional */
      }
    } catch (e) {
      report(e);
    }
  };
  return (
    <aside className="inbox" aria-label="Project inbox" hidden={!visible}>
      <div className="inbox-heading">
        <span>PROJECT INBOX</span>
        <button
          className="icon-button"
          aria-label="Hide project inbox"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="inbox-project">
        <button
          disabled={busy}
          className="project-name"
          title={project?.root || "Choose a folder"}
          onClick={() => void pick()}
        >
          <span className="project-name-text">
            {project?.name || "Open a project"}
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        {project && (
          <button
            disabled={busy}
            className="inbox-refresh"
            title="Check all document contents"
            aria-label="Refresh project"
            onClick={() => void refresh()}
          >
            ↻
          </button>
        )}
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
      {!project ? (
        <div className="inbox-welcome">
          <div className="inbox-glyph">▤</div>
          <h2>A place for what’s next.</h2>
          <p>
            Plans, reports, and documents from your project. See what’s new,
            then settle in to read.
          </p>
          <button
            disabled={busy}
            className="primary-button"
            onClick={() => void pick()}
          >
            Choose Project Folder
          </button>
          <p className="inbox-small">
            Local files. Personal reading history.
            <br />
            Your repository stays untouched.
          </p>
        </div>
      ) : (
        <>
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
              aria-label="Filter project documents"
              placeholder="Find a document…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="Project folder filter"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value="">All folders</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path}/
                </option>
              ))}
            </select>
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
                  {query || folder
                    ? "No matching documents"
                    : view === "Unread"
                      ? "You’re all caught up."
                      : view === "Updated"
                        ? "Nothing has changed."
                        : view === "Pinned"
                          ? "Keep the essentials close."
                          : "No Markdown here yet."}
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
                key={entry.path}
                className={`inbox-row ${entry.path === relative ? "current" : ""}`}
              >
                <button
                  className="inbox-open"
                  aria-current={entry.path === relative ? "page" : undefined}
                  onClick={() => {
                    void onOpen(`${project.root}/${entry.path}`).then(
                      (opened) => {
                        if (opened && window.innerWidth <= 760) onClose();
                      },
                    );
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
                    <span className="inbox-path" title={entry.path}>
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
              <button
                disabled={!counts.Unread && !counts.Updated}
                onClick={() => void markAll()}
              >
                Mark all read
              </button>
            </div>
            {hint && <p>{hint}</p>}
            {project.warnings.map((warning) => (
              <p className="inbox-warning" key={warning}>
                {warning}
              </p>
            ))}
            <button className="inbox-stop" onClick={() => void closeProject()}>
              Close project
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
