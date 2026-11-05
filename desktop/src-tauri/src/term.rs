//! A real terminal per open terminal view: `hollr gate attach <pane> <cols> <rows>` (the pane's own
//! TUI in a PTY sized to the view) or `hollr gate shell <pane> <cols> <rows>` (an own shell in the
//! pane's folder). Typing and resizes go in as JSON lines (`{"t":"in","d":…}`, `{"t":"resize",…}`),
//! the output comes out as `hollr-term` events ({id, kind, …}, see `TermEvent`). One connection per
//! start: the view starts a new one when this one ends without an answer (`end`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep_until, Instant};

use crate::hollr::Hollr;

/// The server pings every 20 s: this long without a line = the connection is dead.
const WATCHDOG: Duration = Duration::from_secs(50);
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// The server takes at most 8192 characters (UTF-16) per `in` message.
const INPUT_CHUNK: usize = 4000;

/// What one stream reports. `exit` / `error` / `closed` / `unsupported` / `failed` are answers
/// (no retry); `end` is a dropped connection (the view reconnects).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TermEvent {
    /// terminal output, written to xterm as it is
    Out { data: String },
    /// the shell / attach process ended
    Exit { code: Option<i64> },
    /// the server's own error (`not_found`: the pane is gone, shell disabled …)
    Error { error: String },
    /// the session was closed
    Closed,
    /// older server without `attach` / `shell` (`{"error":"not_allowed"}`)
    Unsupported,
    /// no connection, and retrying won't help (host key changed, no longer paired …)
    Failed { error: String },
    /// the stream ended without an answer: the connection is gone
    End {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl TermEvent {
    fn is_answer(&self) -> bool {
        !matches!(self, TermEvent::Out { .. } | TermEvent::End { .. })
    }
}

/// One stdout line of `attach` / `shell` → its event (`ping` and unknown lines: none).
pub fn parse_line(line: &str) -> Option<TermEvent> {
    let v: Value = serde_json::from_str(line).ok()?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    match v.get("t").and_then(Value::as_str) {
        Some("out") => Some(TermEvent::Out { data: text("d")? }),
        Some("exit") => Some(TermEvent::Exit { code: v.get("code").and_then(Value::as_i64) }),
        Some("error") => Some(TermEvent::Error { error: text("error").unwrap_or_default() }),
        Some("closed") => Some(TermEvent::Closed),
        Some(_) => None,
        None => match text("error")?.as_str() {
            "not_allowed" => Some(TermEvent::Unsupported),
            other => Some(TermEvent::Error { error: other.to_string() }),
        },
    }
}

/// `attach` / `shell` command line for the gate.
pub fn command(mode: &str, pane: &str, cols: u16, rows: u16) -> String {
    let verb = if mode == "shell" { "shell" } else { "attach" };
    format!("{verb} {pane} {cols} {rows}")
}

pub enum Cmd {
    Input(String),
    Resize(u16, u16),
}

impl Cmd {
    /// The JSON lines for the server (long input split so none gets cut off).
    fn lines(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut push = |v: Value| {
            out.extend_from_slice(v.to_string().as_bytes());
            out.push(b'\n');
        };
        match self {
            Cmd::Input(text) => {
                let chars: Vec<char> = text.chars().collect();
                for chunk in chars.chunks(INPUT_CHUNK) {
                    push(serde_json::json!({ "t": "in", "d": chunk.iter().collect::<String>() }));
                }
            }
            Cmd::Resize(cols, rows) => push(serde_json::json!({ "t": "resize", "cols": cols, "rows": rows })),
        }
        out
    }
}

/// Connection problems that won't go away by retrying.
fn fatal(error: &str) -> bool {
    ["Server-Schlüssel", "Anmeldung abgelehnt", "Server nicht gefunden"].iter().any(|s| error.contains(s))
}

/// Runs one stream until it ends, the server answers, or `cmds` is closed (stopped by the view –
/// then nothing more is emitted). Commands sent while connecting go out once the stream is open.
pub async fn run_stream(
    hollr: &Hollr,
    server: &str,
    command: String,
    mut cmds: mpsc::UnboundedReceiver<Cmd>,
    emit: impl Fn(TermEvent),
) {
    let connect = async {
        let handle = hollr.handle_for(server).await.map_err(|e| format!("{e:#}"))?;
        let opened = tokio::time::timeout(OPEN_TIMEOUT, async {
            let channel = handle.channel_open_session().await?;
            channel.exec(true, command.as_str()).await?;
            Ok::<_, russh::Error>(channel)
        })
        .await;
        match opened {
            Ok(Ok(c)) => Ok(c),
            Ok(Err(e)) => {
                hollr.invalidate(server).await;
                Err(e.to_string())
            }
            // a dead pooled connection: the next start reconnects
            Err(_) => {
                hollr.invalidate(server).await;
                Err("Zeitüberschreitung".to_string())
            }
        }
    };
    tokio::pin!(connect);
    let mut early = Vec::new();
    let opened = loop {
        tokio::select! {
            r = &mut connect => break r,
            c = cmds.recv() => match c {
                Some(c) => early.push(c),
                None => return,
            },
        }
    };
    let mut channel = match opened {
        Ok(c) => c,
        Err(error) if fatal(&error) => return emit(TermEvent::Failed { error }),
        Err(error) => return emit(TermEvent::End { error: Some(error) }),
    };

    let mut dropped: Option<String> = None;
    let mut answered = false;
    let mut by_user = false;
    for c in early {
        if let Err(e) = channel.data(&c.lines()[..]).await {
            dropped = Some(e.to_string());
            break;
        }
    }
    let mut buf = Vec::<u8>::new();
    let mut deadline = Instant::now() + WATCHDOG;
    while dropped.is_none() && !answered {
        tokio::select! {
            m = channel.wait() => match m {
                Some(ChannelMsg::Data { data }) => {
                    deadline = Instant::now() + WATCHDOG;
                    buf.extend_from_slice(&data);
                    // the output of one chunk as one event
                    let mut out = String::new();
                    while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=nl).collect();
                        match parse_line(String::from_utf8_lossy(&line).trim()) {
                            Some(TermEvent::Out { data }) => out.push_str(&data),
                            Some(e) => {
                                if !out.is_empty() {
                                    emit(TermEvent::Out { data: std::mem::take(&mut out) });
                                }
                                answered |= e.is_answer();
                                emit(e);
                            }
                            None => {}
                        }
                    }
                    if !out.is_empty() {
                        emit(TermEvent::Out { data: out });
                    }
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            c = cmds.recv() => match c {
                Some(c) => {
                    if let Err(e) = channel.data(&c.lines()[..]).await {
                        dropped = Some(e.to_string());
                    }
                }
                None => {
                    by_user = true;
                    break;
                }
            },
            _ = sleep_until(deadline) => {
                // no ping for too long: the connection is dead, the next start opens a new one
                hollr.invalidate(server).await;
                dropped = Some("keine Antwort vom Server".to_string());
            }
        }
    }
    // closing stdin hangs up the shell / detaches herdr on the server
    let _ = channel.eof().await;
    let _ = channel.close().await;
    if !by_user && !answered {
        emit(TermEvent::End { error: dropped });
    }
}

#[derive(Default)]
pub struct Terms {
    next: AtomicU64,
    /// stream id → (the webview that started it, its input)
    running: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<Cmd>)>>,
}

