//! The chat as a stream: one `hollr gate follow <pane> 150` channel per open session view.
//! Every stdout line goes to the frontend unparsed as a `hollr-follow` event ({id, line});
//! the end of the stream as {id, end: true} (the view reconnects). Stopping closes the
//! channel, the server process exits when its stdin closes.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex};

use crate::hollr::Hollr;

/// The server pings every 20 s: this long without a line = the connection is dead.
const WATCHDOG: Duration = Duration::from_secs(50);
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct Follows {
    next: AtomicU64,
    running: Mutex<HashMap<u64, oneshot::Sender<()>>>,
}

#[derive(Clone, Serialize)]
struct Line {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    end: bool,
}

impl Follows {
    /// Starts a stream; its events carry the returned id.
    pub async fn start(&self, app: AppHandle, server: String, pane: String) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (stop, stopped) = oneshot::channel();
        let mut running = self.running.lock().await;
        // finished streams leave a closed sender behind
        running.retain(|_, s| !s.is_closed());
        running.insert(id, stop);
        tokio::spawn(run(app, id, server, pane, stopped));
        id
    }

    pub async fn stop(&self, id: u64) {
        if let Some(stop) = self.running.lock().await.remove(&id) {
            let _ = stop.send(());
        }
    }
}

async fn run(app: AppHandle, id: u64, server: String, pane: String, mut stopped: oneshot::Receiver<()>) {
    let emit = |line: Option<String>, end: bool| {
        let _ = app.emit("hollr-follow", Line { id, line, end });
    };
    let hollr = app.state::<Hollr>();
    let opened = async {
        let handle = hollr.handle_for(&server).await.ok()?;
        let opened = tokio::time::timeout(OPEN_TIMEOUT, async {
            let channel = handle.channel_open_session().await?;
            channel.exec(true, format!("follow {pane} 150")).await?;
            Ok::<_, russh::Error>(channel)
        })
        .await;
        match opened {
            Ok(Ok(c)) => Some(c),
            // a dead pooled connection: the next start reconnects
            _ => {
                hollr.invalidate(&server).await;
                None
            }
        }
    };
    let channel = tokio::select! {
        c = opened => c,
        _ = &mut stopped => return,
    };
    let Some(mut channel) = channel else {
        emit(None, true);
        return;
    };
    let mut buf = Vec::<u8>::new();
    let mut by_user = false;
    loop {
        let msg = tokio::select! {
            m = tokio::time::timeout(WATCHDOG, channel.wait()) => m,
            _ = &mut stopped => {
                by_user = true;
                break;
            }
        };
        let Ok(Some(msg)) = msg else { break }; // watchdog or channel gone
        match msg {
            ChannelMsg::Data { data } => {
                buf.extend_from_slice(&data);
                while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=nl).collect();
                    let line = String::from_utf8_lossy(&line).trim().to_string();
                    if !line.is_empty() {
                        emit(Some(line), false);
                    }
                }
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = channel.eof().await;
    let _ = channel.close().await;
    if !by_user {
        emit(None, true);
    }
}
