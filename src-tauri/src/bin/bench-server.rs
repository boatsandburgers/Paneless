//! Development-only adapter for measuring the same native pipeline in a browser.
use paneless_lib::Reader;
fn main() {
    let reader = Reader::default();
    let storage = tempfile::tempdir().unwrap();
    let mut projects: Vec<paneless_lib::project::Project> = Vec::new();
    let mut offline: Vec<std::path::PathBuf> = Vec::new();
    let mut version: u64 = 0;
    let server = tiny_http::Server::http("127.0.0.1:1421").unwrap();
    println!("Benchmark adapter on http://127.0.0.1:1421 (development only)");
    for mut request in server.incoming_requests() {
        if request
            .headers()
            .iter()
            .any(|h| h.field.equiv("Origin") && h.value.as_str() != "http://127.0.0.1:1420")
        {
            let _ = request.respond(tiny_http::Response::empty(403));
            continue;
        }
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        let args: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        let result: Result<serde_json::Value, String> = (|| {
            Ok(match request.url() {
                "/api/handoff_context" => {
                    let doc = reader.get(args["id"].as_u64().unwrap())?;
                    serde_json::to_value(paneless_lib::handoff::context(
                        &doc,
                        root_for(&projects, &doc.info.path),
                    ))
                    .unwrap()
                }
                // The multi-folder inbox, mirroring src-tauri/src/inbox.rs. That module is private
                // to the app, so its commands are re-implemented here over the public `Project`
                // API, the same way the single-folder commands were. No watchers: the browser
                // tests refresh explicitly.
                "/api/projects_add" => {
                    let requested = std::path::Path::new(args["path"].as_str().unwrap_or(""));
                    let canonical = requested.canonicalize().ok();
                    if let Some(canonical) = &canonical {
                        if projects.iter().any(|p| &p.root == canonical) {
                            return Ok(multi(&projects, &offline, &mut version));
                        }
                        if let Some(clash) = projects.iter().find(|p| {
                            canonical.starts_with(&p.root) || p.root.starts_with(canonical)
                        }) {
                            return Err(format!(
                                "This folder overlaps an open folder ({}). Pick a folder that does not contain the other.",
                                clash.root.to_string_lossy()
                            ));
                        }
                    }
                    match paneless_lib::project::Project::open(requested, storage.path()) {
                        Ok(project) => {
                            offline.retain(|r| r != &project.root);
                            projects.push(project);
                        }
                        Err(e) => {
                            // Only an unreachable path becomes an offline chip (Invariant #11).
                            if canonical.is_some() {
                                return Err(e);
                            }
                            let key = requested.to_path_buf();
                            if !offline.contains(&key) {
                                offline.push(key);
                            }
                        }
                    }
                    multi(&projects, &offline, &mut version)
                }
                "/api/projects_remove" => {
                    let target = std::path::PathBuf::from(args["root"].as_str().unwrap_or(""));
                    let canonical = target.canonicalize().ok();
                    let matches =
                        |r: &std::path::Path| r == target || Some(r) == canonical.as_deref();
                    projects.retain(|p| !matches(&p.root));
                    offline.retain(|r| !matches(r));
                    multi(&projects, &offline, &mut version)
                }
                "/api/project_refresh" => {
                    for root in std::mem::take(&mut offline) {
                        // Already open under its canonical path: drop the key, never re-open it.
                        if let Ok(canonical) = root.canonicalize() {
                            if projects.iter().any(|p| p.root == canonical) {
                                continue;
                            }
                        }
                        match paneless_lib::project::Project::open(&root, storage.path()) {
                            // Overlaps an open folder: keep the chip so it can be removed.
                            Ok(project)
                                if projects.iter().any(|p| {
                                    project.root.starts_with(&p.root)
                                        || p.root.starts_with(&project.root)
                                }) =>
                            {
                                offline.push(root)
                            }
                            Ok(project) => projects.push(project),
                            Err(_) => offline.push(root), // still unreachable
                        }
                    }
                    let mut gone = Vec::new();
                    for p in projects.iter_mut() {
                        if p.scan(&std::collections::HashSet::new(), true).is_err()
                            && std::fs::read_dir(&p.root).is_err()
                        {
                            gone.push(p.root.clone());
                        }
                    }
                    projects.retain(|p| !gone.contains(&p.root));
                    offline.extend(gone);
                    multi(&projects, &offline, &mut version)
                }
                "/api/project_mark" => {
                    let p = find(&mut projects, &args)?;
                    p.mark(args["path"].as_str(), args["revision"].as_str())?;
                    multi(&projects, &offline, &mut version)
                }
                "/api/project_pin" => {
                    let p = find(&mut projects, &args)?;
                    p.pin(
                        args["path"].as_str().unwrap(),
                        args["pinned"].as_bool().unwrap(),
                    )?;
                    multi(&projects, &offline, &mut version)
                }
                "/api/project_close" => {
                    projects.clear();
                    offline.clear();
                    version += 1;
                    serde_json::Value::Null
                }
                "/api/resolve_document_link" => {
                    let doc = reader.get(args["id"].as_u64().unwrap())?;
                    serde_json::to_value(paneless_lib::resolve_markdown_link(
                        &doc,
                        args["href"].as_str().unwrap(),
                        root_for(&projects, &doc.info.path),
                    )?)
                    .unwrap()
                }
                "/api/open_document" => serde_json::to_value(
                    reader.open(std::path::Path::new(args["path"].as_str().unwrap_or("")))?,
                )
                .unwrap(),
                "/api/document_chunks" => serde_json::to_value(reader.chunks(
                    args["id"].as_u64().unwrap(),
                    args["offset"].as_u64().unwrap() as usize,
                )?)
                .unwrap(),
                "/api/search_document" => {
                    let d = reader.get(args["id"].as_u64().unwrap())?;
                    // The same count as the app's search_document.
                    serde_json::to_value(paneless_lib::count_matches(
                        &d.texts,
                        args["query"].as_str().unwrap_or(""),
                    ))
                    .unwrap()
                }
                "/api/document_source" => {
                    serde_json::to_value(&reader.get(args["id"].as_u64().unwrap())?.source).unwrap()
                }
                "/api/save_document" => {
                    reader.save(
                        args["id"].as_u64().unwrap(),
                        args["source"].as_str().unwrap().into(),
                    )?;
                    serde_json::Value::Null
                }
                _ => return Err("Unknown command".into()),
            })
        })();
        let (status, value) = match result {
            Ok(v) => (200, v),
            Err(e) => (400, serde_json::json!({"error":e})),
        };
        let response = tiny_http::Response::from_string(value.to_string())
            .with_status_code(status)
            .with_header(
                tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
            );
        let _ = request.respond(response);
    }
}