#[derive(Clone, Serialize)]
struct Envelope {
    id: u64,
    #[serde(flatten)]
    event: TermEvent,
}

impl Terms {
    /// Starts a stream for webview `owner`; its `hollr-term` events carry the returned id.
    pub async fn start(&self, app: AppHandle, owner: String, server: String, command: String) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::unbounded_channel();
        let mut running = self.running.lock().await;
        // finished streams leave a closed sender behind
        running.retain(|_, (_, s)| !s.is_closed());
        running.insert(id, (owner, tx));
        tokio::spawn(async move {
            let hollr = app.state::<Hollr>();
            run_stream(&hollr, &server, command, rx, |event| {
                let _ = app.emit("hollr-term", Envelope { id, event });
            })
            .await;
        });
        id
    }

    async fn send(&self, id: u64, cmd: Cmd) {
        if let Some((_, tx)) = self.running.lock().await.get(&id) {
            let _ = tx.send(cmd);
        }
    }

    pub async fn write(&self, id: u64, data: String) {
        self.send(id, Cmd::Input(data)).await;
    }

    pub async fn resize(&self, id: u64, cols: u16, rows: u16) {
        self.send(id, Cmd::Resize(cols, rows)).await;
    }

    /// Ends the stream (the channel closes, the server hangs up); nothing more is emitted for it.
    pub async fn stop(&self, id: u64) {
        self.running.lock().await.remove(&id);
    }

    /// Webview `owner` (re)loaded or closed: no view is left to stop its terminals, so their shells would stay open.
    /// Another window's terminals keep running.
    pub async fn stop_owned(&self, owner: &str) {
        self.running.lock().await.retain(|_, (o, _)| o != owner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_server_lines() {
        assert_eq!(parse_line(r#"{"t":"out","d":"a\u001b[1m"}"#), Some(TermEvent::Out { data: "a\x1b[1m".into() }));
        assert_eq!(parse_line(r#"{"t":"exit","code":0}"#), Some(TermEvent::Exit { code: Some(0) }));
        assert_eq!(parse_line(r#"{"t":"error","error":"not_found"}"#), Some(TermEvent::Error { error: "not_found".into() }));
        assert_eq!(parse_line(r#"{"t":"closed"}"#), Some(TermEvent::Closed));
        assert_eq!(parse_line(r#"{"error":"not_allowed","hint":"…"}"#), Some(TermEvent::Unsupported));
        assert_eq!(parse_line(r#"{"t":"ping"}"#), None);
        assert_eq!(parse_line("garbage"), None);
    }

    #[test]
    fn splits_long_input() {
        let text = "ä".repeat(INPUT_CHUNK + 1);
        let lines = String::from_utf8(Cmd::Input(text).lines()).unwrap();
        let parts: Vec<Value> = lines.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["d"], "ä");
        let resize: Value = serde_json::from_slice(&Cmd::Resize(80, 24).lines()).unwrap();
        assert_eq!(resize, serde_json::json!({ "t": "resize", "cols": 80, "rows": 24 }));
    }

    #[test]
    fn events_serialize_flat() {
        let v = serde_json::to_value(Envelope { id: 3, event: TermEvent::End { error: None } }).unwrap();
        assert_eq!(v, serde_json::json!({ "id": 3, "kind": "end" }));
    }
}
