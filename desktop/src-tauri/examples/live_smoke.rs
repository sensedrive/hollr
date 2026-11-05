// cargo run --example live_smoke -- <data dir> <server id> <pane> [seconds]
// omp /live without audio (only the connection): waits for "live", mutes, tries a stop with a
// wrong session id, then sits for <seconds> (default 30) printing what arrives – pings alone must
// keep the muted call alive; freeze the server's `hollr gate live` meanwhile and `lost` must come.
// Ends with a real stop.
use std::sync::Arc;
use std::time::{Duration, Instant};

use hollr_desktop_lib::hollr::Hollr;
use hollr_desktop_lib::live::{Emit, Lives, Options};
use serde_json::Value;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Hollr::new(args[1].clone().into());
    let (server, pane) = (args[2].clone(), args[3].clone());
    let secs: u64 = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(30);
    let t0 = Instant::now();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let emit: Emit = Arc::new(move |name: &str, v: Value| {
        if name == "live" {
            let _ = tx.send(v);
        }
    });
    let lives = Lives::default();
    let handle = hollr.handle_for(&server).await?;
    let id = lives.start(emit, handle, pane, Options { headphones: false, audio: false }).await?;
    println!("{:>5.1}s started session {id}", t0.elapsed().as_secs_f32());
    let show = |v: &Value| {
        let t = v["t"].as_str().unwrap_or_default();
        let extra = match t {
            "phase" => format!(" {} {}", v["phase"].as_str().unwrap_or_default(), v["reason"].as_str().unwrap_or_default()),
            "omp" => format!(" {}", v["state"].as_str().unwrap_or_default()),
            "error" => format!(" {}", v["message"].as_str().unwrap_or_default()),
            "lost" => format!(" after {}s silence", v["seconds"]),
            _ => String::new(),
        };
        println!("{:>5.1}s event {t}{extra}", t0.elapsed().as_secs_f32());
    };
    let over = |v: &Value| matches!(v["t"].as_str(), Some("closed" | "lost" | "error")) || v["phase"] == "ended";

    // until omp is live
    let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
    loop {
        let Ok(Some(v)) = tokio::time::timeout_at(deadline, rx.recv()).await else { anyhow::bail!("no phase live within 40 s") };
        show(&v);
        if over(&v) {
            anyhow::bail!("call ended before it went live");
        }
        if v["phase"] == "live" {
            break;
        }
    }
    lives.mute(id, true).await;
    println!("{:>5.1}s muted", t0.elapsed().as_secs_f32());
    println!("{:>5.1}s stop(session {}) → {}", t0.elapsed().as_secs_f32(), id + 7, lives.stop(id + 7).await);

    // sit still: only pings go out
    let since = Instant::now();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    let mut ended = false;
    while let Ok(Some(v)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        show(&v);
        if over(&v) {
            ended = true;
            break;
        }
    }
    if ended {
        println!("{:>5.1}s call over after {:.1}s muted", t0.elapsed().as_secs_f32(), since.elapsed().as_secs_f32());
        // a lost call still has its "closed" to come
        while let Ok(Some(v)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
            show(&v);
        }
    } else {
        println!("{:>5.1}s still live after {secs}s muted", t0.elapsed().as_secs_f32());
    }
    println!("{:>5.1}s stop(session {id}) → {}", t0.elapsed().as_secs_f32(), lives.stop(id).await);
    while let Ok(Some(v)) = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
        show(&v);
        if v["t"] == "closed" {
            break;
        }
    }
    Ok(())
}
