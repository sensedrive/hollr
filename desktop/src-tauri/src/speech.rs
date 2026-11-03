//! Read aloud (Settings › Vorlesen): text selected in the chat or the terminal is spoken on this
//! computer. Phonon (Gradium's on-device TTS, crate `ptts`) speaks when a downloaded model knows the
//! text's language; otherwise the macOS system voice (`/usr/bin/say`) does, so the feature works
//! before any model is there. Markdown cleanup and language detection happen in the frontend
//! (speechText.ts); this gets plain text plus a language code.
//!
//! Files in `<app data>/speech`: `models/<id>/` (one Phonon checkpoint from `gradium/<id>` on
//! Hugging Face: config, tokenizer, q8 weights, default voice), `voices/` (Gradium's voice catalog
//! and the voices picked from it) and `hf-token` (0600). The Phonon 40m models are gated (CC BY-NC):
//! their download needs the terms accepted on Hugging Face and a read token.
//!
//! Events: `speech` {session, t: "playing" | "end" | "error", error?, warning?} and
//! `speech-download` {id, progress} / {id, done} / {id, cancelled} / {id, error}.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use ptts::checkpoint::{Checkpoint, ResolveOptions, read_config};
use ptts::preprocess::{Lang, Normalize};
use ptts::synth::{DeviceKind, Quant, SpeechOptions, SpeechStream, Synth};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::live::Resampler;

/// What a checkpoint needs here: `Checkpoint::resolve` finds the q8 weights, the tokenizer and the
/// default voice by these names. Small files first, so a missing licence fails before the big one.
const MODEL_FILES: [&str; 4] = ["config.json", "tokenizer.json", "default-voice.safetensors", "model.q8.gguf"];
/// The voice format of every voice in Gradium's catalog (its README); a checkpoint lists the formats
/// it takes in `embeddings_ext`. A voice made for another checkpoint gives confident nonsense.
const CATALOG_VOICE_FORMAT: &str = "ba7a5a45@300";
/// The conditioner Phonon checkpoints read the speaking rate from (positive = slower).
const DURATION_DELTA: &str = "duration_delta";

// ------------------------------------------------------------ files

/// `<dir>/models/<id>`; ids are the repo names under `gradium/` ("phonon-40m-multilingual" …).
pub fn model_dir(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = id.starts_with("phonon-") && id.len() < 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        bail!("Unbekanntes Modell „{id}“");
    }
    Ok(dir.join("models").join(id))
}

pub fn model_page(id: &str) -> String {
    format!("https://huggingface.co/gradium/{id}")
}

fn token_file(dir: &Path) -> PathBuf {
    dir.join("hf-token")
}

/// The Hugging Face read token: the one entered in the settings, else `HF_TOKEN` (like ptts' own CLI).
pub fn token(dir: &Path) -> Option<String> {
    let saved = std::fs::read_to_string(token_file(dir)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    saved.or_else(|| std::env::var("HF_TOKEN").ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()))
}

/// Saves the token readable by this user only; "" deletes it.
pub fn save_token(dir: &Path, token: &str) -> Result<()> {
    let token = token.trim();
    let file = token_file(dir);
    if token.is_empty() {
        return match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        };
    }
    if token.len() > 256 || !token.chars().all(|c| c.is_ascii_graphic()) {
        bail!("Das sieht nicht nach einem Hugging-Face-Token aus.");
    }
    std::fs::create_dir_all(dir).context("Ordner für die Sprachausgabe")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        // an older file keeps its mode on truncate
        if file.exists() {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    options.open(&file).and_then(|mut f| f.write_all(token.as_bytes())).context("Token speichern")
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(20))).build().into()
}

fn http_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::StatusCode(401) => anyhow!("Kein Zugriff – Hugging-Face-Token eintragen (Einstellungen › Vorlesen)."),
        ureq::Error::StatusCode(403) => anyhow!("Noch nicht freigeschaltet – auf der Modellseite bei Hugging Face die Bedingungen akzeptieren."),
        ureq::Error::StatusCode(404) => anyhow!("Datei nicht gefunden (404)"),
        e => anyhow!("Download fehlgeschlagen: {e}"),
    }
}

