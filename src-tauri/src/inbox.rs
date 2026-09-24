use crate::project::{Entry, Project, Snapshot};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

/// One open root. Its `project` mutex is held only while THAT folder is scanned/marked/pinned,
/// so a slow root (an SMB share timing out) locks only itself. `view` is a cached snapshot,
/// refreshed under the `project` lock after every mutation and read by `merged` WITHOUT touching
/// `project` — so the merged view (and the UI) never waits behind another folder's scan.
struct Open {
    root: PathBuf,
    project: Mutex<Project>,
    view: Mutex<Snapshot>,
}
impl Open {
    fn new(project: Project) -> Arc<Self> {
        let root = project.root.clone();
        let view = project.snapshot();
        Arc::new(Self {
            root,
            project: Mutex::new(project),
            view: Mutex::new(view),
        })
    }
    /// Read the cached snapshot (brief lock; never blocks behind a scan of this or any folder).
    fn view(&self) -> Snapshot {
        self.view.lock().unwrap().clone()
    }
    /// Rescan this folder, then refresh its cached view. Returns the new directory set to watch.
    /// The view is written WHILE `project` is held, so the order of view-writes is the order of
    /// mutations — a slow writer can no longer overwrite a newer view. `view` is taken only for
    /// that instant assignment (the scan is already done), so `merged`/`current` never wait behind
    /// it. Lock order is always `project` before `view`; nothing takes `view` then `project`.
    fn scan(
        &self,
        invalidated: &HashSet<PathBuf>,
        force: bool,
    ) -> Result<HashSet<PathBuf>, String> {
        let mut project = self.project.lock().unwrap();
        project.scan(invalidated, force)?;
        let directories = project.directories.clone();
        *self.view.lock().unwrap() = project.snapshot();
        Ok(directories)
    }
    fn mark(&self, path: Option<&str>, revision: Option<&str>) -> Result<(), String> {
        let mut project = self.project.lock().unwrap();
        project.mark(path, revision)?;
        *self.view.lock().unwrap() = project.snapshot();
        Ok(())
    }
    fn pin(&self, path: &str, pinned: bool) -> Result<(), String> {
        let mut project = self.project.lock().unwrap();
        project.pin(path, pinned)?;
        *self.view.lock().unwrap() = project.snapshot();
        Ok(())
    }
}

/// A watched project's OS watcher plus the directory set it currently watches. One per open root.
struct Watched {
    root: PathBuf,
    watcher: notify::RecommendedWatcher,
    directories: HashSet<PathBuf>,
}

