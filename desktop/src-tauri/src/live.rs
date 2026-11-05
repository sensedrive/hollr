//! omp /live from the desktop: microphone → server, omp's voice → speakers.
//! Same wire protocol as the iPhone app over `hollr gate live <pane>`:
//!   [type u8][len u24 BE][payload]  · 0x01 = PCM s16le 24 kHz mono · 0x02 = JSON
//! Desktop audio has no echo cancellation, so the mic is muted while omp speaks
//! (unless you talk clearly louder – barge-in – or the headphones option is on).
//!
//! Like the iPhone: a `ping` every 5 s (also while muted; the server answers `pong` and ends a
//! pinging call it hasn't heard from for 20 s). Nothing from the server for 20 s → `lost`.
//! Audio follows the system's default input/output (AirPods, monitor, wake from sleep) by
//! rebuilding the streams; the server connection stays. Never onto hollr's own call devices, though:
//! a hollr server on this same Mac points the defaults at its BlackHole loopbacks for the call
//! (server/src/macaudio.ts) – following them looped the call into itself (mic = our own upload,
//! speaker = the capture omp's voice is read from), nothing was heard either way.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, SampleFormat, StreamConfig};
use russh::ChannelMsg;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, watch};

const RATE: f64 = 24_000.0;
const FRAME_AUDIO: u8 = 1;
const FRAME_JSON: u8 = 2;
const PING_EVERY: Duration = Duration::from_secs(5);
/// nothing from the server this long (it answers every ping) = the connection is gone
const LOST_AFTER: Duration = Duration::from_secs(20);
/// how often the default input/output devices are checked for a change
const DEVICE_POLL: Duration = Duration::from_secs(2);

/// Where `live` / `live-levels` events go (the app's webview, or stdout in the smoke example).
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut out = Vec::with_capacity(4 + n);
    out.extend_from_slice(&[kind, (n >> 16) as u8, (n >> 8) as u8, n as u8]);
    out.extend_from_slice(payload);
    out
}

fn json_frame(value: Value) -> Vec<u8> {
    frame(FRAME_JSON, value.to_string().as_bytes())
}

/// Linear resampler (good enough for speech); also used by the read-aloud playback (speech.rs).
pub(crate) struct Resampler {
    ratio: f64,
    pos: f64,
    last: f32,
}

impl Resampler {
    pub(crate) fn new(from: f64, to: f64) -> Self {
        Self { ratio: from / to, pos: 0.0, last: 0.0 }
    }
    /// Interpolates over [last, input…] so chunk borders stay smooth.
    pub(crate) fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let n = input.len() as f64;
        while self.pos < n {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.last } else { input[i - 1] };
            let b = input[i];
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        self.pos -= n;
        self.last = input[input.len() - 1];
    }
}

pub struct Options {
    /// headphones: no echo gate, the mic stays open while omp speaks
    pub headphones: bool,
    /// false: no microphone / speakers at all (smoke tests, dev bridge) – only the connection
    pub audio: bool,
}

struct LiveSession {
    id: u64,
    control: mpsc::UnboundedSender<Vec<u8>>,
    speaker_muted: Arc<AtomicBool>,
    headphones: Arc<AtomicBool>,
    stop_audio: Arc<AtomicBool>,
}

impl LiveSession {
    fn send_json(&self, value: Value) {
        let _ = self.control.send(json_frame(value));
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        // hang up; the server answers with phase "ended" and closes the channel
        self.send_json(json!({ "t": "stop" }));
        self.stop_audio.store(true, Ordering::Relaxed);
    }
}

/// The app's one live call (one microphone). Every call has an id; the UI passes it back so a
/// late stop from an old view can't hang up a newer call.
#[derive(Default)]
pub struct Lives {
    current: tokio::sync::Mutex<Option<LiveSession>>,
    next: AtomicU64,
}