/// One file into `dest`; `progress` gets 0 … 1 when the size is known. Stops as soon as `cancel` is set.
fn fetch(url: &str, token: Option<&str>, dest: &Path, cancel: &AtomicBool, mut progress: impl FnMut(f64)) -> Result<()> {
    let mut req = agent().get(url);
    if let Some(token) = token {
        // ureq drops it on the redirect to the CDN (signed URL there)
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let resp = req.call().map_err(http_error)?;
    let total = resp.body().content_length();
    let mut reader = resp.into_body().into_reader();
    let mut out = std::io::BufWriter::new(std::fs::File::create(dest).context("Datei anlegen")?);
    let mut buf = vec![0u8; 1 << 16];
    let mut done = 0u64;
    let mut reported = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!("Abgebrochen");
        }
        let n = reader.read(&mut buf).map_err(|e| anyhow!("Download unterbrochen: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).context("Datei schreiben")?;
        done += n as u64;
        if let Some(total) = total
            && reported.elapsed() > Duration::from_millis(150)
        {
            reported = Instant::now();
            progress(done as f64 / total.max(1) as f64);
        }
    }
    out.flush()?;
    if let Some(total) = total
        && done != total
    {
        bail!("Download unvollständig ({done} von {total} Bytes)");
    }
    Ok(())
}

/// Downloads a Phonon checkpoint into `<dir>/models/<id>.part` and renames it when complete.
pub fn download_model(dir: &Path, id: &str, token: Option<&str>, cancel: &AtomicBool, mut progress: impl FnMut(f64)) -> Result<PathBuf> {
    let target = model_dir(dir, id)?;
    let part = target.with_extension("part");
    let _ = std::fs::remove_dir_all(&part);
    std::fs::create_dir_all(&part).context("Modellordner")?;
    let mut run = || -> Result<()> {
        for name in MODEL_FILES {
            let url = format!("https://huggingface.co/gradium/{id}/resolve/main/{name}");
            let weights = name.ends_with(".gguf");
            // no file-name prefix: the 401 / 403 texts are what the settings show (and translate)
            fetch(&url, token, &part.join(name), cancel, |p| {
                if weights {
                    progress(p);
                }
            })?;
        }
        Ok(())
    };
    if let Err(e) = run() {
        let _ = std::fs::remove_dir_all(&part);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&part, &target).context("Modellordner")?;
    progress(1.0);
    Ok(target)
}

#[derive(Serialize, Clone, Debug)]
pub struct LocalModel {
    pub id: String,
    pub bytes: u64,
    /// what the checkpoint says it speaks ("de", "en" …); empty = not said
    pub languages: Vec<String>,
    /// takes a speaking rate
    pub speed: bool,
    /// takes the voices of Gradium's catalog
    pub catalog_voices: bool,
}

fn has_speed(config: &ptts::tts_model::TTSConfig) -> bool {
    config.conditioners.iter().any(|c| c.name() == DURATION_DELTA)
}

/// Finished downloads in `<dir>/models`.
pub fn local_models(dir: &Path) -> Vec<LocalModel> {
    let Ok(entries) = std::fs::read_dir(dir.join("models")) else { return Vec::new() };
    let mut models: Vec<LocalModel> = entries
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().into_string().ok()?;
            let path = model_dir(dir, &id).ok()?;
            if !MODEL_FILES.iter().all(|f| path.join(f).is_file()) {
                return None;
            }
            let config = read_config(path.join("config.json")).ok()?;
            let bytes = MODEL_FILES.iter().filter_map(|f| path.join(f).metadata().ok()).map(|m| m.len()).sum();
            let catalog_voices = config.embeddings_ext.as_ref().is_none_or(|ext| ext.iter().any(|e| e == CATALOG_VOICE_FORMAT));
            Some(LocalModel { speed: has_speed(&config), catalog_voices, languages: config.languages, bytes, id })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

// ------------------------------------------------------------ voices

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CatalogVoice {
    pub name: String,
    /// relative to the catalog ("voices/<id>.safetensors")
    pub filename: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// downloaded already
    #[serde(default)]
    pub local: bool,
}

/// ptts' pinned default catalog (`hf://gradium/phonon-voices@<commit>`) as a download base URL.
fn catalog_base() -> String {
    let source = ptts::voice_catalog::DEFAULT_VOICE_CATALOG.trim_start_matches("hf://");
    let (repo, revision) = source.split_once('@').unwrap_or((source, "main"));
    format!("https://huggingface.co/{repo}/resolve/{revision}")
}

fn voices_dir(dir: &Path) -> PathBuf {
    dir.join("voices")
}

/// A catalog file name that stays inside the catalog folder.
fn inside(file: &str) -> bool {
    !file.is_empty() && !file.starts_with('/') && !file.contains('\\') && file.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

/// Gradium's voice catalog (downloaded once, ~35 KB), each voice marked when it is on this computer.
pub fn catalog(dir: &Path) -> Result<Vec<CatalogVoice>> {
    let folder = voices_dir(dir);
    let file = folder.join(ptts::voice_catalog::CATALOG_FILE);
    if !file.is_file() {
        std::fs::create_dir_all(&folder).context("Stimmenordner")?;
        let part = file.with_extension("part");
        let url = format!("{}/{}", catalog_base(), ptts::voice_catalog::CATALOG_FILE);
        fetch(&url, None, &part, &AtomicBool::new(false), |_| {}).context("Stimmenkatalog")?;
        std::fs::rename(&part, &file)?;
    }
    let text = std::fs::read_to_string(&file)?;
    let mut voices = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut v: CatalogVoice = serde_json::from_str(line).context("Stimmenkatalog")?;
        if !inside(&v.filename) {
            continue;
        }
        v.local = folder.join(&v.filename).is_file();
        voices.push(v);
    }
    Ok(voices)
}

/// Downloads one catalog voice (~250 KB).
pub fn download_voice(dir: &Path, name: &str) -> Result<()> {
    let voice = catalog(dir)?.into_iter().find(|v| v.name == name).ok_or_else(|| anyhow!("Unbekannte Stimme „{name}“"))?;
    if voice.local {
        return Ok(());
    }
    let dest = voices_dir(dir).join(&voice.filename);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = dest.with_extension("part");
    fetch(&format!("{}/{}", catalog_base(), voice.filename), None, &part, &AtomicBool::new(false), |_| {})?;
    std::fs::rename(&part, &dest)?;
    Ok(())
}

// ------------------------------------------------------------ Phonon

/// Speaking rate (1 = normal) → Phonon's `duration_delta`. Measured on Phonon 31m: −0.5 speaks
/// ~1.3× as fast, +0.5 ~0.8×; beyond that it barely changes and gets unstable.
pub fn duration_delta(speed: f32) -> f32 {
    ((1.0 - speed) * 1.7).clamp(-0.5, 0.5)
}

/// Loads a checkpoint for the CPU (q8 weights, ~20× realtime on one Apple core) with its own voices
/// and the catalog voices downloaded so far. Text is normalized per request (`stream`), so one
/// loaded model serves every language it speaks.
pub fn load(dir: &Path, model: &Path, speed: f32) -> Result<Synth> {
    let checkpoint = Checkpoint::resolve(model, ResolveOptions { quant: Quant::Q80, weights: None })
        .map_err(|e| anyhow!("Phonon-Modell lässt sich nicht laden: {e}"))?;
    let mut builder = checkpoint.builder(Normalize::OFF).device(DeviceKind::Cpu);
    if has_speed(&checkpoint.config) {
        builder = builder.condition(DURATION_DELTA, format!("{:.2}", duration_delta(speed)));
    }
    let mut synth = builder.build().map_err(|e| anyhow!("Phonon-Modell lässt sich nicht laden: {e}"))?;
    checkpoint.register_voices(&mut synth);
    let folder = voices_dir(dir);
    if let Ok(voices) = catalog_local(&folder) {
        for (name, path) in voices {
            // a voice of another format is refused here – speaking falls back to the default voice
            if let Err(e) = synth.add_voice_file(&name, &path) {
                eprintln!("speech: voice {name} skipped: {e}");
            }
        }
    }
    Ok(synth)
}

/// The downloaded catalog voices (no network).
fn catalog_local(folder: &Path) -> Result<Vec<(String, PathBuf)>> {
    let text = std::fs::read_to_string(folder.join(ptts::voice_catalog::CATALOG_FILE))?;
    Ok(text
        .lines()
        .filter_map(|l| serde_json::from_str::<CatalogVoice>(l).ok())
        .filter(|v| inside(&v.filename))
        .map(|v| (v.name, folder.join(v.filename)))
        .filter(|(_, p)| p.is_file())
        .collect())
}

/// Starts generating `text` (normalized as `lang`) in `voice`; a voice the model doesn't have falls
/// back to its default one, with a warning.
pub fn stream(synth: &Synth, text: &str, lang: &str, voice: Option<&str>) -> Result<(SpeechStream, Option<String>)> {
    let normalize = lang.parse::<Lang>().map(Normalize::for_lang).unwrap_or(Normalize::OFF);
    let text = normalize.apply(text);
    let mut options = SpeechOptions::default();
    let mut warning = None;
    if let Some(voice) = voice.filter(|v| !v.is_empty() && *v != "default") {
        if synth.voices().iter().any(|v| v == voice) {
            options = options.voice(voice);
        } else {
            warning = Some(format!("Stimme „{voice}“ passt nicht zu diesem Modell – Standardstimme."));
        }
    }
    let stream = synth.stream_with(&text, &options).map_err(|e| anyhow!("Phonon: {e}"))?;
    Ok((stream, warning))
}

/// Plays PCM chunks at `rate` on the default output while they are generated. `stop` silences the
/// speaker at once (checked in the audio callback) and ends generation with the next chunk.
fn play<E: std::fmt::Display>(chunks: impl Iterator<Item = Result<Vec<f32>, E>>, rate: u32, stop: &Arc<AtomicBool>, mut playing: impl FnMut()) -> Result<()> {
    let host = cpal::default_host();
    let device = host.default_output_device().context("Kein Lautsprecher gefunden")?;
    let cfg = device.default_output_config().context("Lautsprecher-Format")?;
    let channels = cfg.channels() as usize;
    let device_rate = cfg.sample_rate();
    let config: StreamConfig = cfg.config();
    let queue: Arc<Mutex<VecDeque<f32>>> = Default::default();
    let broken = Arc::new(AtomicBool::new(false));
    let fill = {
        let (queue, stop) = (queue.clone(), stop.clone());
        move |data: &mut [f32]| {
            let mut q = queue.lock().unwrap();
            if stop.load(Ordering::Relaxed) {
                q.clear();
            }
            for frame in data.chunks_mut(channels) {
                frame.fill(q.pop_front().unwrap_or(0.0));
            }
        }
    };
    let on_error = {
        let broken = broken.clone();
        move |_| broken.store(true, Ordering::Relaxed)
    };
    let output = match cfg.sample_format() {
        SampleFormat::F32 => device.build_output_stream::<f32, _, _>(config, move |d, _| fill(d), on_error, None)?,
        SampleFormat::I16 => {
            let fill = fill;
            let mut scratch = Vec::new();
            device.build_output_stream::<i16, _, _>(
                config,
                move |d: &mut [i16], _| {
                    scratch.resize(d.len(), 0.0);
                    fill(&mut scratch);
                    for (o, s) in d.iter_mut().zip(&scratch) {
                        *o = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    }
                },
                on_error,
                None,
            )?
        }
        f => bail!("Lautsprecher-Format {f:?} nicht unterstützt"),
    };
    output.play().context("Lautsprecher starten")?;
    let mut resampler = Resampler::new(rate as f64, device_rate as f64);
    let mut out = Vec::new();
    // generation runs ~20× realtime: two seconds ahead is plenty and keeps memory flat for long texts
    let ahead = device_rate as usize * 2;
    let queued = || queue.lock().unwrap().len();
    let mut first = true;
    for chunk in chunks {
        if stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let chunk = chunk.map_err(|e| anyhow!("Phonon: {e}"))?;
        out.clear();
        resampler.push(&chunk, &mut out);
        queue.lock().unwrap().extend(out.iter().copied());
        if first {
            first = false;
            playing();
        }
        while queued() > ahead && !stop.load(Ordering::Relaxed) && !broken.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if broken.load(Ordering::Relaxed) {
            bail!("Lautsprecher getrennt");
        }
    }
    while queued() > 0 && !stop.load(Ordering::Relaxed) && !broken.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
    }
    // the device still holds its last buffer
    if !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(150));
    }
    Ok(())
}

