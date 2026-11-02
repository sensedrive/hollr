// Transcribes a WAV file with the local Whisper engine of the dictation (dictation.rs), through the same
// pipeline as a composer dictation (chunks at pauses, tail after stop). Downloads the model on first use.
//   cargo run --example dictate -- <file.wav> [model=base] [language=de] [models dir]
// Models dir defaults to the app's (`~/Library/Application Support/app.hollr.desktop/whisper` on macOS).
// A test file: say -v Anna -o /tmp/x.aiff "Hallo Welt" && afconvert -f WAVE -d LEI16@16000 /tmp/x.aiff /tmp/x.wav
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use hollr_desktop_lib::dictation;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(wav) = args.first() else { bail!("usage: dictate <file.wav> [model] [language] [models dir]") };
    let model = args.get(1).map_or("base", String::as_str);
    let language = args.get(2).map_or("de", String::as_str);
    let dir = args.get(3).map(PathBuf::from).unwrap_or_else(|| {
        dirs::data_dir().expect("data dir").join("app.hollr.desktop").join("whisper")
    });

    let file = dictation::model_file(&dir, model)?;
    if !file.exists() {
        eprintln!("downloading {} …", dictation::model_url(model));
        dictation::download_model(&dir, model, &AtomicBool::new(false), |p| {
            eprint!("\r{:5.1} %", p * 100.0);
            let _ = std::io::stderr().flush();
        })?;
        eprintln!();
    }

    let mut reader = hound::WavReader::open(wav).with_context(|| format!("{wav}"))?;
    let spec = reader.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().map(|s| s.map(|v| v as f32 / scale)).collect::<Result<_, _>>()?
        }
    };
    let channels = spec.channels as usize;
    let mono: Vec<f32> = raw.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect();
    let samples = dictation::resample(&mono, spec.sample_rate);

    let started = Instant::now();
    let ctx = dictation::load_model(&file)?;
    eprintln!("model loaded in {:.1}s", started.elapsed().as_secs_f64());

    // the app's pipeline: the "microphone" fills the recording in real time (pauses must last long enough to be seen) while
    // the job transcribes the pieces between pauses; stop leaves only the tail
    let rec = Arc::new(Mutex::new(dictation::Recording::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let job = dictation::Job {
        rec: rec.clone(),
        stop: stop.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        language: language.to_string(),
        vocabulary: ["Hollr", "omp", "herdr", "Pull Request", "Staging"].map(String::from).to_vec(),
        fallbacks: 3,
        on_text: Box::new(|text| eprintln!("… {text}")),
    };
    let worker = std::thread::spawn(move || job.run(&ctx));
    for block in samples.chunks(dictation::RATE / 10) {
        rec.lock().unwrap().push(block);
        std::thread::sleep(Duration::from_millis(100));
    }
    let stopped = Instant::now();
    stop.store(true, Ordering::Relaxed);
    let outcome = worker.join().expect("job thread")?;
    eprintln!("{:.1}s audio, {:.1}s left after stop", outcome.seconds, stopped.elapsed().as_secs_f64());
    println!("{}", outcome.text);
    Ok(())
}
