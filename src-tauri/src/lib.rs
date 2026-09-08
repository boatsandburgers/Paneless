pub mod document;
pub mod handoff;
mod inbox;
pub mod project;
use document::{Document, Info};
use inbox::{project_close, project_mark, project_open, project_pin, project_refresh, Inbox};
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
        tmp.as_file()
            .set_permissions(fs::metadata(path).map_err(|e| e.to_string())?.permissions())
            .map_err(|e| e.to_string())?;
        tmp.write_all(source.as_bytes())
            .map_err(|e| e.to_string())?;
        tmp.as_file().sync_all().map_err(|e| e.to_string())?;
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
    resolve_markdown_link(&doc, &href, app.state::<Inbox>().root())
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
            handoff::handoff_context,
            handoff::open_codex,
            document_chunks,
            document_source,
            save_document,
            take_pending,
            set_dirty,
            quit,
            search_document,
            resolve_document_link,
            project_open,
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
}