/// The multi-folder inbox: several independent `Project` roots merged into one view.
/// Each root keeps its OWN read/unread history (a per-root cache file) and its OWN watcher;
/// the inbox only merges their snapshots. A root whose folder is unavailable (e.g. an
/// unmounted network share) stays in `offline` — never forgotten, just skipped — and is
/// retried on refresh. The `projects` vec lock is only ever held briefly (clone the `Arc`s,
/// read roots, push/retain); the long work happens under each `Open`'s own lock.
#[derive(Default)]
pub struct Inbox {
    projects: Mutex<Vec<Arc<Open>>>,
    watchers: Mutex<Vec<Watched>>,
    offline: Mutex<Vec<PathBuf>>,
    epoch: AtomicU64,
}
impl Inbox {
    /// Which open root actually contains this document path (for the handoff workspace).
    /// Reads roots only — never locks a project, so it stays responsive during a slow scan.
    pub fn root_for(&self, path: &Path) -> Option<PathBuf> {
        self.projects
            .lock()
            .unwrap()
            .iter()
            .map(|o| o.root.clone())
            .find(|root| path.starts_with(root))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub root: String,
    pub name: String,
    pub online: bool,
    pub count: usize,
    pub warnings: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedEntry {
    pub root: String,
    #[serde(flatten)]
    pub entry: Entry,
}
/// The whole inbox in one payload: the folder list (for the toggle UI) plus every document
/// from every open folder, each tagged with its root so the UI can filter and route.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Multi {
    pub folders: Vec<Folder>,
    pub entries: Vec<MergedEntry>,
    pub version: u64,
}

fn storage(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects"))
}

/// Build the merged payload from the current projects + offline roots. Reads each folder's
/// cached `view`, so it never blocks behind a scan.
fn merged(opens: &[Arc<Open>], offline: &[PathBuf], version: u64) -> Multi {
    let mut folders = Vec::new();
    let mut entries = Vec::new();
    for open in opens {
        let snapshot = open.view();
        folders.push(Folder {
            root: snapshot.root.clone(),
            name: snapshot.name.clone(),
            online: true,
            count: snapshot.entries.len(),
            warnings: snapshot.warnings.clone(),
        });
        for entry in snapshot.entries {
            entries.push(MergedEntry {
                root: snapshot.root.clone(),
                entry,
            });
        }
    }
    for root in offline {
        folders.push(Folder {
            root: root.to_string_lossy().into(),
            name: root
                .file_name()
                .unwrap_or(root.as_os_str())
                .to_string_lossy()
                .into(),
            online: false,
            count: 0,
            warnings: vec![
                "This folder is currently unavailable. Use Refresh when it is back.".into(),
            ],
        });
    }
    // One combined ordering, newest first — the same rule a single folder uses.
    entries.sort_by(|a, b| {
        b.entry
            .changed
            .cmp(&a.entry.changed)
            .then_with(|| a.entry.path.cmp(&b.entry.path))
    });
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Multi {
        folders,
        entries,
        version,
    }
}

/// Snapshot the current state (safe to call from a command or a watcher thread).
/// Every call advances the epoch, so each payload it produces carries a unique, increasing
/// version. The UI keeps the highest version and drops one that lands out of order — a slow
/// background rescan can no longer overwrite a fresh pin/mark just by arriving late. Only the
/// brief vec/offline locks are taken here; the per-folder `view` locks inside `merged` are brief.
fn current(state: &Inbox) -> Multi {
    let version = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let opens: Vec<Arc<Open>> = state.projects.lock().unwrap().clone();
    let offline: Vec<PathBuf> = state.offline.lock().unwrap().clone();
    merged(&opens, &offline, version)
}

/// Install/remove OS watches so `watched.directories` equals the project's current directory set.
fn sync_watch(watched: &mut Watched, want: &HashSet<PathBuf>) {
    for path in watched.directories.difference(want) {
        let _ = watched.watcher.unwatch(path);
    }
    let mut now: HashSet<PathBuf> = watched.directories.intersection(want).cloned().collect();
    for path in want.difference(&watched.directories) {
        if watched
            .watcher
            .watch(path, RecursiveMode::NonRecursive)
            .is_ok()
        {
            now.insert(path.clone());
        }
    }
    watched.directories = now;
}

/// Move a specific open folder offline: drop it everywhere (projects + its watcher) and remember
/// it. Its drain thread self-exits once its watcher is gone. Matched by `Arc` identity, not by
/// root string, and a no-op if this exact folder is no longer the live one — so a scan that
/// finishes AFTER the user removed the folder cannot resurrect it as an offline chip.
fn fell_offline(state: &Inbox, open: &Arc<Open>) {
    let removed = {
        let mut projects = state.projects.lock().unwrap();
        let before = projects.len();
        projects.retain(|o| !Arc::ptr_eq(o, open));
        before != projects.len()
    };
    if !removed {
        return; // already removed (or replaced) by the user — do not bring it back
    }
    state
        .watchers
        .lock()
        .unwrap()
        .retain(|w| w.root != open.root);
    let mut offline = state.offline.lock().unwrap();
    if !offline.iter().any(|r| r == &open.root) {
        offline.push(open.root.clone());
    }
}

/// Attach an already-opened project: set up its watcher, its drain thread, and register it.
/// Used by `projects_add` (`retry_key: None`) and the offline-retry in `project_refresh`
/// (`retry_key: Some(offline key)`). For a retry, the folder is committed only if that offline key
/// is still present at the push — so a `projects_remove` during the slow, per-directory watch
/// setup cannot resurrect a folder the user just removed. No async nesting.
fn attach(
    app: &tauri::AppHandle,
    project: Project,
    retry_key: Option<PathBuf>,
) -> Result<(), String> {
    let state = app.state::<Inbox>();
    let root = project.root.clone();
    // Already open (e.g. an offline retry whose typed path canonicalised to a live root)? Just
    // clear any offline entry pointing here — never attach a second Project for the same root.
    if state
        .projects
        .lock()
        .unwrap()
        .iter()
        .any(|o| o.root == root)
    {
        state.offline.lock().unwrap().retain(|r| r != &root);
        return Ok(());
    }
    // Refuse a folder that overlaps an already-open one (a nested parent/child would list the same
    // file twice). Also closes the back door where an offline PARENT is retried after its CHILD was
    // already added: `projects_add`'s own nesting check saw an empty `projects` for the parent then.
    if let Some(clash) = state
        .projects
        .lock()
        .unwrap()
        .iter()
        .find(|o| root.starts_with(&o.root) || o.root.starts_with(&root))
        .map(|o| o.root.to_string_lossy().into_owned())
    {
        return Err(format!(
            "This folder overlaps an open folder ({clash}). Pick a folder that does not contain the other."
        ));
    }

    // Build the watcher FIRST. If it fails, the folder stays wherever it was (its offline entry
    // intact) instead of vanishing from every list.
    // A watcher for THIS root; its channel feeds a drain thread that rescans just this project
    // and re-emits the whole merged view.
    let (tx, rx) = mpsc::channel();
    let watch_root = root.clone();
    let watcher = notify::recommended_watcher(
        move |event: Result<notify::Event, notify::Error>| match event {
            Ok(event)
                if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() =>
            {
                let paths: Vec<_> = event
                    .paths
                    .into_iter()
                    .filter(|p| !crate::project::ignored(p, &watch_root))
                    .collect();
                if !paths.is_empty() {
                    let _ = tx.send(paths);
                }
            }
            Ok(_) => {}
            Err(_) => {
                let _ = tx.send(Vec::new());
            }
        },
    )
    .map_err(|e| e.to_string())?;

    let mut watched = Watched {
        root: root.clone(),
        watcher,
        directories: HashSet::new(),
    };
    sync_watch(&mut watched, &project.directories);
    {
        // Commit the whole join under ONE `projects` hold: the "still wanted" check, the push,
        // leaving the offline list, and registering the watcher. `projects_remove` also takes
        // `projects` first, so the two are atomic w.r.t. each other — there is no interval where a
        // remove can half-apply against a half-committed folder (resurrect it, or orphan a watcher).
        // Only one of `offline`/`watchers` is held at a time under `projects`; order is always
        // `projects` → {offline | watchers}, so no lock cycle exists.
        let mut projects = state.projects.lock().unwrap();
        if let Some(key) = &retry_key {
            // The user removed this offline folder while we were opening/watching it → discard it,
            // never bring it back. `projects_remove` already cleared the key.
            if !state.offline.lock().unwrap().iter().any(|r| r == key) {
                return Ok(());
            }
        }
        // A concurrent add of the same root won the race — do not double-add.
        if projects.iter().any(|o| o.root == root) {
            return Ok(());
        }
        projects.push(Open::new(project));
        state.offline.lock().unwrap().retain(|r| r != &root);
        state.watchers.lock().unwrap().push(watched);
    }
    state.epoch.fetch_add(1, Ordering::SeqCst);

    let drain_app = app.clone();
    let drain_root = root;
    std::thread::spawn(move || {
        while let Ok(paths) = rx.recv() {
            let mut invalidated: HashSet<_> = paths.into_iter().collect();
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2) {
                match rx.recv_timeout(Duration::from_millis(600)) {
                    Ok(more) => invalidated.extend(more),
                    Err(_) => break,
                }
            }
            let state = drain_app.state::<Inbox>();
            // Find our folder (brief vec lock, clone the Arc, release) and scan it under its OWN
            // lock — so this rescan never blocks the vec or another folder.
            let open = state
                .projects
                .lock()
                .unwrap()
                .iter()
                .find(|o| o.root == drain_root)
                .cloned();
            let Some(open) = open else {
                break; // this root was removed → stop the thread
            };
            match open.scan(&invalidated, false) {
                Ok(directories) => {
                    if let Some(w) = state
                        .watchers
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .find(|w| w.root == drain_root)
                    {
                        sync_watch(w, &directories);
                    }
                    let _ = drain_app.emit("inbox-updated", current(&state));
                }
                Err(e) => {
                    // A local folder deleted while open: move it offline (its watcher drops, so
                    // this thread exits on the next recv) instead of leaving stale documents that
                    // fail on click. A transient read error keeps the folder and surfaces the text.
                    if std::fs::read_dir(&drain_root).is_err() {
                        fell_offline(&state, &open);
                        let _ = drain_app.emit("inbox-updated", current(&state));
                    } else {
                        let _ = drain_app.emit("inbox-error", e);
                    }
                }
            }
        }
    });
    Ok(())
}

