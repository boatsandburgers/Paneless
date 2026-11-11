use crate::{document, document::Document, inbox::Inbox, Reader};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub workspace: String,
    pub matches_disk: bool,
}

pub fn context(doc: &Document, project: Option<PathBuf>) -> Context {
    let workspace = project
        .filter(|root| Path::new(&doc.info.path).starts_with(root))
        .or_else(|| {
            doc.base
                .ancestors()
                .find(|p| p.join(".git").exists())
                .map(Path::to_path_buf)
        })
        .unwrap_or_else(|| doc.base.clone());
    Context {
        workspace: workspace.to_string_lossy().into_owned(),
        matches_disk: std::fs::read_to_string(&doc.info.path)
            .map(|source| document::fingerprint(&source) == doc.fingerprint)
            .unwrap_or(false),
    }
}

// Keep custom agent URLs out of Markdown's general-purpose link opener.
pub fn codex_url(workspace: &str, prompt: &str) -> (String, bool) {
    let mut url = url::Url::parse("codex://threads/new").unwrap();
    url.query_pairs_mut().append_pair("path", workspace);
    let base = url.clone();
    url.query_pairs_mut().append_pair("prompt", prompt);
    // Conservative shell URL limit. Long handoffs use the clipboard instead.
    if url.as_str().len() > 1900 {
        (base.into(), false)
    } else {
        (url.into(), true)
    }
}

// The Claude desktop app's Code tab: `claude://code/new` with `folder` and
// `q`. The app treats a folder from a link as untrusted and confirms it
// before adopting it; the prompt lands in the composer unsent. The composer
// cap is about 14,000 characters; longer prompts travel on the clipboard.
pub fn claude_url(workspace: &str, prompt: &str) -> (String, bool) {
    let mut url = url::Url::parse("claude://code/new").unwrap();
    url.query_pairs_mut().append_pair("folder", workspace);
    let base = url.clone();
    if prompt.chars().count() > 14_000 {
        return (base.into(), false);
    }
    url.query_pairs_mut().append_pair("q", prompt);
    (url.into(), true)
}

// A desktop session already working on the document's folder. Every running session
// writes `<pid>.json` into `~/.claude/sessions/` with its `cwd`, its `entrypoint` and the
// `hostSessionId` (`local_<id>`) that `claude://code/continue?session=` accepts. That route
// opens the session but reads no prompt, so the prompt travels on the clipboard.
#[derive(serde::Deserialize)]
struct LiveSession {
    pid: Option<i64>,
    cwd: Option<String>,
    entrypoint: Option<String>,
    kind: Option<String>,
    #[serde(rename = "hostSessionId")]
    host_session_id: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<i64>,
    // The title the desktop app shows for the session in its sidebar. Read loosely, so a
    // title of another JSON type cannot make a live session unreadable and send the user to a new one.
    name: Option<serde_json::Value>,
}

