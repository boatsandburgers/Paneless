use crate::project::{Project, Snapshot};
use notify::{RecursiveMode, Watcher};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Inbox {
    project: Mutex<Option<Project>>,
    watcher: Mutex<Option<(notify::RecommendedWatcher, HashSet<PathBuf>)>>,
    epoch: AtomicU64,
    opening: AtomicU64,
}
impl Inbox {
    pub fn root(&self) -> Option<PathBuf> {
        self.project
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.root.clone())
    }
}
fn sync_watchers(state: &Inbox, project: &Project) -> Result<(), String> {
    let mut guard = state.watcher.lock().unwrap();
    if let Some((watcher, directories)) = guard.as_mut() {
        for path in directories.difference(&project.directories) {
            let _ = watcher.unwatch(path);
        }
        let mut errors = Vec::new();
        let mut watched: HashSet<_> = directories
            .intersection(&project.directories)
            .cloned()
            .collect();
        for path in project.directories.difference(directories) {
            match watcher.watch(path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    watched.insert(path.clone());
                }
                Err(e) => errors.push(e.to_string()),
            }
        }
        *directories = watched;
        if !errors.is_empty() {
            return Err(format!(
                "Some folders could not be watched. Use Refresh to check for changes. {}",
                errors[0]
            ));
        }
    }
    Ok(())
}
fn storage(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects"))
}
#[tauri::command]
pub async fn project_open(app: tauri::AppHandle, path: String) -> Result<Snapshot, String> {
    let attempt = app.state::<Inbox>().opening.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let project = Project::open(std::path::Path::new(&path), &storage(&app)?)?;
        let root = project.root.clone();
        let (tx, rx) = mpsc::channel();
        let watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if let Ok(event) = event {
                    if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() {
                        let paths: Vec<_> = event
                            .paths
                            .into_iter()
                            .filter(|p| !crate::project::ignored(p, &root))
                            .collect();
                        if !paths.is_empty() {
                            let _ = tx.send(paths);
                        }
                    }
                } else {
                    let _ = tx.send(Vec::new());
                }
            })
            .map_err(|e| e.to_string())?;
        let state = app.state::<Inbox>();
        let mut data = state.project.lock().unwrap();
        if state.opening.load(Ordering::SeqCst) != attempt {
            return Err("A newer project is opening.".into());
        }
        let epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *state.watcher.lock().unwrap() = Some((watcher, HashSet::new()));
        *data = Some(project);
        let project = data.as_mut().unwrap();
        let watch_error = sync_watchers(&state, project).err();
        // Close the discovery/watch installation gap, including newly created folders.
        project.scan(&HashSet::new(), false)?;
        let _ = sync_watchers(&state, project);
        let mut snapshot = project.snapshot();
        if let Some(error) = watch_error {
            snapshot.warnings.push(error);
        }
        drop(data);
        std::thread::spawn(move || {
            while let Ok(paths) = rx.recv() {
                let mut invalidated: HashSet<_> = paths.into_iter().collect();
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(2) {
                    match rx.recv_timeout(Duration::from_millis(600)) {
                        Ok(paths) => invalidated.extend(paths),
                        Err(_) => break,
                    }
                }
                let state = app.state::<Inbox>();
                let mut data = state.project.lock().unwrap();
                if state.epoch.load(Ordering::SeqCst) != epoch {
                    break;
                }
                if let Some(project) = data.as_mut() {
                    match project
                        .scan(&invalidated, false)
                        .and_then(|()| sync_watchers(&state, project))
                    {
                        Ok(()) => {
                            let _ = app.emit("project-updated", project.snapshot());
                        }
                        Err(e) => {
                            let _ = app.emit("project-error", e);
                        }
                    }
                }
            }
        });
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn project_refresh(app: tauri::AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let mut data = state.project.lock().unwrap();
        let project = data.as_mut().ok_or("Open a project first.")?;
        project.scan(&HashSet::new(), true)?;
        let mut snapshot = project.snapshot();
        if let Err(e) = sync_watchers(&state, project) {
            snapshot.warnings.push(e);
        }
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn project_mark(
    app: tauri::AppHandle,
    root: String,
    path: Option<String>,
    revision: Option<String>,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let mut data = state.project.lock().unwrap();
        let project = data.as_mut().ok_or("Open a project first.")?;
        if project.root != std::path::Path::new(&root) {
            return Err("Project has changed.".into());
        }
        project.mark(path.as_deref(), revision.as_deref())?;
        Ok(project.snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn project_pin(
    app: tauri::AppHandle,
    root: String,
    path: String,
    pinned: bool,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Inbox>();
        let mut data = state.project.lock().unwrap();
        let project = data.as_mut().ok_or("Open a project first.")?;
        if project.root != std::path::Path::new(&root) {
            return Err("Project has changed.".into());
        }
        project.pin(&path, pinned)?;
        Ok(project.snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn project_close(state: tauri::State<Inbox>) {
    state.opening.fetch_add(1, Ordering::SeqCst);
    state.epoch.fetch_add(1, Ordering::SeqCst);
    let mut data = state.project.lock().unwrap();
    *state.watcher.lock().unwrap() = None;
    *data = None;
}
