//! Hollr desktop backend: device key, paired servers, pinned SSH connections and the
//! `hollr gate` calls the UI makes (same protocol as the iPhone app).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use russh::client::{self, Handle};
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub label: String,
    pub user: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub host_fingerprint: String,
    pub device_id: String,
    /// lan / tailscale / auto (from the pairing code; older servers: none)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    /// ms; set when paired. The user's machine list (`hollr gate machines`) keeps the newest version per
    /// machine – records from before it count as 1, so a removal made on another device wins over them.
    #[serde(default = "first_version")]
    pub updated_at: u64,
}

const fn first_version() -> u64 {
    1
}

/// A server removed here, kept so the removal spreads to the user's other devices (machines sync) and an
/// older entry elsewhere doesn't bring it back. Same shape as a machine entry on the server.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub fp: String,
    pub label: String,
    pub addresses: Vec<String>,
    pub port: u16,
    pub user: String,
    pub updated_at: u64,
    pub removed: bool,
}

/// Tombstones older than this are dropped: every device has long seen the removal by then.
const TOMBSTONE_MS: u64 = 90 * 24 * 3600 * 1000;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The gate command's name only (logs keep no pane ids or arguments).
fn first_word(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// `hollr://pair?c=<base64url(JSON)>`
#[derive(Deserialize)]
struct PairingPayload {
    v: u32,
    a: Vec<String>,
    p: u16,
    u: String,
    fp: String,
    s: String,
    e: f64,
    l: String,
    #[serde(default)]
    n: Option<String>,
}

/// The pooled connections to one server; its own lock so a slow connect only blocks that server.
type Slot = Arc<Mutex<Vec<Arc<Conn>>>>;

/// sshd allows 10 session channels per connection (`MaxSessions`). Chats, terminals, the feed and live calls keep
/// theirs open; past that every further `gate` call is refused with "ConnectFailed" (the server then showed
/// „Keine Verbindung“ while its terminal kept working). A connection takes at most this many – the next one opens
/// another connection.
const SESSION_BUDGET: usize = 8;

/// One SSH connection and how many session channels run on it right now.
pub struct Conn {
    handle: Arc<Handle<Pinned>>,
    sessions: std::sync::atomic::AtomicUsize,
}

/// A session channel's place on a pooled connection: hold it as long as the channel lives; dropping it frees
/// the place. Derefs to the connection's handle.
pub struct Lease {
    conn: Arc<Conn>,
}

impl Lease {
    /// The connection itself (to drop it when it turned out dead).
    pub fn arc(&self) -> Arc<Handle<Pinned>> {
        self.conn.handle.clone()
    }
}

impl std::ops::Deref for Lease {
    type Target = Handle<Pinned>;
    fn deref(&self) -> &Handle<Pinned> {
        &self.conn.handle
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.conn.sessions.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Opening a channel on a pooled connection: longer means the connection is dead (e.g. after sleep).
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for one gate command's answer (git / worktree ops can take a while).
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
/// Uploads (up to 20 MB of base64 on stdin) over a slow link.
pub const LONG_TIMEOUT: Duration = Duration::from_secs(180);

pub struct Hollr {
    dir: PathBuf,
    pool: std::sync::Mutex<HashMap<String, Slot>>,
}

/// Accepts exactly the host key fingerprint from pairing ("SHA256:…").
pub struct Pinned {
    fingerprint: String,
}

impl client::Handler for Pinned {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let got = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };
        if got != self.fingerprint {
            bail!("Server-Schlüssel stimmt nicht (erwartet {}, bekommen {}). Nicht verbinden – Server neu koppeln.", self.fingerprint, got);
        }
        Ok(true)
    }
}

impl Hollr {
    pub fn new(dir: PathBuf) -> Self {
        std::fs::create_dir_all(&dir).ok();
        Self { dir, pool: Default::default() }
    }

    // ------------------------------------------------------------ storage

    fn servers_file(&self) -> PathBuf {
        self.dir.join("servers.json")
    }

    pub fn servers(&self) -> Vec<Server> {
        std::fs::read(self.servers_file())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save_servers(&self, servers: &[Server]) -> Result<()> {
        std::fs::write(self.servers_file(), serde_json::to_vec_pretty(servers)?)?;
        Ok(())
    }

    /// `removed_at`: when it was removed – now when the user removes it here, the removal's own time when it
    /// was removed on another device (machines sync). Leaves a tombstone so the removal spreads.
    pub async fn remove_server(&self, id: &str, removed_at: Option<u64>) -> Result<()> {
        let (gone, servers): (Vec<Server>, Vec<Server>) = self.servers().into_iter().partition(|s| s.id == id);
        self.save_servers(&servers)?;
        for s in gone {
            // another record (other user) for the same machine keeps it alive
            if servers.iter().any(|o| o.host_fingerprint == s.host_fingerprint) {
                continue;
            }
            let mut stones: Vec<Tombstone> = self.tombstones().into_iter().filter(|t| t.fp != s.host_fingerprint).collect();
            stones.push(Tombstone {
                fp: s.host_fingerprint,
                label: s.label,
                addresses: s.addresses,
                port: s.port,
                user: s.user,
                updated_at: removed_at.unwrap_or_else(now_ms),
                removed: true,
            });
            self.save_tombstones(&stones)?;
        }
        self.invalidate(id).await;
        Ok(())
    }

    fn tombstones_file(&self) -> PathBuf {
        self.dir.join("removed-servers.json")
    }

    /// Servers removed here in the last 90 days.
    pub fn tombstones(&self) -> Vec<Tombstone> {
        let since = now_ms().saturating_sub(TOMBSTONE_MS);
        std::fs::read(self.tombstones_file())
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Tombstone>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|t| t.updated_at >= since)
            .collect()
    }

    fn save_tombstones(&self, stones: &[Tombstone]) -> Result<()> {
        std::fs::write(self.tombstones_file(), serde_json::to_vec_pretty(stones)?)?;
        Ok(())
    }

    /// This app installation's id (random, made once): pairing requests and invites between the user's
    /// devices name the asking installation with it.
    pub fn install_id(&self) -> Result<String> {
        let path = self.dir.join("install_id");
        if let Ok(id) = std::fs::read_to_string(&path) {
            let id = id.trim();
            if !id.is_empty() {
                return Ok(id.to_string());
            }
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|e| anyhow!("Zufall: {e}"))?;
        let id = URL_SAFE_NO_PAD.encode(bytes);
        std::fs::write(&path, &id)?;
        Ok(id)
    }

    /// This computer's Ed25519 key (seed file, mode 600).
    fn device_key(&self) -> Result<PrivateKey> {
        let path = self.dir.join("device_key");
        let seed: [u8; 32] = match std::fs::read(&path) {
            Ok(b) if b.len() == 32 => b.try_into().unwrap(),
            _ => {
                let mut seed = [0u8; 32];
                getrandom::fill(&mut seed).map_err(|e| anyhow!("Zufall: {e}"))?;
                std::fs::write(&path, seed)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
                }
                seed
            }
        };
        Ok(PrivateKey::from(Ed25519Keypair::from_seed(&seed)))
    }

    // ------------------------------------------------------------ ssh

    async fn connect(addresses: &[String], port: u16, user: &str, fingerprint: &str, key: PrivateKey) -> Result<Handle<Pinned>> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(20)),
            ..Default::default()
        });
        let key = Arc::new(key);
        let mut last = anyhow!("keine Adresse");
        for host in addresses {
            let attempt = tokio::time::timeout(
                Duration::from_secs(8),
                client::connect(config.clone(), (host.as_str(), port), Pinned { fingerprint: fingerprint.to_string() }),
            )
            .await;
            match attempt {
                Ok(Ok(mut handle)) => {
                    let auth = tokio::time::timeout(
                        Duration::from_secs(8),
                        handle.authenticate_publickey(user, PrivateKeyWithHashAlg::new(key.clone(), None)),
                    )
                    .await;
                    let Ok(auth) = auth else {
                        last = anyhow!("{host}: Anmeldung – Zeitüberschreitung");
                        continue;
                    };
                    if !auth?.success() {
                        bail!("Anmeldung abgelehnt – ist dieser Rechner noch gekoppelt?");
                    }
                    return Ok(handle);
                }
                Ok(Err(e)) => {
                    // wrong host key: never try the next address
                    if e.to_string().contains("Server-Schlüssel") {
                        return Err(e);
                    }
                    last = anyhow!("{host}: {e}");
                }
                Err(_) => last = anyhow!("{host}: Zeitüberschreitung"),
            }
        }
        Err(anyhow!("Server nicht erreichbar: {last}"))
    }

    /// Drops the pooled connections, the next call reconnects (users of the old handles keep them).
    pub async fn invalidate(&self, server_id: &str) {
        self.pool.lock().unwrap().remove(server_id);
    }

    /// Drops this (stale) connection from the pool – the others and a fresh reconnect stay.
    pub async fn drop_stale(&self, server_id: &str, stale: &Arc<Handle<Pinned>>) {
        let slot = self.pool.lock().unwrap().get(server_id).cloned();
        if let Some(slot) = slot {
            slot.lock().await.retain(|c| !Arc::ptr_eq(&c.handle, stale));
        }
    }

    /// A place for one session channel on a pooled connection to a paired server (see `Lease`).
    pub async fn handle_for(&self, server_id: &str) -> Result<Lease> {
        let server = self.servers().into_iter().find(|s| s.id == server_id).context("Server nicht gefunden")?;
        self.handle(&server).await
    }

    /// Any pooled connection, for channels that aren't sessions (tunnels: sshd's session limit doesn't count them).
    pub async fn connection_for(&self, server_id: &str) -> Result<Arc<Handle<Pinned>>> {
        Ok(self.handle_for(server_id).await?.arc())
    }

    async fn handle(&self, server: &Server) -> Result<Lease> {
        use std::sync::atomic::Ordering;
        // the map lock is only held for the lookup, the connect waits on this server's slot alone
        let slot = self.pool.lock().unwrap().entry(server.id.clone()).or_default().clone();
        let mut pooled = slot.lock().await;
        pooled.retain(|c| !c.handle.is_closed());
        if let Some(conn) = pooled.iter().find(|c| c.sessions.load(Ordering::Relaxed) < SESSION_BUDGET) {
            conn.sessions.fetch_add(1, Ordering::Relaxed);
            return Ok(Lease { conn: conn.clone() });
        }
        let handle = Arc::new(
            Self::connect(&server.addresses, server.port, &server.user, &server.host_fingerprint, self.device_key()?).await?,
        );
        if !pooled.is_empty() {
            crate::diag::write(&format!("pool {}: connection {} (the others are full)", server.label, pooled.len() + 1));
        }
        let conn = Arc::new(Conn { handle, sessions: std::sync::atomic::AtomicUsize::new(1) });
        pooled.push(conn.clone());
        Ok(Lease { conn })
    }

    /// Runs one `hollr gate` command; `stdin` (one JSON line) is sent first. Returns stdout.
    async fn exec(handle: &Handle<Pinned>, command: &str, stdin: Option<&str>) -> Result<String> {
        let channel = Self::open(handle, command, stdin).await?;
        Self::collect(channel).await
    }

    /// Opens a channel and starts `command` (stdin is sent right away).
    async fn open(handle: &Handle<Pinned>, command: &str, stdin: Option<&str>) -> Result<russh::Channel<client::Msg>> {
        let channel = handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        if let Some(input) = stdin {
            Self::send_line(&channel, input).await?;
        }
        Ok(channel)
    }

    /// One line on stdin, then EOF.
    async fn send_line(channel: &russh::Channel<client::Msg>, input: &str) -> Result<()> {
        let mut line = input.as_bytes().to_vec();
        line.push(b'\n');
        channel.data(&line[..]).await?;
        channel.eof().await?;
        Ok(())
    }

    /// Reads stdout until the command ends.
    async fn collect(mut channel: russh::Channel<client::Msg>) -> Result<String> {
        let mut out = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    pub async fn gate(&self, server_id: &str, command: &str, stdin: Option<String>) -> Result<String> {
        self.gate_with(server_id, command, stdin, REPLY_TIMEOUT).await
    }

    /// `gate` for big stdin (uploads): only the channel open has the short timeout, sending the
    /// data counts into `reply`.
    pub async fn gate_with(&self, server_id: &str, command: &str, stdin: Option<String>, reply: Duration) -> Result<String> {
        let server = self.servers().into_iter().find(|s| s.id == server_id).context("Server nicht gefunden")?;
        let late = reply > REPLY_TIMEOUT;
        for attempt in 0..3 {
            if attempt == 2 {
                // right after waking up every stream reconnects at once: give the burst a moment
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let handle = self.handle(&server).await?;
            let early = if late { None } else { stdin.as_deref() };
            // a dead connection (e.g. after sleep) never answers the channel open: time out, reconnect once
            let opened = tokio::time::timeout(OPEN_TIMEOUT, Self::open(&handle, command, early))
                .await
                .unwrap_or_else(|_| Err(anyhow!("Zeitüberschreitung")));
            let channel = match opened {
                Ok(c) => {
                    if attempt > 0 {
                        crate::diag::write(&format!("gate {}: {} worked after reconnecting", server.label, first_word(command)));
                    }
                    c
                }
                Err(e) => {
                    // why a server shows „Keine Verbindung“ while its terminal still works: the open failed on this
                    // connection (sshd's channel limit after a wake-up burst, a half-dead connection, …)
                    crate::diag::write(&format!("gate {}: {} channel open failed (try {}): {e}", server.label, first_word(command), attempt + 1));
                    self.drop_stale(&server.id, &handle.arc()).await;
                    if attempt < 2 {
                        continue;
                    }
                    // russh's "Failed to open channel (ConnectFailed)" means sshd refused one more session
                    if e.to_string().contains("ConnectFailed") {
                        return Err(anyhow!("Der Server nimmt gerade keine weitere Sitzung an – gleich wieder versuchen"));
                    }
                    return Err(e);
                }
            };
            // the command runs now: no retry (it may not be idempotent), but never hang forever
            let run = async {
                if late && let Some(input) = stdin.as_deref() {
                    Self::send_line(&channel, input).await?;
                }
                Self::collect(channel).await
            };
            return match tokio::time::timeout(reply, run).await {
                Ok(out) => out,
                Err(_) => {
                    self.drop_stale(&server.id, &handle.arc()).await;
                    Err(anyhow!("Zeitüberschreitung – keine Antwort vom Server"))
                }
            };
        }
        unreachable!()
    }

    // ------------------------------------------------------------ pairing

    pub async fn pair(&self, link: &str, device_name: &str) -> Result<Server> {
        self.enroll(&Self::link_payload(link)?, device_name, None, now_ms()).await
    }

    /// Pairing with an invite another of the user's devices asked machine X for (machines sync): like a
    /// scanned link, but quiet – the label and version come from the shared machine entry, so this record is
    /// the same entry everywhere.
    pub async fn pair_invite(&self, link: &str, device_name: &str, label: &str, updated_at: u64) -> Result<Server> {
        self.enroll(&Self::link_payload(link)?, device_name, Some(label), updated_at).await
    }

    fn link_payload(link: &str) -> Result<Vec<u8>> {
        let c = link
            .trim()
            .strip_prefix("hollr://pair?c=")
            .context("Das ist kein Hollr-Kopplungscode.")?;
        URL_SAFE_NO_PAD
            .decode(c.trim_end_matches('='))
            .context("Der Kopplungscode ist beschädigt.")
    }

    /// The pairing payload (JSON) from a link or a one-time code → enrolled, saved server.
    pub(crate) async fn pair_payload(&self, json: &[u8], device_name: &str) -> Result<Server> {
        self.enroll(json, device_name, None, now_ms()).await
    }

    async fn enroll(&self, json: &[u8], device_name: &str, label: Option<&str>, updated_at: u64) -> Result<Server> {
        let p: PairingPayload = serde_json::from_slice(json).context("Der Kopplungscode ist beschädigt.")?;
        if p.v != 1 || p.a.is_empty() {
            bail!("Der Kopplungscode ist beschädigt.");
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs_f64();
        if now > p.e {
            bail!("Der Kopplungscode ist abgelaufen. Auf dem Server neu erzeugen: hollr pair");
        }
        let seed: [u8; 32] = URL_SAFE_NO_PAD
            .decode(p.s.trim_end_matches('='))?
            .try_into()
            .map_err(|_| anyhow!("Der Kopplungscode ist beschädigt."))?;
        let bootstrap = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
        let handle = Self::connect(&p.a, p.p, &p.u, &p.fp, bootstrap).await?;

        let device = self.device_key()?;
        let public = device.public_key().to_openssh()?;
        let request = serde_json::json!({ "pub": public, "name": device_name }).to_string();
        let reply = Self::exec(&handle, "enroll", Some(&request)).await?;
        let reply: serde_json::Value = serde_json::from_str(reply.trim()).context("Unerwartete Antwort vom Server")?;
        if reply["ok"] != true {
            let code = reply["error"].as_str().unwrap_or("unknown");
            bail!(if code == "expired" || code == "unknown_pairing" {
                "Der Code wurde schon benutzt oder ist abgelaufen. Auf dem Server neu erzeugen: hollr pair".to_string()
            } else if code == "denied" {
                "Am Rechner abgelehnt.".to_string()
            } else if code == "not_confirmed" {
                "Am Rechner wurde nicht rechtzeitig bestätigt. Auf dem Server neu erzeugen: hollr pair".to_string()
            } else {
                format!("Kopplung abgelehnt ({code}).")
            });
        }
        let mut id_bytes = [0u8; 8];
        getrandom::fill(&mut id_bytes).map_err(|e| anyhow!("Zufall: {e}"))?;
        let server = Server {
            id: STANDARD.encode(id_bytes).replace(['/', '+', '='], ""),
            label: label.map(str::to_string).unwrap_or(p.l),
            user: p.u,
            addresses: p.a,
            port: p.p,
            host_fingerprint: p.fp,
            device_id: reply["device"].as_str().unwrap_or("").to_string(),
            network: p.n,
            updated_at,
        };
        let mut servers: Vec<Server> = self
            .servers()
            .into_iter()
            .filter(|s| !(s.host_fingerprint == server.host_fingerprint && s.user == server.user))
            .collect();
        servers.push(server.clone());
        self.save_servers(&servers)?;
        // paired again: an earlier removal here no longer holds
        let stones = self.tombstones();
        if stones.iter().any(|t| t.fp == server.host_fingerprint) {
            self.save_tombstones(&stones.into_iter().filter(|t| t.fp != server.host_fingerprint).collect::<Vec<_>>())?;
        }
        Ok(server)
    }
}
