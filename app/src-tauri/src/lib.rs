mod attachments;
mod backup;
mod database;
mod lan_upload;
mod recognition;
mod request_log;
mod storage_sql;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan_upload::LanUploadManager::default())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            lan_upload::start_lan_upload_session,
            lan_upload::update_lan_upload_session,
            lan_upload::stop_lan_upload_session,
            recognition::recognize_expense,
            request_log::list_request_logs,
            request_log::get_request_log,
            request_log::clear_request_logs,
            storage_sql::bootstrap_storage,
            storage_sql::schedule_storage_backup,
            storage_sql::save_workspace,
            storage_sql::load_workspace,
            storage_sql::load_record,
            storage_sql::delete_record,
            storage_sql::update_record_status,
            storage_sql::query_history,
            attachments::store_attachment,
            attachments::read_attachment,
            attachments::save_attachment_as,
            attachments::open_attachment_folder,
            backup::get_backup_status,
            backup::create_database_backup,
            backup::restore_database_backup,
            backup::export_full_backup,
            backup::import_full_backup,
            backup::open_backup_directory,
            backup::cleanup_legacy_archives,
            backup::cleanup_orphan_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
