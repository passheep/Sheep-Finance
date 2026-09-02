use serde_json::Value;
use tauri::AppHandle;

use crate::{backup, database};

#[tauri::command]
pub async fn bootstrap_storage(
    app: AppHandle,
    allow_default_settings: Option<bool>,
) -> Result<database::BootstrapResult, String> {
    let root = database::storage_root(&app)?;
    let migration_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        Ok::<_, String>(database::bootstrap_at_root(
            &root,
            Some(&migration_app),
            allow_default_settings.unwrap_or(false),
        ))
    })
    .await
    .map_err(|_| "本地存储初始化任务异常结束".to_string())?
}

#[tauri::command]
pub fn schedule_storage_backup(app: AppHandle) -> bool {
    backup::schedule_startup_backup(app)
}

#[tauri::command]
pub async fn save_workspace(
    app: AppHandle,
    request: database::SaveWorkspaceRequest,
) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::save_workspace_at_root(&root, request)
    })
    .await
    .map_err(|_| "本地保存任务异常结束".to_string())?;
    if result.is_ok() {
        backup::schedule_startup_backup(app);
    }
    result
}

#[tauri::command]
pub async fn load_workspace(app: AppHandle) -> Result<database::LoadedWorkspace, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::load_workspace_at_root(&root)
    })
    .await
    .map_err(|_| "本地读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn load_record(app: AppHandle, record_id: String) -> Result<Value, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::load_record_at_root(&root, &record_id)
    })
    .await
    .map_err(|_| "历史记录读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn delete_record(app: AppHandle, record_id: String) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::delete_record_at_root(&root, &record_id)
    })
    .await
    .map_err(|_| "历史记录删除任务异常结束".to_string())?
}

#[tauri::command]
pub async fn update_record_status(
    app: AppHandle,
    record_id: String,
    status: String,
) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::update_record_status_at_root(&root, &record_id, &status)
    })
    .await
    .map_err(|_| "报销状态保存任务异常结束".to_string())?
}

#[tauri::command]
pub async fn query_history(
    app: AppHandle,
    query: database::HistoryQuery,
) -> Result<database::HistoryQueryResult, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        database::query_history_at_root(&root, query)
    })
    .await
    .map_err(|_| "历史记录查询任务异常结束".to_string())?
}
