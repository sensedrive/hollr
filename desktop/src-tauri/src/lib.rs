pub mod hollr;
mod feed;
mod live;
mod tunnel;

use hollr::{Hollr, Server};
use tauri::Manager;

type R<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
fn servers(state: tauri::State<'_, Hollr>) -> Vec<Server> {
    state.servers()
}

#[tauri::command]
async fn pair(state: tauri::State<'_, Hollr>, link: String, device_name: String) -> R<Server> {
    state.pair(&link, &device_name).await.map_err(err)
}

#[tauri::command]
async fn remove_server(state: tauri::State<'_, Hollr>, tunnels: tauri::State<'_, tunnel::Tunnels>, id: String) -> R<()> {
    tunnels.close_server(&id).await;
    state.remove_server(&id).await.map_err(err)
}

/// One `hollr gate` call: command line plus optional JSON on stdin; returns stdout.
#[tauri::command]
async fn gate(state: tauri::State<'_, Hollr>, server: String, command: String, stdin: Option<String>) -> R<String> {
    state.gate(&server, &command, stdin).await.map_err(err)
}

#[derive(Default)]
struct Live(tokio::sync::Mutex<Option<live::LiveSession>>);

#[tauri::command]
async fn live_start(app: tauri::AppHandle, state: tauri::State<'_, Hollr>, live: tauri::State<'_, Live>, server: String, pane: String) -> R<()> {
    let mut current = live.0.lock().await;
    if let Some(old) = current.take() {
        old.stop();
    }
    let handle = state.handle_for(&server).await.map_err(err)?;
    *current = Some(live::start(app, handle, pane).await.map_err(err)?);
    Ok(())
}

#[tauri::command]
async fn live_stop(live: tauri::State<'_, Live>) -> R<()> {
    if let Some(s) = live.0.lock().await.take() {
        s.stop();
    }
    Ok(())
}

/// Mic mute = omp's own mute (Space): you keep hearing the answer.
#[tauri::command]
async fn live_mute(live: tauri::State<'_, Live>, on: bool) -> R<()> {
    if let Some(s) = live.0.lock().await.as_ref() {
        s.send_json(serde_json::json!({ "t": "mute", "on": on }));
    }
    Ok(())
}

#[tauri::command]
async fn live_speaker(live: tauri::State<'_, Live>, muted: bool) -> R<()> {
    if let Some(s) = live.0.lock().await.as_ref() {
        s.speaker_muted.store(muted, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// Local port on this computer that leads to `localhost:<port>` on the server (for the in-app browser).
#[tauri::command]
async fn tunnel_open(app: tauri::AppHandle, tunnels: tauri::State<'_, tunnel::Tunnels>, server: String, port: u16) -> R<u16> {
    tunnels.open(app, server, port).await.map_err(err)
}

#[tauri::command]
async fn tunnel_close(tunnels: tauri::State<'_, tunnel::Tunnels>, local_port: u16) -> R<()> {
    tunnels.close(local_port).await;
    Ok(())
}

/// Keeps one live change feed per paired server (emits `hollr-changed` / `hollr-feed`).
#[tauri::command]
async fn feeds_sync(app: tauri::AppHandle, feeds: tauri::State<'_, feed::Feeds>, servers: Vec<String>) -> R<()> {
    feeds.sync(app, servers).await;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            app.manage(Hollr::new(dir));
            app.manage(Live::default());
            app.manage(feed::Feeds::default());
            app.manage(tunnel::Tunnels::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![feeds_sync, servers, pair, remove_server, gate, live_start, live_stop, live_mute, live_speaker, tunnel_open, tunnel_close])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
