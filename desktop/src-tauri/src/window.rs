//! The side conversation's own window ("Nebengespräch", server `fork`): one per main session, labelled
//! `side-<server>-<main pane>`, showing the fork's pane with the whole session view. Opening it again
//! focuses it; a reset loads the new fork inside it (the window stays). Its result goes back to the
//! main window's composer as a draft (`hollr-side-result`).
use anyhow::{bail, Result};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MAIN: &str = "main";

/// The window label of `main`'s side conversation (herdr ids and server ids only use label-safe characters).
pub fn side_label(server: &str, main: &str) -> Result<String> {
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'));
    if !ok(server) || !ok(main) {
        bail!("ungültige Sitzung");
    }
    Ok(format!("side-{server}-{main}"))
}

/// The page the window loads: the app in side mode. `live`: start Live once the fork is ready.
pub fn side_url(server: &str, main: &str, pane: &str, live: bool) -> String {
    format!("?window=side&server={server}&main={main}&pane={pane}{}", if live { "&live=1" } else { "" })
}

/// Opens `main`'s side window on fork `pane` – or brings the open one to the front (showing `pane` if it changed).
pub fn open_side(app: &AppHandle, server: &str, main: &str, pane: &str, title: &str, live: bool) -> Result<()> {
    let label = side_label(server, main)?;
    if side_label(server, pane).is_err() {
        bail!("ungültiges Pane");
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_title(title);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // the window follows the fork it is told (reopened from another fork's tab)
        let _ = app.emit_to(&label, "hollr-side-show", json!({ "pane": pane }));
        return Ok(());
    }
    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(side_url(server, main, pane, live).into()))
        .title(title)
        .inner_size(1040.0, 760.0)
        .min_inner_size(640.0, 480.0)
        .zoom_hotkeys_enabled(false)
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

/// The side conversation's result for the main session's composer. False when the main window is gone
/// (the side window then keeps the draft itself).
pub fn send_result(app: &AppHandle, server: &str, main: &str, text: &str) -> bool {
    let Some(w) = app.get_webview_window(MAIN) else { return false };
    let sent = app.emit_to(MAIN, "hollr-side-result", json!({ "server": server, "pane": main, "text": text })).is_ok();
    if sent {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    sent
}

pub fn focus_main(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window(MAIN) else { return false };
    let _ = w.unminimize();
    let _ = w.show();
    w.set_focus().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_urls() {
        assert_eq!(side_label("b2JWHpw2e5Q", "wD:p18").unwrap(), "side-b2JWHpw2e5Q-wD:p18");
        assert!(side_label("x", "w1:p1&live=1").is_err());
        assert!(side_label("", "w1:p1").is_err());
        assert_eq!(side_url("s", "w1:p1", "w1:p9", true), "?window=side&server=s&main=w1:p1&pane=w1:p9&live=1");
        assert_eq!(side_url("s", "w1:p1", "w1:p9", false), "?window=side&server=s&main=w1:p1&pane=w1:p9");
    }
}
