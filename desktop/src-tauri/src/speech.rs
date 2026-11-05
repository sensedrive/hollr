//! Read aloud (Settings › Vorlesen): text selected in the chat or the terminal is spoken on this
//! computer. Phonon (Gradium's on-device TTS, crate `ptts`) speaks when a downloaded model knows the
//! text's language; otherwise the macOS system voice (`/usr/bin/say`) does, so the feature works
//! before any model is there. Markdown cleanup and language detection happen in the frontend
//! (speechText.ts); this gets plain text plus a language code.
//!
//! Models come from Ollama's registry (`library/phonon:<tag>`), which hosts Gradium's checkpoints
//! without Hugging Face's gate: one single-tensor safetensors blob per weight plus config, tokenizer
//! and licence files. The blobs are checked against their digests and merged into one
//! `model.safetensors`, so `ptts` loads the folder like a Hugging Face checkpoint.
//!
//! Files in `<app data>/speech`: `models/<id>/` (config.json, tokenizer.json, model.safetensors,
//! LICENSE*.txt), `models/<id>.part/` while downloading (kept on failure: the next try resumes) and
//! `voices.jsonl` (Gradium's public voice catalog from Hugging Face, only for names → language and
//! gender). Gradium's voices are baked into the weights; each language reads with the catalog's
//! first voice of that language unless another one is chosen.
//!
//! Events: `speech` {session, t: "playing" | "end" | "error", error?, warning?} and
//! `speech-download` {id, progress} / {id, done} / {id, cancelled} / {id, error}.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use ptts::checkpoint::{Checkpoint, ResolveOptions, read_config};
use ptts::preprocess::{Lang, Normalize};
use ptts::synth::{DeviceKind, Quant, SpeechOptions, SpeechStream, Synth};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::live::Resampler;

/// Where Ollama keeps the Phonon checkpoints; tag = the model id without `phonon-`.
const REGISTRY: &str = "https://registry.ollama.ai/v2/library/phonon";
/// What a finished model folder holds (`Checkpoint::resolve` finds them by these names).
const MODEL_FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];
/// The model licence (its first lines name the source: "Gradium gradium/<repo>", "Source: <url>").
const LICENSE_FILE: &str = "LICENSE.txt";
/// Parallel blob downloads: a checkpoint is ~300 small files, each behind a redirect.
const DOWNLOAD_THREADS: usize = 6;
/// The tensors Ollama's checkpoints keep Gradium's voices in: `voices.<name>`.
const VOICE_PREFIX: &str = "voices.";
/// The conditioner Phonon checkpoints read the speaking rate from (positive = slower).
const DURATION_DELTA: &str = "duration_delta";

// ------------------------------------------------------------ files

/// `<dir>/models/<id>`; ids are "phonon-<tag>" ("phonon-40m-multilingual" …).
pub fn model_dir(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = id.starts_with("phonon-") && id.len() < 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        bail!("Unbekanntes Modell „{id}“");
    }
    Ok(dir.join("models").join(id))
}

fn tag(id: &str) -> &str {
    id.strip_prefix("phonon-").unwrap_or(id)
}

pub fn model_page(id: &str) -> String {
    format!("https://ollama.com/library/phonon:{}", tag(id))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(20))).build().into()
}

fn http_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::StatusCode(404) => anyhow!("Datei nicht gefunden (404)"),
        e => anyhow!("Download fehlgeschlagen: {e}"),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One file into `dest` (via `<dest>.part`); `on_bytes` gets every piece's length. With `sha256` the
