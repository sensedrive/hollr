//! omp /live from the desktop: microphone → server, omp's voice → speakers.
//! Same wire protocol as the iPhone app over `hollr gate live <pane>`:
//!   [type u8][len u24 BE][payload]  · 0x01 = PCM s16le 24 kHz mono · 0x02 = JSON
//! Desktop audio has no echo cancellation, so the mic is muted while omp speaks
//! (unless you talk clearly louder – barge-in).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use russh::ChannelMsg;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const RATE: f64 = 24_000.0;
const FRAME_AUDIO: u8 = 1;
const FRAME_JSON: u8 = 2;

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let n = payload.len();
    let mut out = Vec::with_capacity(4 + n);
    out.extend_from_slice(&[kind, (n >> 16) as u8, (n >> 8) as u8, n as u8]);
    out.extend_from_slice(payload);
    out
}

/// Linear resampler (good enough for speech).
struct Resampler {
    ratio: f64,
    pos: f64,
    last: f32,
}

impl Resampler {
    fn new(from: f64, to: f64) -> Self {
        Self { ratio: from / to, pos: 0.0, last: 0.0 }
    }
    /// Interpolates over [last, input…] so chunk borders stay smooth.
    fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
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

pub struct LiveSession {
    control: mpsc::UnboundedSender<Vec<u8>>,
    pub speaker_muted: Arc<AtomicBool>,
    stop_audio: Arc<AtomicBool>,
}

impl LiveSession {
    pub fn send_json(&self, value: serde_json::Value) {
        let _ = self.control.send(frame(FRAME_JSON, value.to_string().as_bytes()));
    }
    pub fn stop(&self) {
        self.send_json(serde_json::json!({ "t": "stop" }));
        // audio threads end with the session
        let stop = self.stop_audio.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(4));
            stop.store(true, Ordering::Relaxed);
        });
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        self.stop_audio.store(true, Ordering::Relaxed);
    }
}

pub async fn start<H: russh::client::Handler + 'static>(
    app: AppHandle,
    handle: Arc<russh::client::Handle<H>>,
    pane: String,
) -> Result<LiveSession> {
    let channel = handle.channel_open_session().await.map_err(|e| anyhow!("{e}"))?;
    channel.exec(true, format!("live {pane}")).await.map_err(|e| anyhow!("{e}"))?;
    let (mut reader, writer) = channel.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let stop_audio = Arc::new(AtomicBool::new(false));
    let speaker_muted = Arc::new(AtomicBool::new(false));
    let playback: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let out_level = Arc::new(AtomicU32::new(0));
    let in_level = Arc::new(AtomicU32::new(0));
    let live = Arc::new(AtomicBool::new(false));

    // writer: everything for the server goes through one queue
    tokio::spawn(async move {
        let mut w = writer.make_writer();
        while let Some(bytes) = rx.recv().await {
            if w.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });

    // audio thread (cpal streams are not Send on every platform)
    let device_rate = Arc::new(AtomicU32::new(48_000));
    {
        let tx = tx.clone();
        let stop = stop_audio.clone();
        let playback = playback.clone();
        let speaker_muted = speaker_muted.clone();
        let out_level = out_level.clone();
        let in_level = in_level.clone();
        let live = live.clone();
        let device_rate = device_rate.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = run_audio(tx, stop.clone(), playback, speaker_muted, out_level, in_level, live, device_rate) {
                let _ = app.emit("live", serde_json::json!({ "t": "audio_error", "message": format!("{e:#}") }));
                stop.store(true, Ordering::Relaxed);
            }
        });
    }

    // reader: frames from the server
    {
        let app = app.clone();
        let playback = playback.clone();
        let live = live.clone();
        let stop = stop_audio.clone();
        let device_rate = device_rate.clone();
        tokio::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut resampler: Option<(u32, Resampler)> = None;
            let mut tmp = Vec::new();
            while let Some(msg) = reader.wait().await {
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
                    } else if kind == FRAME_JSON {
                        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&payload) {
                            if v["t"] == "phase" && v["phase"] == "live" {
                                live.store(true, Ordering::Relaxed);
                            }
                            let _ = app.emit("live", v);
                        }
                    }
                }
            }
            stop.store(true, Ordering::Relaxed);
            let _ = app.emit("live", serde_json::json!({ "t": "closed" }));
        });
    }

    // levels for the UI
    {
        let app = app.clone();
        let stop = stop_audio.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
                let i = f32::from_bits(in_level.load(Ordering::Relaxed));
                let o = f32::from_bits(out_level.load(Ordering::Relaxed));
                let _ = app.emit("live-levels", serde_json::json!({ "input": i, "output": o }));
            }
        });
    }

    Ok(LiveSession { control: tx, speaker_muted, stop_audio })
}

#[allow(clippy::too_many_arguments)]
fn run_audio(
    tx: mpsc::UnboundedSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    playback: Arc<Mutex<VecDeque<f32>>>,
    speaker_muted: Arc<AtomicBool>,
    out_level: Arc<AtomicU32>,
    in_level: Arc<AtomicU32>,
    live: Arc<AtomicBool>,
    device_rate: Arc<AtomicU32>,
) -> Result<()> {
    let host = cpal::default_host();
    let input = host.default_input_device().context("Kein Mikrofon gefunden")?;
    let output = host.default_output_device().context("Kein Lautsprecher gefunden")?;
    let in_cfg = input.default_input_config().context("Mikrofon-Format")?;
    let out_cfg = output.default_output_config().context("Lautsprecher-Format")?;
    device_rate.store(out_cfg.sample_rate(), Ordering::Relaxed);

    // ---- speaker
    let out_channels = out_cfg.channels() as usize;
    let out_config: StreamConfig = out_cfg.config();
    let last_output = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10)));
    let fill = {
        let playback = playback.clone();
        let last_output = last_output.clone();
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
    let out_stream = match out_cfg.sample_format() {
        SampleFormat::F32 => output.build_output_stream::<f32, _, _>(out_config, move |d, _| fill(d), |_| {}, None)?,
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
                |_| {},
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
        // echo gate: omp is speaking → only let clearly louder speech through
        let speaking = last_output.lock().unwrap().elapsed() < Duration::from_millis(350);
        let gated = speaking && rms < 0.08;
        resampler.push(&mono, &mut pending);
        while pending.len() >= 480 {
            let chunk: Vec<f32> = pending.drain(..480).collect();
            let mut bytes = Vec::with_capacity(960);
            for s in chunk {
                let v = if gated { 0 } else { (s.clamp(-1.0, 1.0) * 32767.0) as i16 };
                bytes.extend_from_slice(&v.to_le_bytes());
            }
            let _ = tx.send(frame(FRAME_AUDIO, &bytes));
        }
    };
    let in_stream = match in_cfg.sample_format() {
        SampleFormat::F32 => {
            let mut capture = capture;
            input.build_input_stream::<f32, _, _>(in_config, move |d, _| capture(d), |_| {}, None)?
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
                |_| {},
                None,
            )?
        }
        f => return Err(anyhow!("Mikrofon-Format {f:?} nicht unterstützt")),
    };

    out_stream.play()?;
    in_stream.play()?;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(100));
    }
    drop(in_stream);
    drop(out_stream);
    Ok(())
}