// ------------------------------------------------------------ system voice

/// `say -v ?` → (name, locale), e.g. ("Anna (Deutsch (Deutschland))", "de_DE").
pub fn parse_system_voices(listing: &str) -> Vec<(String, String)> {
    listing
        .lines()
        .filter_map(|line| {
            let line = line.split(" # ").next()?.trim_end();
            let (name, locale) = line.rsplit_once(' ')?;
            let ok = locale.len() >= 5 && locale.as_bytes()[2] == b'_' && locale[..2].chars().all(|c| c.is_ascii_lowercase());
            ok.then(|| (name.trim().to_string(), locale.to_string()))
        })
        .collect()
}

/// The well-sounding standard voices first (not the novelty ones like "Bad News" that share the locale).
pub fn pick_system_voice(voices: &[(String, String)], lang: &str) -> Option<String> {
    let preferred: &[&str] = match lang {
        "de" => &["Anna", "Petra", "Markus", "Yannick", "Helena", "Martin"],
        "en" => &["Samantha", "Daniel", "Karen", "Moira", "Alex"],
        "fr" => &["Thomas", "Amélie", "Audrey"],
        "es" => &["Mónica", "Paulina", "Jorge"],
        "pt" => &["Luciana", "Joana"],
        _ => &[],
    };
    let base = |name: &str| name.split(" (").next().unwrap_or(name).to_string();
    let of_lang = |l: &&(String, String)| l.1.starts_with(&format!("{lang}_"));
    preferred
        .iter()
        .find_map(|p| voices.iter().filter(of_lang).find(|v| base(&v.0) == *p))
        .or_else(|| voices.iter().filter(of_lang).next())
        .map(|v| v.0.clone())
}