/// content must hash to it. Stops as soon as `cancel` is set.
fn fetch(agent: &ureq::Agent, url: &str, dest: &Path, sha256: Option<&str>, cancel: &AtomicBool, mut on_bytes: impl FnMut(u64)) -> Result<()> {
    let part = dest.with_extension("part");
    let mut run = || -> Result<()> {
        let resp = agent.get(url).call().map_err(http_error)?;
        let total = resp.body().content_length();
        let mut reader = resp.into_body().into_reader();
        let mut out = std::io::BufWriter::new(std::fs::File::create(&part).context("Datei anlegen")?);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut done = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("Abgebrochen");
            }
            let n = reader.read(&mut buf).map_err(|e| anyhow!("Download unterbrochen: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).context("Datei schreiben")?;
            hasher.update(&buf[..n]);
            done += n as u64;
            on_bytes(n as u64);
        }
        out.flush()?;
        if let Some(total) = total
            && done != total
        {
            bail!("Download unvollständig ({done} von {total} Bytes)");
        }
        if let Some(want) = sha256
            && hex(&hasher.finalize()) != want
        {
            bail!("Download beschädigt (Prüfsumme stimmt nicht)");
        }
        Ok(())
    };
    if let Err(e) = run() {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, dest).context("Datei ablegen")
}

#[derive(Deserialize, Debug)]
struct Manifest {
    layers: Vec<Layer>,
}

#[derive(Deserialize, Debug, Clone)]
struct Layer {
    #[serde(rename = "mediaType")]
    media_type: String,
    digest: String,
    size: u64,
    #[serde(default)]
    name: Option<String>,
}

impl Layer {
    /// The digest's hex part – also the blob's file name, so it must be exactly that.
    fn sha256(&self) -> Result<&str> {
        let hex = self.digest.strip_prefix("sha256:").unwrap_or_default();
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            bail!("Unerwarteter Eintrag im Modell-Manifest: {}", self.digest);
        }
        Ok(hex)
    }

    fn kind(&self) -> &str {
        self.media_type.strip_prefix("application/vnd.ollama.image.").unwrap_or(&self.media_type)
    }
}

fn manifest(agent: &ureq::Agent, tag: &str) -> Result<Manifest> {
    let resp = agent
        .get(format!("{REGISTRY}/manifests/{tag}"))
        .header("Accept", "application/vnd.docker.distribution.manifest.v2+json")
        .call()
        .map_err(http_error)
        .context("Modell-Manifest")?;
    let text = resp.into_body().read_to_string().context("Modell-Manifest")?;
    serde_json::from_str(&text).context("Modell-Manifest")
}

/// Merges single-tensor safetensors blobs (in order) into one safetensors file at `out`: one header
/// with the offsets moved along, then the blobs' data back to back, streamed from disk. Returns the
/// tensor names.
pub fn merge_safetensors(blobs: &[PathBuf], out: &Path) -> Result<Vec<String>> {
    let mut header = serde_json::Map::new();
    // (blob, where its data starts, how long it is)
    let mut parts = Vec::with_capacity(blobs.len());
    let mut offset = 0u64;
    for blob in blobs {
        let mut f = std::fs::File::open(blob).context("Modellteil")?;
        let mut len = [0u8; 8];
        f.read_exact(&mut len).context("Modellteil")?;
        let len = u64::from_le_bytes(len);
        if len > 1 << 20 {
            bail!("Modellteil ist keine safetensors-Datei");
        }
        let mut raw = vec![0u8; len as usize];
        f.read_exact(&mut raw).context("Modellteil")?;
        let tensors: serde_json::Map<String, Value> = serde_json::from_slice(&raw).context("Modellteil")?;
        let mut data = 0u64;
        for (name, info) in tensors {
            if name == "__metadata__" {
                continue;
            }
            let range = info["data_offsets"].as_array().and_then(|r| Some((r.first()?.as_u64()?, r.get(1)?.as_u64()?)));
            let Some((begin, end)) = range.filter(|(b, e)| b <= e) else { bail!("Modellteil {name}: ungültige Offsets") };
            if header.contains_key(&name) {
                bail!("Tensor {name} doppelt im Modell");
            }
            header.insert(name, json!({ "dtype": info["dtype"], "shape": info["shape"], "data_offsets": [offset + begin, offset + end] }));
            data = data.max(end);
        }
        if f.metadata()?.len() != 8 + len + data {
            bail!("Modellteil {} hat eine unerwartete Größe", blob.display());
        }
        parts.push((blob, 8 + len, data));
        offset += data;
    }
    let mut head = serde_json::to_vec(&header)?;
    // the format pads the header to 8 bytes, so the data starts aligned
    head.resize(head.len().div_ceil(8) * 8, b' ');
    let mut w = std::io::BufWriter::new(std::fs::File::create(out).context("model.safetensors")?);
    w.write_all(&(head.len() as u64).to_le_bytes())?;
    w.write_all(&head)?;
    for (blob, start, len) in parts {
        let mut f = std::fs::File::open(blob)?;
        f.seek(SeekFrom::Start(start))?;
        let copied = std::io::copy(&mut f.take(len), &mut w)?;
        if copied != len {
            bail!("Modellteil {} ist zu kurz", blob.display());
        }
    }
    w.flush().context("model.safetensors")?;
    Ok(header.into_iter().map(|(name, _)| name).collect())
}

