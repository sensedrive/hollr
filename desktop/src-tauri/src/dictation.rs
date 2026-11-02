//! Local dictation for the composer (iOS Dictation.swift / DictationPipeline.swift): microphone →
//! 16 kHz mono → whisper.cpp on this computer (Metal on macOS). Independent of omp /live.
//!
//! While you talk, the recording is cut at speech pauses and those pieces are transcribed right away,
//! so only the last few seconds are left when you stop. Text cleanup (vocabulary, replacements,
//! fillers, "… senden") happens in the frontend (dictationText.ts), which owns the settings.
//!
//! Models are the ggml files of `ggerganov/whisper.cpp` on Hugging Face, kept in `<app data>/whisper`.
//!
//! Events: `dictation` {session, t: "level" | "text" | "interrupted", …} and
//! `dictation-download` {id, progress} / {id, done} / {id, error}.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use serde_json::json;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

/// Whisper's sample rate.
pub const RATE: usize = 16_000;
/// 20 ms analysis frames
const FRAME: usize = RATE / 50;

// ------------------------------------------------------------ models

/// `<dir>/ggml-<id>.bin`; ids are the file names on Hugging Face ("base", "large-v3-turbo-q5_0" …).
pub fn model_file(dir: &Path, id: &str) -> Result<PathBuf> {
    let ok = !id.is_empty() && !id.contains("..") && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok {
        bail!("Unbekanntes Modell „{id}“");
    }
    Ok(dir.join(format!("ggml-{id}.bin")))
}

pub fn model_url(id: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{id}.bin")
}

/// Downloads a model into `<file>.part` and renames it when complete; `progress` gets 0 … 1.
/// Stops with an error as soon as `cancel` is set.
pub fn download_model(dir: &Path, id: &str, cancel: &AtomicBool, mut progress: impl FnMut(f64)) -> Result<PathBuf> {
    let file = model_file(dir, id)?;
    std::fs::create_dir_all(dir).context("Modellordner")?;
    let part = file.with_extension("bin.part");
    let mut run = || -> Result<()> {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(20))).build().into();
        let resp = agent.get(&model_url(id)).call().map_err(|e| anyhow!("Download fehlgeschlagen: {e}"))?;
        let total = resp.body().content_length();
        let mut reader = resp.into_body().into_reader();
        let mut out = std::io::BufWriter::new(std::fs::File::create(&part).context("Modelldatei")?);
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
            out.write_all(&buf[..n]).context("Modelldatei schreiben")?;
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
    };
    if let Err(e) = run() {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, &file).context("Modelldatei")?;
    progress(1.0);
    Ok(file)
}

#[derive(Serialize)]
pub struct LocalModel {
    pub id: String,
    pub bytes: u64,
}

/// Models in `dir` (finished downloads only).
pub fn local_models(dir: &Path) -> Vec<LocalModel> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let id = name.strip_prefix("ggml-")?.strip_suffix(".bin")?.to_string();
            Some(LocalModel { id, bytes: e.metadata().ok()?.len() })
        })
        .collect()
}

/// Loads a ggml model (GPU/Metal when built with it). whisper.cpp's own logging is switched off.
pub fn load_model(path: &Path) -> Result<WhisperContext> {
    whisper_rs::install_logging_hooks();
    WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| anyhow!("Whisper-Modell lässt sich nicht laden: {e}"))
}

// ------------------------------------------------------------ audio

/// Any input rate → 16 kHz by averaging the samples of each output step (cheap low-pass for speech).
pub struct Downsampler {
    step: f64,
    pos: f64,
    sum: f32,
    n: u32,
    last: f32,
}

impl Downsampler {
    pub fn new(from: f64) -> Self {
        Self { step: from / RATE as f64, pos: 0.0, sum: 0.0, n: 0, last: 0.0 }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &s in input {
            self.sum += s;
            self.n += 1;
            self.pos += 1.0;
            while self.pos >= self.step {
                if self.n > 0 {
                    self.last = self.sum / self.n as f32;
                    self.sum = 0.0;
                    self.n = 0;
                }
                out.push(self.last);
                self.pos -= self.step;
            }
        }
    }
}

