use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub draft: Value,
    pub profiles: Value,
    pub dictionaries: Value,
    pub services: Value,
    pub history: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedWorkspace {
    pub draft: Option<Value>,
    pub profiles: Value,
    pub dictionaries: Value,
    pub services: Value,
    pub history: Value,
    pub data_directory: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIndex {
    current_record_id: String,
    profiles: Value,
    dictionaries: Value,
    services: Value,
    history: Value,
}

#[tauri::command]
pub async fn save_workspace(app: AppHandle, request: SaveWorkspaceRequest) -> Result<(), String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || save_workspace_blocking(&root, request))
        .await
        .map_err(|_| "本地保存任务异常结束".to_string())?
}

#[tauri::command]
pub async fn load_workspace(app: AppHandle) -> Result<Option<LoadedWorkspace>, String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_workspace_blocking(&root))
        .await
        .map_err(|_| "本地读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn load_record(app: AppHandle, record_id: String) -> Result<Value, String> {
    validate_record_id(&record_id)?;
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = storage_guard()?;
        read_json_with_backup(&record_path(&root, &record_id))
            .map_err(|error| format!("读取历史报销单失败：{error}"))
    })
    .await
    .map_err(|_| "历史记录读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn delete_record(app: AppHandle, record_id: String) -> Result<(), String> {
    validate_record_id(&record_id)?;
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = storage_guard()?;
        for path in [
            record_path(&root, &record_id),
            record_path(&root, &record_id).with_extension("bak"),
        ] {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("删除本地记录失败：{error}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "历史记录删除任务异常结束".to_string())?
}

fn save_workspace_blocking(root: &Path, request: SaveWorkspaceRequest) -> Result<(), String> {
    let _guard = storage_guard()?;
    fs::create_dir_all(root.join("records"))
        .map_err(|error| format!("创建本地数据目录失败：{error}"))?;
    let record_id = request
        .draft
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "报销单缺少记录编号".to_string())?;
    validate_record_id(record_id)?;
    write_json_atomic(&record_path(root, record_id), &request.draft)?;
    let index = WorkspaceIndex {
        current_record_id: record_id.to_string(),
        profiles: request.profiles,
        dictionaries: request.dictionaries,
        services: request.services,
        history: request.history,
    };
    write_json_atomic(&root.join("workspace.json"), &index)
}

fn load_workspace_blocking(root: &Path) -> Result<Option<LoadedWorkspace>, String> {
    let _guard = storage_guard()?;
    let index_path = root.join("workspace.json");
    if !index_path.exists() && !index_path.with_extension("bak").exists() {
        return Ok(None);
    }
    let index: WorkspaceIndex = read_json_with_backup(&index_path)
        .map_err(|error| format!("读取本地工作区失败：{error}"))?;
    let draft_path = record_path(root, &index.current_record_id);
    let draft = if draft_path.exists() || draft_path.with_extension("bak").exists() {
        Some(
            read_json_with_backup(&draft_path)
                .map_err(|error| format!("读取当前报销单失败：{error}"))?,
        )
    } else {
        None
    };
    Ok(Some(LoadedWorkspace {
        draft,
        profiles: index.profiles,
        dictionaries: index.dictionaries,
        services: index.services,
        history: index.history,
        data_directory: root.to_string_lossy().into_owned(),
    }))
}

fn storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))
}

fn record_path(root: &Path, record_id: &str) -> PathBuf {
    root.join("records").join(format!("{record_id}.json"))
}

fn validate_record_id(record_id: &str) -> Result<(), String> {
    if record_id.is_empty()
        || record_id.len() > 120
        || !record_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        return Err("本地记录编号格式无效".to_string());
    }
    Ok(())
}

fn storage_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "本地存储锁异常".to_string())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建本地数据目录失败：{error}"))?;
    }
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化本地数据失败：{error}"))?;
    let temporary = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    fs::write(&temporary, bytes).map_err(|error| format!("写入临时数据失败：{error}"))?;
    if path.exists() {
        fs::copy(path, &backup).map_err(|error| format!("创建本地备份失败：{error}"))?;
        fs::remove_file(path).map_err(|error| format!("替换旧数据失败：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() && !path.exists() {
            let _ = fs::copy(&backup, path);
        }
        return Err(format!("提交本地数据失败：{error}"));
    }
    Ok(())
}

fn read_json_with_backup<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    match read_json(path) {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let backup = path.with_extension("bak");
            read_json(&backup).map_err(|backup_error| {
                format!("主文件错误：{primary_error}；备份文件错误：{backup_error}")
            })
        }
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_id_validation_blocks_path_traversal() {
        assert!(validate_record_id("record-123_ab").is_ok());
        assert!(validate_record_id("../workspace").is_err());
        assert!(validate_record_id("C:\\temp").is_err());
    }

    #[test]
    fn atomic_json_roundtrip_uses_backup() {
        let root = std::env::temp_dir().join(format!("sheepfinance-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("test.json");
        write_json_atomic(&path, &serde_json::json!({ "value": 1 })).expect("first write");
        write_json_atomic(&path, &serde_json::json!({ "value": 2 })).expect("second write");
        let current: Value = read_json_with_backup(&path).expect("current");
        assert_eq!(current["value"], 2);
        fs::write(&path, b"broken").expect("corrupt current");
        let recovered: Value = read_json_with_backup(&path).expect("backup");
        assert_eq!(recovered["value"], 1);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
