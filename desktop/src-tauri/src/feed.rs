//! Live change feed: one long-running `hollr gate events` channel per server. Every change in herdr
//! (new workspace, closed pane, agent status …) is forwarded to the frontend as a `hollr-changed`
//! event, so the UI refreshes right away instead of waiting for the next poll.
//! (Desktop counterpart of the feed in `ios/Sources/Hollr/Model/HerdrStore.swift`.)

use std::collections::HashMap;
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::hollr::Hollr;

#[derive(Default)]
pub struct Feeds(Mutex<HashMap<String, JoinHandle<()>>>);

#[derive(Clone, Serialize)]
struct Changed {
    server: String,
    spaces: bool,
}

#[derive(Clone, Serialize)]
struct Live {
    server: String,
    live: bool,
}

impl Feeds {
    /// Makes sure exactly these servers have a running feed.
    pub async fn sync(&self, app: AppHandle, servers: Vec<String>) {
        let mut feeds = self.0.lock().await;
        feeds.retain(|id, task| {
            let keep = servers.contains(id) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });
        for id in servers {
            if !feeds.contains_key(&id) {
                feeds.insert(id.clone(), tokio::spawn(run(app.clone(), id)));
            }
        }
    }
}

async fn run(app: AppHandle, server: String) {
    let mut backoff = 2u64;
    loop {
        let mut unsupported = false;
        let hollr = app.state::<Hollr>();
        if let Ok(handle) = hollr.handle_for(&server).await
            && let Ok(mut channel) = handle.channel_open_session().await
            && channel.exec(true, "events").await.is_ok()
        {
            let mut buf = Vec::<u8>::new();
            while let Some(msg) = channel.wait().await {
                let ChannelMsg::Data { data } = msg else {
                    if matches!(msg, ChannelMsg::Eof | ChannelMsg::Close) {
                        break;
                    }
                    continue;
                };
                buf.extend_from_slice(&data);
                while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=nl).collect();
                    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
                    match v["t"].as_str() {
                        Some("ready") => {
                            backoff = 2;
                            let _ = app.emit("hollr-feed", Live { server: server.clone(), live: true });
                        }
                        Some("changed") => {
                            let spaces = v["spaces"].as_bool().unwrap_or(false);
                            let _ = app.emit("hollr-changed", Changed { server: server.clone(), spaces });
                        }
                        None if v.get("error").is_some() => unsupported = true, // older server
                        _ => {}
                    }
                }
            }
        }
        let _ = app.emit("hollr-feed", Live { server: server.clone(), live: false });
        // an older server without the feed: polling covers it, look again in a few minutes
        tokio::time::sleep(Duration::from_secs(if unsupported { 300 } else { backoff })).await;
        backoff = (backoff * 2).min(30);
    }
}
