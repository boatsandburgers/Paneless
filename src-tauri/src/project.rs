//! Optional local project index. The repository is never modified.
use crate::document::{fingerprint, is_markdown};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILES: usize = 10_000;
const MAX_DIRS: usize = 20_000;
const MAX_BYTES: u64 = 100 * 1024 * 1024;
pub const IGNORED: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "vendor",
    "generated",
    "__pycache__",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub title: String,
    pub preview: String,
    pub modified: u64,
    pub changed: u64,
    pub bytes: u64,
    pub fingerprint: String,
    pub seen: Option<String>,
    pub pinned: bool,
    stamp: u128,
}
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    initialized: bool,
    entries: BTreeMap<String, Entry>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub root: String,
    pub version: u64,
    pub session: String,
    pub name: String,
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}
pub struct Project {
    pub root: PathBuf,
    cache: PathBuf,
    saved: Saved,
    pub directories: HashSet<PathBuf>,
    warnings: Vec<String>,
    present: HashSet<String>,
    version: u64,
    session: String,
}
fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn cache_key(path: &str) -> u64 {
    // Stable across application/Rust releases; collisions cannot alias different roots
    // because the cache is also checked against its stored root.
    path.as_bytes().iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x100000001b3)
    })
}
pub fn ignored(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).map_or(true, |relative| {
        relative.components().any(|part| {
            let name = part.as_os_str().to_string_lossy();
            name.starts_with('.') || IGNORED.contains(&name.as_ref())
        })
    })
}
fn summary(source: &str, path: &Path) -> (String, String) {
    let mut title = None;
    let mut preview = Vec::new();
    let mut frontmatter = source.starts_with("---\n") || source.starts_with("---\r\n");
    let mut fence = false;
    for (i, line) in source.lines().take(200).enumerate() {
        let line = line.trim();
        if frontmatter {
            if i > 0 && (line == "---" || line == "...") {
                frontmatter = false;
            }
            continue;
        }
        if line.starts_with("```") || line.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence || line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if title.is_none() {
                title = Some(
                    line.trim_start_matches('#')
                        .trim()
                        .chars()
                        .take(180)
                        .collect(),
                );
            }
        } else if preview.len() < 3 && !line.starts_with('<') && !line.starts_with("![") {
            preview.push(line);
        }
    }
    (
        title.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        }),
        pulldown_cmark::Parser::new(&preview.join(" ").chars().take(1200).collect::<String>())
            .filter_map(|event| match event {
                pulldown_cmark::Event::Text(text) | pulldown_cmark::Event::Code(text) => {
                    Some(text.to_string())
                }
                pulldown_cmark::Event::SoftBreak | pulldown_cmark::Event::HardBreak => {
                    Some(" ".into())
                }
                _ => None,
            })
            .collect::<String>()
            .chars()
            .take(180)
            .collect(),
    )
}
impl Project {
    pub fn open(root: &Path, storage: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|e| format!("Cannot open project: {e}"))?;
        if !root.is_dir() {
            return Err("Choose a project folder.".into());
        }
        fs::create_dir_all(storage).map_err(|e| format!("Cannot store reading history: {e}"))?;
        let cache = storage.join(format!("{:016x}.json", cache_key(&root.to_string_lossy())));
        let saved = match fs::read(&cache) {
            Ok(bytes) => {
                let (saved_root, saved): (PathBuf, Saved) = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Cannot read project history: {e}"))?;
                if saved_root != root {
                    return Err("Project history belongs to another folder.".into());
                }
                saved
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(e) => return Err(format!("Cannot read project history: {e}")),
        };
        let mut project = Self {
            root,
            cache,
            saved,
            directories: HashSet::new(),
            warnings: Vec::new(),
            present: HashSet::new(),
            version: 0,
            session: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string(),
        };
        project.scan(&HashSet::new(), true)?;
        Ok(project)
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut entries: Vec<_> = self
            .saved
            .entries
            .iter()
            .filter(|(path, _)| self.present.contains(*path))
            .map(|(_, entry)| entry.clone())
            .collect();
        entries.sort_by(|a, b| b.changed.cmp(&a.changed).then_with(|| a.path.cmp(&b.path)));
        Snapshot {
            version: self.version,
            session: self.session.clone(),
            root: self.root.to_string_lossy().into(),
            name: self
                .root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            entries,
            warnings: self.warnings.clone(),
        }
    }
    fn persist(&self) -> Result<(), String> {
        let mut file = tempfile::NamedTempFile::new_in(self.cache.parent().unwrap())
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, &(&self.root, &self.saved)).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.persist(&self.cache)
            .map_err(|e| format!("Cannot save reading history: {e}"))?;
        Ok(())
    }
    pub fn scan(&mut self, invalidated: &HashSet<PathBuf>, force: bool) -> Result<(), String> {
        fs::read_dir(&self.root).map_err(|e| format!("Project folder is unavailable: {e}"))?;
        let mut pending = vec![(self.root.clone(), 0usize)];
        let mut found = HashSet::new();
        let mut directories = HashSet::new();
        let mut warnings = Vec::new();
        let now = millis(SystemTime::now());
        while let Some((directory, depth)) = pending.pop() {
            if directories.len() >= MAX_DIRS || found.len() >= MAX_FILES {
                warnings.push("Index limit reached (10,000 documents / 20,000 folders). Choose a smaller project folder.".into());
                break;
            }
            directories.insert(directory.clone());
            let children = match fs::read_dir(&directory) {
                Ok(children) => children,
                Err(e) => {
                    warnings.push(format!("Cannot scan {}: {e}", directory.display()));
                    continue;
                }
            };
            for child in children {
                let child = match child {
                    Ok(c) => c,
                    Err(e) => {
                        warnings.push(e.to_string());
                        continue;
                    }
                };
                let path = child.path();
                if ignored(&path, &self.root) {
                    continue;
                }
                let kind = match child.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                // Do not follow symlinks, including directory cycles and links outside the root.
                if kind.is_dir() {
                    if depth < 64 {
                        pending.push((path, depth + 1));
                    } else {
                        warnings.push("Folders deeper than 64 levels were skipped.".into());
                    }
                    continue;
                }
                if !kind.is_file() || !is_markdown(&path) {
                    continue;
                }
                if found.len() >= MAX_FILES {
                    break;
                }
                let relative = path
                    .strip_prefix(&self.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                found.insert(relative.clone());
                let meta = match child.metadata() {
                    Ok(m) => m,
                    Err(e) => {
                        warnings.push(format!("Cannot read {relative}: {e}"));
                        continue;
                    }
                };
                if meta.len() > MAX_BYTES {
                    warnings.push(format!("Skipped {relative}: exceeds 100 MB."));
                    continue;
                }
                let modified = meta.modified().unwrap_or(UNIX_EPOCH);
                let stamp = modified
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let old = self.saved.entries.get(&relative);
                if !force
                    && !invalidated.contains(&path)
                    && old.is_some_and(|e| e.stamp == stamp && e.bytes == meta.len())
                {
                    continue;
                }
                let source = match fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(e) => {
                        warnings.push(format!("Cannot read {relative}: {e}"));
                        continue;
                    }
                };
                let fingerprint = format!("{:016x}", fingerprint(&source));
                let (title, preview) = summary(&source, &path);
                let changed = match old {
                    Some(old) if old.fingerprint == fingerprint => old.changed,
                    _ if !self.saved.initialized => millis(modified),
                    _ => now,
                };
                let entry = Entry {
                    path: relative.clone(),
                    title,
                    preview,
                    modified: millis(modified),
                    changed,
                    bytes: meta.len(),
                    stamp,
                    seen: if !self.saved.initialized {
                        Some(fingerprint.clone())
                    } else {
                        old.and_then(|e| e.seen.clone())
                    },
                    pinned: old.is_some_and(|e| e.pinned),
                    fingerprint,
                };
                self.saved.entries.insert(relative, entry);
            }
        }
        // Keep history for absent files (branch switches, temporary removal), but never display them.
        self.directories = directories;
        self.warnings = warnings.into_iter().take(12).collect();
        self.saved.initialized = true;
        self.present = found;
        self.version += 1;
        self.persist()
    }
    pub fn mark(&mut self, path: Option<&str>, revision: Option<&str>) -> Result<(), String> {
        if let Some(path) = path {
            let entry = self
                .saved
                .entries
                .get_mut(path)
                .ok_or("Document is no longer indexed.")?;
            // Mark precisely the version the reader opened, never a newer background update.
            if let Some(revision) = revision {
                entry.seen = Some(revision.into());
            }
        } else {
            for (path, entry) in &mut self.saved.entries {
                if self.present.contains(path) {
                    entry.seen = Some(entry.fingerprint.clone());
                }
            }
        }
        self.version += 1;
        self.persist()
    }
    pub fn pin(&mut self, path: &str, pinned: bool) -> Result<(), String> {
        self.saved
            .entries
            .get_mut(path)
            .ok_or("Document is no longer indexed.")?
            .pinned = pinned;
        self.version += 1;
        self.persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baseline_new_updated_read_and_history_survive_reopen() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let original = root.path().join("plan.md");
        fs::write(&original, "# A plan\n\nFirst draft.").unwrap();
        let mut project = Project::open(root.path(), storage.path()).unwrap();
        let first = project.snapshot().entries[0].clone();
        assert_eq!(first.seen.as_ref(), Some(&first.fingerprint));
        fs::write(&original, "# A plan\n\nFirst draft.").unwrap();
        project.scan(&HashSet::new(), true).unwrap();
        assert_eq!(project.snapshot().entries[0].changed, first.changed);
        fs::write(&original, "# A plan\n\nSecond draft.").unwrap();
        let new = root.path().join("report.MD");
        fs::write(
            &new,
            "---\ntitle: ignored\n---\n# Daily report\n\nEverything is on track.",
        )
        .unwrap();
        project.scan(&HashSet::new(), true).unwrap();
        let snapshot = project.snapshot();
        let updated = snapshot
            .entries
            .iter()
            .find(|e| e.path == "plan.md")
            .unwrap();
        assert_ne!(updated.seen.as_ref(), Some(&updated.fingerprint));
        let new_entry = snapshot
            .entries
            .iter()
            .find(|e| e.path == "report.MD")
            .unwrap();
        assert!(new_entry.seen.is_none());
        assert_eq!(new_entry.title, "Daily report");
        assert_eq!(new_entry.preview, "Everything is on track.");
        // An older read acknowledgement must not mark a later write as read.
        project
            .mark(Some("plan.md"), Some(&first.fingerprint))
            .unwrap();
        let entry = project
            .snapshot()
            .entries
            .into_iter()
            .find(|e| e.path == "plan.md")
            .unwrap();
        assert_ne!(entry.seen.as_ref(), Some(&entry.fingerprint));
        project.pin("report.MD", true).unwrap();
        let mut project = Project::open(root.path(), storage.path()).unwrap();
        assert!(project
            .snapshot()
            .entries
            .iter()
            .any(|e| e.path == "report.MD" && e.pinned && e.seen.is_none()));
        project.mark(None, None).unwrap();
        assert!(project
            .snapshot()
            .entries
            .iter()
            .all(|e| e.seen.as_ref() == Some(&e.fingerprint)));
        fs::remove_file(&new).unwrap();
        project.scan(&HashSet::new(), true).unwrap();
        assert_eq!(project.snapshot().entries.len(), 1);
        fs::write(
            &new,
            "---\ntitle: ignored\n---\n# Daily report\n\nEverything is on track.",
        )
        .unwrap();
        project.scan(&HashSet::new(), true).unwrap();
        let restored = project
            .snapshot()
            .entries
            .into_iter()
            .find(|e| e.path == "report.MD")
            .unwrap();
        assert!(restored.pinned);
        assert_eq!(restored.seen.as_ref(), Some(&restored.fingerprint));
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            2,
            "No repository metadata is written"
        );
    }
    #[test]
    fn excluded_folders_and_symlinks_are_not_indexed() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        for name in ["node_modules", "target", ".git", "generated", "docs"] {
            fs::create_dir(root.path().join(name)).unwrap();
            fs::write(root.path().join(name).join("readme.md"), "# Read me").unwrap();
        }
        fs::write(root.path().join("plain.txt"), "Not markdown").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.path(), root.path().join("cycle")).unwrap();
        let project = Project::open(root.path(), storage.path()).unwrap();
        assert_eq!(project.snapshot().entries.len(), 1);
        assert_eq!(project.snapshot().entries[0].path, "docs/readme.md");
        assert_eq!(project.directories.len(), 2);
    }
    #[test]
    fn event_invalidation_detects_writes_with_unchanged_metadata() {
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let path = root.path().join("task.md");
        fs::write(&path, "# Before").unwrap();
        let stamp = fs::metadata(&path).unwrap().modified().unwrap();
        let mut project = Project::open(root.path(), storage.path()).unwrap();
        fs::write(&path, "# After!").unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stamp))
            .unwrap();
        project
            .scan(&HashSet::from([path.canonicalize().unwrap()]), false)
            .unwrap();
        let entry = &project.snapshot().entries[0];
        assert_eq!(entry.title, "After!");
        assert_ne!(entry.seen.as_ref(), Some(&entry.fingerprint));
    }
}
