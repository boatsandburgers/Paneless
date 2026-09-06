pub mod document;
use document::{Document, Info};
use notify::{Watcher, RecursiveMode};
use serde::Serialize;
use std::{fs, io::Write, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct Reader { pub current: Mutex<Option<Arc<Document>>>, serial: AtomicU64, pending: Mutex<Option<String>>, watcher: Mutex<Option<notify::RecommendedWatcher>> }
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct OpenResult { pub info: Info, pub first: String }
impl Reader {
    pub fn open(&self, path: &Path) -> Result<OpenResult,String> {
        let id = self.serial.fetch_add(1, Ordering::SeqCst)+1;
        let doc = document::load(path,id)?;
        let result = OpenResult {info:doc.info.clone(),first:doc.chunks.first().cloned().unwrap_or_default()};
        if self.serial.load(Ordering::SeqCst) != id { return Err("A newer file is opening.".into()); }
        *self.current.lock().unwrap() = Some(Arc::new(doc)); Ok(result)
    }
    pub fn get(&self, id:u64) -> Result<Arc<Document>,String> { self.current.lock().unwrap().as_ref().filter(|d|d.info.id==id).cloned().ok_or("Document is no longer open.".into()) }
    pub fn chunks(&self,id:u64,offset:usize)->Result<Vec<String>,String> { let d=self.get(id)?; Ok(d.chunks.iter().skip(offset).take(12).cloned().collect()) }
    pub fn save(&self,id:u64,source:String)->Result<(),String> {
        let doc=self.get(id)?; let path=Path::new(&doc.info.path);
        let disk=fs::read_to_string(path).map_err(|e|e.to_string())?;
        if document::fingerprint(&disk)!=doc.fingerprint {return Err("The file changed on disk. Copy your edits before reloading; your original file has not been overwritten.".into());}
        let mut tmp=tempfile::NamedTempFile::new_in(&doc.base).map_err(|e|e.to_string())?;
        tmp.as_file().set_permissions(fs::metadata(path).map_err(|e|e.to_string())?.permissions()).map_err(|e|e.to_string())?;
        tmp.write_all(source.as_bytes()).map_err(|e|e.to_string())?; tmp.as_file().sync_all().map_err(|e|e.to_string())?;
        tmp.persist(path).map_err(|e|e.to_string())?;
        // Update the baseline immediately so consecutive saves remain valid.
        let mut current=self.current.lock().unwrap();
        if current.as_ref().is_some_and(|d|d.info.id==id) {
            let mut info=doc.info.clone(); info.bytes=source.len();
            *current=Some(Arc::new(Document {info,chunks:Vec::new(),fingerprint:document::fingerprint(&source),source,base:doc.base.clone()}));
        }
        Ok(())
    }
}
fn watch(app:&tauri::AppHandle,path:PathBuf) {
    let handle=app.clone(); let target=path.clone(); let mut last=Instant::now()-Duration::from_secs(1);
    let watcher=notify::recommended_watcher(move |event:Result<notify::Event,notify::Error>| {
        if let Ok(event)=event { if (event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove()) && event.paths.iter().any(|p|p==&target) && last.elapsed()>Duration::from_millis(150) {last=Instant::now(); let _=handle.emit("file-changed",target.to_string_lossy().to_string());} }
    });
    if let Ok(mut watcher)=watcher { if watcher.watch(path.parent().unwrap(),RecursiveMode::NonRecursive).is_ok() { *app.state::<Reader>().watcher.lock().unwrap()=Some(watcher); } }
}
#[tauri::command]
async fn open_document(app:tauri::AppHandle,path:String)->Result<OpenResult,String> {
    tauri::async_runtime::spawn_blocking(move || { let result=app.state::<Reader>().open(Path::new(&path))?; watch(&app,PathBuf::from(&result.info.path)); Ok(result) }).await.map_err(|e|e.to_string())?
}
#[tauri::command] fn document_chunks(state:State<Reader>,id:u64,offset:usize)->Result<Vec<String>,String>{state.chunks(id,offset)}
#[tauri::command] fn document_source(state:State<Reader>,id:u64)->Result<String,String>{Ok(state.get(id)?.source.clone())}
#[tauri::command] async fn save_document(app:tauri::AppHandle,id:u64,source:String)->Result<(),String>{tauri::async_runtime::spawn_blocking(move||app.state::<Reader>().save(id,source)).await.map_err(|e|e.to_string())?}
#[tauri::command] fn take_pending(state:State<Reader>)->Option<String>{state.pending.lock().unwrap().take()}
fn deliver(app:&tauri::AppHandle,path:PathBuf) { if document::is_markdown(&path) { *app.state::<Reader>().pending.lock().unwrap()=Some(path.to_string_lossy().into()); let _=app.emit("open-file",()); if let Some(w)=app.get_webview_window("main"){let _=w.unminimize();let _=w.set_focus();} } }
pub fn run() {
    let app=tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,args,cwd|{for arg in args.iter().skip(1){let p=Path::new(arg);deliver(app,if p.is_absolute(){p.into()}else{Path::new(&cwd).join(p)});}}))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Reader::default())
        .register_asynchronous_uri_scheme_protocol("mdimage",|ctx,request,responder| {
            let app=ctx.app_handle().clone();
            std::thread::spawn(move||{
                let result=(||{ let uri=request.uri().path().trim_start_matches('/'); let (id,path)=uri.split_once('/').ok_or("Invalid resource")?; let id=id.parse::<u64>().map_err(|_|"Invalid document")?; let doc=app.state::<Reader>().get(id)?; document::local_image(&doc,path) })();
                let response=match result { Ok((bytes,mime))=>tauri::http::Response::builder().header("Content-Type",mime).header("X-Content-Type-Options","nosniff").body(bytes).unwrap(), Err(_)=>tauri::http::Response::builder().status(403).body(Vec::new()).unwrap() };
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![open_document,document_chunks,document_source,save_document,take_pending])
        .setup(|app|{for arg in std::env::args().skip(1) {deliver(app.handle(),PathBuf::from(arg));} Ok(())})
        .build(tauri::generate_context!()).expect("Could not start Paneless");
    app.run(|app,event|{
        #[cfg(target_os="macos")]
        if let tauri::RunEvent::Opened {urls}=event {for url in urls {if let Ok(path)=url.to_file_path(){deliver(app,path);}}}
        #[cfg(not(target_os="macos"))] let _=(app,event);
    });
}
