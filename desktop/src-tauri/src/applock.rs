//! Optional app lock with Touch ID / the device password (like iOS `AppLock.swift`).
//! macOS only (LocalAuthentication, `LAPolicyDeviceOwnerAuthentication`); elsewhere unavailable.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Support {
    /// the device can ask for its owner (Touch ID or password)
    pub available: bool,
    /// "touchid" | "faceid" | "opticid" | "none" (password only)
    pub biometry: &'static str,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Support;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
    use std::sync::{Mutex, mpsc};

    pub fn support() -> Support {
        let ctx = unsafe { LAContext::new() };
        let available = unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_ok();
        // biometryType is only filled in after a canEvaluatePolicy call with the biometrics policy
        let _ = unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) };
        let biometry = match unsafe { ctx.biometryType() } {
            LABiometryType::TouchID => "touchid",
            LABiometryType::FaceID => "faceid",
            LABiometryType::OpticID => "opticid",
            _ => "none",
        };
        Support { available, biometry }
    }

    /// Blocks until the user answered the system prompt. macOS shows the reason as
    /// "„<App>“ is trying to <reason>." – so phrase it as the end of that sentence.
    pub fn authenticate(reason: &str) -> bool {
        let ctx = unsafe { LAContext::new() };
        // like iOS: a device that cannot ask for its owner has nothing to lock with
        if unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) }.is_err() {
            return true;
        }
        let (tx, rx) = mpsc::channel::<bool>();
        let tx = Mutex::new(Some(tx));
        let reply = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(ok.as_bool());
            }
        });
        unsafe {
            ctx.evaluatePolicy_localizedReason_reply(LAPolicy::DeviceOwnerAuthentication, &NSString::from_str(reason), &reply);
        }
        // `ctx` stays alive until the reply came: releasing it would cancel the prompt
        let ok = rx.recv().unwrap_or(false);
        drop(ctx);
        ok
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Support;

    pub fn support() -> Support {
        Support { available: false, biometry: "none" }
    }

    pub fn authenticate(_reason: &str) -> bool {
        true
    }
}

pub use imp::{authenticate, support};