impl Lives {
    /// Ends a running call and starts one on `pane`; returns its id (carried by every event).
    pub async fn start<H: russh::client::Handler + 'static>(
        &self,
        emit: Emit,
        handle: Arc<russh::client::Handle<H>>,
        pane: String,
        options: Options,
    ) -> Result<u64> {
        let mut current = self.current.lock().await;
        current.take();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        *current = Some(start(emit, handle, pane, id, options).await?);
        Ok(id)
    }

    /// Hangs up call `id`; any other (newer) call keeps running. True if `id` was the current call.
    pub async fn stop(&self, id: u64) -> bool {
        let mut current = self.current.lock().await;
        if current.as_ref().is_some_and(|s| s.id == id) {
            current.take();
            true
        } else {
            false
        }
    }

    /// The webview reloaded: nobody is left to show or end the call.
    pub async fn stop_all(&self) {
        self.current.lock().await.take();
    }

    /// Mic mute = omp's own mute (Space): you keep hearing the answer.
    pub async fn mute(&self, id: u64, on: bool) {
        if let Some(s) = self.current.lock().await.as_ref().filter(|s| s.id == id) {
            s.send_json(json!({ "t": "mute", "on": on }));
        }
    }

    pub async fn speaker(&self, id: u64, muted: bool) {
        if let Some(s) = self.current.lock().await.as_ref().filter(|s| s.id == id) {
            s.speaker_muted.store(muted, Ordering::Relaxed);
        }
    }

    /// The headphones setting, applied to a running call at once.
    pub async fn headphones(&self, on: bool) {
        if let Some(s) = self.current.lock().await.as_ref() {
            s.headphones.store(on, Ordering::Relaxed);
        }
    }
}

/// Resolves once the call is closed (the watch's guard must not live across an await).
async fn until(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|c| *c).await;
}

