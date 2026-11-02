//! Desktop notifications that know when they are clicked (macOS).
//!
//! The notification plugin reports a click on macOS only for notifications with action buttons:
//! notify-rust doesn't ask `NSUserNotificationCenter` to wait for a plain click, so it returns
//! right away. Here each notification waits for its click on a thread of its own; a click brings
//! the window to the front and emits `notice-click` with the session it is about.
//! Other systems keep using the plugin, which reports clicks there (`notice_show` → `unsupported`).

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
struct Click {
    server: Option<String>,
    pane: Option<String>,
}

/// Once at startup: notifications go out as this app (a click activates it), like the plugin does.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let id = if tauri::is_dev() { "com.apple.Terminal".to_owned() } else { app.config().identifier.clone() };
        let _ = mac_notification_sys::set_application(&id);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn notice_show(app: AppHandle, title: String, body: String, server: Option<String>, pane: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::{Emitter, Manager};
        std::thread::Builder::new()
            .name("notice".into())
            .spawn(move || {
                let mut n = mac_notification_sys::Notification::new();
                n.title(&title).message(&body).wait_for_click(true);
                // blocks until the notification is clicked or goes away
                if let Ok(mac_notification_sys::NotificationResponse::Click) = n.send() {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("notice-click", Click { server, pane });
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body, server, pane);
        Err("unsupported".into())
    }
}
