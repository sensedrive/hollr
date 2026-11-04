// Synthesizes text with Phonon through the same code as the app's read-aloud (speech.rs), into a WAV
// file instead of the speaker. Downloads the model from Ollama's registry on first use.
//   cargo run --release --example speak -- "<text>" [lang=de] [model=phonon-40m-multilingual] [speed=1] [out=speech.wav] [voice] [speech dir]
// Speech dir defaults to the app's (`~/Library/Application Support/app.hollr.desktop/speech` on macOS).
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use anyhow::{Result, bail};
use hollr_desktop_lib::speech;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(text) = args.first() else { bail!("usage: speak <text> [lang] [model] [speed] [out.wav] [voice] [speech dir]") };
    let arg = |i: usize, default: &str| args.get(i).map_or(default.to_string(), String::clone);
    let (lang, model, out) = (arg(1, "de"), arg(2, "phonon-40m-multilingual"), arg(4, "speech.wav"));
    let speed: f32 = arg(3, "1").parse()?;
    let voice = args.get(5).filter(|v| !v.is_empty()).cloned();
    let dir = args.get(6).map(PathBuf::from).unwrap_or_else(|| dirs::data_dir().expect("data dir").join("app.hollr.desktop").join("speech"));

    let path = speech::model_dir(&dir, &model)?;
    if !speech::local_models(&dir).iter().any(|m| m.id == model) {
        eprintln!("downloading {} …", speech::model_page(&model));
        let t = Instant::now();
        speech::download_model(&dir, &model, &AtomicBool::new(false), |p| {
            eprint!("\r{:5.1} %", p * 100.0);
            let _ = std::io::stderr().flush();
        })?;
        eprintln!("\ndownloaded in {:.1} s", t.elapsed().as_secs_f64());
    }
    if let Some(m) = speech::local_models(&dir).iter().find(|m| m.id == model) {
        eprintln!("{}: {} bytes, {:?}, {}", m.id, m.bytes, m.languages, m.attribution.as_deref().unwrap_or("no licence file"));
    }
    let t = Instant::now();
    let synth = speech::load(&path, speed)?;
    let loaded = t.elapsed();
    let t = Instant::now();
    let (chunks, warning) = speech::stream(&synth, &dir, text, &lang, voice.as_deref())?;
    if let Some(w) = warning {
        eprintln!("warning: {w}");
    }
    let rate = chunks.sample_rate();
    let mut pcm = Vec::new();
    let mut first = None;
    for chunk in chunks {
        first.get_or_insert(t.elapsed());
        pcm.extend(chunk?);
    }
    let seconds = pcm.len() as f64 / rate as f64;
    let peak = pcm.iter().fold(0f32, |m, s| m.max(s.abs()));
    println!(
        "{out}: {seconds:.2} s at {rate} Hz, peak {peak:.2}; load {:.0} ms, first audio {:.0} ms, total {:.0} ms",
        loaded.as_secs_f64() * 1000.0,
        first.unwrap_or_default().as_secs_f64() * 1000.0,
        t.elapsed().as_secs_f64() * 1000.0
    );
    ptts::wav::write_wav_file(&out, &pcm, rate)?;
    Ok(())
}
