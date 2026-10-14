// cargo run --example smoke -- <dir> <hollr://pair link>   → pairs, then calls tree + timeline
use hollr_desktop_lib::hollr::Hollr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Hollr::new(args[1].clone().into());
    let server = if let Some(link) = args.get(2) { hollr.pair(link, "hollr-desktop-smoke").await? } else { hollr.servers()[0].clone() };
    println!("paired: {} device {}", server.label, server.device_id);
    let tree = hollr.gate(&server.id, "tree", None).await?;
    println!("tree: {} bytes, starts {}", tree.len(), &tree[..tree.len().min(120)]);
    let tl = hollr.gate(&server.id, "timeline w18:p1 5", None).await?;
    println!("timeline: {} bytes", tl.len());
    let models = hollr.gate(&server.id, "models claude", None).await?;
    println!("models: {}", &models[..models.len().min(100)]);
    Ok(())
}
