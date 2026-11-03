pub mod hollr;
mod feed;
mod follow;
pub mod live;
mod tunnel;
mod pairing_code;
pub mod applock;
pub mod term;
pub mod dictation;
pub mod speech;
mod notice;

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

/// Pairing by one-time code; code errors come back as `otp:<kind>` keys the UI words.
#[tauri::command]
async fn pair_code(state: tauri::State<'_, Hollr>, code: String, device_name: String) -> R<Server> {
    state.pair_code(&code, &device_name).await.map_err(|e| match e.downcast_ref::<pairing_code::CodeError>() {
        Some(c) => c.key(),
        None => err(e),
    })
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

/// `gate` with a long timeout for big stdin (file uploads to the agent).
#[tauri::command]
async fn gate_long(state: tauri::State<'_, Hollr>, server: String, command: String, stdin: Option<String>) -> R<String> {
    state.gate_with(&server, &command, stdin, hollr::LONG_TIMEOUT).await.map_err(err)
}

/// Starts omp /live (ending a call on another pane); returns the session id that every `live` /
/// `live-levels` event carries and `live_stop` / `live_mute` / `live_speaker` take.
#[tauri::command]
async fn live_start(app: tauri::AppHandle, state: tauri::State<'_, Hollr>, live: tauri::State<'_, live::Lives>, server: String, pane: String, headphones: bool) -> R<u64> {
    use tauri::Emitter;
    let handle = state.handle_for(&server).await.map_err(err)?;
    let emit: live::Emit = {
        let handle = handle.clone();
        std::sync::Arc::new(move |name: &str, v: serde_json::Value| {
            // connection lost: "Neu verbinden" should get a fresh SSH connection
            if v["t"] == "lost" {
                let (app, server, handle) = (app.clone(), server.clone(), handle.clone());
                tauri::async_runtime::spawn(async move { app.state::<Hollr>().drop_stale(&server, &handle).await });
            }
            let _ = app.emit(name, v);
        })
    };
    live.start(emit, handle, pane, live::Options { headphones, audio: true }).await.map_err(err)
}

/// Hangs up call `session` only – a stale stop can't end a newer call.
#[tauri::command]
async fn live_stop(live: tauri::State<'_, live::Lives>, session: u64) -> R<bool> {
    Ok(live.stop(session).await)
}

/// Mic mute = omp's own mute (Space): you keep hearing the answer.
#[tauri::command]
async fn live_mute(live: tauri::State<'_, live::Lives>, session: u64, on: bool) -> R<()> {
    live.mute(session, on).await;
    Ok(())
}

#[tauri::command]
async fn live_speaker(live: tauri::State<'_, live::Lives>, session: u64, muted: bool) -> R<()> {
    live.speaker(session, muted).await;
    Ok(())
}

/// Settings › "Kopfhörer": no echo gate; applies to a running call at once.
#[tauri::command]
async fn live_headphones(live: tauri::State<'_, live::Lives>, on: bool) -> R<()> {
    live.headphones(on).await;
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

/// Streams one omp chat (`hollr gate follow`) as `hollr-follow` events; returns the stream id.
#[tauri::command]
async fn follow_start(app: tauri::AppHandle, follows: tauri::State<'_, follow::Follows>, server: String, pane: String) -> R<u64> {
    Ok(follows.start(app, server, pane).await)
}

#[tauri::command]
async fn follow_stop(follows: tauri::State<'_, follow::Follows>, id: u64) -> R<()> {
    follows.stop(id).await;
    Ok(())
}

/// A live terminal on a pane (`hollr gate attach` / `shell`) as `hollr-term` events; returns the stream id.
#[tauri::command]
async fn term_start(app: tauri::AppHandle, terms: tauri::State<'_, term::Terms>, server: String, pane: String, mode: String, cols: u16, rows: u16) -> R<u64> {
    Ok(terms.start(app, server, term::command(&mode, &pane, cols, rows)).await)
}

#[tauri::command]
async fn term_write(terms: tauri::State<'_, term::Terms>, id: u64, data: String) -> R<()> {
    terms.write(id, data).await;
    Ok(())
}

#[tauri::command]
async fn term_resize(terms: tauri::State<'_, term::Terms>, id: u64, cols: u16, rows: u16) -> R<()> {
    terms.resize(id, cols, rows).await;
    Ok(())
}

#[tauri::command]
async fn term_stop(terms: tauri::State<'_, term::Terms>, id: u64) -> R<()> {
    terms.stop(id).await;
    Ok(())
}

/// App lock (Settings → Sicherheit): can this computer ask for Touch ID / its password?
#[tauri::command]
async fn applock_available() -> applock::Support {
    tokio::task::spawn_blocking(applock::support).await.unwrap_or(applock::Support { available: false, biometry: "none" })
}

/// Shows the system prompt; true once the owner confirmed (cancel / failure → false).
#[tauri::command]
async fn applock_authenticate(reason: String) -> bool {
    tokio::task::spawn_blocking(move || applock::authenticate(&reason)).await.unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // a reloaded webview leaves its terminals and its live call behind: hang them up
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let app = webview.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app.state::<term::Terms>().stop_all().await;
                    app.state::<live::Lives>().stop_all().await;
                    app.state::<speech::Speech>().stop();
                });
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            app.manage(dictation::Dictation::new(dir.join("whisper")));
            app.manage(speech::Speech::new(dir.join("speech")));
            app.manage(Hollr::new(dir));
            app.manage(live::Lives::default());
            app.manage(feed::Feeds::default());
            app.manage(follow::Follows::default());
            app.manage(tunnel::Tunnels::default());
            app.manage(term::Terms::default());
            notice::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![feeds_sync, follow_start, follow_stop, servers, pair, pair_code, remove_server, gate, gate_long, live_start, live_stop, live_mute, live_speaker, live_headphones, tunnel_open, tunnel_close, applock_available, applock_authenticate, term_start, term_write, term_resize, term_stop, notice::notice_show, dictation::dictation_models, dictation::dictation_download, dictation::dictation_download_cancel, dictation::dictation_delete, dictation::dictation_prewarm, dictation::dictation_start, dictation::dictation_stop, dictation::dictation_cancel, speech::speech_status, speech::speech_token, speech::speech_download, speech::speech_download_cancel, speech::speech_delete, speech::speech_voices, speech::speech_voice_download, speech::speech_speak, speech::speech_stop, speech::speech_prewarm])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