/// `say -v ?` once per run (it takes ~100 ms).
static SYSTEM_VOICES: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    Command::new("/usr/bin/say")
        .args(["-v", "?"])
        .output()
        .map(|o| parse_system_voices(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
});

fn system_voice(lang: &str) -> Option<String> {
    pick_system_voice(&SYSTEM_VOICES, lang)
}

pub const SYSTEM_VOICE: bool = cfg!(target_os = "macos");

/// Speaks through `/usr/bin/say` (words per minute from `speed`); `stop` kills it within 30 ms.
fn speak_system(text: &str, lang: &str, speed: f32, stop: &AtomicBool, mut playing: impl FnMut(Option<&str>)) -> Result<()> {
    if !SYSTEM_VOICE {
        bail!("Keine Systemstimme – ein Phonon-Modell laden (Einstellungen › Vorlesen).");
    }
    let voice = system_voice(lang);
    let mut cmd = Command::new("/usr/bin/say");
    if let Some(v) = &voice {
        cmd.arg("-v").arg(v);
    }
    let rate = (180.0 * speed).round().clamp(90.0, 400.0) as u32;
    cmd.arg("-r").arg(rate.to_string()).arg("-f").arg("-");
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().context("Systemstimme startet nicht")?;
    // a long text would block on the pipe while `say` is still reading
    let mut stdin = child.stdin.take().context("Systemstimme")?;
    let text = text.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(text.as_bytes());
    });
    playing(voice.as_deref());
    loop {
        if stop.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            bail!("Systemstimme: {}", err.trim());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

// ------------------------------------------------------------ engine choice

#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    Phonon(String),
    System,
}

