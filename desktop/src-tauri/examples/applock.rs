//! Shows the app-lock prompt (Touch ID / password) once and prints the result.
//! `cargo run --example applock -- [reason]`
use hollr_desktop_lib::applock;

fn main() {
    let reason = std::env::args().nth(1).unwrap_or_else(|| "unlock Hollr".into());
    println!("support: {:?}", applock::support());
    println!("authenticated: {}", applock::authenticate(&reason));
}
