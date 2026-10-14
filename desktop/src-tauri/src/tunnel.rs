//! Localhost tunnel for the in-app browser: a listener on this computer's 127.0.0.1 forwards every
//! connection through the server's pooled SSH connection (direct-tcpip) to the server's own
//! `localhost:<port>`. Device keys may only forward to localhost, nothing else is exposed.
//! (Desktop counterpart of `ios/Sources/Hollr/SSH/Tunnel.swift`.)

use std::collections::HashMap;

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};

use crate::hollr::Hollr;

struct Tunnel {
    server: String,
    remote_port: u16,
    task: JoinHandle<()>,
}

/// Open tunnels by local port. Aborting a listener task drops its `JoinSet`, which aborts all
/// of its connections too.
#[derive(Default)]
pub struct Tunnels(Mutex<HashMap<u16, Tunnel>>);

impl Tunnels {
    /// Local port that leads to `localhost:<remote_port>` on `server` (reuses a running tunnel).
    pub async fn open(&self, app: AppHandle, server: String, remote_port: u16) -> Result<u16> {
        let mut tunnels = self.0.lock().await;
        tunnels.retain(|_, t| !t.task.is_finished());
        if let Some((&port, _)) = tunnels.iter().find(|(_, t)| t.server == server && t.remote_port == remote_port) {
            return Ok(port);
        }
        // connect first, so a server that is unreachable fails here and not on the first request
        app.state::<Hollr>().handle_for(&server).await?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.context("Lokaler Port")?;
        let local_port = listener.local_addr()?.port();
        let task = tokio::spawn(accept_loop(app, listener, server.clone(), remote_port));
        tunnels.insert(local_port, Tunnel { server, remote_port, task });
        Ok(local_port)
    }

    pub async fn close(&self, local_port: u16) {
        if let Some(t) = self.0.lock().await.remove(&local_port) {
            t.task.abort();
        }
    }

    /// All tunnels of a server (server removed).
    pub async fn close_server(&self, server: &str) {
        self.0.lock().await.retain(|_, t| {
            if t.server == server {
                t.task.abort();
                false
            } else {
                true
            }
        });
    }
}

async fn accept_loop(app: AppHandle, listener: TcpListener, server: String, remote_port: u16) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    connections.spawn(forward(app.clone(), socket, server.clone(), remote_port));
                }
                Err(e) => {
                    eprintln!("tunnel {server}:{remote_port}: accept: {e}");
                    break;
                }
            },
            // reap finished connections so the set doesn't grow
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// One local connection ⇄ one direct-tcpip channel, until either side closes.
async fn forward(app: AppHandle, mut socket: TcpStream, server: String, remote_port: u16) {
    socket.set_nodelay(true).ok();
    let hollr = app.state::<Hollr>();
    let mut channel = None;
    for attempt in 0..2 {
        let handle = match hollr.handle_for(&server).await {
            Ok(h) => h,
            Err(e) => {
                eprintln!("tunnel {server}:{remote_port}: {e:#}");
                return;
            }
        };
        match handle.channel_open_direct_tcpip("localhost", remote_port.into(), "127.0.0.1", 0).await {
            Ok(c) => {
                channel = Some(c);
                break;
            }
            // nothing listening on that port on the server: the connection itself is fine
            Err(russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed)) => return,
            Err(e) => {
                eprintln!("tunnel {server}:{remote_port} attempt {attempt}: {e}");
                // dead connection, or one opened before the server allowed forwarding: reconnect once
                if attempt == 0 {
                    hollr.invalidate(&server).await;
                }
            }
        }
    }
    let Some(channel) = channel else { return };
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
}