/// Mono samples at `rate` → 16 kHz.
pub fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate as usize == RATE {
        return samples.to_vec();
    }
    let mut out = Vec::with_capacity(samples.len() * RATE / rate.max(1) as usize + 1);
    Downsampler::new(rate as f64).push(samples, &mut out);
    out
}

/// 16 kHz samples plus the energy of every 20 ms frame; filled on the audio thread.
#[derive(Default)]
pub struct Recording {
    pub samples: Vec<f32>,
    pub rms: Vec<f32>,
}

impl Recording {
    pub fn push(&mut self, chunk: &[f32]) {
        self.samples.extend_from_slice(chunk);
        while (self.rms.len() + 1) * FRAME <= self.samples.len() {
            let start = self.rms.len() * FRAME;
            self.rms.push(rms(&self.samples[start..start + FRAME]));
        }
    }
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

// ------------------------------------------------------------ silence

/// Speech threshold relative to the recording's own noise floor (quiet room vs. train).
fn threshold(rms: &[f32]) -> f32 {
    if rms.is_empty() {
        return 0.01;
    }
    let mut sorted = rms.to_vec();
    sorted.sort_by(f32::total_cmp);
    let floor = sorted[(sorted.len() / 10).min(sorted.len() - 1)];
    (floor * 3.5).max(0.008)
}

/// Cuts leading/trailing silence (keeps 250 ms around speech); None = nothing was said.
pub fn trim(samples: &[f32]) -> Option<&[f32]> {
    if samples.len() < FRAME * 5 {
        return None;
    }
    let frames: Vec<f32> = samples.chunks_exact(FRAME).map(rms).collect();
    let t = threshold(&frames);
    let first = frames.iter().position(|r| *r > t)?;
    let last = frames.iter().rposition(|r| *r > t)?;
    // a single click is not speech: at least ~120 ms above the threshold
    if frames.iter().filter(|r| **r > t).count() < 6 {
        return None;
    }
    let pad = RATE / 4;
    let start = (first * FRAME).saturating_sub(pad);
    let end = ((last + 1) * FRAME + pad).min(samples.len());
    Some(&samples[start..end])
}

/// Where to cut the running recording into a chunk (sample index), or None = keep collecting.
/// At a pause after ≥ 6 s of audio, forced at 25 s (at the quietest spot of the last 2 s).
pub fn cut_point(rms: &[f32], start: usize, total: usize) -> Option<usize> {
    let start_frame = start / FRAME;
    if rms.len() <= start_frame {
        return None;
    }
    let seconds = total.saturating_sub(start) as f64 / RATE as f64;
    if seconds < 6.0 {
        return None;
    }
    let t = threshold(rms);
    let tail = &rms[rms.len().saturating_sub(20)..];
    if tail.len() == 20 && tail.iter().all(|r| *r < t) {
        return Some((rms.len() - 10) * FRAME); // middle of the pause
    }
    if seconds >= 25.0 {
        let from = start_frame.max(rms.len().saturating_sub(100));
        let quiet = (from..rms.len()).min_by(|a, b| rms[*a].total_cmp(&rms[*b]));
        return Some(quiet.map_or(total, |i| i * FRAME));
    }
    None
}

// ------------------------------------------------------------ whisper

pub struct Options<'a> {
    /// "de", "en", … or "auto"
    pub language: &'a str,
    /// vocabulary terms for the prompt (already deduplicated)
    pub vocabulary: &'a [String],
    /// what was just said (the previous chunks) – the next chunk continues in style and spelling
    pub context: &'a str,
    /// retries with higher temperature when the result looks wrong (0 = off)
    pub fallbacks: u32,
}

unsafe extern "C" fn abort_requested(data: *mut c_void) -> bool {
    // SAFETY: `data` points at the AtomicBool behind the Arc that `transcribe` keeps alive.
    unsafe { (*(data as *const AtomicBool)).load(Ordering::Relaxed) }
}

fn threads() -> i32 {
    std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4) as i32
}

