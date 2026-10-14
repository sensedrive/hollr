// Dev only: serves the backend commands over HTTP on 127.0.0.1 so the frontend can be tested in a
// normal browser (`bun run dev`, then open http://localhost:1420/?bridge=7419).
//   cargo run --example bridge -- "<app data dir>" [port]
use hollr_desktop_lib::hollr::Hollr;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Arc::new(Hollr::new(args[1].clone().into()));
    let port = args.get(2).map(|p| p.parse()).transpose()?.unwrap_or(7419u16);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("bridge on 127.0.0.1:{port}");
    loop {
        let (mut sock, _) = listener.accept().await?;
        let hollr = hollr.clone();
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            // read headers + body (Content-Length)
            let body = loop {
                let Ok(n) = sock.read(&mut chunk).await else { return };
                if n == 0 { return; }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if buf.len() >= end + 4 + len { break String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string(); }
                }
            };
            let (status, out) = if body.is_empty() { (200, json!(null)) } else {
                let req: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                let a = &req["args"];
                let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
                let r: anyhow::Result<Value> = match req["cmd"].as_str().unwrap_or_default() {
                    "servers" => Ok(serde_json::to_value(hollr.servers()).unwrap()),
                    "gate" => hollr.gate(&s("server"), &s("command"), a["stdin"].as_str().map(String::from)).await.map(Value::String),
                    other => Err(anyhow::anyhow!("bridge: {other} not available")),
                };
                match r { Ok(v) => (200, v), Err(e) => (500, json!(format!("{e:#}"))) }
            };
            let body = out.to_string();
            let resp = format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: http://localhost:1420\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}
