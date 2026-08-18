use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::storage::{read_json_with_backup, storage_root, write_json_atomic};

const MAX_REQUEST_LOGS: usize = 200;
const MAX_CONTENT_CHARS: usize = 100_000;
const REQUEST_LOG_FILE: &str = "request-records.json";
static REQUEST_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug)]
pub struct RequestLogInput {
    pub service: String,
    pub record_id: String,
    pub expense_id: String,
    pub file_name: String,
    pub profile_name: String,
    pub model: Option<String>,
    pub action: Option<String>,
    pub request_url: String,
    pub requested_at: String,
    pub duration_ms: u128,
    pub http_status: Option<u16>,
    pub success: bool,
    pub error: Option<String>,
    pub request_content: String,
    pub response_content: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogRecord {
    pub id: String,
    pub service: String,
    pub record_id: String,
    pub expense_id: String,
    pub file_name: String,
    pub profile_name: String,
    pub model: Option<String>,
    pub action: Option<String>,
    pub request_url: String,
    pub requested_at: String,
    pub duration_ms: u128,
    pub http_status: Option<u16>,
    pub success: bool,
    pub error: Option<String>,
    pub request_content: String,
    pub response_content: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogSummary {
    pub id: String,
    pub service: String,
    pub record_id: String,
    pub expense_id: String,
    pub file_name: String,
    pub profile_name: String,
    pub model: Option<String>,
    pub action: Option<String>,
    pub request_url: String,
    pub requested_at: String,
    pub duration_ms: u128,
    pub http_status: Option<u16>,
    pub success: bool,
    pub error: Option<String>,
}

impl From<&RequestLogRecord> for RequestLogSummary {
    fn from(value: &RequestLogRecord) -> Self {
        Self {
            id: value.id.clone(),
            service: value.service.clone(),
            record_id: value.record_id.clone(),
            expense_id: value.expense_id.clone(),
            file_name: value.file_name.clone(),
            profile_name: value.profile_name.clone(),
            model: value.model.clone(),
            action: value.action.clone(),
            request_url: value.request_url.clone(),
            requested_at: value.requested_at.clone(),
            duration_ms: value.duration_ms,
            http_status: value.http_status,
            success: value.success,
            error: value.error.clone(),
        }
    }
}

pub fn now_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

pub async fn append_request_log(app: &AppHandle, input: RequestLogInput) -> Result<(), String> {
    let root = storage_root(app)?;
    let record = RequestLogRecord {
        id: format!("request-{}", Uuid::new_v4().simple()),
        service: input.service,
        record_id: input.record_id,
        expense_id: input.expense_id,
        file_name: input.file_name,
        profile_name: input.profile_name,
        model: input.model,
        action: input.action,
        request_url: input.request_url,
        requested_at: input.requested_at,
        duration_ms: input.duration_ms,
        http_status: input.http_status,
        success: input.success,
        error: input
            .error
            .map(|value| truncate_content(value, MAX_CONTENT_CHARS)),
        request_content: truncate_content(input.request_content, MAX_CONTENT_CHARS),
        response_content: input
            .response_content
            .map(|value| truncate_content(value, MAX_CONTENT_CHARS)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = request_log_guard()?;
        let path = root.join(REQUEST_LOG_FILE);
        let mut records = read_request_logs(&path)?;
        records.insert(0, record);
        records.truncate(MAX_REQUEST_LOGS);
        write_json_atomic(&path, &records)
    })
    .await
    .map_err(|_| "请求记录保存任务异常结束".to_string())?
}

#[tauri::command]
pub async fn list_request_logs(app: AppHandle) -> Result<Vec<RequestLogSummary>, String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = request_log_guard()?;
        let records = read_request_logs(&root.join(REQUEST_LOG_FILE))?;
        Ok(records.iter().map(RequestLogSummary::from).collect())
    })
    .await
    .map_err(|_| "请求记录读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn get_request_log(app: AppHandle, id: String) -> Result<RequestLogRecord, String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = request_log_guard()?;
        read_request_logs(&root.join(REQUEST_LOG_FILE))?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "请求记录不存在或已被清理".to_string())
    })
    .await
    .map_err(|_| "请求详情读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn clear_request_logs(app: AppHandle) -> Result<(), String> {
    let root = storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = request_log_guard()?;
        write_json_atomic(
            &root.join(REQUEST_LOG_FILE),
            &Vec::<RequestLogRecord>::new(),
        )
    })
    .await
    .map_err(|_| "请求记录清理任务异常结束".to_string())?
}

fn request_log_guard() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    REQUEST_LOG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "请求记录存储锁异常".to_string())
}

fn read_request_logs(path: &std::path::Path) -> Result<Vec<RequestLogRecord>, String> {
    if !path.exists() && !path.with_extension("bak").exists() {
        return Ok(Vec::new());
    }
    read_json_with_backup(path).map_err(|error| format!("读取请求记录失败：{error}"))
}

fn truncate_content(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut result = value.chars().take(max_chars).collect::<String>();
    result.push_str("\n...[内容过长，已截断]");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_request_content_is_bounded() {
        let value = "中".repeat(12);
        assert_eq!(
            truncate_content(value, 5),
            "中中中中中\n...[内容过长，已截断]"
        );
    }

    #[test]
    fn short_request_content_is_unchanged() {
        assert_eq!(truncate_content("request".to_string(), 20), "request");
    }
}
