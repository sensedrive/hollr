// cargo run --example term_smoke -- <data dir> <server id> <pane> [pane|shell]
// Opens a live terminal (`attach` / `shell`), types a line, resizes, prints the events and stops.
use std::time::Duration;

use hollr_desktop_lib::hollr::Hollr;
use hollr_desktop_lib::term::{Cmd, TermEvent, command, run_stream};
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Hollr::new(args[1].clone().into());
    let (server, pane) = (args[2].clone(), args[3].clone());
    let mode = args.get(4).cloned().unwrap_or("pane".into());
    let (tx, rx) = mpsc::unbounded_channel();
    let typing = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if mode == "shell" {
            let _ = tx.send(Cmd::Input("echo hollr-term-$((6*7))\r".into()));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = tx.send(Cmd::Resize(100, 30));
        tokio::time::sleep(Duration::from_secs(2)).await;
        if mode == "shell" {
            let _ = tx.send(Cmd::Input("stty size; exit\r".into()));
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
        drop(tx); // stop
    });
    let bytes = std::cell::Cell::new(0usize);
    run_stream(&hollr, &server, command(&args.get(4).cloned().unwrap_or_default(), &pane, 80, 24), rx, |e| match e {
        TermEvent::Out { data } => {
            bytes.set(bytes.get() + data.len());
            let plain: String = data.chars().filter(|c| !c.is_control() || *c == '\n').collect();
            for line in plain.lines().filter(|l| l.contains("hollr-term") || l.contains("30 100")) {
                println!("out: {line}");
            }
        }
        other => println!("event: {other:?}"),
    })
    .await;
    let _ = typing.await;
    println!("output: {} bytes", bytes.get());
    Ok(())
}
