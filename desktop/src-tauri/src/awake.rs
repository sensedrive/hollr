// only the menu text command is wired up outside macOS
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
//! Menu bar item (macOS): "Zugeklappt wach bleiben" – the MacBook stays reachable from the phone with its lid
//! closed, also on battery. macOS forces clamshell sleep on battery; only `pmset -a disablesleep 1` (root)
//! prevents it. Turning the option on asks once for an admin password and installs a sudoers rule that allows
//! exactly `pmset -a disablesleep 0|1`; after that the app switches it without asking.
//!
//! Safety: on battery at or below `LOW_BATTERY` % sleep is allowed again (a closed Mac in a bag must not run
//! flat or hot), and quitting Hollr allows it again too – nothing watches the battery then.

use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

const LOW_BATTERY: u8 = 20;
const RULE: &str = "/etc/sudoers.d/hollr-sleep";
const PMSET: &str = "/usr/bin/pmset";

/// The menu's words, from the frontend (its language setting); German until it sends them.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Texts {
    toggle: String,
    /// option off: the Mac sleeps when closed, as usual
    status_off: String,
    status_on: String,
    /// on, but the battery is low: sleep allowed for now
    status_low: String,
    /// on, but switching failed (rule missing, pmset error)
    status_failed: String,
    open: String,
    quit: String,
    /// the admin prompt's text
    prompt: String,
}

impl Default for Texts {
    fn default() -> Self {
        Self {
            toggle: "Zugeklappt wach bleiben".into(),
            status_off: "Schläft zugeklappt (wie gewohnt)".into(),
            status_on: "Bleibt zugeklappt wach – vom iPhone erreichbar".into(),
            status_low: "Akku unter {pct} % – darf jetzt schlafen".into(),
            status_failed: "Ließ sich nicht umstellen".into(),
            open: "Hollr öffnen".into(),
            quit: "Hollr beenden".into(),
            prompt: "Hollr möchte einstellen dürfen, ob der Mac zugeklappt schläft.".into(),
        }
    }
}

pub struct Awake {
    tray: TrayIcon,
    toggle: CheckMenuItem<Wry>,
    status: MenuItem<Wry>,
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    state: Mutex<State>,
}

struct State {
    /// the user's choice (kept in awake.json)
    on: bool,
    texts: Texts,
    /// what the last reconcile found / did
    shown: Shown,
}

#[derive(Clone, Copy, PartialEq)]
enum Shown {
    Off,
    On,
    Low(u8),
    Failed,
}

fn pref_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("awake.json"))
}

fn load_pref(app: &AppHandle) -> bool {
    pref_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["on"].as_bool())
        .unwrap_or(false)
}

fn save_pref(app: &AppHandle, on: bool) {
    if let Some(f) = pref_file(app) {
        let _ = std::fs::write(f, serde_json::json!({ "on": on }).to_string());
    }
}

