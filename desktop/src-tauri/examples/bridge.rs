// Dev only: serves the backend commands over HTTP on 127.0.0.1 so the frontend can be tested in a
// normal browser (`bun run dev`, then open http://localhost:1420/?bridge=7419). Events (the live
// terminal's `hollr-term`, omp /live's `live`) come as server-sent events from GET /events.
// Live runs without microphone / speakers here: only the connection, phases and omp's state.
//   cargo run --example bridge -- "<app data dir>" [port]
use hollr_desktop_lib::hollr::Hollr;
use hollr_desktop_lib::live::{Emit, Lives, Options};
use hollr_desktop_lib::term::{self, Cmd};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, broadcast, mpsc};

type Terms = Arc<Mutex<(u64, HashMap<u64, mpsc::UnboundedSender<Cmd>>)>>;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Arc::new(Hollr::new(args[1].clone().into()));
    let (events, _) = broadcast::channel::<String>(4096);
    let terms: Terms = Default::default();
    let lives = Arc::new(Lives::default());
    let port = args.get(2).map(|p| p.parse()).transpose()?.unwrap_or(7419u16);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("bridge on 127.0.0.1:{port}");
    loop {
        let (mut sock, _) = listener.accept().await?;
        let hollr = hollr.clone();
        let (events, terms, lives) = (events.clone(), terms.clone(), lives.clone());
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
            if body.is_empty() && buf.starts_with(b"GET /events") {
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: http://localhost:1420\r\n\r\n";
                if sock.write_all(head.as_bytes()).await.is_err() { return; }
                let mut rx = events.subscribe();
                while let Ok(e) = rx.recv().await {
                    if sock.write_all(format!("data: {e}\n\n").as_bytes()).await.is_err() { return; }
                }
                return;
            }
            let (status, out) = if body.is_empty() { (200, json!(null)) } else {
                let req: Value = serde_json::from_str(&body).unwrap_or(json!({}));
                let a = &req["args"];
                let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
                let r: anyhow::Result<Value> = match req["cmd"].as_str().unwrap_or_default() {
                    "servers" => Ok(serde_json::to_value(hollr.servers()).unwrap()),
                    "gate" => hollr.gate(&s("server"), &s("command"), a["stdin"].as_str().map(String::from)).await.map(Value::String),
                    "term_start" => {
                        let (tx, rx) = mpsc::unbounded_channel();
                        let mut t = terms.lock().await;
                        t.0 += 1;
                        let id = t.0;
                        t.1.insert(id, tx);
                        let command = term::command(&s("mode"), &s("pane"), a["cols"].as_u64().unwrap_or(80) as u16, a["rows"].as_u64().unwrap_or(24) as u16);
                        let (hollr, server, events) = (hollr.clone(), s("server"), events.clone());
                        tokio::spawn(async move {
                            term::run_stream(&hollr, &server, command, rx, |e| {
                                let mut v = serde_json::to_value(e).unwrap();
                                v["id"] = json!(id);
                                let _ = events.send(json!({ "event": "hollr-term", "payload": v }).to_string());
                            }).await;
                        });
                        Ok(json!(id))
                    }
                    "term_write" | "term_resize" | "term_stop" => {
                        let mut t = terms.lock().await;
                        let id = a["id"].as_u64().unwrap_or_default();
                        let n = |k: &str| a[k].as_u64().unwrap_or_default() as u16;
                        match req["cmd"].as_str() {
                            Some("term_write") => { t.1.get(&id).map(|tx| tx.send(Cmd::Input(s("data")))); }
                            Some("term_resize") => { t.1.get(&id).map(|tx| tx.send(Cmd::Resize(n("cols"), n("rows")))); }
                            _ => { t.1.remove(&id); }
                        }
                        Ok(json!(null))
                    }
                    "live_start" => match hollr.handle_for(&s("server")).await {
                        Ok(handle) => {
                            let events = events.clone();
                            let emit: Emit = Arc::new(move |name: &str, v: Value| {
                                let _ = events.send(json!({ "event": name, "payload": v }).to_string());
                            });
                            lives.start(emit, handle, s("pane"), Options { headphones: false, audio: false }).await.map(|id| json!(id))
                        }
                        Err(e) => Err(e),
                    },
                    "live_stop" => Ok(json!(lives.stop(a["session"].as_u64().unwrap_or_default()).await)),
                    "live_mute" => { lives.mute(a["session"].as_u64().unwrap_or_default(), a["on"].as_bool().unwrap_or_default()).await; Ok(json!(null)) }
                    "live_speaker" => { lives.speaker(a["session"].as_u64().unwrap_or_default(), a["muted"].as_bool().unwrap_or_default()).await; Ok(json!(null)) }
                    "live_headphones" => { lives.headphones(a["on"].as_bool().unwrap_or_default()).await; Ok(json!(null)) }
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
