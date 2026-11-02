fn main() {
    // whisper.cpp's Metal backend uses `@available`, which needs `___isPlatformVersionAtLeast` from
    // clang's runtime (libclang_rt.osx.a). rustc links with `-nodefaultlibs`, so clang doesn't add
    // it by itself – on some toolchains (GitHub's macOS runners) the link then fails.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let out = std::process::Command::new("xcrun")
            .args(["clang", "--print-resource-dir"])
            .output()
            .expect("xcrun clang --print-resource-dir");
        let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
        println!("cargo:rustc-link-search=native={dir}/lib/darwin");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
    tauri_build::build()
}