/// Phonon with the first model that speaks `lang` (the chosen one, then multilingual, then the rest),
/// otherwise the system voice; `engine` "system" turns that order around.
pub fn choose(models: &[LocalModel], engine: &str, preferred: Option<&str>, lang: &str, system: bool) -> Option<Choice> {
    let mut candidates: Vec<&LocalModel> = models.iter().filter(|m| m.languages.is_empty() || m.languages.iter().any(|l| l == lang)).collect();
    candidates.sort_by_key(|m| (Some(m.id.as_str()) != preferred, !m.id.contains("multilingual"), !m.id.contains("40m")));
    let phonon = candidates.first().map(|m| Choice::Phonon(m.id.clone()));
    let system = system.then_some(Choice::System);
    if engine == "system" { system.or(phonon) } else { phonon.or(system) }
}

// ------------------------------------------------------------ app state

/// One loaded checkpoint (a few hundred ms to load) for the next request; keyed by model and rate.
#[derive(Default, Clone)]
struct Loaded(Arc<Mutex<Option<(PathBuf, i32, Arc<Synth>)>>>);

impl Loaded {
    fn get(&self, dir: &Path, model: &Path, speed: f32) -> Result<Arc<Synth>> {
        let key = (duration_delta(speed) * 100.0).round() as i32;
        let mut slot = self.0.lock().unwrap();
        if let Some((p, k, synth)) = slot.as_ref()
            && p == model
            && *k == key
        {
            return Ok(synth.clone());
        }
        *slot = None; // free the old model first
        let synth = Arc::new(load(dir, model, speed)?);
        *slot = Some((model.to_path_buf(), key, synth.clone()));
        Ok(synth)
    }

