fn main() {
    println!("cargo:rerun-if-env-changed=CODE_LITE_BUILD_ID");
    println!("cargo:rerun-if-env-changed=CODE_LITE_DISPLAY_VERSION");
    tauri_build::build()
}
