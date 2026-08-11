mod lan_upload;
mod recognition;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan_upload::LanUploadManager::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            lan_upload::start_lan_upload_session,
            lan_upload::update_lan_upload_session,
            lan_upload::stop_lan_upload_session,
            recognition::recognize_expense,
            storage::save_workspace,
            storage::load_workspace,
            storage::load_record,
            storage::delete_record
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
