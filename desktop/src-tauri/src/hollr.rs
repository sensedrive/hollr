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

/// One pooled connection per server; its own lock so a slow connect only blocks that server.
type Slot = Arc<Mutex<Option<Arc<Handle<Pinned>>>>>;

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

    pub async fn remove_server(&self, id: &str) -> Result<()> {
        let servers: Vec<Server> = self.servers().into_iter().filter(|s| s.id != id).collect();
        self.save_servers(&servers)?;
        self.invalidate(id).await;
        Ok(())
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

    /// Drops the pooled connection, the next call reconnects (users of the old handle keep it).
    pub async fn invalidate(&self, server_id: &str) {
        self.pool.lock().unwrap().remove(server_id);
    }

    /// Like `invalidate`, but only if the pool still holds this (stale) handle – not a fresh reconnect.
    async fn drop_stale(&self, server_id: &str, stale: &Arc<Handle<Pinned>>) {
        let slot = self.pool.lock().unwrap().get(server_id).cloned();
        if let Some(slot) = slot {
            let mut h = slot.lock().await;
            if h.as_ref().is_some_and(|h| Arc::ptr_eq(h, stale)) {
                *h = None;
            }
        }
    }

    /// Pooled connection to a paired server (live calls open their own channel on it).
    pub async fn handle_for(&self, server_id: &str) -> Result<Arc<Handle<Pinned>>> {
        let server = self.servers().into_iter().find(|s| s.id == server_id).context("Server nicht gefunden")?;
        self.handle(&server).await
    }

    async fn handle(&self, server: &Server) -> Result<Arc<Handle<Pinned>>> {
        // the map lock is only held for the lookup, the connect waits on this server's slot alone
        let slot = self.pool.lock().unwrap().entry(server.id.clone()).or_default().clone();
        let mut pooled = slot.lock().await;
        if let Some(h) = pooled.as_ref()
            && !h.is_closed()
        {
            return Ok(h.clone());
        }
        let h = Arc::new(
            Self::connect(&server.addresses, server.port, &server.user, &server.host_fingerprint, self.device_key()?).await?,
        );
        *pooled = Some(h.clone());
        Ok(h)
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
        for attempt in 0..2 {
            let handle = self.handle(&server).await?;
            let early = if late { None } else { stdin.as_deref() };
            // a dead connection (e.g. after sleep) never answers the channel open: time out, reconnect once
            let opened = tokio::time::timeout(OPEN_TIMEOUT, Self::open(&handle, command, early))
                .await
                .unwrap_or_else(|_| Err(anyhow!("Zeitüberschreitung")));
            let channel = match opened {
                Ok(c) => c,
                Err(e) => {
                    self.drop_stale(&server.id, &handle).await;
                    if attempt == 0 {
                        continue;
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
                    self.drop_stale(&server.id, &handle).await;
                    Err(anyhow!("Zeitüberschreitung – keine Antwort vom Server"))
                }
            };
        }
        unreachable!()
    }

    // ------------------------------------------------------------ pairing

    pub async fn pair(&self, link: &str, device_name: &str) -> Result<Server> {
        let c = link
            .trim()
            .strip_prefix("hollr://pair?c=")
            .context("Das ist kein Hollr-Kopplungscode.")?;
        let json = URL_SAFE_NO_PAD
            .decode(c.trim_end_matches('='))
            .context("Der Kopplungscode ist beschädigt.")?;
        let p: PairingPayload = serde_json::from_slice(&json).context("Der Kopplungscode ist beschädigt.")?;
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
            label: p.l,
            user: p.u,
            addresses: p.a,
            port: p.p,
            host_fingerprint: p.fp,
            device_id: reply["device"].as_str().unwrap_or("").to_string(),
            network: p.n,
        };
        let mut servers: Vec<Server> = self
            .servers()
            .into_iter()
            .filter(|s| !(s.host_fingerprint == server.host_fingerprint && s.user == server.user))
            .collect();
        servers.push(server.clone());
        self.save_servers(&servers)?;
        Ok(server)
    }
}
