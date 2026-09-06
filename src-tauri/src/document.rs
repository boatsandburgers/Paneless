//! The parser is shared by the desktop app and the development benchmark harness.
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, fs, hash::{Hash, Hasher}, path::{Path, PathBuf}, time::Instant};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading { pub id: String, pub text: String, pub level: u8 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: u64, pub path: String, pub name: String, pub bytes: usize,
    pub headings: Vec<Heading>, pub chunks: usize, pub read_ms: f64, pub parse_ms: f64,
}
pub struct Document { pub info: Info, pub chunks: Vec<String>, pub source: String, pub fingerprint: u64, pub base: PathBuf }
pub fn fingerprint(s: &str) -> u64 { let mut h = std::collections::hash_map::DefaultHasher::new(); s.hash(&mut h); h.finish() }
pub fn is_markdown(p: &Path) -> bool { p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown")) }
pub fn load(path: &Path, id: u64) -> Result<Document, String> {
    let started = Instant::now();
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !is_markdown(&path) { return Err("Choose a .md or .markdown file.".into()); }
    if fs::metadata(&path).map_err(|e|e.to_string())?.len() > 100 * 1024 * 1024 { return Err("This file exceeds the 100 MB safety limit.".into()); }
    let source = fs::read_to_string(&path).map_err(|e| format!("Cannot read this UTF-8 Markdown file: {e}"))?;
    let read_ms = started.elapsed().as_secs_f64() * 1000.;
    let base = path.parent().unwrap().to_path_buf();
    let parse_start = Instant::now();
    let (chunks, headings) = render(&source, id);
    let info = Info { id, path: path.to_string_lossy().into(), name: path.file_name().unwrap().to_string_lossy().into(), bytes: source.len(), headings, chunks: chunks.len(), read_ms, parse_ms: parse_start.elapsed().as_secs_f64()*1000. };
    let fingerprint = fingerprint(&source);
    Ok(Document { info, chunks, source, fingerprint, base })
}
fn slug(text: &str) -> String {
    let s: String = text.to_lowercase().chars().filter_map(|c| if c.is_alphanumeric() || c == '_' || c == '-' {Some(c)} else if c.is_whitespace() {Some('-')} else {None}).collect();
    if s.is_empty() { "section".into() } else {s}
}
fn safe_link(s: &str) -> bool { s.starts_with('#') || url::Url::parse(s).is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "mailto")) }
fn image_url(s: &str, id: u64) -> String {
    // No remote images, absolute paths, data URLs, or arbitrary protocols.
    if s.starts_with('/') || s.starts_with('\\') || s.contains(':') { return String::new(); }
    let encoded = utf8_percent_encode(s, NON_ALPHANUMERIC);
    if cfg!(target_os="windows") {format!("http://mdimage.localhost/{id}/{encoded}")} else {format!("mdimage://localhost/{id}/{encoded}")}
}
pub fn render(source: &str, id: u64) -> (Vec<String>, Vec<Heading>) {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES | Options::ENABLE_GFM;
    let mut chunks = Vec::new(); let mut headings = Vec::new(); let mut used = HashMap::<String, usize>::new();
    let mut anchors = HashSet::new();
    let mut events = Vec::new(); let mut size = 0; let mut depth = 0usize; let mut heading_start = None;
    let mut heading_text = String::new(); let mut heading_level = 1u8;
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        let event = match event {
            Event::Html(_) | Event::InlineHtml(_) => continue,
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => Event::Start(Tag::Link {link_type, dest_url: if safe_link(&dest_url) {dest_url} else {CowStr::Borrowed("")}, title, id}),
            Event::Start(Tag::Image {link_type, dest_url, title, id: image_id}) => Event::Start(Tag::Image {link_type, dest_url: image_url(&dest_url, id).into(), title, id: image_id}),
            e => e,
        };
        if let Event::Start(Tag::Heading {level,..}) = &event { heading_start = Some(events.len()); heading_text.clear(); heading_level = *level as u8; }
        if heading_start.is_some() { match &event { Event::Text(t) | Event::Code(t) => heading_text.push_str(t), Event::SoftBreak | Event::HardBreak => heading_text.push(' '), _ => {} } }
        if matches!(event, Event::End(TagEnd::Heading(_))) {
            let base = slug(&heading_text); let n = used.entry(base.clone()).or_default();
            let mut anchor = if *n == 0 {base.clone()} else {format!("{base}-{n}")}; *n += 1;
            // IDs are unique even when a literal heading matches a generated suffix.
            while !anchors.insert(anchor.clone()) { anchor.push('-'); }
            if let Some(Event::Start(Tag::Heading {id,..})) = heading_start.and_then(|i|events.get_mut(i)) { *id = Some(anchor.clone().into()); }
            headings.push(Heading {id:anchor,text:heading_text.clone(),level:heading_level}); heading_start = None;
        }
        match &event { Event::Start(_) => depth += 1, Event::End(_) => depth = depth.saturating_sub(1), _ => {} }
        size += range.len().min(1024); events.push(event);
        if depth == 0 && size >= 12 * 1024 { let mut out = String::new(); html::push_html(&mut out, events.drain(..)); chunks.push(out); size = 0; }
    }
    if !events.is_empty() { let mut out = String::new(); html::push_html(&mut out, events.into_iter()); chunks.push(out); }
    (chunks, headings)
}
pub fn local_image(doc: &Document, raw: &str) -> Result<(Vec<u8>, &'static str), String> {
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().map_err(|e|e.to_string())?;
    let decoded = percent_encoding::percent_decode_str(&decoded).decode_utf8().map_err(|e|e.to_string())?;
    let relative = Path::new(decoded.as_ref());
    if relative.is_absolute() || decoded.contains(':') { return Err("Invalid image path".into()); }
    let path = doc.base.join(relative).canonicalize().map_err(|e|e.to_string())?;
    if !path.starts_with(&doc.base) { return Err("Image outside document directory".into()); }
    let mime = match path.extension().and_then(|x|x.to_str()).unwrap_or("").to_lowercase().as_str() { "png"=>"image/png", "jpg"|"jpeg"=>"image/jpeg", "gif"=>"image/gif", "webp"=>"image/webp", "avif"=>"image/avif", _=>return Err("Only raster images are supported".into()) };
    if fs::metadata(&path).map_err(|e|e.to_string())?.len() > 32*1024*1024 {return Err("Image exceeds 32 MB".into());}
    Ok((fs::read(path).map_err(|e|e.to_string())?, mime))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn untrusted_html_and_urls() {
        let (c,_) = render("<script>alert(1)</script>\n\n[bad](javascript:alert%281%29) ![bad](file:///etc/passwd)\n\n<img src=x onerror=alert(1)>\n\n[ok](https://example.com)",1);
        let s=c.concat(); assert!(!s.contains("<script")); assert!(!s.contains("onerror")); assert!(!s.contains("javascript:")); assert!(!s.contains("file:")); assert!(s.contains("https://example.com"));
    }
    #[test] fn headings_and_gfm() { let (c,h)=render("# Hello *world*\n\n# Hello world\n\n# Hello world-1\n\n- [x] task\n\n| A | B |\n|---|---|\n| a | b |\n\n~~gone~~",1); assert_eq!(h.len(),3); assert_eq!(h[1].id,"hello-world-1"); assert_ne!(h[1].id,h[2].id); let s=c.concat(); assert!(s.contains("<table>")); assert!(s.contains("type=\"checkbox\"")); assert!(s.contains("<del>")); }
    #[test] fn resource_confinement() { let d=tempfile::tempdir().unwrap(); fs::write(d.path().join("a.md"),"# hi").unwrap(); fs::write(d.path().join("ok.png"),b"png").unwrap(); fs::write(d.path().join("bad.svg"),"<svg/>").unwrap(); let doc=load(&d.path().join("a.md"),1).unwrap(); assert!(local_image(&doc,"ok.png").is_ok()); assert!(local_image(&doc,"../secret.png").is_err()); assert!(local_image(&doc,"bad.svg").is_err()); assert!(local_image(&doc,"%2Fetc%2Fpasswd").is_err()); }
}