// Invisible characters that can blank or reverse the line the title sits in: zero-width spaces
// and joiners, direction marks, overrides and isolates, the word joiner family and the BOM.
fn invisible(c: char) -> bool {
    matches!(c, '\u{00AD}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

// What the dialog calls the session it switched to: its sidebar title, or failing that
// the name of its folder. Control and invisible characters are dropped, a long title is shortened.
fn session_label(name: Option<&str>, cwd: &Path) -> String {
    let clean = |s: &str| -> String {
        let s: String = s.chars().filter(|c| !c.is_control() && !invisible(*c)).collect();
        let s = s.trim();
        if s.chars().count() > 60 {
            format!("{}…", s.chars().take(60).collect::<String>().trim_end())
        } else {
            s.to_string()
        }
    };
    let titled = name.map(clean).filter(|s| !s.is_empty());
    titled
        .or_else(|| cwd.file_name().map(|f| clean(&f.to_string_lossy())).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| cwd.display().to_string())
}

// The same shape the desktop app checks before it opens a session from a link.
fn is_local_session_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("local_") else {
        return false;
    };
    (1..=64).contains(&rest.len())
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // Signal 0 only asks whether the process exists; EPERM means it exists under another user.
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

// Untested off macOS: with no way to ask, no session counts as live and the new-session route
// is used, rather than a link to a session that may be gone.
#[cfg(not(unix))]
fn process_alive(_pid: i64) -> bool {
    false
}

pub fn sessions_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .map(|config| config.join("sessions"))
}

// The live desktop session whose folder is the deepest one containing `document`; on a tie,
// the one updated most recently. Returns its id and its label; None when no such session exists.
pub fn live_session_for(sessions: &Path, document: &Path) -> Option<(String, String)> {
    let mut best: Option<((usize, i64), (String, String))> = None;
    for entry in std::fs::read_dir(sessions).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(session) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LiveSession>(&bytes).ok())
        else {
            continue;
        };
        let (Some(pid), Some(cwd), Some(id)) = (session.pid, session.cwd, session.host_session_id)
        else {
            continue;
        };
        let cwd = PathBuf::from(cwd);
        // The desktop app itself counts only interactive sessions (or ones with no kind) as live.
        if session.entrypoint.as_deref() != Some("claude-desktop")
            || !matches!(session.kind.as_deref(), None | Some("interactive"))
            || !is_local_session_id(&id)
            || !cwd.is_absolute()
            || !document.starts_with(&cwd)
            || !process_alive(pid)
        {
            continue;
        }
        let rank = (cwd.components().count(), session.updated_at.unwrap_or(0));
        if best.as_ref().is_none_or(|(best_rank, _)| rank > *best_rank) {
            let label = session_label(session.name.as_ref().and_then(|n| n.as_str()), &cwd);
            best = Some((rank, (id, label)));
        }
    }
    best.map(|(_, found)| found)
}

pub fn claude_session_url(session: &str) -> String {
    let mut url = url::Url::parse("claude://code/continue").unwrap();
    url.query_pairs_mut().append_pair("session", session);
    url.into()
}

// What `open_claude` did, so the dialog can say whether the prompt is filled in or must be pasted,
// and, for a running session, which one it switched to.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClaudeOpened {
    NewWithPrompt,
    NewWithoutPrompt,
    ExistingSession { session: String },
}

#[tauri::command]
pub async fn handoff_context(app: tauri::AppHandle, id: u64) -> Result<Context, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let doc = app.state::<Reader>().get(id)?;
        Ok(context(
            &doc,
            app.state::<Inbox>().root_for(Path::new(&doc.info.path)),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_codex(
    app: tauri::AppHandle,
    id: u64,
    workspace: String,
    prompt: String,
) -> Result<bool, String> {
    let doc = app.state::<Reader>().get(id)?;
    if !Path::new(&workspace).is_absolute() || !Path::new(&doc.info.path).starts_with(&workspace) {
        return Err("The handoff workspace no longer contains this document.".into());
    }
    if prompt.len() > 100_000 {
        return Err("This handoff is too long. Use Copy for agent.".into());
    }
    let (url, included) = codex_url(&workspace, &prompt);
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        format!("Could not open Codex. Your context is copied; paste it into your agent. {e}")
    })?;
    Ok(included)
}

