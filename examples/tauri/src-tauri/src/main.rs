// The page does the work. The one native call is Save: the platform's save dialog, then the file's bytes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn save(app: tauri::AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("Expected the file's bytes.".into()) };
    // The page sends the name percent-encoded; only its last path part is kept.
    let name = request.headers().get("name").and_then(|v| v.to_str().ok()).map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned()).unwrap_or_default();
    let name = name.rsplit(['/', '\\']).next().filter(|n| !n.is_empty()).unwrap_or("image.jxl").to_string();
    #[cfg(feature = "check")]
    if let Ok(dir) = std::env::var("RAPIER_JXL_CHECK_SAVE_DIR") {
        let path = std::path::Path::new(&dir).join(&name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    let Some(path) = app.dialog().file().set_file_name(&name).add_filter("JPEG XL", &["jxl"]).blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// Check build only: the report of a scenario run inside the page (where no WebDriver reaches the web view).
#[cfg(feature = "check")]
#[tauri::command]
fn check_report(app: tauri::AppHandle, json: String) {
    if let Ok(dir) = std::env::var("RAPIER_JXL_CHECK_SAVE_DIR") {
        let _ = std::fs::write(std::path::Path::new(&dir).join("report.json"), json);
    }
    app.exit(0);
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    #[cfg(feature = "check")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![save, check_report])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(script) = std::env::var("RAPIER_JXL_CHECK_SCRIPT").ok().and_then(|path| std::fs::read_to_string(path).ok()) {
                    let _ = webview.eval(script);
                }
            }
        });
    #[cfg(not(feature = "check"))]
    let builder = builder.invoke_handler(tauri::generate_handler![save]);
    builder.run(tauri::generate_context!()).expect("the app could not start");
}
