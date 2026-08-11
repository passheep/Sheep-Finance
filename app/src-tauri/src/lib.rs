mod recognition;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            recognition::recognize_expense,
            storage::save_workspace,
            storage::load_workspace,
            storage::load_record,
            storage::delete_record
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