async fn start<H: russh::client::Handler + 'static>(
    emit: Emit,
    handle: Arc<russh::client::Handle<H>>,
    pane: String,
    session: u64,
    options: Options,
) -> Result<LiveSession> {
    let channel = handle.channel_open_session().await.map_err(|e| anyhow!("{e}"))?;
    channel.exec(true, format!("live {pane}")).await.map_err(|e| anyhow!("{e}"))?;
    let (mut reader, writer) = channel.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    // true once the call is over (server closed, or the watchdog gave up): every task ends
    let (closed_tx, closed_rx) = watch::channel(false);
    let closed_tx = Arc::new(closed_tx);
    let stop_audio = Arc::new(AtomicBool::new(false));
    let speaker_muted = Arc::new(AtomicBool::new(false));
    let headphones = Arc::new(AtomicBool::new(options.headphones));
    let playback: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let out_level = Arc::new(AtomicU32::new(0));
    let in_level = Arc::new(AtomicU32::new(0));
    let live = Arc::new(AtomicBool::new(false));
    let heard = Arc::new(Mutex::new(Instant::now()));

    // writer: everything for the server goes through one queue
    {
        let mut closed = closed_rx.clone();
        tokio::spawn(async move {
            let mut w = writer.make_writer();
            loop {
                tokio::select! {
                    _ = until(&mut closed) => break,
                    bytes = rx.recv() => {
                        let Some(bytes) = bytes else { break };
                        // a write can hang on a dead connection – the watchdog's close ends it
                        tokio::select! {
                            r = w.write_all(&bytes) => if r.is_err() { break },
                            _ = until(&mut closed) => break,
                        }
                    }
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), writer.close()).await;
        });
    }

    // heartbeat + watchdog
    {
        let tx = tx.clone();
        let mut closed = closed_rx.clone();
        let closed_tx = closed_tx.clone();
        let heard = heard.clone();
        let emit = emit.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = until(&mut closed) => return,
                    _ = tokio::time::sleep(PING_EVERY) => {}
                }
                let _ = tx.send(json_frame(json!({ "t": "ping" })));
                let age = heard.lock().unwrap().elapsed();
                if age > LOST_AFTER {
                    emit("live", json!({ "t": "lost", "seconds": age.as_secs(), "session": session }));
                    closed_tx.send_replace(true);
                    return;
                }
            }
        });
    }

    // audio thread (cpal streams are not Send on every platform)
    let device_rate = Arc::new(AtomicU32::new(48_000));
    if options.audio {
        let audio = Audio {
            tx: tx.clone(),
            stop: stop_audio.clone(),
            playback: playback.clone(),
            speaker_muted: speaker_muted.clone(),
            headphones: headphones.clone(),
            out_level: out_level.clone(),
            in_level: in_level.clone(),
            live: live.clone(),
            device_rate: device_rate.clone(),
            emit: emit.clone(),
            session,
        };
        std::thread::spawn(move || run_audio(audio));
    }

    // reader: frames from the server
    {
        let emit = emit.clone();
        let playback = playback.clone();
        let live = live.clone();
        let stop = stop_audio.clone();
        let device_rate = device_rate.clone();
        let mut closed = closed_rx.clone();
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut resampler: Option<(u32, Resampler)> = None;
            let mut tmp = Vec::new();
            loop {
                let msg = tokio::select! {
                    m = reader.wait() => m,
                    _ = until(&mut closed) => None,
                };
                let Some(msg) = msg else { break };
                *heard.lock().unwrap() = Instant::now();
                let ChannelMsg::Data { data } = msg else {
                    if matches!(msg, ChannelMsg::Eof | ChannelMsg::Close) {
                        break;
                    }
                    continue;
                };
                buf.extend_from_slice(&data);
                while buf.len() >= 4 {
                    let n = ((buf[1] as usize) << 16) | ((buf[2] as usize) << 8) | buf[3] as usize;
                    if buf.len() < 4 + n {
                        break;
                    }
                    let kind = buf[0];
                    let payload: Vec<u8> = buf[4..4 + n].to_vec();
                    buf.drain(..4 + n);
                    if kind == FRAME_AUDIO {
                        let rate = device_rate.load(Ordering::Relaxed);
                        if resampler.as_ref().map(|r| r.0) != Some(rate) {
                            resampler = Some((rate, Resampler::new(RATE, rate as f64)));
                        }
                        let samples: Vec<f32> = payload
                            .chunks_exact(2)
                            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                            .collect();
                        tmp.clear();
                        resampler.as_mut().unwrap().1.push(&samples, &mut tmp);
                        let mut q = playback.lock().unwrap();
                        // stay real-time: drop if more than ~0.8 s is queued
                        if q.len() < (rate as usize * 8 / 10) {
                            q.extend(tmp.iter());
                        }
                    } else if kind == FRAME_JSON
                        && let Ok(mut v) = serde_json::from_slice::<Value>(&payload)
                    {
                        if v["t"] == "pong" {
                            continue; // only the watchdog cares
                        }
                        if v["t"] == "phase" && v["phase"] == "live" {
                            live.store(true, Ordering::Relaxed);
                        }
                        // the UI ignores events of an older session (e.g. its late "closed")
                        if let Some(o) = v.as_object_mut() {
                            o.insert("session".into(), session.into());
                        }
                        emit("live", v);
                    }
                }
            }
            stop.store(true, Ordering::Relaxed);
            closed_tx.send_replace(true);
            emit("live", json!({ "t": "closed", "session": session }));
        });
    }

    // levels for the UI
    if options.audio {
        let stop = stop_audio.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
                let i = f32::from_bits(in_level.load(Ordering::Relaxed));
                let o = f32::from_bits(out_level.load(Ordering::Relaxed));
                emit("live-levels", json!({ "input": i, "output": o, "session": session }));
            }
        });
    }

    Ok(LiveSession { id: session, control: tx, speaker_muted, headphones, stop_audio })
}

