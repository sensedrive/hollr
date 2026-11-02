//! Pairing by one-time code (`hollr pair` shows it next to the QR code) – same payload, other way in.
//!   code = Crockford-base32( IPv4 ‖ 6-byte secret ), e.g. "K7Q2-M9XA-3PLD-W8RT"
//! We ask that address on port 47820, prove we know the code (HMAC) and get the link payload
//! AES-256-GCM encrypted with a key from the code (PBKDF2-SHA256, 600 000 rounds, salt = address).
//! Counterparts: `server/src/otp.ts`, iOS `PairingCode.swift`.

use std::fmt;
use std::time::Duration;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::hollr::{Hollr, Server};

pub const PORT: u16 = 47820;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROUNDS: u32 = 600_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE: usize = 1_000_000;

#[derive(Debug, PartialEq)]
pub enum CodeError {
    Format,
    Wrong,
    Locked,
    Expired,
    /// the address from the code
    Unreachable(String),
    Damaged,
}

impl CodeError {
    /// Stable key for the UI, which words (and translates) the message: `otp:wrong`, `otp:unreachable:<ip>` …
    pub fn key(&self) -> String {
        match self {
            Self::Format => "otp:format".into(),
            Self::Wrong => "otp:wrong".into(),
            Self::Locked => "otp:locked".into(),
            Self::Expired => "otp:expired".into(),
            Self::Unreachable(ip) => format!("otp:unreachable:{ip}"),
            Self::Damaged => "otp:damaged".into(),
        }
    }
}

impl fmt::Display for CodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Format => write!(f, "Der Code hat 16 Zeichen, z. B. K7Q2-M9XA-3PLD-W8RT."),
            Self::Wrong => write!(f, "Der Code stimmt nicht. Bitte genau so eingeben, wie er am Rechner steht."),
            Self::Locked => write!(f, "Zu viele falsche Versuche – der Code ist gesperrt. Am Rechner einen neuen erzeugen („n“ + Enter)."),
            Self::Expired => write!(f, "Der Code ist abgelaufen oder wurde schon benutzt. Am Rechner einen neuen erzeugen: hollr pair"),
            Self::Unreachable(ip) => write!(f, "Der Rechner ({ip}) ist nicht erreichbar."),
            Self::Damaged => write!(f, "Die Antwort des Rechners passt nicht zum Code."),
        }
    }
}

impl std::error::Error for CodeError {}

/// "k7q2 m9xa-3pld w8rt" → "K7Q2-M9XA-3PLD-W8RT" (O → 0, I/L → 1, everything else outside the alphabet dropped)
pub fn format(input: &str) -> String {
    let clean: Vec<u8> = input
        .bytes()
        .map(|c| match c.to_ascii_uppercase() {
            b'O' => b'0',
            b'I' | b'L' => b'1',
            c => c,
        })
        .filter(|c| ALPHABET.contains(c))
        .take(16)
        .collect();
    clean.chunks(4).map(|c| String::from_utf8_lossy(c)).collect::<Vec<_>>().join("-")
}

/// Code → (IPv4 address, 6-byte secret); `None` unless it has exactly 16 code characters.
pub fn decode(code: &str) -> Option<(String, [u8; 6])> {
    let clean = format(code).replace('-', "");
    if clean.len() != 16 {
        return None;
    }
    let (mut bits, mut value) = (0u32, 0u32);
    let mut bytes = Vec::with_capacity(10);
    for c in clean.bytes() {
        let v = ALPHABET.iter().position(|&a| a == c)? as u32;
        value = (value << 5) | v;
        bits += 5;
        if bits >= 8 {
            bytes.push((value >> (bits - 8)) as u8);
            bits -= 8;
        }
        value &= (1 << bits) - 1;
    }
    let ip = bytes[..4].iter().map(u8::to_string).collect::<Vec<_>>().join(".");
    Some((ip, bytes[4..10].try_into().ok()?))
}

/// 64 bytes of PBKDF2 → (auth key, encryption key).
fn derive_keys(ip: &str, secret: &[u8; 6]) -> ([u8; 32], [u8; 32]) {
    let mut out = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha256>(secret, format!("hollr-pair:{ip}").as_bytes(), ROUNDS, &mut out);
    (out[..32].try_into().unwrap(), out[32..].try_into().unwrap())
}

fn proof(auth: &[u8; 32]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(auth).expect("HMAC takes any key length");
    mac.update(b"hollr-pair-v1");
    mac.finalize().into_bytes().to_vec()
}

/// nonce (12) ‖ ciphertext ‖ tag (16) – CryptoKit's AES.GCM "combined" format.
fn open(enc: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(enc).ok()?;
    let nonce = Nonce::try_from(&sealed[..12]).ok()?;
    cipher.decrypt(&nonce, &sealed[12..]).ok()
}

