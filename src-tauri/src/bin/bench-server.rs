//! Development-only adapter for measuring the same native pipeline in a browser.
use paneless_lib::Reader;
fn main() {
    let reader = Reader::default();
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
                    let q = args["query"].as_str().unwrap_or("").to_lowercase();
                    serde_json::to_value(
                        d.texts
                            .iter()
                            .enumerate()
                            .filter_map(|(i, t)| t.to_lowercase().contains(&q).then_some(i))
                            .collect::<Vec<_>>(),
                    )
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