/// What the audio thread shares with the connection.
struct Audio {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    playback: Arc<Mutex<VecDeque<f32>>>,
    speaker_muted: Arc<AtomicBool>,
    headphones: Arc<AtomicBool>,
    out_level: Arc<AtomicU32>,
    in_level: Arc<AtomicU32>,
    live: Arc<AtomicBool>,
    device_rate: Arc<AtomicU32>,
    emit: Emit,
    session: u64,
}

/// hollr's loopback devices on a Mac that runs the server (server/src/macaudio.ts MIC_DEVICE / SPEAKER_DEVICE):
/// the server makes them the defaults for the length of a call.
const CALL_DEVICES: [&str; 2] = ["BlackHole 2ch", "BlackHole 16ch"];

/// The device to use: the system default – unless that is one of the call devices, then the one in use so
/// far, else the real default the server saved before switching, else any other device. `all` is only
/// asked for in that case (listing devices every poll would be wasted work).
fn pick(default: Option<String>, using: &str, saved: Option<&str>, all: impl FnOnce() -> Vec<String>) -> Option<String> {
    let call = |n: &str| CALL_DEVICES.contains(&n);
    if let Some(d) = default.filter(|d| !call(d)) {
        return Some(d);
    }
    let all = all();
    let present = |n: &&str| !n.is_empty() && !call(n) && all.iter().any(|a| a == n);
    [Some(using), saved].into_iter().flatten().find(present).map(str::to_string).or_else(|| all.into_iter().find(|n| !call(n)))
}

/// The defaults a hollr server on this Mac saved before pointing them at its call devices (macaudio.ts).
fn saved_defaults() -> (Option<String>, Option<String>) {
    let file = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/state/hollr/mac-audio-defaults.json"));
    let saved: Value = file.and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let get = |k: &str| saved[k].as_str().map(str::to_string);
    (get("input"), get("output"))
}

fn device_name(d: &cpal::Device) -> String {
    d.description().map(|d| d.name().to_string()).unwrap_or_default()
}

/// Names of the input / output the call should use now (`using`: the ones it uses so far).
fn wanted(host: &cpal::Host, using: &(String, String)) -> (Option<String>, Option<String>) {
    let saved = saved_defaults();
    let names = |list: Option<Vec<cpal::Device>>| list.unwrap_or_default().iter().map(device_name).collect::<Vec<_>>();
    (
        pick(host.default_input_device().map(|d| device_name(&d)), &using.0, saved.0.as_deref(), || {
            names(host.input_devices().ok().map(|d| d.collect()))
        }),
        pick(host.default_output_device().map(|d| device_name(&d)), &using.1, saved.1.as_deref(), || {
            names(host.output_devices().ok().map(|d| d.collect()))
        }),
    )
}

