//! Live change feed: one long-running `hollr gate events` channel per server. Every change in herdr
//! (new workspace, closed pane, agent status …) and in the spaces' git state (pull, fetch, commit …)
//! is forwarded to the frontend as a `hollr-changed` event, so the UI refreshes right away instead of
//! waiting for the next poll.
//! (Desktop counterpart of the feed in `ios/Sources/Hollr/Model/HerdrStore.swift`.)

use std::collections::HashMap;
use std::time::Duration;

use russh::ChannelMsg;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::hollr::Hollr;

#[derive(Default)]
pub struct Feeds(Mutex<HashMap<String, JoinHandle<()>>>);

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
                let app = app.clone();
                feeds.insert(
                    id.clone(),
                    tokio::spawn(async move {
                        let hollr = app.state::<Hollr>();
                        follow(&hollr, &id, |name, payload| {
                            let _ = app.emit(name, payload);
                        })
                        .await;
                    }),
                );
            }
        }
    }
}

/// Follows one server's feed for good (reconnecting with backoff): `hollr-feed` {server, live} when the
/// channel comes up or goes down, `hollr-changed` {server, spaces} per change. (The dev bridge reuses it.)
pub async fn follow(hollr: &Hollr, server: &str, emit: impl Fn(&str, Value)) {
    let mut backoff = 2u64;
    loop {
        let mut unsupported = false;
        if let Ok(handle) = hollr.handle_for(server).await
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
                    let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
                    match v["t"].as_str() {
                        Some("ready") => {
                            backoff = 2;
                            emit("hollr-feed", json!({ "server": server, "live": true }));
                        }
                        Some("changed") => {
                            let spaces = v["spaces"].as_bool().unwrap_or(false);
                            emit("hollr-changed", json!({ "server": server, "spaces": spaces }));
                        }
                        None if v.get("error").is_some() => unsupported = true, // older server
                        _ => {}
                    }
                }
            }
        }
        emit("hollr-feed", json!({ "server": server, "live": false }));
        // an older server without the feed: polling covers it, look again in a few minutes
        tokio::time::sleep(Duration::from_secs(if unsupported { 300 } else { backoff })).await;
        backoff = (backoff * 2).min(30);
    }
}
