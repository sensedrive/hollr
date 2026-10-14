// cargo run --example tunnel_smoke -- <app data dir> <remote port>
// Opens a direct-tcpip channel to localhost:<port> on the first server (as the tunnel does) and fetches "/".
use hollr_desktop_lib::hollr::Hollr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let hollr = Hollr::new(args[1].clone().into());
    let port: u32 = args[2].parse()?;
    let server = hollr.servers()[0].id.clone();
    let handle = hollr.handle_for(&server).await?;
    let channel = handle.channel_open_direct_tcpip("localhost", port, "127.0.0.1", 0).await?;
    let mut stream = channel.into_stream();
    stream.write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n").await?;
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await?;
    let text = String::from_utf8_lossy(&out);
    println!("{}", text.lines().next().unwrap_or(""));
    println!("body contains marker: {}", text.contains("hollr-tunnel-ok"));
    Ok(())
}
