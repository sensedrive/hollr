// cargo run --example pair_code -- <dir> <K7Q2-M9XA-3PLD-W8RT>   → pairs by one-time code, then calls tree
use hollr_desktop_lib::hollr::Hollr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Hollr::new(args[1].clone().into());
    let name = std::env::var("HOLLR_DEVICE").unwrap_or("hollr-desktop-code".into());
    let started = std::time::Instant::now();
    let server = hollr.pair_code(&args[2], &name).await?;
    println!("paired in {:.1}s: {} device {}", started.elapsed().as_secs_f64(), server.label, server.device_id);
    let tree = hollr.gate(&server.id, "tree", None).await?;
    println!("tree: {} bytes", tree.len());
    Ok(())
}