fn pmset(args: &[&str]) -> String {
    Command::new(PMSET).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

/// `pmset -g`: is system sleep switched off?
fn parse_sleep_disabled(out: &str) -> bool {
    out.lines().any(|l| {
        let mut w = l.split_whitespace();
        w.next() == Some("SleepDisabled") && w.next() == Some("1")
    })
}

fn sleep_disabled() -> bool {
    parse_sleep_disabled(&pmset(&["-g"]))
}

/// `pmset -g batt`: (on battery, percent); a Mac without a battery reports AC and 100.
fn parse_battery(out: &str) -> (bool, u8) {
    let on_battery = out.contains("'Battery Power'");
    let pct = out
        .split_once('%')
        .and_then(|(head, _)| head.rsplit(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(100);
    (on_battery, pct)
}

fn battery() -> (bool, u8) {
    parse_battery(&pmset(&["-g", "batt"]))
}

/// Switches without a password (the sudoers rule); false when that isn't possible.
fn set_disabled(disabled: bool) -> bool {
    Command::new("/usr/bin/sudo")
        .args(["-n", PMSET, "-a", "disablesleep", if disabled { "1" } else { "0" }])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The AppleScript for the admin prompt: the rule is checked with visudo before it goes in place
/// (root-owned, 0440); a broken rule would lock sudo.
fn rule_script(user: &str, prompt: &str, target: &str) -> String {
    let line = format!("{user} ALL=(root) NOPASSWD: {PMSET} -a disablesleep 0, {PMSET} -a disablesleep 1");
    let script = format!(
        "t=$(/usr/bin/mktemp) && /usr/bin/printf '%s\\n' '{line}' > \"$t\" && /usr/sbin/visudo -cf \"$t\" && /usr/bin/install -m 0440 -o root -g wheel \"$t\" {target}; r=$?; /bin/rm -f \"$t\"; exit $r"
    );
    format!(
        "do shell script \"{}\" with prompt \"{}\" with administrator privileges",
        script.replace('\\', "\\\\").replace('"', "\\\""),
        prompt.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// The macOS admin prompt once.
fn install_rule(prompt: &str) -> bool {
    let user = std::env::var("USER").unwrap_or_default();
    if user.is_empty() || !user.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return false;
    }
    let apple = rule_script(&user, prompt, RULE);
    Command::new("/usr/bin/osascript").args(["-e", &apple]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Menu bar icon (template: macOS tints it): a crescent moon while the Mac may sleep, a sun while it stays awake.
fn icon(awake: bool) -> Image<'static> {
    const S: usize = 44; // 22 pt @2x
    const SS: usize = 4; // supersampling for smooth edges
    let mut rgba = vec![0u8; S * S * 4];
    let c = S as f32 / 2.0;
    for y in 0..S {
        for x in 0..S {
            let mut hits = 0;
            for sy in 0..SS {
                for sx in 0..SS {
                    let px = x as f32 + (sx as f32 + 0.5) / SS as f32 - c;
                    let py = y as f32 + (sy as f32 + 0.5) / SS as f32 - c;
                    let r = (px * px + py * py).sqrt();
                    let inside = if awake {
                        // disc and eight rays
                        let a = py.atan2(px);
                        let ray = (a * 4.0 / std::f32::consts::PI).round() * std::f32::consts::PI / 4.0;
                        let off = (a - ray).abs() * r;
                        r <= 8.0 || (r >= 11.5 && r <= 18.0 && off <= 1.6)
                    } else {
                        // a disc minus a shifted disc
                        let (dx, dy) = (px - 6.0, py + 5.0);
                        r <= 15.0 && (dx * dx + dy * dy).sqrt() > 12.5
                    };
                    if inside {
                        hits += 1;
                    }
                }
            }
            let a = (hits * 255 / (SS * SS)) as u8;
            let i = (y * S + x) * 4;
            rgba[i + 3] = a;
        }
    }
    Image::new_owned(rgba, S as u32, S as u32)
}

impl Awake {
    fn texts(&self) -> Texts {
        self.state.lock().map(|s| s.texts.clone()).unwrap_or_default()
    }

    fn show(&self, shown: Shown) {
        let t = self.texts();
        let (on, text) = match shown {
            Shown::Off => (false, t.status_off),
            Shown::On => (true, t.status_on),
            Shown::Low(pct) => (true, t.status_low.replace("{pct}", &pct.to_string())),
            Shown::Failed => (true, t.status_failed),
        };
        let _ = self.toggle.set_checked(on);
        let _ = self.status.set_text(text);
        let _ = self.tray.set_icon(Some(icon(shown == Shown::On)));
        let _ = self.tray.set_icon_as_template(true);
        if let Ok(mut s) = self.state.lock() {
            s.shown = shown;
        }
    }

    /// Brings the system setting in line with the choice and the battery.
    fn reconcile(&self) {
        let on = self.state.lock().map(|s| s.on).unwrap_or(false);
        if !on {
            return self.show(Shown::Off);
        }
        let (on_battery, pct) = battery();
        let want = !(on_battery && pct <= LOW_BATTERY);
        let ok = sleep_disabled() == want || set_disabled(want);
        self.show(match (ok, want) {
            (false, _) => Shown::Failed,
            (true, true) => Shown::On,
            (true, false) => Shown::Low(pct),
        });
    }

    fn toggled(&self, app: &AppHandle) {
        let was = self.state.lock().map(|s| s.on).unwrap_or(false);
        let on = !was;
        if on && !set_disabled(true) {
            // no rule yet: the admin prompt once, then the switch works without asking
            let prompt = self.texts().prompt;
            if !install_rule(&prompt) || !set_disabled(true) {
                return self.show(Shown::Off);
            }
        }
        if !on {
            set_disabled(false);
        }
        if let Ok(mut s) = self.state.lock() {
            s.on = on;
        }
        save_pref(app, on);
        self.reconcile();
    }
}

/// At startup: the menu bar item, the choice from last time, a battery check every 30 s.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let texts = Texts::default();
    let on = load_pref(app);
    let toggle = CheckMenuItem::with_id(app, "awake", &texts.toggle, true, on, None::<&str>)?;
    let status = MenuItem::with_id(app, "awake-status", &texts.status_off, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", &texts.open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", &texts.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &status, &PredefinedMenuItem::separator(app)?, &open, &quit])?;
    let tray = TrayIconBuilder::with_id("hollr")
        .icon(icon(false))
        .icon_as_template(true)
        .tooltip("Hollr")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "awake" => {
                let app = app.clone();
                // the admin prompt blocks: not on the menu's thread
                std::thread::spawn(move || app.state::<Awake>().toggled(&app));
            }
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    app.manage(Awake { tray, toggle, status, open, quit, state: Mutex::new(State { on, texts, shown: Shown::Off }) });
    let app = app.clone();
    std::thread::Builder::new()
        .name("awake".into())
        .spawn(move || loop {
            app.state::<Awake>().reconcile();
            std::thread::sleep(Duration::from_secs(30));
        })
        .ok();
    Ok(())
}

/// Quitting: sleep is allowed again – nothing would watch the battery any more.
pub fn on_exit(app: &AppHandle) {
    if let Some(awake) = app.try_state::<Awake>() {
        if awake.state.lock().map(|s| s.on).unwrap_or(false) && sleep_disabled() {
            set_disabled(false);
        }
    }
}

/// The frontend's words for the menu (its language).
#[tauri::command]
pub fn awake_texts(app: AppHandle, texts: Texts) {
    if let Some(awake) = app.try_state::<Awake>() {
        let _ = awake.toggle.set_text(&texts.toggle);
        let _ = awake.open.set_text(&texts.open);
        let _ = awake.quit.set_text(&texts.quit);
        let shown = awake.state.lock().map(|s| s.shown).unwrap_or(Shown::Off);
        if let Ok(mut s) = awake.state.lock() {
            s.texts = texts;
        }
        awake.show(shown);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_battery_and_power_source() {
        let batt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=8126563)\t17%; discharging; 2:10 remaining present: true\n";
        assert_eq!(parse_battery(batt), (true, 17));
        let ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=8126563)\t100%; charged; 0:00 remaining present: true\n";
        assert_eq!(parse_battery(ac), (false, 100));
        // a Mac mini: no battery line at all
        assert_eq!(parse_battery("Now drawing from 'AC Power'\n"), (false, 100));
    }

    #[test]
    fn reads_sleep_disabled() {
        assert!(parse_sleep_disabled("System-wide power settings:\n SleepDisabled\t\t1\n"));
        assert!(!parse_sleep_disabled("System-wide power settings:\n SleepDisabled\t\t0\n"));
        assert!(!parse_sleep_disabled(""));
    }

    /// The script runs without the admin part: it must install a rule visudo accepts.
    #[test]
    #[cfg(target_os = "macos")]
    fn rule_script_installs_a_valid_rule() {
        let dir = std::env::temp_dir().join(format!("hollr-awake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("rule");
        let apple = rule_script("martin", "Test \"quoted\"", target.to_str().unwrap())
            .replace(" with administrator privileges", "")
            .replace(" -o root -g wheel", "");
        let ok = Command::new("/usr/bin/osascript").args(["-e", &apple]).output().unwrap();
        assert!(ok.status.success(), "{}", String::from_utf8_lossy(&ok.stderr));
        let rule = std::fs::read_to_string(&target).unwrap();
        assert_eq!(rule, "martin ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