/// Code → the same JSON a `hollr://pair?c=` link carries.
pub async fn fetch_payload(code: &str) -> Result<Vec<u8>, CodeError> {
    let (ip, secret) = decode(code).ok_or(CodeError::Format)?;
    let (auth, enc) = {
        let ip = ip.clone();
        tokio::task::spawn_blocking(move || derive_keys(&ip, &secret)).await.map_err(|_| CodeError::Damaged)?
    };
    let body = serde_json::json!({ "proof": STANDARD.encode(proof(&auth)) }).to_string();
    let (status, response) = post(&ip, "/hollr/pair", body.as_bytes()).await.map_err(|_| CodeError::Unreachable(ip.clone()))?;
    let obj: serde_json::Value = serde_json::from_slice(&response).unwrap_or_default();
    match (status, obj["error"].as_str()) {
        (200, _) => {}
        (403, Some("locked")) => return Err(CodeError::Locked),
        (403, _) => return Err(CodeError::Wrong),
        (410, _) => return Err(CodeError::Expired),
        _ => return Err(CodeError::Damaged),
    }
    let sealed = obj["box"].as_str().and_then(|b| STANDARD.decode(b).ok()).ok_or(CodeError::Damaged)?;
    let plain = open(&enc, &sealed).ok_or(CodeError::Damaged)?;
    let payload: serde_json::Value = serde_json::from_slice(&plain).map_err(|_| CodeError::Damaged)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    if payload["e"].as_f64().is_some_and(|e| now > e) {
        return Err(CodeError::Expired);
    }
    Ok(plain)
}

/// Minimal HTTP/1.1 over plain TCP (the body is encrypted with the code's key; on Tailscale
/// WireGuard sits underneath). Returns status and body.
async fn post(ip: &str, path: &str, body: &[u8]) -> std::io::Result<(u16, Vec<u8>)> {
    let timeout = |_| std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout");
    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((ip, PORT))).await.map_err(timeout)??;
    let exchange = async {
        let mut request = format!(
            "POST {path} HTTP/1.1\r\nHost: {ip}:{PORT}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        request.extend_from_slice(body);
        stream.write_all(&request).await?;
        let mut received = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            received.extend_from_slice(&chunk[..n]);
            if received.len() > MAX_RESPONSE || complete(&received) {
                break;
            }
        }
        Ok::<_, std::io::Error>(received)
    };
    let received = tokio::time::timeout(EXCHANGE_TIMEOUT, exchange).await.map_err(timeout)??;
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "bad response");
    let split = find(&received, b"\r\n\r\n").ok_or_else(bad)?;
    let head = std::str::from_utf8(&received[..split]).map_err(|_| bad())?;
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).ok_or_else(bad)?;
    Ok((status, received[split + 4..].to_vec()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Headers plus `Content-Length` bytes are in – no need to wait for the server to close.
fn complete(received: &[u8]) -> bool {
    let Some(split) = find(received, b"\r\n\r\n") else { return false };
    let head = String::from_utf8_lossy(&received[..split]).to_ascii_lowercase();
    head.lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok())
        .is_some_and(|len| received.len() - split - 4 >= len)
}

impl Hollr {
    /// Code → payload → the same pairing as a link.
    pub async fn pair_code(&self, code: &str, device_name: &str) -> anyhow::Result<Server> {
        let payload = fetch_payload(code).await?;
        self.pair_payload(&payload, device_name).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_while_typing() {
        // L is no code character: it reads as 1 (Crockford)
        assert_eq!(format("k7q2 m9xa-3pld w8rt"), "K7Q2-M9XA-3P1D-W8RT");
        assert_eq!(format("k7q"), "K7Q");
        assert_eq!(format("oil u"), "011");
        assert_eq!(format("K7Q2M9XA3PXDW8RTXXXX"), "K7Q2-M9XA-3PXD-W8RT");
    }

    #[test]
    fn decodes_like_the_server_encodes() {
        // encodeCode("100.64.1.2", Buffer.from([1, 2, 3, 4, 5, 6])) from server/src/otp.ts
        let (ip, secret) = decode("CH00-20G1-081G-8186").unwrap();
        assert_eq!(ip, "100.64.1.2");
        assert_eq!(secret, [1, 2, 3, 4, 5, 6]);
        assert_eq!(decode("ch00 20g1 o81g 8186"), decode("CH00-20G1-081G-8186"));
        assert_eq!(decode("CH00-20G1-081G-818"), None);
    }

    #[test]
    fn opens_combined_box() {
        let key = [7u8; 32];
        let nonce = [9u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ct = cipher.encrypt(&Nonce::try_from(&nonce[..]).unwrap(), &b"{\"v\":1}"[..]).unwrap();
        let sealed = [&nonce[..], &ct].concat();
        assert_eq!(open(&key, &sealed).unwrap(), b"{\"v\":1}");
        assert_eq!(open(&[8u8; 32], &sealed), None);
    }
}