/// One piece of 16 kHz audio → text; "" for under half a second. `abort` stops a running decode.
pub fn transcribe(state: &mut WhisperState, samples: &[f32], o: &Options, abort: Option<&Arc<AtomicBool>>) -> Result<String> {
    if samples.len() <= RATE / 2 {
        return Ok(String::new());
    }
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 5 });
    p.set_n_threads(threads());
    p.set_language(Some(o.language));
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_temperature_inc(if o.fallbacks == 0 { 0.0 } else { 1.0 / o.fallbacks as f32 });
    // Whisper keeps the last ~220 prompt tokens: vocabulary as a sentence, then what was just said.
    // Long audio goes without (whisper.cpp splits it into windows that would all repeat the prompt).
    if (!o.vocabulary.is_empty() || !o.context.is_empty()) && samples.len() <= 30 * RATE {
        let mut prompt = String::new();
        if !o.vocabulary.is_empty() {
            prompt = format!(" {}.", o.vocabulary.iter().take(40).map(String::as_str).collect::<Vec<_>>().join(", "));
        }
        if !o.context.is_empty() {
            let tail: String = o.context.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
            prompt.push(' ');
            prompt.push_str(&tail);
        }
        p.set_initial_prompt(&prompt.replace('\0', ""));
    }
    if let Some(abort) = abort {
        // SAFETY: the flag outlives `full` (the caller holds the Arc); the callback only reads it.
        unsafe {
            p.set_abort_callback(Some(abort_requested));
            p.set_abort_callback_user_data(Arc::as_ptr(abort) as *mut c_void);
        }
    }
    state.full(p, samples).map_err(|e| anyhow!("Whisper: {e}"))?;
    let mut text = String::new();
    for i in 0..state.full_n_segments() {
        if let Some(seg) = state.get_segment(i)
            && let Ok(s) = seg.to_str_lossy()
        {
            text.push_str(&s);
        }
    }
    Ok(clean(&text))
}

/// Drops whisper's markers ("[BLANK_AUDIO]", "[MUSIK]") and squeezes whitespace.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find(']') {
            Some(close) if close > 0 && after[..close].chars().all(|c| c.is_uppercase() || c == '_' || c == ' ') => {
                rest = &after[close + 1..];
            }
            _ => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn join(a: &str, b: &str) -> String {
    [a.trim(), b.trim()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------ app state

/// The loaded model – loading takes a moment, so it stays in memory for the next dictation.
#[derive(Default, Clone)]
struct Loaded(Arc<Mutex<Option<(PathBuf, Arc<WhisperContext>)>>>);

impl Loaded {
    fn get(&self, path: &Path) -> Result<Arc<WhisperContext>> {
        let mut slot = self.0.lock().unwrap();
        if let Some((p, ctx)) = slot.as_ref()
            && p == path
        {
            return Ok(ctx.clone());
        }
        *slot = None; // free the old model first
        let ctx = Arc::new(load_model(path)?);
        *slot = Some((path.to_path_buf(), ctx.clone()));
        Ok(ctx)
    }

    fn forget(&self, path: &Path) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|(p, _)| p == path) {
            *slot = None;
        }
    }
}

struct Active {
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    done: tokio::sync::oneshot::Receiver<Result<Outcome>>,
}

#[derive(Serialize)]
pub struct Outcome {
    /// raw recognised text (cleanup happens in the frontend)
    pub text: String,
    /// recorded audio in seconds
    pub seconds: f64,
    /// the last piece failed, the text before it is kept
    pub tail_failed: bool,
}

pub struct Dictation {
    dir: PathBuf,
    loaded: Loaded,
    current: tokio::sync::Mutex<Option<Active>>,
    sessions: AtomicU64,
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Dictation {
    /// `dir`: where the models live (`<app data>/whisper`).
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, loaded: Loaded::default(), current: Default::default(), sessions: AtomicU64::new(0), downloads: Default::default() }
    }
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Downloaded models with their size.
#[tauri::command]
pub fn dictation_models(state: tauri::State<'_, Dictation>) -> Vec<LocalModel> {
    local_models(&state.dir)
}