/// Keeps streams on the current default devices until the call ends: rebuilds them when a
/// default changes or a stream breaks; errors go to the UI as `audio_error`, recovery as `audio`.
fn run_audio(a: Audio) {
    let host = cpal::default_host();
    let mut shown_error = String::new();
    let mut shown_devices = (String::new(), String::new());
    while !a.stop.load(Ordering::Relaxed) {
        let want = wanted(&host, &shown_devices);
        let fault: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        match open_streams(&host, &want, &a, &fault) {
            Ok((streams, devices)) => {
                if !shown_error.is_empty() || devices != shown_devices {
                    (a.emit)("live", json!({ "t": "audio", "input": devices.0, "output": devices.1, "session": a.session }));
                    shown_error.clear();
                    shown_devices = devices;
                }
                let mut polled = Instant::now();
                while !a.stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    if let Some(message) = fault.lock().unwrap().take() {
                        (a.emit)("live", json!({ "t": "audio_error", "message": message, "session": a.session }));
                        shown_error = message;
                        break;
                    }
                    if polled.elapsed() >= DEVICE_POLL {
                        polled = Instant::now();
                        if wanted(&host, &shown_devices) != want {
                            break;
                        }
                    }
                }
                drop(streams);
                // queued at the old device's rate
                a.playback.lock().unwrap().clear();
            }
            Err(e) => {
                let message = format!("{e:#}");
                if message != shown_error {
                    (a.emit)("live", json!({ "t": "audio_error", "message": message, "session": a.session }));
                    shown_error = message;
                }
                // try again (a device may come back, e.g. after sleep)
                for _ in 0..20 {
                    if a.stop.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
}

/// Error callback: reroutes / glitches are fine, anything else means rebuild.
fn on_stream_error(fault: &Arc<Mutex<Option<String>>>, what: &'static str) -> impl FnMut(cpal::Error) + Send + 'static {
    let fault = fault.clone();
    move |e: cpal::Error| {
        if matches!(e.kind(), ErrorKind::Xrun | ErrorKind::RealtimeDenied | ErrorKind::DeviceChanged) {
            return;
        }
        fault.lock().unwrap().get_or_insert_with(|| format!("{what}: {e}"));
    }
}

/// The device named `name` (the default when it is that one – no listing needed).
fn device_named(default: Option<cpal::Device>, list: impl FnOnce() -> Option<Vec<cpal::Device>>, name: &str) -> Option<cpal::Device> {
    match default {
        Some(d) if device_name(&d) == name => Some(d),
        _ => list()?.into_iter().find(|d| device_name(d) == name),
    }
}

/// Opens and starts speaker + microphone (`want`: their names, see `wanted`); returns them with the names.
fn open_streams(
    host: &cpal::Host,
    want: &(Option<String>, Option<String>),
    a: &Audio,
    fault: &Arc<Mutex<Option<String>>>,
) -> Result<([cpal::Stream; 2], (String, String))> {
    let input = want
        .0
        .as_deref()
        .and_then(|n| device_named(host.default_input_device(), || host.input_devices().ok().map(|d| d.collect()), n))
        .context("Kein Mikrofon gefunden")?;
    let output = want
        .1
        .as_deref()
        .and_then(|n| device_named(host.default_output_device(), || host.output_devices().ok().map(|d| d.collect()), n))
        .context("Kein Lautsprecher gefunden")?;
    let in_cfg = input.default_input_config().context("Mikrofon-Format")?;
    let out_cfg = output.default_output_config().context("Lautsprecher-Format")?;
    let names = (device_name(&input), device_name(&output));
    a.device_rate.store(out_cfg.sample_rate(), Ordering::Relaxed);

    // ---- speaker
    let out_channels = out_cfg.channels() as usize;
    let out_config: StreamConfig = out_cfg.config();
    let last_output = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
    let fill = {
        let playback = a.playback.clone();
        let last_output = last_output.clone();
        let speaker_muted = a.speaker_muted.clone();
        let out_level = a.out_level.clone();
        move |data: &mut [f32]| {
            let mut q = playback.lock().unwrap();
            let muted = speaker_muted.load(Ordering::Relaxed);
            let mut sum = 0.0f32;
            let mut had = false;
            for frame in data.chunks_mut(out_channels) {
                let s = q.pop_front().unwrap_or(0.0);
                if s != 0.0 {
                    had = true;
                }
                sum += s * s;
                let v = if muted { 0.0 } else { s };
                for x in frame.iter_mut() {
                    *x = v;
                }
            }
            let rms = (sum / (data.len().max(1) / out_channels.max(1)) as f32).sqrt();
            out_level.store(rms.to_bits(), Ordering::Relaxed);
            if had && !muted {
                *last_output.lock().unwrap() = Instant::now();
            }
        }
    };
    let speaker_error = on_stream_error(fault, "Lautsprecher");
    let out_stream = match out_cfg.sample_format() {
        SampleFormat::F32 => output.build_output_stream::<f32, _, _>(out_config, move |d, _| fill(d), speaker_error, None)?,
        SampleFormat::I16 => {
            let fill = fill;
            let mut scratch = Vec::new();
            output.build_output_stream::<i16, _, _>(
                out_config,
                move |d: &mut [i16], _| {
                    scratch.resize(d.len(), 0.0);
                    fill(&mut scratch);
                    for (o, s) in d.iter_mut().zip(&scratch) {
                        *o = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    }
                },
                speaker_error,
                None,
            )?
        }
        f => return Err(anyhow!("Lautsprecher-Format {f:?} nicht unterstützt")),
    };

    // ---- microphone
    let in_channels = in_cfg.channels() as usize;
    let in_rate = in_cfg.sample_rate() as f64;
    let in_config: StreamConfig = in_cfg.config();
    let mut resampler = Resampler::new(in_rate, RATE);
    let mut pending: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let (tx, in_level, live, headphones) = (a.tx.clone(), a.in_level.clone(), a.live.clone(), a.headphones.clone());
    let capture = move |data: &[f32]| {
        mono.clear();
        let mut sum = 0.0f32;
        for frame in data.chunks(in_channels) {
            let v = frame.iter().sum::<f32>() / in_channels as f32;
            sum += v * v;
            mono.push(v);
        }
        let rms = (sum / mono.len().max(1) as f32).sqrt();
        in_level.store(rms.to_bits(), Ordering::Relaxed);
        if !live.load(Ordering::Relaxed) {
            return;
        }
        // echo gate: omp is speaking → only let clearly louder speech through (not with headphones)
        let speaking = last_output.lock().unwrap().elapsed() < Duration::from_millis(350);
        let gated = speaking && rms < 0.08 && !headphones.load(Ordering::Relaxed);
        resampler.push(&mono, &mut pending);
        while pending.len() >= 480 {
            let mut bytes = Vec::with_capacity(960);
            for s in pending.drain(..480) {
                let v = if gated { 0 } else { (s.clamp(-1.0, 1.0) * 32767.0) as i16 };
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let _ = tx.send(frame(FRAME_AUDIO, &bytes));
        }
    };
    let mic_error = on_stream_error(fault, "Mikrofon");
    let in_stream = match in_cfg.sample_format() {
        SampleFormat::F32 => {
            let mut capture = capture;
            input.build_input_stream::<f32, _, _>(in_config, move |d, _| capture(d), mic_error, None)?
        }
        SampleFormat::I16 => {
            let mut capture = capture;
            let mut scratch = Vec::new();
            input.build_input_stream::<i16, _, _>(
                in_config,
                move |d: &[i16], _| {
                    scratch.clear();
                    scratch.extend(d.iter().map(|s| *s as f32 / 32768.0));
                    capture(&scratch);
                },
                mic_error,
                None,
            )?
        }
        f => return Err(anyhow!("Mikrofon-Format {f:?} nicht unterstützt")),
    };

    out_stream.play()?;
    in_stream.play()?;
    Ok(([in_stream, out_stream], names))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<String> {
        ["MacBook Pro-Mikrofon", "AirPods", "BlackHole 2ch", "BlackHole 16ch"].map(String::from).to_vec()
    }

    #[test]
    fn follows_the_default_but_never_onto_the_call_devices() {
        // an ordinary default change (AirPods): followed, no device listing needed
        assert_eq!(pick(Some("AirPods".into()), "MacBook Pro-Mikrofon", None, || unreachable!()), Some("AirPods".into()));
        // the server on this Mac switched the default to its loopback: stay on what the call uses
        assert_eq!(pick(Some("BlackHole 2ch".into()), "AirPods", None, all), Some("AirPods".into()));
        // first open after the switch: the real default the server saved
        assert_eq!(pick(Some("BlackHole 16ch".into()), "", Some("MacBook Pro-Mikrofon"), all), Some("MacBook Pro-Mikrofon".into()));
        // nothing known (or the saved one is gone): any device but the loopbacks
        assert_eq!(pick(Some("BlackHole 2ch".into()), "", Some("USB headset"), all), Some("MacBook Pro-Mikrofon".into()));
        assert_eq!(pick(None, "", None, || ["BlackHole 2ch".to_string()].to_vec()), None);
    }
}
