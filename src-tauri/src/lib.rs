pub mod document;
pub mod handoff;
mod inbox;
pub mod project;
use document::{Document, Info};
use inbox::{
    project_close, project_mark, project_pin, project_refresh, projects_add, projects_remove, Inbox,
};
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Reader {
    dirty: AtomicBool,
    pub current: Mutex<Option<Arc<Document>>>,
    serial: AtomicU64,
    pending: Mutex<Option<String>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub info: Info,
    pub first: String,
}
impl Reader {
    pub fn open(&self, path: &Path) -> Result<OpenResult, String> {
        let id = self.serial.fetch_add(1, Ordering::SeqCst) + 1;
        let doc = document::load(path, id)?;
        let result = OpenResult {
            info: doc.info.clone(),
            first: doc.chunks.first().cloned().unwrap_or_default(),
        };
        if self.serial.load(Ordering::SeqCst) != id {
            return Err("A newer file is opening.".into());
        }
        *self.current.lock().unwrap() = Some(Arc::new(doc));
        Ok(result)
    }
    pub fn get(&self, id: u64) -> Result<Arc<Document>, String> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|d| d.info.id == id)
            .cloned()
            .ok_or("Document is no longer open.".into())
    }
    pub fn chunks(&self, id: u64, offset: usize) -> Result<Vec<String>, String> {
        let d = self.get(id)?;
        Ok(d.chunks.iter().skip(offset).take(12).cloned().collect())
    }
    pub fn save(&self, id: u64, source: String) -> Result<(), String> {
        let doc = self.get(id)?;
        let path = Path::new(&doc.info.path);
        let disk = fs::read_to_string(path).map_err(|e| e.to_string())?;
        if document::fingerprint(&disk) != doc.fingerprint {
            return Err("The file changed on disk. Copy your edits before reloading; your original file has not been overwritten.".into());
        }
        let mut tmp = tempfile::NamedTempFile::new_in(&doc.base).map_err(|e| e.to_string())?;
        // Best-effort: mirror the original file's permissions. Some network shares (SMB) reject
        // chmod; a failure here must not block the save.
        if let Ok(meta) = fs::metadata(path) {
            let _ = tmp.as_file().set_permissions(meta.permissions());
        }
        tmp.write_all(source.as_bytes())
            .map_err(|e| e.to_string())?;
        // Flush to disk before the atomic rename so a crash can't leave a truncated file. On
        // macOS `sync_all` issues F_FULLFSYNC, which SMB / network shares reject with ENOTSUP
        // (os error 45) — fall back to a plain fsync (still flushes the write to the server), and
        // if even that is unsupported, proceed: the atomic rename below, not the flush, is what
        // guarantees a reader never sees a half-written file.
        if tmp.as_file().sync_all().is_err() {
            #[cfg(unix)]
            {
                use std::os::unix::io::AsRawFd;
                unsafe {
                    libc::fsync(tmp.as_file().as_raw_fd());
                }
            }
        }
        tmp.persist(path).map_err(|e| e.to_string())?;
        // Update the baseline immediately so consecutive saves remain valid.
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|d| d.info.id == id) {
            let mut info = doc.info.clone();
            info.bytes = source.len();
            *current = Some(Arc::new(Document {
                info,
                chunks: Vec::new(),
                texts: Vec::new(),
                fingerprint: document::fingerprint(&source),
                source,
                base: doc.base.clone(),
            }));
        }
        Ok(())
    }
}
fn watch(app: &tauri::AppHandle, path: PathBuf) {
    let handle = app.clone();
    let target = path.clone();
    let mut last = Instant::now() - Duration::from_secs(1);
    let watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                if (event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove())
                    && event.paths.iter().any(|p| p == &target)
                    && last.elapsed() > Duration::from_millis(150)
                {
                    last = Instant::now();
                    let app = handle.clone();
                    let path = target.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(220));
                        let current = app.state::<Reader>().current.lock().unwrap().clone();
                        if let Some(doc) = current {
                            if Path::new(&doc.info.path) == path
                                && fs::read_to_string(&path)
                                    .map(|s| document::fingerprint(&s) != doc.fingerprint)
                                    .unwrap_or(true)
                            {
                                let _ =
                                    app.emit("file-changed", path.to_string_lossy().to_string());
                            }
                        }
                    });
                }
            }
        });
    if let Ok(mut watcher) = watcher {
        if watcher
            .watch(path.parent().unwrap(), RecursiveMode::NonRecursive)
            .is_ok()
        {
            *app.state::<Reader>().watcher.lock().unwrap() = Some(watcher);
        }
    }
}
pub fn resolve_markdown_link(
    doc: &Document,
    href: &str,
    project: Option<PathBuf>,
) -> Result<(String, String), String> {
    if !document::relative_markdown_link(href) {
        return Err("Unsupported document link.".into());
    }
    let (raw, anchor) = href.split_once('#').unwrap_or((href, ""));
    let relative = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let path = doc
        .base
        .join(relative.as_ref())
        .canonicalize()
        .map_err(|e| format!("Cannot open linked document: {e}"))?;
    let boundary = project
        .filter(|root| Path::new(&doc.info.path).starts_with(root))
        .unwrap_or_else(|| doc.base.clone());
    if !path.starts_with(&boundary) || !document::is_markdown(&path) {
        return Err("This link is outside the document folder. Open the containing project to follow links within it.".into());
    }
    Ok((
        path.to_string_lossy().into(),
        percent_encoding::percent_decode_str(anchor)
            .decode_utf8()
            .map_err(|e| e.to_string())?
            .into(),
    ))
}
#[tauri::command]
fn resolve_document_link(
    app: tauri::AppHandle,
    id: u64,
    href: String,
) -> Result<(String, String), String> {
    let doc = app.state::<Reader>().get(id)?;
    // Confine the link to the folder that actually contains this document, not the first open
    // folder — otherwise a "../" link in any but the alphabetically-first root is refused.
    let root = app.state::<Inbox>().root_for(Path::new(&doc.info.path));
    resolve_markdown_link(&doc, &href, root)
}
#[tauri::command]
async fn open_document(app: tauri::AppHandle, path: String) -> Result<OpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<Reader>().open(Path::new(&path))?;
        watch(&app, PathBuf::from(&result.info.path));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Create a NEW Markdown file and fill it. Refuses every path that already exists, and leaves