/// Add one folder as a root. Success → indexed + watched + merged into the view. If the folder is
/// unavailable it is remembered as offline rather than rejected. Re-adding an existing root is a no-op.
#[tauri::command]
pub async fn projects_add(app: tauri::AppHandle, path: String) -> Result<Multi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let requested = std::path::Path::new(&path);
        let canonical = requested.canonicalize().ok();
        if let Some(canonical) = &canonical {
            let projects = state.projects.lock().unwrap();
            if projects.iter().any(|o| &o.root == canonical) {
                drop(projects);
                return Ok(current(&state));
            }
            // Overlapping roots would list the same file under two folders, with split
            // read-state and an unread count that can never reach zero. Refuse rather than
            // silently double it.
            if let Some(clash) = projects
                .iter()
                .find(|o| canonical.starts_with(&o.root) || o.root.starts_with(canonical))
            {
                let clash = clash.root.to_string_lossy().into_owned();
                drop(projects);
                return Err(format!(
                    "This folder overlaps an open folder ({clash}). Pick a folder that does not contain the other."
                ));
            }
        }
        match Project::open(requested, &storage(&app)?) {
            Ok(project) => attach(&app, project, None)?,
            Err(e) => {
                // ONLY an unreachable path becomes an offline chip. A path that DOES resolve but
                // failed to open — a corrupt history cache, an unwritable store, or a file picked
                // as a folder — returns the real error; it is never silently relabelled
                // "unavailable" (Invariant #11). Unreachable = canonicalize fails.
                if requested.canonicalize().is_ok() {
                    return Err(e);
                }
                let key = canonical.unwrap_or_else(|| requested.to_path_buf());
                let mut offline = state.offline.lock().unwrap();
                if !offline.contains(&key) {
                    offline.push(key);
                }
                state.epoch.fetch_add(1, Ordering::SeqCst);
            }
        }
        Ok(current(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove a folder from the inbox (its watcher drops → its drain thread self-exits). Reading
/// history on disk is kept, so re-adding it later restores the read/unread state.
#[tauri::command]
pub async fn projects_remove(app: tauri::AppHandle, root: String) -> Result<Multi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let target = std::path::Path::new(&root);
        let canonical = target.canonicalize().ok();
        let matches = |r: &Path| r == target || Some(r) == canonical.as_deref();
        state.epoch.fetch_add(1, Ordering::SeqCst);
        {
            // Remove from all three lists under ONE `projects` hold, so a concurrent attach commit
            // (which also takes `projects` first) cannot interleave and half-resurrect the folder
            // or leave an orphan watcher. Order projects → watchers → offline nests nowhere else.
            let mut projects = state.projects.lock().unwrap();
            projects.retain(|o| !matches(&o.root));
            state.watchers.lock().unwrap().retain(|w| !matches(&w.root));
            state.offline.lock().unwrap().retain(|r| !matches(r));
        }
        Ok(current(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Refresh every open folder, and retry the offline ones (a network share may be back).
/// Each folder is rescanned under its OWN lock (the vec lock is not held during a scan), so a
/// slow root does not block the others or the UI. A folder that has disappeared is moved offline
/// instead of left showing stale documents.
#[tauri::command]
pub async fn project_refresh(app: tauri::AppHandle) -> Result<Multi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        // Retry offline roots — a network share may be back. Project::open runs outside any lock.
        let retry: Vec<PathBuf> = state.offline.lock().unwrap().clone();
        for root in retry {
            // If this offline entry already resolves to an open folder, drop it without a second
            // Project::open — that open would scan and persist over the LIVE project's own cache
            // file, and could revert a mark written between its read and its persist.
            if let Ok(canonical) = root.canonicalize() {
                if state
                    .projects
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|o| o.root == canonical)
                {
                    state.offline.lock().unwrap().retain(|r| r != &root);
                    continue;
                }
            }
            match Project::open(&root, &storage(&app)?) {
                // attach commits only if this offline key is still present at its push, so a remove
                // during the (slow) open+watch cannot resurrect the folder.
                Ok(project) => match attach(&app, project, Some(root.clone())) {
                    // Attached, or discarded because the user removed it mid-open → drop the key.
                    Ok(()) => {
                        state.offline.lock().unwrap().retain(|r| r != &root);
                    }
                    // Overlaps an already-open folder: surface it and KEEP the chip so the user
                    // has a control to remove it, instead of it vanishing and returning on restart.
                    Err(e) => {
                        let _ = app.emit("inbox-error", e);
                    }
                },
                Err(_) => {} // still unreachable → leave it offline for the next refresh
            }
        }
        // Rescan each open folder under its own lock (vec lock only briefly, to clone the Arcs).
        let opens: Vec<Arc<Open>> = state.projects.lock().unwrap().clone();
        for open in opens {
            match open.scan(&HashSet::new(), true) {
                Ok(directories) => {
                    if let Some(w) = state
                        .watchers
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .find(|w| w.root == open.root)
                    {
                        sync_watch(w, &directories);
                    }
                }
                Err(_) => {
                    // Re-probe: a scan can also fail on a transient write error. Only a folder
                    // that is genuinely unreachable moves to the offline list.
                    if std::fs::read_dir(&open.root).is_err() {
                        fell_offline(&state, &open);
                    }
                }
            }
        }
        Ok(current(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mark read — routed to the folder that owns `root`.
#[tauri::command]
pub async fn project_mark(
    app: tauri::AppHandle,
    root: String,
    path: Option<String>,
    revision: Option<String>,
) -> Result<Multi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        // Find the folder (brief vec lock), then mutate it under its own lock.
        let open = state
            .projects
            .lock()
            .unwrap()
            .iter()
            .find(|o| o.root == std::path::Path::new(&root))
            .cloned()
            .ok_or("That folder is no longer open.")?;
        open.mark(path.as_deref(), revision.as_deref())?;
        Ok(current(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pin/unpin — routed to the folder that owns `root`.
#[tauri::command]
pub async fn project_pin(
    app: tauri::AppHandle,
    root: String,
    path: String,
    pinned: bool,
) -> Result<Multi, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let open = state
            .projects
            .lock()
            .unwrap()
            .iter()
            .find(|o| o.root == std::path::Path::new(&root))
            .cloned()
            .ok_or("That folder is no longer open.")?;
        open.pin(&path, pinned)?;
        Ok(current(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Close everything (drops all watchers → all drain threads self-exit).
#[tauri::command]
pub fn project_close(state: tauri::State<Inbox>) {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.projects.lock().unwrap().clear();
    state.watchers.lock().unwrap().clear();
    state.offline.lock().unwrap().clear();
}

// The `#[tauri::command]` fns need a running app and are not covered here. Everything below
// exercises the pure core — `Open` and `merged` — which is what the commands compose.
#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::UNIX_EPOCH};

    const UNAVAILABLE: &str = "This folder is currently unavailable. Use Refresh when it is back.";

    /// A project root as a NAMED subfolder of a tempdir (tempdir names are random `.tmpXXXX`,
    /// and the folder name is what the tests below sort and display).
    fn root(base: &Path, name: &str) -> PathBuf {
        let dir = base.join(name);
        fs::create_dir(&dir).unwrap();
        dir
    }
    fn open(dir: &Path, storage: &Path) -> Arc<Open> {
        Open::new(Project::open(dir, storage).unwrap())
    }
    /// On first scan a document's `changed` is its mtime, so a pinned mtime makes ordering
    /// deterministic instead of depending on how fast the test wrote two files.
    fn write_with_mtime(path: &Path, text: &str, secs: u64) {
        fs::write(path, text).unwrap();
        fs::File::open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(secs)))
            .unwrap();
    }
    fn canonical(dir: &Path) -> String {
        dir.canonicalize().unwrap().to_string_lossy().into()
    }
    fn entry<'a>(snapshot: &'a Snapshot, path: &str) -> &'a Entry {
        snapshot.entries.iter().find(|e| e.path == path).unwrap()
    }

    #[test]
    fn merged_tags_every_entry_with_its_owning_root_and_lists_every_folder() {
        let base = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let alpha = root(base.path(), "alpha");
        let beta = root(base.path(), "beta");
        fs::write(alpha.join("a.md"), "# A").unwrap();
        fs::write(beta.join("b.md"), "# B").unwrap();
        let a = open(&alpha, storage.path());
        let b = open(&beta, storage.path());

        let multi = merged(&[a, b], &[], 1);

        assert_eq!(multi.version, 1);
        assert_eq!(multi.folders.len(), 2);
        assert!(multi.folders.iter().all(|f| f.online));
        let names: Vec<&str> = multi.folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["alpha", "beta"]);
        assert!(multi.folders.iter().all(|f| f.count == 1));
        assert_eq!(multi.entries.len(), 2);
        // The root tag is what the UI routes a click by: a wrong tag opens the wrong file, or
        // none. So each tag must be the folder the file physically lives in.
        for e in &multi.entries {
            assert!(
                Path::new(&e.root).join(&e.entry.path).is_file(),
                "{} is tagged with a root that does not contain it: {}",
                e.entry.path,
                e.root
            );
        }
        let a_entry = multi
            .entries
            .iter()
            .find(|e| e.entry.path == "a.md")
            .unwrap();
        let b_entry = multi
            .entries
            .iter()
            .find(|e| e.entry.path == "b.md")
            .unwrap();
        assert_eq!(a_entry.root, canonical(&alpha));
        assert_eq!(b_entry.root, canonical(&beta));
        assert!(multi.folders.iter().any(|f| f.root == canonical(&alpha)));
        assert!(multi.folders.iter().any(|f| f.root == canonical(&beta)));
    }

    #[test]
    fn merged_lists_an_offline_root_as_an_empty_offline_folder_with_the_unavailable_warning() {
        let base = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let live = root(base.path(), "live");
        fs::write(live.join("doc.md"), "# Doc").unwrap();
        let open_live = open(&live, storage.path());
        // An unmounted share: the path is remembered but nothing can be read from it.
        let missing = base.path().join("Missing Share");

        let multi = merged(&[open_live], &[missing.clone()], 7);

        assert_eq!(multi.version, 7);
        assert_eq!(multi.folders.len(), 2);
        let offline = multi.folders.iter().find(|f| !f.online).unwrap();
        assert_eq!(offline.root, missing.to_string_lossy());
        assert_eq!(offline.name, "Missing Share");
        assert_eq!(offline.count, 0);
        assert_eq!(offline.warnings, [UNAVAILABLE]);
        let online = multi.folders.iter().find(|f| f.online).unwrap();
        assert_eq!(online.name, "live");
        assert_eq!(online.count, 1);
        assert!(online.warnings.is_empty());
        // Offline folders contribute no documents — nothing stale to click on.
        assert_eq!(multi.entries.len(), 1);
        assert_eq!(multi.entries[0].root, canonical(&live));
    }

    #[test]
    fn merged_sorts_folders_case_insensitively_and_entries_newest_first_across_folders() {
        let base = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        // "Zeta" sorts BEFORE "alpha" bytewise ('Z' < 'a'); the UI wants alphabetical.
        let zeta = root(base.path(), "Zeta");
        let alpha = root(base.path(), "alpha");
        write_with_mtime(&zeta.join("older.md"), "# Older", 1_000_000);
        write_with_mtime(&alpha.join("middle.md"), "# Middle", 1_500_000);
        write_with_mtime(&zeta.join("newest.md"), "# Newest", 2_000_000);
        let z = open(&zeta, storage.path());
        let a = open(&alpha, storage.path());

        // Pass Zeta first so a stable "keep input order" sort would also be caught.
        let multi = merged(&[z, a], &[], 1);

        let names: Vec<&str> = multi.folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["alpha", "Zeta"]);
        // Entries are one combined newest-first list, not grouped by folder.
        let paths: Vec<&str> = multi
            .entries
            .iter()
            .map(|e| e.entry.path.as_str())
            .collect();
        assert_eq!(paths, ["newest.md", "middle.md", "older.md"]);
        assert!(multi
            .entries
            .windows(2)
            .all(|w| w[0].entry.changed > w[1].entry.changed));
    }

    #[test]
    fn open_view_reflects_each_scan_mark_and_pin() {
        let base = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let dir = root(base.path(), "notes");
        fs::write(dir.join("first.md"), "# First").unwrap();
        let open = open(&dir, storage.path());

        // Fresh open: the existing document is the read baseline and nothing is pinned.
        let seeded = open.view();
        assert_eq!(seeded.entries.len(), 1);
        assert!(!seeded.entries[0].pinned);

        // A file written AFTER open is invisible until this folder is rescanned — `view` is a
        // cache of the project, not a live directory read.
        fs::write(dir.join("second.md"), "# Second").unwrap();
        assert_eq!(open.view().entries.len(), 1);
        let directories = open.scan(&HashSet::new(), true).unwrap();
        assert!(directories.contains(&dir.canonicalize().unwrap()));
        let scanned = open.view();
        assert_eq!(scanned.entries.len(), 2);
        let second = entry(&scanned, "second.md");
        assert!(second.seen.is_none(), "a new document arrives unread");
        assert!(!second.pinned);
        let fingerprint = second.fingerprint.clone();

        // The mark lands in the cached view without any further scan.
        open.mark(Some("second.md"), Some(&fingerprint)).unwrap();
        let marked = open.view();
        assert_eq!(
            entry(&marked, "second.md").seen.as_deref(),
            Some(fingerprint.as_str())
        );
        assert!(!entry(&marked, "second.md").pinned);

        open.pin("second.md", true).unwrap();
        let pinned = open.view();
        assert!(entry(&pinned, "second.md").pinned);
        assert_eq!(
            entry(&pinned, "second.md").seen.as_deref(),
            Some(fingerprint.as_str())
        );

        // Every mutation advanced the project's version, and the view carries the latest one.
        assert!(scanned.version > seeded.version);
        assert!(marked.version > scanned.version);
        assert!(pinned.version > marked.version);
    }

    #[test]
    fn fresh_open_view_equals_the_project_snapshot_it_was_built_from() {
        let base = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let dir = root(base.path(), "seed");
        fs::write(dir.join("one.md"), "# One\n\nBody one.").unwrap();
        fs::write(dir.join("two.md"), "# Two\n\nBody two.").unwrap();
        let project = Project::open(&dir, storage.path()).unwrap();
        let expected = project.snapshot();

        let view = Open::new(project).view();

        // `Snapshot`/`Entry` have no PartialEq, so compare every observable field by hand.
        assert_eq!(view.root, expected.root);
        assert_eq!(view.name, expected.name);
        assert_eq!(view.version, expected.version);
        assert_eq!(
            view.session, expected.session,
            "seeded from THIS project, not a reopen"
        );
        assert_eq!(view.warnings, expected.warnings);
        assert_eq!(view.entries.len(), expected.entries.len());
        assert_eq!(view.entries.len(), 2);
        for (got, want) in view.entries.iter().zip(&expected.entries) {
            assert_eq!(got.path, want.path);
            assert_eq!(got.title, want.title);
            assert_eq!(got.preview, want.preview);
            assert_eq!(got.modified, want.modified);
            assert_eq!(got.changed, want.changed);
            assert_eq!(got.bytes, want.bytes);
            assert_eq!(got.fingerprint, want.fingerprint);
            assert_eq!(got.seen, want.seen);
            assert_eq!(got.pinned, want.pinned);
        }
    }
}
