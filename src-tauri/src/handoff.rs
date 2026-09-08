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

#[tauri::command]
pub async fn handoff_context(app: tauri::AppHandle, id: u64) -> Result<Context, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let doc = app.state::<Reader>().get(id)?;
        Ok(context(&doc, app.state::<Inbox>().root()))
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
    }
}