/// Starts a download in the background; progress comes as `dictation-download` events.
#[tauri::command]
pub fn dictation_download(app: AppHandle, state: tauri::State<'_, Dictation>, id: String) -> Result<(), String> {
    model_file(&state.dir, &id).map_err(err)?;
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
            let _ = app.emit("dictation-download", json!({ "id": id, "progress": p }));
        });
        let state = app.state::<Dictation>();
        state.downloads.lock().unwrap().remove(&id);
        let msg = match result {
            Ok(_) => json!({ "id": id, "done": true }),
            Err(_) if cancel.load(Ordering::Relaxed) => json!({ "id": id, "cancelled": true }),
            Err(e) => json!({ "id": id, "error": err(e) }),
        };
        let _ = app.emit("dictation-download", msg);
    });
    Ok(())
}

#[tauri::command]
pub fn dictation_download_cancel(state: tauri::State<'_, Dictation>, id: String) {
    if let Some(flag) = state.downloads.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn dictation_delete(state: tauri::State<'_, Dictation>, id: String) -> Result<(), String> {
    let file = model_file(&state.dir, &id).map_err(err)?;
    state.loaded.forget(&file);
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Loads the model ahead of the first dictation (a chat with a composer opened).
#[tauri::command]
pub fn dictation_prewarm(state: tauri::State<'_, Dictation>, model: String) {
    let Ok(file) = model_file(&state.dir, &model) else { return };
    if !file.exists() {
        return;
    }
    let loaded = state.loaded.clone();
    std::thread::spawn(move || {
        let _ = loaded.get(&file);
    });
}

/// Opens the microphone and starts recording; returns the session id the `dictation` events carry.
/// A running dictation is thrown away.
#[tauri::command]
pub async fn dictation_start(
    app: AppHandle,
    state: tauri::State<'_, Dictation>,
    model: String,
    language: String,
    vocabulary: Vec<String>,
    fallbacks: u32,
) -> Result<u64, String> {
    let mut current = state.current.lock().await;
    if let Some(old) = current.take() {
        old.cancel.store(true, Ordering::Relaxed);
        old.stop.store(true, Ordering::Relaxed);
    }
    let file = model_file(&state.dir, &model).map_err(err)?;
    if !file.exists() {
        return Err("Whisper-Modell noch nicht geladen (Einstellungen › Diktat).".into());
    }
    let session = state.sessions.fetch_add(1, Ordering::Relaxed) + 1;
    let rec = Arc::new(Mutex::new(Recording::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));

    // audio thread (cpal streams are not Send everywhere); reports once the microphone runs
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<()>>();
    {
        let (app, rec, stop) = (app.clone(), rec.clone(), stop.clone());
        std::thread::spawn(move || run_mic(app, session, rec, stop, ready_tx));
    }
    match ready_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(err(e)),
        Err(_) => return Err("Mikrofon konnte nicht gestartet werden.".into()),
    }

    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    {
        let (loaded, stop, cancel) = (state.loaded.clone(), stop.clone(), cancel.clone());
        std::thread::spawn(move || {
            let on_text = move |text: &str| {
                let _ = app.emit("dictation", json!({ "session": session, "t": "text", "text": text }));
            };
            let job = Job { rec, stop, cancel, language, vocabulary, fallbacks, on_text: Box::new(on_text) };
            let _ = done_tx.send(loaded.get(&file).and_then(|ctx| job.run(&ctx)));
        });
    }
    *current = Some(Active { stop, cancel, done: done_rx });
    Ok(session)
}

/// Stops recording and returns the recognised text (only the tail after the last pause is left to do).
#[tauri::command]
pub async fn dictation_stop(state: tauri::State<'_, Dictation>) -> Result<Outcome, String> {
    let Some(active) = state.current.lock().await.take() else {
        return Ok(Outcome { text: String::new(), seconds: 0.0, tail_failed: false });
    };
    active.stop.store(true, Ordering::Relaxed);
    match active.done.await {
        Ok(result) => result.map_err(err),
        Err(_) => Err("Diktat abgebrochen".into()),
    }
}

/// Throws the recording away.
#[tauri::command]
pub async fn dictation_cancel(state: tauri::State<'_, Dictation>) -> Result<(), String> {
    if let Some(active) = state.current.lock().await.take() {
        active.cancel.store(true, Ordering::Relaxed);
        active.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn run_mic(app: AppHandle, session: u64, rec: Arc<Mutex<Recording>>, stop: Arc<AtomicBool>, ready: tokio::sync::oneshot::Sender<Result<()>>) {
    let level = Arc::new(AtomicU32::new(0));
    let broken = Arc::new(AtomicBool::new(false));
    let stream = match open_mic(rec, level.clone(), broken.clone()) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut last = -1.0f32;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(66));
        if broken.load(Ordering::Relaxed) {
            // microphone gone (unplugged, taken by another app): end the dictation, keep what was said
            let _ = app.emit("dictation", json!({ "session": session, "t": "interrupted" }));
            break;
        }
        let l = f32::from_bits(level.load(Ordering::Relaxed));
        if (l - last).abs() > 0.002 {
            last = l;
            let _ = app.emit("dictation", json!({ "session": session, "t": "level", "level": l }));
        }
    }
    drop(stream);
}

fn open_mic(rec: Arc<Mutex<Recording>>, level: Arc<AtomicU32>, broken: Arc<AtomicBool>) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let input = host.default_input_device().context("Kein Mikrofon gefunden")?;
    let cfg = input.default_input_config().context("Mikrofon-Format")?;
    let channels = cfg.channels() as usize;
    let config: StreamConfig = cfg.config();
    let mut down = Downsampler::new(cfg.sample_rate() as f64);
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let mut capture = move |data: &[f32]| {
        mono.clear();
        mono.extend(data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32));
        level.store(rms(&mono).to_bits(), Ordering::Relaxed);
        out.clear();
        down.push(&mono, &mut out);
        rec.lock().unwrap().push(&out);
    };
    let on_error = move |_| broken.store(true, Ordering::Relaxed);
    let stream = match cfg.sample_format() {
        SampleFormat::F32 => input.build_input_stream::<f32, _, _>(config, move |d, _| capture(d), on_error, None)?,
        SampleFormat::I16 => {
            let mut scratch = Vec::new();
            input.build_input_stream::<i16, _, _>(
                config,
                move |d: &[i16], _| {
                    scratch.clear();
                    scratch.extend(d.iter().map(|s| *s as f32 / 32768.0));
                    capture(&scratch);
                },
                on_error,
                None,
            )?
        }
        f => bail!("Mikrofon-Format {f:?} nicht unterstützt"),
    };
    stream.play().context("Mikrofon starten")?;
    Ok(stream)
}