/// Which open root contains this document path (inbox.rs `Inbox::root_for`).
fn root_for(
    projects: &[paneless_lib::project::Project],
    path: &str,
) -> Option<std::path::PathBuf> {
    projects
        .iter()
        .map(|p| p.root.clone())
        .find(|root| std::path::Path::new(path).starts_with(root))
}

/// The open folder a mark/pin is routed to, by its `root` argument.
fn find<'a>(
    projects: &'a mut [paneless_lib::project::Project],
    args: &serde_json::Value,
) -> Result<&'a mut paneless_lib::project::Project, String> {
    let root = std::path::Path::new(args["root"].as_str().unwrap_or(""));
    projects
        .iter_mut()
        .find(|p| p.root == root)
        .ok_or_else(|| "That folder is no longer open.".to_string())
}

/// The merged payload, the same shape as inbox.rs `Multi` (folders + root-tagged entries +
/// a version that rises with every payload).
fn multi(
    projects: &[paneless_lib::project::Project],
    offline: &[std::path::PathBuf],
    version: &mut u64,
) -> serde_json::Value {
    *version += 1;
    let mut folders = Vec::new();
    let mut entries = Vec::new();
    for p in projects {
        let snapshot = p.snapshot();
        folders.push(serde_json::json!({
            "root": snapshot.root,
            "name": snapshot.name,
            "online": true,
            "count": snapshot.entries.len(),
            "warnings": snapshot.warnings,
        }));
        for entry in snapshot.entries {
            let mut value = serde_json::to_value(&entry).unwrap();
            value["root"] = snapshot.root.clone().into();
            entries.push((entry.changed, entry.path, value));
        }
    }
    for root in offline {
        folders.push(serde_json::json!({
            "root": root.to_string_lossy(),
            "name": root.file_name().unwrap_or(root.as_os_str()).to_string_lossy(),
            "online": false,
            "count": 0,
            "warnings": ["This folder is currently unavailable. Use Refresh when it is back."],
        }));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    folders.sort_by_key(|f| f["name"].as_str().unwrap_or("").to_lowercase());
    serde_json::json!({
        "folders": folders,
        "entries": entries.into_iter().map(|e| e.2).collect::<Vec<_>>(),
        "version": *version,
    })
}