    fn forget(&self) {
        *self.0.lock().unwrap() = None;
    }
}

pub struct Speech {
    dir: PathBuf,
    loaded: Loaded,
    /// stop flag of what is speaking now
    current: Mutex<Option<Arc<AtomicBool>>>,
    sessions: AtomicU64,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Speech {
    /// `dir`: `<app data>/speech`.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, loaded: Loaded::default(), current: Default::default(), sessions: AtomicU64::new(0), downloads: Default::default() }
    }

    /// Silences whatever speaks (a reloaded webview, the stop button, Esc, a deleted model).
    pub fn stop(&self) {
        if let Some(stop) = self.current.lock().unwrap().take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// A request is over (done, failed, stopped): forget its flag unless a newer one took its place.
    fn release(&self, stop: &Arc<AtomicBool>) {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, stop)) {
            *current = None;
        }
    }
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Which engine speaks a language: "phonon" (label = model id) or "system" (label = the `say` voice).
#[derive(Serialize, Debug)]
pub struct EngineInfo {
    pub engine: &'static str,
    pub label: Option<String>,
}

fn describe(choice: &Choice, lang: &str) -> EngineInfo {
    match choice {
        Choice::Phonon(id) => EngineInfo { engine: "phonon", label: Some(id.clone()) },
        Choice::System => EngineInfo { engine: "system", label: system_voice(lang) },
    }
}

/// The languages speechText.ts tells apart (Phonon 40m multilingual speaks all of them).
const LANGUAGES: [&str; 5] = ["de", "en", "fr", "es", "pt"];

#[derive(Serialize)]
pub struct Status {
    /// the system voice (`say`) is there
    pub system: bool,
    /// a Hugging Face token is saved (or in `HF_TOKEN`); the token itself never goes to the webview
    pub token: bool,
    pub models: Vec<LocalModel>,
    /// what would speak each language with these settings (None = nothing can)
    pub engines: HashMap<&'static str, Option<EngineInfo>>,
}

/// async: off the main thread (the first look at the system voices runs `say -v ?`)
#[tauri::command]
pub async fn speech_status(state: tauri::State<'_, Speech>, engine: String, model: Option<String>) -> Result<Status, String> {
    let models = local_models(&state.dir);
    let engines = LANGUAGES
        .iter()
        .map(|lang| (*lang, choose(&models, &engine, model.as_deref(), lang, SYSTEM_VOICE).map(|c| describe(&c, lang))))
        .collect();
    Ok(Status { system: SYSTEM_VOICE, token: token(&state.dir).is_some(), models, engines })
}

/// Saves the Hugging Face read token ("" removes it).
#[tauri::command]
pub fn speech_token(state: tauri::State<'_, Speech>, token: String) -> Result<(), String> {
    save_token(&state.dir, &token).map_err(err)
}

/// Starts a model download in the background; progress comes as `speech-download` events.
#[tauri::command]
pub fn speech_download(app: AppHandle, state: tauri::State<'_, Speech>, id: String) -> Result<(), String> {
    model_dir(&state.dir, &id).map_err(err)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().unwrap();
        if downloads.contains_key(&id) {
            return Ok(());
        }
        downloads.insert(id.clone(), cancel.clone());
    }
    let dir = state.dir.clone();
    std::thread::spawn(move || {
        let token = token(&dir);
        let result = download_model(&dir, &id, token.as_deref(), &cancel, |p| {
            let _ = app.emit("speech-download", json!({ "id": id, "progress": p }));
        });
        let state = app.state::<Speech>();
        state.downloads.lock().unwrap().remove(&id);
        let msg = match result {
            Ok(_) => json!({ "id": id, "done": true }),
            Err(_) if cancel.load(Ordering::Relaxed) => json!({ "id": id, "cancelled": true }),
            Err(e) => json!({ "id": id, "error": err(e) }),
        };
        let _ = app.emit("speech-download", msg);
    });
    Ok(())
}