/// The transcription side of one dictation: chunks at pauses while `rec` fills, the tail once `stop` is set.
pub struct Job {
    pub rec: Arc<Mutex<Recording>>,
    pub stop: Arc<AtomicBool>,
    /// throws everything away (also aborts a running decode)
    pub cancel: Arc<AtomicBool>,
    pub language: String,
    pub vocabulary: Vec<String>,
    pub fallbacks: u32,
    /// the text recognised so far, after every chunk
    pub on_text: Box<dyn Fn(&str) + Send>,
}

impl Job {
    pub fn run(&self, ctx: &WhisperContext) -> Result<Outcome> {
        let mut state = ctx.create_state().map_err(|e| anyhow!("Whisper: {e}"))?;
        let mut committed = String::new();
        let mut cut = 0usize;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return Ok(Outcome { text: String::new(), seconds: 0.0, tail_failed: false });
            }
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            let piece = {
                let r = self.rec.lock().unwrap();
                cut_point(&r.rms, cut, r.samples.len()).filter(|p| *p > cut).map(|p| (p, r.samples[cut..p].to_vec()))
            };
            let Some((point, piece)) = piece else {
                // wait up to 500 ms, but notice a stop right away
                for _ in 0..10 {
                    if self.stop.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                continue;
            };
            cut = point;
            match self.piece(&mut state, &piece, &committed) {
                Ok(text) if !text.is_empty() => {
                    committed = join(&committed, &text);
                    (self.on_text)(&committed);
                }
                Ok(_) => {}
                Err(e) if self.cancel.load(Ordering::Relaxed) => return Err(e),
                Err(e) => eprintln!("dictation chunk: {e:#}"),
            }
        }
        let (tail, seconds, silent) = {
            let r = self.rec.lock().unwrap();
            let tail = r.samples.get(cut..).unwrap_or_default().to_vec();
            (tail, r.samples.len() as f64 / RATE as f64, r.samples.iter().all(|s| *s == 0.0))
        };
        // macOS hands out pure zeros when the microphone is not allowed
        if silent && seconds > 0.5 {
            bail!("Mikrofon-Zugriff fehlt (Systemeinstellungen › Datenschutz & Sicherheit › Mikrofon).");
        }
        // a failing last piece must not throw away what is already recognised
        let mut tail_failed = false;
        match self.piece(&mut state, &tail, &committed) {
            Ok(text) => committed = join(&committed, &text),
            Err(e) if committed.is_empty() || self.cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => {
                eprintln!("dictation tail: {e:#}");
                tail_failed = true;
            }
        }
        if self.cancel.load(Ordering::Relaxed) {
            committed.clear();
        }
        Ok(Outcome { text: committed, seconds, tail_failed })
    }

    /// silence trimmed; "" = nothing said
    fn piece(&self, state: &mut WhisperState, samples: &[f32], context: &str) -> Result<String> {
        let Some(speech) = trim(samples) else { return Ok(String::new()) };
        let o = Options { language: &self.language, vocabulary: &self.vocabulary, context, fallbacks: self.fallbacks };
        transcribe(state, speech, &o, Some(&self.cancel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_ids() {
        let dir = Path::new("/m");
        assert_eq!(model_file(dir, "large-v3-turbo-q5_0").unwrap(), Path::new("/m/ggml-large-v3-turbo-q5_0.bin"));
        assert!(model_file(dir, "../x").is_err());
        assert!(model_file(dir, "a/b").is_err());
        assert!(model_file(dir, "").is_err());
    }

    #[test]
    fn downsamples_48k() {
        let input: Vec<f32> = (0..48_000).map(|i| (i % 3) as f32).collect();
        let out = resample(&input, 48_000);
        assert_eq!(out.len(), RATE);
        assert!(out.iter().all(|s| (*s - 1.0).abs() < 1e-6));
        assert!(resample(&vec![0.0; 44_100], 44_100).len().abs_diff(RATE) <= 1);
    }

    #[test]
    fn cleans_markers() {
        assert_eq!(clean(" [BLANK_AUDIO] Hallo  Welt [MUSIK]"), "Hallo Welt");
        assert_eq!(clean("Array [0] und [x]"), "Array [0] und [x]");
    }

    fn tone(seconds: f64, amp: f32) -> Vec<f32> {
        (0..(seconds * RATE as f64) as usize).map(|i| amp * ((i as f32) * 0.07).sin()).collect()
    }

    #[test]
    fn trims_silence() {
        assert!(trim(&vec![0.0; RATE]).is_none());
        let mut s = vec![0.001; RATE];
        s.extend(tone(1.0, 0.3));
        s.extend(vec![0.001; RATE]);
        let t = trim(&s).unwrap();
        assert!(t.len() > RATE && t.len() < RATE * 2);
    }

    #[test]
    fn cuts_at_pauses() {
        let mut rec = Recording::default();
        // a room is never silent: the noise floor sets the speech threshold
        rec.push(&vec![0.001; RATE]);
        rec.push(&tone(4.0, 0.3));
        assert_eq!(cut_point(&rec.rms, 0, rec.samples.len()), None, "under 6 s");
        rec.push(&tone(2.0, 0.3));
        assert_eq!(cut_point(&rec.rms, 0, rec.samples.len()), None, "no pause yet");
        rec.push(&vec![0.001; RATE / 2]);
        let p = cut_point(&rec.rms, 0, rec.samples.len()).unwrap();
        assert!(p > 7 * RATE && p < rec.samples.len());
    }
}
