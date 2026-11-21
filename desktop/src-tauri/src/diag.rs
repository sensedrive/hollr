//! A small diagnostic log for the "app was gone / froze" reports: Rust panics, webview errors and UI stalls
//! go to ~/Library/Logs/Hollr/desktop.log (Linux: ~/.local/state/hollr/desktop.log), capped at 1 MB.
use std::io::Write;
use std::path::PathBuf;

fn path() -> Option<PathBuf> {
    let dir = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library/Logs/Hollr")
    } else {
        dirs::state_dir().or_else(dirs::data_local_dir)?.join("hollr")
    };
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("desktop.log"))
}

pub fn write(line: &str) {
    let Some(p) = path() else { return };
    if std::fs::metadata(&p).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&p, p.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{now} {line}");
    }
}

/// Panics abort the release build (panic = "abort"): write what and where first.
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write(&format!("PANIC {info}"));
        prev(info);
    }));
    write(&format!("start {}", env!("CARGO_PKG_VERSION")));
}

#[tauri::command]
pub fn diag_log(line: String) {
    write(&line.chars().take(2000).collect::<String>());
}