/// nothing behind when the write fails. Split out of the command so it can be tested: the command
/// itself needs a running Tauri app, this does not.
pub fn create_markdown_file(path: &Path, source: &str) -> Result<(), String> {
    if !document::is_markdown(path) {
        return Err("Paneless writes Markdown: give the file a .md or .markdown name.".into());
    }
    // `create_new` tests for existence and creates in ONE syscall, so a file appearing between a
    // check and a write cannot be clobbered. A new document never overwrites an existing one,
    // even if the save panel already asked about replacing it.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "{} already exists and was not touched. Save under another name.",
                    path.display()
                )
            } else {
                e.to_string()
            }
        })?;
    // A failed write removes the file again, so a retry meets the folder the user saw. Left
    // behind, it would make the next attempt fail with "already exists" — naming this call's own
    // half-written file as the obstacle. It was created microseconds earlier by this call, so
    // removing it can only undo our own work.
    if let Err(e) = file.write_all(source.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
async fn create_document(
    app: tauri::AppHandle,
    path: String,
    source: String,
) -> Result<OpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&path);
        create_markdown_file(&path, &source)?;
        // Open it the same way any other document is opened, so the new file is an ordinary
        // document from this point on: same id, same watcher, same save path. A failure here is
        // rolled back too, for the same reason the write is.
        match app.state::<Reader>().open(&path) {
            Ok(result) => {
                watch(&app, PathBuf::from(&result.info.path));
                Ok(result)
            }
            Err(e) => {
                let _ = fs::remove_file(&path);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn document_chunks(state: State<Reader>, id: u64, offset: usize) -> Result<Vec<String>, String> {
    state.chunks(id, offset)
}
#[tauri::command]
async fn search_document(
    app: tauri::AppHandle,
    id: u64,
    query: String,
) -> Result<Vec<usize>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let doc = app.state::<Reader>().get(id)?;
        let q = query.to_lowercase();
        Ok(doc
            .texts
            .iter()
            .enumerate()
            .filter_map(|(i, t)| t.to_lowercase().contains(&q).then_some(i))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn document_source(state: State<Reader>, id: u64) -> Result<String, String> {
    Ok(state.get(id)?.source.clone())
}
#[tauri::command]
async fn save_document(app: tauri::AppHandle, id: u64, source: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<Reader>().save(id, source))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_dirty(state: State<Reader>, dirty: bool) {
    state.dirty.store(dirty, Ordering::SeqCst);
}
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.state::<Reader>().dirty.store(false, Ordering::SeqCst);
    app.exit(0);
}
#[tauri::command]
fn take_pending(state: State<Reader>) -> Option<String> {
    state.pending.lock().unwrap().take()
}
fn deliver(app: &tauri::AppHandle, path: PathBuf) {
    if document::is_markdown(&path) {
        *app.state::<Reader>().pending.lock().unwrap() = Some(path.to_string_lossy().into());
        let _ = app.emit("open-file", ());
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            for arg in args.iter().skip(1) {
                let p = Path::new(arg);
                deliver(
                    app,
                    if p.is_absolute() {
                        p.into()
                    } else {
                        Path::new(&cwd).join(p)
                    },
                );
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Reader::default())
        .manage(Inbox::default())
        .register_asynchronous_uri_scheme_protocol("mdimage", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let result = (|| {
                    let uri = request.uri().path().trim_start_matches('/');
                    let (id, path) = uri.split_once('/').ok_or("Invalid resource")?;
                    let id = id.parse::<u64>().map_err(|_| "Invalid document")?;
                    let doc = app.state::<Reader>().get(id)?;
                    document::local_image(&doc, path)
                })();
                let response = match result {
                    Ok((bytes, mime)) => tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("X-Content-Type-Options", "nosniff")
                        .body(bytes)
                        .unwrap(),
                    Err(_) => tauri::http::Response::builder()
                        .status(403)
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            create_document,
            handoff::handoff_context,
            handoff::open_codex,
            handoff::open_claude,
            handoff::open_supacode,
            document_chunks,
            document_source,
            save_document,
            take_pending,
            set_dirty,
            quit,
            search_document,
            resolve_document_link,
            projects_add,
            projects_remove,
            project_refresh,
            project_mark,
            project_pin,
            project_close
        ])
        .setup(|app| {
            for arg in std::env::args().skip(1) {
                deliver(app.handle(), PathBuf::from(arg));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Paneless");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { ref api, .. } = event {
            if app.state::<Reader>().dirty.load(Ordering::SeqCst) {
                api.prevent_exit();
                let _ = app.emit("confirm-quit", ());
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    deliver(app, path);
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod reader_tests {
    use super::*;
    #[test]
    fn relative_links_stay_inside_the_selected_project() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        let source = root.path().join("docs/report.md");
        fs::write(&source, "# Report").unwrap();
        let target = root.path().join("plan.md");
        fs::write(&target, "# Plan").unwrap();
        let doc = document::load(&source, 1).unwrap();
        assert!(resolve_markdown_link(&doc, "../plan.md#review", None).is_err());
        let result = resolve_markdown_link(
            &doc,
            "../plan.md#review",
            Some(root.path().canonicalize().unwrap()),
        )
        .unwrap();
        assert_eq!(PathBuf::from(result.0), target.canonicalize().unwrap());
        assert_eq!(result.1, "review");
        for href in [
            "file:///etc/passwd.md",
            "%2Fetc/passwd.md",
            "%5Cserver/a.md",
            "javascript:alert.md",
            "https://example.com/a.md",
            "../plan.md?run=1",
        ] {
            assert!(resolve_markdown_link(&doc, href, Some(root.path().to_path_buf())).is_err());
        }
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("outside.md"), "# Outside").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("outside.md"),
                root.path().join("docs/link.md"),
            )
            .unwrap();
            assert!(resolve_markdown_link(
                &doc,
                "link.md",
                Some(root.path().canonicalize().unwrap())
            )
            .is_err());
        }
    }
    #[test]
    fn saves_are_atomic_and_conflicts_preserve_disk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.md");
        fs::write(&path, "# Original").unwrap();
        let reader = Reader::default();
        let opened = reader.open(&path).unwrap();
        reader.save(opened.info.id, "# First save".into()).unwrap();
        reader.save(opened.info.id, "# Second save".into()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Second save");
        fs::write(&path, "# External change").unwrap();
        assert!(reader.save(opened.info.id, "# My edit".into()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# External change");
        let next = reader.open(&path).unwrap();
        assert_ne!(next.info.id, opened.info.id);
        assert!(reader.chunks(opened.info.id, 0).is_err());
    }
    #[test]
    fn new_file_holds_exactly_the_source_even_when_empty() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.md");
        create_markdown_file(&path, "# Hello\n\nbody").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Hello\n\nbody");
        // A blank note is a legal note: it must exist and hold nothing, not a placeholder.
        let empty = directory.path().join("empty.md");
        create_markdown_file(&empty, "").unwrap();
        assert_eq!(fs::read(&empty).unwrap(), b"");
    }
    #[test]
    fn an_existing_file_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("existing.md");
        fs::write(&path, "# Original").unwrap();
        let err = create_markdown_file(&path, "# Replacement").unwrap_err();
        assert!(err.contains("already exists and was not touched"), "{err}");
        assert_eq!(fs::read(&path).unwrap(), b"# Original");
    }
    #[test]
    fn non_markdown_names_are_refused_and_nothing_is_created() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["notes.txt", "notes", "notes.md.bak", "notes.mdx"] {
            let path = directory.path().join(name);
            assert!(create_markdown_file(&path, "# Notes").is_err(), "{name}");
            assert!(!path.exists(), "{name} was created");
        }
    }
    #[test]
    fn extension_check_is_case_insensitive_like_open() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["NOTE.MD", "Note.Markdown"] {
            let path = directory.path().join(name);
            create_markdown_file(&path, "# Note").unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "# Note", "{name}");
        }
    }
    #[test]
    fn a_directory_or_a_missing_parent_fails_without_panicking() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("folder.md");
        fs::create_dir(&folder).unwrap();
        assert!(create_markdown_file(&folder, "# Not a file").is_err());
        assert!(folder.is_dir());
        // The save panel only offers folders that exist; a parent that does not is not ours to
        // create silently.
        let orphan = directory.path().join("missing/new.md");
        assert!(create_markdown_file(&orphan, "# Orphan").is_err());
        assert!(!orphan.exists());
        assert!(!directory.path().join("missing").exists());
    }
    #[test]
    fn case_insensitive_disk_blocks_a_case_variant_of_an_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let upper = directory.path().join("EXISTING.md");
        fs::write(&upper, "# Keep").unwrap();
        let lower = directory.path().join("existing.md");
        // On a case-sensitive disk these are two different files and the guarantee does not
        // apply; the probe is the same file the assertion uses, so the test cannot lie.
        if !lower.exists() {
            return;
        }
        let err = create_markdown_file(&lower, "# Replacement").unwrap_err();
        assert!(err.contains("already exists and was not touched"), "{err}");
        assert_eq!(fs::read(&upper).unwrap(), b"# Keep");
    }
}