/// Downloads the blobs of `layers` that `blobs` doesn't have yet (in parallel, each checked against its
/// digest); `progress` gets the bytes there so far, including blobs a previous try finished.
fn download_blobs(agent: &ureq::Agent, layers: &[Layer], blobs: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64)) -> Result<()> {
    let done = AtomicU64::new(0);
    let mut todo = Vec::new();
    for layer in layers {
        let hash = layer.sha256()?;
        let file = blobs.join(hash);
        // only a verified download gets its final name
        if file.metadata().is_ok_and(|m| m.len() == layer.size) {
            done.fetch_add(layer.size, Ordering::Relaxed);
        } else {
            todo.push((format!("{REGISTRY}/blobs/{}", layer.digest), hash, file));
        }
    }
    let next = AtomicUsize::new(0);
    // set by a cancel (copied over below) or the first failing blob: every worker stops
    let abort = AtomicBool::new(false);
    let error: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    std::thread::scope(|s| {
        let workers: Vec<_> = (0..DOWNLOAD_THREADS.min(todo.len()))
            .map(|_| {
                s.spawn(|| {
                    while !abort.load(Ordering::Relaxed) {
                        let Some((url, hash, file)) = todo.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                        if let Err(e) = fetch(agent, url, file, Some(hash), &abort, |n| {
                            done.fetch_add(n, Ordering::Relaxed);
                        }) {
                            if !abort.swap(true, Ordering::Relaxed) {
                                *error.lock().unwrap() = Some(e);
                            }
                        }
                    }
                })
            })
            .collect();
        while !workers.iter().all(|w| w.is_finished()) {
            if cancel.load(Ordering::Relaxed) {
                abort.store(true, Ordering::Relaxed);
            }
            progress(done.load(Ordering::Relaxed));
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    if cancel.load(Ordering::Relaxed) {
        bail!("Abgebrochen");
    }
    if let Some(e) = error.into_inner().unwrap() {
        return Err(e);
    }
    progress(done.load(Ordering::Relaxed));
    Ok(())
}

/// Downloads a Phonon checkpoint from Ollama's registry into `<dir>/models/<id>` (via `<id>.part`,
/// kept on failure so the next try only fetches what is missing), plus the default voice of each
/// language it speaks. `progress` gets 0 … 1.
pub fn download_model(dir: &Path, id: &str, cancel: &AtomicBool, mut progress: impl FnMut(f64)) -> Result<PathBuf> {
    let target = model_dir(dir, id)?;
    let part = target.with_extension("part");
    let blobs = part.join("blobs");
    std::fs::create_dir_all(&blobs).context("Modellordner")?;
    let agent = agent();
    let manifest = manifest(&agent, tag(id))?;
    let total: u64 = manifest.layers.iter().map(|l| l.size).sum::<u64>().max(1);
    // the merge and the voices are the last few percent
    download_blobs(&agent, &manifest.layers, &blobs, cancel, |done| progress(done as f64 / total as f64 * 0.97))?;

    let blob = |l: &Layer| l.sha256().map(|h| blobs.join(h));
    let tensors: Vec<PathBuf> = manifest.layers.iter().filter(|l| l.kind() == "tensor").map(blob).collect::<Result<_>>()?;
    if tensors.is_empty() {
        bail!("Das Modell im Registry hat keine Gewichte");
    }
    let names = merge_safetensors(&tensors, &part.join("model.safetensors"))?;
    let mut licenses = 0;
    for layer in &manifest.layers {
        let name = match (layer.kind(), layer.name.as_deref()) {
            ("json", Some(name)) if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) && !name.starts_with('.') => {
                name.to_string()
            }
            ("license", _) => {
                // the voice catalog's licence comes along too; the model's own is LICENSE.txt
                let text = std::fs::read_to_string(blob(layer)?).unwrap_or_default();
                if text.lines().next().is_some_and(|l| l.contains("phonon-voices")) {
                    "LICENSE-voices.txt".to_string()
                } else {
                    licenses += 1;
                    if licenses == 1 { LICENSE_FILE.to_string() } else { format!("LICENSE-{licenses}.txt") }
                }
            }
            _ => continue,
        };
        std::fs::copy(blob(layer)?, part.join(name)).context("Modelldatei")?;
    }
    if !MODEL_FILES.iter().all(|f| part.join(f).is_file()) {
        bail!("Das Modell im Registry ist unvollständig (config.json / tokenizer.json fehlen)");
    }
    bake_voices(&part.join("config.json"), &names)?;
    // voice names → language and gender for the settings; only nice to have
    if let Err(e) = catalog(dir) {
        eprintln!("speech: voice catalog: {e:#}");
    }
    std::fs::remove_dir_all(&blobs).context("Modellordner")?;
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&part, &target).context("Modellordner")?;
    progress(1.0);
    Ok(target)
}

/// Ollama's checkpoints carry Gradium's voices in the weights (`voices.<name>`, speaker latents) but
/// their config doesn't list them, and ptts refuses tensors it doesn't know: list them as baked-in voices.
fn bake_voices(config: &Path, tensors: &[String]) -> Result<()> {
    let voices: Vec<Value> = tensors
        .iter()
        .filter_map(|t| t.strip_prefix(VOICE_PREFIX).map(|name| json!({ "name": name, "prefix": t })))
        .collect();
    let mut cfg: Value = serde_json::from_str(&std::fs::read_to_string(config).context("config.json")?).context("config.json")?;
    if voices.is_empty() || cfg.get("voices").and_then(Value::as_array).is_some_and(|v| !v.is_empty()) {
        return Ok(());
    }
    cfg["voices"] = Value::Array(voices);
    std::fs::write(config, serde_json::to_vec_pretty(&cfg)?).context("config.json")
}

#[derive(Serialize, Clone, Debug)]
pub struct LocalModel {
    pub id: String,
    pub bytes: u64,
    /// what the checkpoint says it speaks ("de", "en" …); empty = not said
    pub languages: Vec<String>,
    /// takes a speaking rate
    pub speed: bool,
    /// its voices (baked into the weights), "default" among them
    pub voices: Vec<String>,
    /// the licence file's source lines ("Gradium gradium/phonon-40m-multilingual · Source: …")
    pub attribution: Option<String>,
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
            let attribution = std::fs::read_to_string(path.join(LICENSE_FILE))
                .ok()
                .map(|t| t.lines().take(2).map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" · "))
                .filter(|a| !a.is_empty());
            let voices = config.voices.iter().map(|v| v.name.clone()).collect();
            Some(LocalModel { speed: has_speed(&config), voices, languages: config.languages, bytes, attribution, id })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

// ------------------------------------------------------------ voices

/// A voice of Gradium's catalog: what the model only knows by name.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CatalogVoice {
    pub name: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// ptts' pinned default catalog (`hf://gradium/phonon-voices@<commit>`, public) as a download URL.
fn catalog_url() -> String {
    let source = ptts::voice_catalog::DEFAULT_VOICE_CATALOG.trim_start_matches("hf://");
    let (repo, revision) = source.split_once('@').unwrap_or((source, "main"));
    format!("https://huggingface.co/{repo}/resolve/{revision}/{}", ptts::voice_catalog::CATALOG_FILE)
}

fn catalog_file(dir: &Path) -> PathBuf {
    dir.join(ptts::voice_catalog::CATALOG_FILE)
}

/// The catalog as it is on this computer (no network); empty before the first download.
fn catalog_entries(dir: &Path) -> Vec<CatalogVoice> {
    let text = std::fs::read_to_string(catalog_file(dir)).unwrap_or_default();
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Gradium's voice catalog (~35 KB, fetched once): which language, accent and gender each voice has.
pub fn catalog(dir: &Path) -> Result<Vec<CatalogVoice>> {
    let file = catalog_file(dir);
    if !file.is_file() {
        std::fs::create_dir_all(dir).context("Ordner für die Sprachausgabe")?;
        fetch(&agent(), &catalog_url(), &file, None, &AtomicBool::new(false), |_| {}).context("Stimmenkatalog")?;
    }
    Ok(catalog_entries(dir))
}

/// The voice a language reads with when none is chosen: the catalog's first one of that language
/// the model has; None = the model's "default".
pub fn default_voice<'a>(catalog: &'a [CatalogVoice], model_voices: &[String], lang: &str) -> Option<&'a CatalogVoice> {
    catalog.iter().find(|v| v.language.as_deref() == Some(lang) && model_voices.contains(&v.name))
}