#[tauri::command]
pub fn open_claude(
    app: tauri::AppHandle,
    id: u64,
    workspace: String,
    prompt: String,
) -> Result<ClaudeOpened, String> {
    let doc = app.state::<Reader>().get(id)?;
    if !Path::new(&workspace).is_absolute() || !Path::new(&doc.info.path).starts_with(&workspace) {
        return Err("The handoff workspace no longer contains this document.".into());
    }
    if prompt.len() > 100_000 {
        return Err("This handoff is too long. Use Copy for agent.".into());
    }
    let session = sessions_dir().and_then(|dir| live_session_for(&dir, Path::new(&doc.info.path)));
    let (url, opened) = match session {
        Some((session, label)) => (
            claude_session_url(&session),
            ClaudeOpened::ExistingSession { session: label },
        ),
        None => match claude_url(&workspace, &prompt) {
            (url, true) => (url, ClaudeOpened::NewWithPrompt),
            (url, false) => (url, ClaudeOpened::NewWithoutPrompt),
        },
    };
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        format!(
            "Could not open the Claude desktop app. Your context is copied; paste it into a Code session. {e}"
        )
    })?;
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_and_rendered_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::write(root.join(".git"), "gitdir: somewhere").unwrap();
        std::fs::create_dir(root.join("docs")).unwrap();
        let path = root.join("docs/test.md");
        std::fs::write(&path, "# Original").unwrap();
        let doc = document::load(&path, 1).unwrap();
        assert_eq!(context(&doc, None).workspace, root.to_str().unwrap());
        assert!(context(&doc, None).matches_disk);
        assert_eq!(
            context(&doc, Some(root.join("docs"))).workspace,
            root.join("docs").to_str().unwrap()
        );
        assert_eq!(
            context(&doc, Some(root.join("unrelated"))).workspace,
            root.to_str().unwrap()
        );
        std::fs::write(&path, "# Agent update").unwrap();
        assert!(!context(&doc, None).matches_disk);
    }
    #[test]
    fn urls_preserve_context_and_bound_length() {
        let prompt = "Explain café & #heading? $(touch /tmp/no)\n第二行";
        let (value, included) = codex_url("/project/a & b", prompt);
        assert!(included);
        let parsed = url::Url::parse(&value).unwrap();
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
        assert_eq!(pairs["path"], "/project/a & b");
        assert_eq!(pairs["prompt"], prompt);
        let (value, included) = codex_url("/project", &"大".repeat(2000));
        assert!(!included);
        assert!(!value.contains("prompt="));
        let (value, included) = claude_url("/project/a & b", prompt);
        assert!(included);
        let parsed = url::Url::parse(&value).unwrap();
        assert_eq!(parsed.scheme(), "claude");
        assert_eq!(parsed.host_str(), Some("code"));
        assert_eq!(parsed.path(), "/new");
        let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
        assert_eq!(pairs["folder"], "/project/a & b");
        assert_eq!(pairs["q"], prompt);
        let (value, included) = claude_url("/project", &"x".repeat(14_001));
        assert!(!included);
        assert!(!value.contains("q="));
    }
    fn write_session(dir: &Path, name: &str, body: serde_json::Value) {
        std::fs::write(dir.join(name), serde_json::to_vec(&body).unwrap()).unwrap();
    }
    fn session(pid: i64, cwd: &str, entrypoint: &str, id: &str, updated: i64) -> serde_json::Value {
        serde_json::json!({"pid": pid, "cwd": cwd, "entrypoint": entrypoint, "hostSessionId": id, "updatedAt": updated})
    }
    fn live_id(dir: &Path, doc: &Path) -> Option<String> {
        live_session_for(dir, doc).map(|(id, _)| id)
    }
    #[test]
    fn live_session_carries_the_label_the_dialog_shows() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let me = std::process::id() as i64;
        let doc = Path::new("/home/me/Notes/Work/plan.md");
        // A title that differs from its folder, so dropping the title would show here.
        let mut titled = session(me, "/home/me/Notes", "claude-desktop", "local_hq", 1);
        titled["name"] = serde_json::json!("  Life\u{7} \u{202E}desk\u{200B}  ");
        write_session(dir, "1.json", titled);
        assert_eq!(live_session_for(dir, doc), Some(("local_hq".into(), "Life desk".into())));
        // A title of another JSON type still leaves the session found, under its folder.
        let mut odd = session(me, "/home/me/Notes", "claude-desktop", "local_odd", 2);
        odd["name"] = serde_json::json!(123);
        write_session(dir, "3.json", odd);
        assert_eq!(live_session_for(dir, doc), Some(("local_odd".into(), "Notes".into())));
        std::fs::remove_file(dir.join("3.json")).unwrap();
        assert_eq!(session_label(Some("\u{200B}"), Path::new("/home/me/Notes")), "Notes");
        let mut blank = session(me, "/home/me/Notes/Work", "claude-desktop", "local_work", 1);
        blank["name"] = serde_json::json!(" \n ");
        write_session(dir, "2.json", blank);
        assert_eq!(live_session_for(dir, doc), Some(("local_work".into(), "Work".into())));
        let long = "x".repeat(70);
        assert_eq!(session_label(Some(&long), Path::new("/a")), format!("{}…", "x".repeat(60)));
        assert_eq!(session_label(None, Path::new("/")), "/");
        // The JSON the dialog reads: a tag, plus the label only for a running session.
        assert_eq!(
            serde_json::to_value(ClaudeOpened::ExistingSession { session: "Notes".into() }).unwrap(),
            serde_json::json!({"kind": "existingSession", "session": "Notes"})
        );
        assert_eq!(
            serde_json::to_value(ClaudeOpened::NewWithPrompt).unwrap(),
            serde_json::json!({"kind": "newWithPrompt"})
        );
    }
    #[test]
    fn live_session_is_the_deepest_living_desktop_session_holding_the_document() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let me = std::process::id() as i64;
        let doc = Path::new("/home/me/Workers/HR/notes/plan.md");
        assert_eq!(live_id(dir, doc), None);
        write_session(dir, "1.json", session(me, "/home/me", "claude-desktop", "local_home", 9));
        assert_eq!(live_id(dir, doc).as_deref(), Some("local_home"));
        write_session(dir, "2.json", session(me, "/home/me/Workers/HR", "claude-desktop", "local_hr-old", 1));
        write_session(dir, "3.json", session(me, "/home/me/Workers/HR", "claude-desktop", "local_hr-new", 2));
        assert_eq!(live_id(dir, doc).as_deref(), Some("local_hr-new"));
        // Each of these is deeper still, or a near miss, and must be passed over.
        let deeper = "/home/me/Workers/HR/notes";
        write_session(dir, "4.json", session(me, deeper, "cli", "local_cli", 5));
        let mut background = session(me, deeper, "claude-desktop", "local_background", 5);
        background["kind"] = "background".into();
        write_session(dir, "4b.json", background);
        write_session(dir, "5.json", session(me, deeper, "claude-desktop", "local_x&q=injected", 5));
        write_session(dir, "6.json", session(i32::MAX as i64, deeper, "claude-desktop", "local_dead", 5));
        write_session(dir, "7.json", session(me, "/home/me/Workers/HR/notesX", "claude-desktop", "local_sibling", 5));
        write_session(dir, "8.json", session(me, "notes", "claude-desktop", "local_relative", 5));
        std::fs::write(dir.join("9.json"), "{ not json").unwrap();
        write_session(dir, "10.key", session(me, deeper, "claude-desktop", "local_key", 5));
        assert_eq!(live_id(dir, doc).as_deref(), Some("local_hr-new"));
        assert_eq!(live_id(&dir.join("missing"), doc), None);
    }
    #[test]
    fn session_url_reopens_the_session_and_carries_no_prompt() {
        let parsed = url::Url::parse(&claude_session_url("local_abc-123")).unwrap();
        assert_eq!(parsed.scheme(), "claude");
        assert_eq!(parsed.host_str(), Some("code"));
        assert_eq!(parsed.path(), "/continue");
        let pairs: Vec<_> = parsed.query_pairs().collect();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0, "session");
        assert_eq!(pairs[0].1, "local_abc-123");
        assert!(is_local_session_id("local_a"));
        assert!(!is_local_session_id("local_"));
        assert!(!is_local_session_id(&format!("local_{}", "a".repeat(65))));
        assert!(!is_local_session_id("cse_abc"));
    }
}
