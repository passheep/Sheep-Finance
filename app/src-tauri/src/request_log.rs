use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::database;

const MAX_REQUEST_LOGS: usize = 200;
const MAX_CONTENT_CHARS: usize = 100_000;

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
    database::now_iso8601()
}

pub async fn append_request_log(app: &AppHandle, input: RequestLogInput) -> Result<(), String> {
    let root = database::storage_root(app)?;
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
        let _guard = database::storage_guard()?;
        let mut connection = database::open_database(&root, false)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("开启请求记录事务失败：{error}"))?;
        transaction
            .execute(
                "INSERT INTO request_logs
                 (id, service, record_id, expense_id, file_name, profile_name, model, action,
                  request_url, requested_at, duration_ms, http_status, success, error,
                  request_content, response_content)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    record.id,
                    record.service,
                    record.record_id,
                    record.expense_id,
                    record.file_name,
                    record.profile_name,
                    record.model,
                    record.action,
                    record.request_url,
                    record.requested_at,
                    record.duration_ms.min(i64::MAX as u128) as i64,
                    record.http_status,
                    record.success,
                    record.error,
                    record.request_content,
                    record.response_content,
                ],
            )
            .map_err(|error| format!("保存请求记录失败：{error}"))?;
        transaction
            .execute(
                "DELETE FROM request_logs WHERE id IN (
                    SELECT id FROM request_logs ORDER BY requested_at DESC LIMIT -1 OFFSET ?1
                 )",
                [MAX_REQUEST_LOGS as i64],
            )
            .map_err(|error| format!("清理过期请求记录失败：{error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("提交请求记录失败：{error}"))
    })
    .await
    .map_err(|_| "请求记录保存任务异常结束".to_string())?
}

#[tauri::command]
pub async fn list_request_logs(app: AppHandle) -> Result<Vec<RequestLogSummary>, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let connection = database::open_database(&root, false)?;
        let mut statement = connection
            .prepare(
                "SELECT id, service, record_id, expense_id, file_name, profile_name, model,
                 action, request_url, requested_at, duration_ms, http_status, success, error,
                 request_content, response_content
                 FROM request_logs ORDER BY requested_at DESC LIMIT ?1",
            )
            .map_err(|error| format!("读取请求记录失败：{error}"))?;
        let rows = statement
            .query_map([MAX_REQUEST_LOGS as i64], map_request_log)
            .map_err(|error| format!("查询请求记录失败：{error}"))?;
        let mut records = Vec::new();
        for row in rows {
            let record = row.map_err(|error| error.to_string())?;
            records.push(RequestLogSummary::from(&record));
        }
        Ok(records)
    })
    .await
    .map_err(|_| "请求记录读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn get_request_log(app: AppHandle, id: String) -> Result<RequestLogRecord, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let connection = database::open_database(&root, false)?;
        connection
            .query_row(
                "SELECT id, service, record_id, expense_id, file_name, profile_name, model,
                 action, request_url, requested_at, duration_ms, http_status, success, error,
                 request_content, response_content FROM request_logs WHERE id=?1",
                [id],
                map_request_log,
            )
            .optional()
            .map_err(|error| format!("读取请求详情失败：{error}"))?
            .ok_or_else(|| "请求记录不存在或已被清理".to_string())
    })
    .await
    .map_err(|_| "请求详情读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn clear_request_logs(app: AppHandle) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let connection = database::open_database(&root, false)?;
        connection
            .execute("DELETE FROM request_logs", [])
            .map_err(|error| format!("清空请求记录失败：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|_| "请求记录清理任务异常结束".to_string())?
}

fn map_request_log(row: &Row<'_>) -> rusqlite::Result<RequestLogRecord> {
    Ok(RequestLogRecord {
        id: row.get(0)?,
        service: row.get(1)?,
        record_id: row.get(2)?,
        expense_id: row.get(3)?,
        file_name: row.get(4)?,
        profile_name: row.get(5)?,
        model: row.get(6)?,
        action: row.get(7)?,
        request_url: row.get(8)?,
        requested_at: row.get(9)?,
        duration_ms: row.get::<_, i64>(10)?.max(0) as u128,
        http_status: row.get(11)?,
        success: row.get(12)?,
        error: row.get(13)?,
        request_content: row.get(14)?,
        response_content: row.get(15)?,
    })
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