// ------------------------------------------------------------ Phonon

/// Speaking rate (1 = normal) → Phonon's `duration_delta`. Measured on Phonon 31m: −0.5 speaks
/// ~1.3× as fast, +0.5 ~0.8×; beyond that it barely changes and gets unstable.
pub fn duration_delta(speed: f32) -> f32 {
    ((1.0 - speed) * 1.7).clamp(-0.5, 0.5)
}

/// Loads a checkpoint for the CPU (weights quantized to q8 on load, ~20× realtime on one Apple core)
/// with the voices baked into it. Text is normalized per request (`stream`), so one loaded model
/// serves every language it speaks.
pub fn load(model: &Path, speed: f32) -> Result<Synth> {
    let checkpoint = Checkpoint::resolve(model, ResolveOptions { quant: Quant::Q80, weights: None })
        .map_err(|e| anyhow!("Phonon-Modell lässt sich nicht laden: {e}"))?;
    let mut builder = checkpoint.builder(Normalize::OFF).device(DeviceKind::Cpu);
    if has_speed(&checkpoint.config) {
        builder = builder.condition(DURATION_DELTA, format!("{:.2}", duration_delta(speed)));
    }
    let mut synth = builder.build().map_err(|e| anyhow!("Phonon-Modell lässt sich nicht laden: {e}"))?;
    checkpoint.register_voices(&mut synth);
    Ok(synth)
}