#[tauri::command]
pub fn speech_download_cancel(state: tauri::State<'_, Speech>, id: String) {
    if let Some(flag) = state.downloads.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn speech_delete(state: tauri::State<'_, Speech>, id: String) -> Result<(), String> {
    let path = model_dir(&state.dir, &id).map_err(err)?;
    state.stop();
    state.loaded.forget();
    match std::fs::remove_dir_all(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Gradium's voice catalog; `compatible` = the model takes these voices (else only its own default).
#[tauri::command]
pub async fn speech_voices(state: tauri::State<'_, Speech>, model: Option<String>) -> Result<serde_json::Value, String> {
    let dir = state.dir.clone();
    let compatible = model.as_deref().is_none_or(|m| local_models(&dir).iter().find(|l| l.id == m).is_none_or(|l| l.catalog_voices));
    let voices = tokio::task::spawn_blocking(move || catalog(&dir)).await.map_err(|e| e.to_string())?.map_err(err)?;
    Ok(json!({ "voices": voices, "compatible": compatible }))
}

/// Downloads a catalog voice; the loaded model picks it up on the next request.
#[tauri::command]
pub async fn speech_voice_download(state: tauri::State<'_, Speech>, name: String) -> Result<(), String> {
    let dir = state.dir.clone();
    tokio::task::spawn_blocking(move || download_voice(&dir, &name)).await.map_err(|e| e.to_string())?.map_err(err)?;
    state.loaded.forget();
    Ok(())
}

#[derive(Deserialize)]
pub struct SpeakRequest {
    pub text: String,
    /// "de", "en", "fr", "es", "pt" (speechText.ts detects it)
    pub lang: String,
    /// "auto" (Phonon when it can) or "system"
    pub engine: String,
    /// the Phonon model chosen in the settings
    pub model: Option<String>,
    /// Phonon voice for this language ("" / "default" = the model's own)
    pub voice: Option<String>,
    /// 1 = normal
    pub speed: f32,
}

#[derive(Serialize)]
pub struct Started {
    pub session: u64,
    #[serde(flatten)]
    pub engine: EngineInfo,
}

fn choice_for(state: &Speech, r: &SpeakRequest) -> Result<Choice> {
    choose(&local_models(&state.dir), &r.engine, r.model.as_deref(), &r.lang, SYSTEM_VOICE)
        .ok_or_else(|| anyhow!("Kein Phonon-Modell für diese Sprache und keine Systemstimme – Einstellungen › Vorlesen."))
}

/// Speaks `text` (stopping what speaks now); returns at once, `speech` events follow.
#[tauri::command]
pub async fn speech_speak(app: AppHandle, state: tauri::State<'_, Speech>, request: SpeakRequest) -> Result<Started, String> {
    // swapped in one step: two quick requests must not both keep speaking
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.current.lock().unwrap().replace(stop.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    let choice = choice_for(&state, &request).inspect_err(|_| state.release(&stop)).map_err(err)?;
    let session = state.sessions.fetch_add(1, Ordering::Relaxed) + 1;
    let started = Started { session, engine: describe(&choice, &request.lang) };
    let (dir, loaded) = (state.dir.clone(), state.loaded.clone());
    std::thread::spawn(move || {
        let emit = |v: serde_json::Value| {
            let _ = app.emit("speech", v);
        };
        let speed = if request.speed.is_finite() { request.speed.clamp(0.5, 2.0) } else { 1.0 };
        let result = match choice {
            Choice::Phonon(id) => model_dir(&dir, &id).and_then(|path| {
                let synth = loaded.get(&dir, &path, speed)?;
                // stopped while the model was loading
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let (chunks, warning) = stream(&synth, &request.text, &request.lang, request.voice.as_deref())?;
                let rate = chunks.sample_rate();
                play(chunks, rate, &stop, || emit(json!({ "session": session, "t": "playing", "warning": warning })))
            }),
            Choice::System => speak_system(&request.text, &request.lang, speed, &stop, |_| emit(json!({ "session": session, "t": "playing" }))),
        };
        app.state::<Speech>().release(&stop);
        match result {
            Ok(()) => emit(json!({ "session": session, "t": "end" })),
            Err(e) => emit(json!({ "session": session, "t": "error", "error": err(e) })),
        }
    });
    Ok(started)
}

#[tauri::command]
pub fn speech_stop(state: tauri::State<'_, Speech>) {
    state.stop();
}

/// Loads the Phonon model the next request would use (text got selected), so speaking starts at once.
#[tauri::command]
pub fn speech_prewarm(state: tauri::State<'_, Speech>, request: SpeakRequest) {
    let Ok(Choice::Phonon(id)) = choice_for(&state, &request) else { return };
    let Ok(path) = model_dir(&state.dir, &id) else { return };
    let (dir, loaded) = (state.dir.clone(), state.loaded.clone());
    std::thread::spawn(move || {
        let _ = loaded.get(&dir, &path, request.speed);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids() {
        let dir = Path::new("/s");
        assert_eq!(model_dir(dir, "phonon-40m-multilingual").unwrap(), Path::new("/s/models/phonon-40m-multilingual"));
        assert!(model_dir(dir, "../x").is_err());
        assert!(model_dir(dir, "phonon-../x").is_err());
        assert!(model_dir(dir, "whisper-base").is_err());
        assert!(model_dir(dir, "phonon-40m.part").is_err());
    }

    #[test]
    fn catalog_paths_stay_inside() {
        assert!(inside("voices/NbpkqMVS3CJeq2j8.safetensors"));
        assert!(!inside("../x.safetensors"));
        assert!(!inside("/etc/passwd"));
        assert!(!inside("voices//x"));
        assert!(catalog_base().starts_with("https://huggingface.co/gradium/phonon-voices/resolve/"));
    }

    #[test]
    fn speed_maps_to_duration_delta() {
        assert_eq!(duration_delta(1.0), 0.0);
        assert!(duration_delta(1.3) < -0.4 && duration_delta(1.3) >= -0.5);
        assert!(duration_delta(0.8) > 0.3);
        assert_eq!(duration_delta(3.0), -0.5);
    }

    #[test]
    fn system_voices() {
        let listing = "Bad News            en_US    # Hello! My name is Bad News.\n\
                       Anna (Deutsch (Deutschland)) de_DE    # Hallo! Ich heiße Anna.\n\
                       Eddy (Deutsch (Deutschland)) de_DE    # Hallo! Ich heiße Eddy.\n\
                       Samantha            en_US    # Hello! My name is Samantha.\n\
                       Amélie              fr_CA    # Bonjour, je m’appelle Amélie.\n";
        let voices = parse_system_voices(listing);
        assert_eq!(voices[1], ("Anna (Deutsch (Deutschland))".to_string(), "de_DE".to_string()));
        assert_eq!(pick_system_voice(&voices, "de").as_deref(), Some("Anna (Deutsch (Deutschland))"));
        assert_eq!(pick_system_voice(&voices, "en").as_deref(), Some("Samantha"));
        assert_eq!(pick_system_voice(&voices, "fr").as_deref(), Some("Amélie"));
        assert_eq!(pick_system_voice(&voices, "es"), None);
    }

    fn model(id: &str, languages: &[&str]) -> LocalModel {
        LocalModel { id: id.into(), bytes: 0, languages: languages.iter().map(|l| l.to_string()).collect(), speed: true, catalog_voices: true }
    }

    #[test]
    fn chooses_engine_by_language() {
        let en = model("phonon-31m-en", &["en"]);
        let multi = model("phonon-40m-multilingual", &["en", "fr", "de", "es", "pt"]);
        let p = |id: &str| Some(Choice::Phonon(id.into()));
        assert_eq!(choose(&[], "auto", None, "de", true), Some(Choice::System));
        assert_eq!(choose(&[], "auto", None, "de", false), None);
        assert_eq!(choose(&[en.clone()], "auto", None, "de", true), Some(Choice::System));
        assert_eq!(choose(&[en.clone()], "auto", None, "en", true), p("phonon-31m-en"));
        assert_eq!(choose(&[en.clone(), multi.clone()], "auto", None, "en", true), p("phonon-40m-multilingual"));
        assert_eq!(choose(&[en.clone(), multi.clone()], "auto", Some("phonon-31m-en"), "en", true), p("phonon-31m-en"));
        assert_eq!(choose(&[en.clone(), multi.clone()], "auto", Some("phonon-31m-en"), "de", true), p("phonon-40m-multilingual"));
        assert_eq!(choose(&[multi.clone()], "system", None, "de", true), Some(Choice::System));
        assert_eq!(choose(&[multi], "system", None, "de", false), p("phonon-40m-multilingual"));
    }

    #[test]
    fn token_file_is_private() {
        let dir = std::env::temp_dir().join(format!("hollr-speech-{}", std::process::id()));
        save_token(&dir, " hf_abc123 ").unwrap();
        assert_eq!(std::fs::read_to_string(token_file(&dir)).unwrap(), "hf_abc123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(token_file(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(save_token(&dir, "no spaces allowed").is_err());
        save_token(&dir, "").unwrap();
        assert!(!token_file(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