/// Starts generating `text` (normalized as `lang`) in `voice`. Without one – or with one the model
/// doesn't have (warning) – it reads with the catalog's first voice of that language, else "default".
pub fn stream(synth: &Synth, dir: &Path, text: &str, lang: &str, voice: Option<&str>) -> Result<(SpeechStream, Option<String>)> {
    let normalize = lang.parse::<Lang>().map(Normalize::for_lang).unwrap_or(Normalize::OFF);
    let text = normalize.apply(text);
    let known = synth.voices();
    let mut warning = None;
    let mut chosen = voice.filter(|v| !v.is_empty() && *v != "default").map(str::to_string);
    if let Some(v) = chosen.take_if(|v| !known.contains(v)) {
        warning = Some(format!("Stimme „{v}“ passt nicht zu diesem Modell – Standardstimme."));
    }
    if chosen.is_none() {
        chosen = default_voice(&catalog_entries(dir), &known, lang).map(|v| v.name.clone());
    }
    let options = chosen.map_or_else(SpeechOptions::default, |v| SpeechOptions::default().voice(v));
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
    fn get(&self, model: &Path, speed: f32) -> Result<Arc<Synth>> {
        let key = (duration_delta(speed) * 100.0).round() as i32;
        let mut slot = self.0.lock().unwrap();
        if let Some((p, k, synth)) = slot.as_ref()
            && p == model
            && *k == key
        {
            return Ok(synth.clone());
        }
        *slot = None; // free the old model first
        let synth = Arc::new(load(model, speed)?);
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
    /// the webview that asked for it (its reload stops it, another window's doesn't)
    owner: Mutex<String>,
    sessions: AtomicU64,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Speech {
    /// `dir`: `<app data>/speech`.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            loaded: Loaded::default(),
            current: Default::default(),
            owner: Default::default(),
            sessions: AtomicU64::new(0),
            downloads: Default::default(),
        }
    }

    /// Silences whatever speaks (a reloaded webview, the stop button, Esc, a deleted model).
    pub fn stop(&self) {
        if let Some(stop) = self.current.lock().unwrap().take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    /// Webview `owner` reloaded: what it was reading aloud stops.
    pub fn stop_owned(&self, owner: &str) {
        if *self.owner.lock().unwrap() == owner {
            self.stop();
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
    Ok(Status { system: SYSTEM_VOICE, models, engines })
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
        let result = download_model(&dir, &id, &cancel, |p| {
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

/// Removes a model, and what an unfinished download of it left behind.
#[tauri::command]
pub fn speech_delete(state: tauri::State<'_, Speech>, id: String) -> Result<(), String> {
    let path = model_dir(&state.dir, &id).map_err(err)?;
    state.stop();
    state.loaded.forget();
    for p in [path.with_extension("part"), path] {
        match std::fs::remove_dir_all(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

/// The chosen model's voices with what the catalog says about them (language, gender …; only the
/// name when the catalog isn't there), and the voice each language reads with when none is chosen.
#[tauri::command]
pub async fn speech_voices(state: tauri::State<'_, Speech>, model: String) -> Result<serde_json::Value, String> {
    let dir = state.dir.clone();
    let names = local_models(&dir).into_iter().find(|m| m.id == model).map(|m| m.voices).unwrap_or_default();
    let catalog = tokio::task::spawn_blocking(move || catalog(&dir).unwrap_or_else(|_| catalog_entries(&dir)))
        .await
        .map_err(|e| e.to_string())?;
    let defaults: HashMap<&str, &str> = LANGUAGES.iter().filter_map(|l| Some((*l, default_voice(&catalog, &names, l)?.name.as_str()))).collect();
    let voices: Vec<CatalogVoice> = names
        .iter()
        .filter(|n| *n != "default")
        .map(|n| {
            catalog.iter().find(|v| &v.name == n).cloned().unwrap_or(CatalogVoice {
                name: n.clone(),
                language: None,
                locale: None,
                gender: None,
                description: None,
            })
        })
        .collect();
    Ok(json!({ "voices": voices, "defaults": defaults }))
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
pub async fn speech_speak(app: AppHandle, webview: tauri::Webview, state: tauri::State<'_, Speech>, request: SpeakRequest) -> Result<Started, String> {
    // swapped in one step: two quick requests must not both keep speaking
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.current.lock().unwrap().replace(stop.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    *state.owner.lock().unwrap() = webview.label().to_string();
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
                let synth = loaded.get(&path, speed)?;
                // stopped while the model was loading
                if stop.load(Ordering::Relaxed) {
                    return Ok(());
                }
                let (chunks, warning) = stream(&synth, &dir, &request.text, &request.lang, request.voice.as_deref())?;
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
    let loaded = state.loaded.clone();
    std::thread::spawn(move || {
        let _ = loaded.get(&path, request.speed);
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
    fn catalog_is_pinned() {
        assert!(catalog_url().starts_with("https://huggingface.co/gradium/phonon-voices/resolve/"));
        assert!(catalog_url().ends_with("/voices.jsonl"));
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
        LocalModel { id: id.into(), bytes: 0, languages: languages.iter().map(|l| l.to_string()).collect(), speed: true, voices: vec![], attribution: None }
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

    /// One single-tensor safetensors file as Ollama's registry stores it.
    fn blob(name: &str, data: &[u8]) -> Vec<u8> {
        let head = json!({ name: { "dtype": "BF16", "shape": [data.len() / 2], "data_offsets": [0, data.len()] } }).to_string();
        let mut out = (head.len() as u64).to_le_bytes().to_vec();
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn merges_tensor_blobs() {
        let dir = std::env::temp_dir().join(format!("hollr-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let files: Vec<PathBuf> = [("b.weight", &[1u8, 2, 3, 4][..]), ("a.bias", &[5, 6][..])]
            .iter()
            .enumerate()
            .map(|(i, (name, data))| {
                let f = dir.join(format!("{i}"));
                std::fs::write(&f, blob(name, data)).unwrap();
                f
            })
            .collect();
        let out = dir.join("model.safetensors");
        merge_safetensors(&files, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let len = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
        assert_eq!(len % 8, 0, "header padded to 8 bytes");
        let header: Value = serde_json::from_slice(&bytes[8..8 + len]).unwrap();
        assert_eq!(header["b.weight"]["data_offsets"], json!([0, 4]));
        assert_eq!(header["a.bias"]["data_offsets"], json!([4, 6]));
        assert_eq!(header["a.bias"]["dtype"], "BF16");
        assert_eq!(&bytes[8 + len..], &[1, 2, 3, 4, 5, 6]);

        // a truncated blob and a duplicate name are refused
        std::fs::write(&files[1], &blob("a.bias", &[5, 6])[..20]).unwrap();
        assert!(merge_safetensors(&files, &out).is_err());
        std::fs::write(&files[1], blob("b.weight", &[5, 6])).unwrap();
        assert!(merge_safetensors(&files, &out).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_digests() {
        let layer = |digest: &str| Layer { media_type: "application/vnd.ollama.image.tensor".into(), digest: digest.into(), size: 1, name: None };
        let ok = format!("sha256:{}", "ab".repeat(32));
        assert_eq!(layer(&ok).sha256().unwrap(), "ab".repeat(32));
        assert_eq!(layer(&ok).kind(), "tensor");
        assert!(layer("sha256:../../etc").sha256().is_err());
        assert!(layer(&format!("md5:{}", "ab".repeat(32))).sha256().is_err());
        assert_eq!(model_page("phonon-40m-multilingual"), "https://ollama.com/library/phonon:40m-multilingual");
    }

    #[test]
    fn default_voice_per_language() {
        let v = |name: &str, lang: &str| CatalogVoice { name: name.into(), language: Some(lang.into()), locale: None, gender: None, description: None };
        let catalog = [v("Zoey", "en"), v("Nele", "de"), v("Juniper", "en"), v("Anton", "de")];
        let model: Vec<String> = ["default", "Juniper", "Anton", "Nele"].map(String::from).to_vec();
        // the catalog's order decides, among the voices the model has
        assert_eq!(default_voice(&catalog, &model, "en").map(|v| v.name.as_str()), Some("Juniper"));
        assert_eq!(default_voice(&catalog, &model, "de").map(|v| v.name.as_str()), Some("Nele"));
        assert!(default_voice(&catalog, &model, "fr").is_none());
        assert!(default_voice(&[], &model, "de").is_none());
    }

    #[test]
    fn bakes_voice_tensors_into_the_config() {
        let dir = std::env::temp_dir().join(format!("hollr-bake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        std::fs::write(&cfg, r#"{"languages": ["de"], "flow_lm": {"d_model": 512}}"#).unwrap();
        bake_voices(&cfg, &["flow_lm.bos_emb".into(), "voices.Nele".into(), "voices.default".into()]).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["voices"], json!([{ "name": "Nele", "prefix": "voices.Nele" }, { "name": "default", "prefix": "voices.default" }]));
        assert_eq!(v["flow_lm"]["d_model"], 512, "the rest stays");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
