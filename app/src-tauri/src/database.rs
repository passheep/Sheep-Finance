use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use time::{format_description::well_known::Rfc3339, macros::format_description, OffsetDateTime};
use uuid::Uuid;

pub const DATABASE_FILE: &str = "sheepfinance.db";
pub const IMAGE_DIRECTORY: &str = "images";
pub const DATABASE_BACKUP_DIRECTORY: &str = "backups/database";
pub const FULL_BACKUP_DIRECTORY: &str = "backups/full";
pub const MAX_DATABASE_BACKUPS: usize = 5;
pub const BACKUP_INTERVAL_SECONDS: i64 = 72 * 60 * 60;

const MIN_DATABASE_SCHEMA_VERSION: i64 = 2;
const DATABASE_SCHEMA_VERSION: i64 = 3;

static STORAGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '未报销',
    company_name TEXT NOT NULL DEFAULT '',
    applicant TEXT NOT NULL DEFAULT '',
    reimbursement_date TEXT NOT NULL DEFAULT '',
    first_occurred_date TEXT NOT NULL DEFAULT '',
    expense_count INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_records_updated_at ON records(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_company ON records(company_name);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_first_occurred_date ON records(first_occurred_date);

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    occurred_date TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    arranger TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_record_order ON expenses(record_id, sort_order);

CREATE TABLE IF NOT EXISTS image_blobs (
    hash TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    extension TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('primary', 'extra')),
    sort_order INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    blob_hash TEXT NOT NULL REFERENCES image_blobs(hash),
    recognition_blob_hash TEXT REFERENCES image_blobs(hash),
    natural_width INTEGER NOT NULL DEFAULT 0,
    natural_height INTEGER NOT NULL DEFAULT 0,
    transform_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_attachments_expense_order ON attachments(expense_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_attachments_blob ON attachments(blob_hash);
CREATE INDEX IF NOT EXISTS idx_attachments_recognition_blob ON attachments(recognition_blob_hash);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dictionary_items (
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(kind, value)
);
CREATE TABLE IF NOT EXISTS ocr_profiles (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_profiles (
    id TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_logs (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    record_id TEXT NOT NULL DEFAULT '',
    expense_id TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    profile_name TEXT NOT NULL DEFAULT '',
    model TEXT,
    action TEXT,
    request_url TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    success INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    request_content TEXT NOT NULL DEFAULT '',
    response_content TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_requested_at ON request_logs(requested_at DESC);
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
PRAGMA user_version = 3;
"#;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResult {
    pub status: String,
    pub message: String,
    pub data_directory: String,
    pub migrated_records: usize,
    pub migrated_expenses: usize,
    pub migrated_attachments: usize,
    pub corrupt_files: Vec<String>,
    pub can_use_default_settings: bool,
    pub backup_scheduled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgress {
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct BlobMetadata {
    pub hash: String,
    pub relative_path: String,
    pub extension: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceRequest {
    pub draft: Value,
    pub profiles: Value,
    pub dictionaries: Value,
    pub services: Value,
    #[serde(default)]
    pub ui_preferences: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedWorkspace {
    pub draft: Option<Value>,
    pub profiles: Value,
    pub dictionaries: Value,
    pub services: Value,
    pub history: Value,
    pub ui_preferences: Value,
    pub data_directory: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub keyword: String,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub date: String,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub status: String,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub folder_kind: String,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub folder_key: String,
    #[serde(default = "default_page")]
    pub page: usize,
    #[serde(default = "default_page_size")]
    pub page_size: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    pub label: String,
    pub status: String,
    pub company_name: String,
    pub applicant: String,
    pub reimbursement_date: String,
    pub expense_count: i64,
    pub total_cents: i64,
    pub first_occurred_date: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQueryResult {
    pub items: Vec<HistoryRecord>,
    pub total: i64,
}

fn default_page() -> usize {
    1
}

fn default_page_size() -> usize {
    20
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

pub fn storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))
}

pub fn database_path(root: &Path) -> PathBuf {
    root.join(DATABASE_FILE)
}

pub fn storage_guard() -> Result<MutexGuard<'static, ()>, String> {
    STORAGE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "本地存储锁异常".to_string())
}

pub fn now_iso8601() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

pub fn open_database(root: &Path, create: bool) -> Result<Connection, String> {
    let path = database_path(root);
    if !create && !path.exists() {
        return Err("数据库尚未初始化".to_string());
    }
    open_database_at(&path, create)
}

pub fn open_database_at(path: &Path, create: bool) -> Result<Connection, String> {
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let connection = Connection::open_with_flags(path, flags)
        .map_err(|error| format!("打开本地数据库失败：{error}"))?;
    configure_connection(&connection)?;
    Ok(connection)
}

pub fn open_database_readonly_at(path: &Path) -> Result<Connection, String> {
    if !path.exists() {
        return Err("数据库文件不存在".to_string());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("打开只读数据库失败：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(10))
        .map_err(|error| format!("设置数据库等待时间失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|error| format!("设置只读数据库参数失败：{error}"))?;
    Ok(connection)
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(10))
        .map_err(|error| format!("设置数据库等待时间失败：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(|error| format!("设置数据库安全参数失败：{error}"))?;
    Ok(())
}

pub fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(SCHEMA)
        .map_err(|error| format!("初始化数据库结构失败：{error}"))
}

fn records_have_created_at(connection: &Connection) -> Result<bool, String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(records)")
        .map_err(|error| format!("读取单据表结构失败：{error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("查询单据表结构失败：{error}"))?;
    for column in columns {
        if column.map_err(|error| error.to_string())? == "created_at" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn upgrade_database_schema(connection: &Connection) -> Result<(), String> {
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("读取数据库版本失败：{error}"))?;
    if user_version < MIN_DATABASE_SCHEMA_VERSION {
        return Err("数据库版本过旧，无法自动升级".to_string());
    }

    let has_created_at = records_have_created_at(connection)?;
    if user_version >= DATABASE_SCHEMA_VERSION && has_created_at {
        return Ok(());
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("开启数据库升级事务失败：{error}"))?;
    if !has_created_at {
        transaction
            .execute(
                "ALTER TABLE records ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("新增单据创建时间字段失败：{error}"))?;
    }

    let records = {
        let mut statement = transaction
            .prepare("SELECT id, updated_at FROM records WHERE created_at='' OR created_at IS NULL")
            .map_err(|error| format!("准备创建时间迁移失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("查询待迁移单据失败：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("读取待迁移单据失败：{error}"))?
    };
    for (record_id, updated_at) in records {
        transaction
            .execute(
                "UPDATE records SET created_at=?1 WHERE id=?2",
                params![infer_record_created_at(&record_id, &updated_at), record_id],
            )
            .map_err(|error| format!("回填单据创建时间失败：{error}"))?;
    }
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC, id DESC)",
            [],
        )
        .map_err(|error| format!("创建单据时间索引失败：{error}"))?;
    transaction
        .pragma_update(
            None,
            "user_version",
            user_version.max(DATABASE_SCHEMA_VERSION),
        )
        .map_err(|error| format!("更新数据库版本失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交数据库升级失败：{error}"))
}

fn infer_record_created_at(record_id: &str, updated_at: &str) -> String {
    created_at_from_record_id(record_id)
        .or_else(|| normalize_record_timestamp(updated_at))
        .unwrap_or_else(|| updated_at.to_string())
}

fn created_at_from_record_id(record_id: &str) -> Option<String> {
    let timestamp = record_id.strip_prefix("record-")?.split_once('-')?.0;
    if timestamp.is_empty() || !timestamp.bytes().all(|value| value.is_ascii_digit()) {
        return None;
    }
    let milliseconds = timestamp.parse::<i128>().ok()?;
    let datetime =
        OffsetDateTime::from_unix_timestamp_nanos(milliseconds.checked_mul(1_000_000)?).ok()?;
    datetime
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .ok()
}

fn normalize_record_timestamp(value: &str) -> Option<String> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()?
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .ok()
}

pub fn quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| format!("数据库完整性检查失败：{error}"))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(format!("数据库完整性检查未通过：{result}"))
    }
}

pub fn validate_database_file(path: &Path) -> Result<(), String> {
    let connection = open_database_readonly_at(path)?;
    quick_check(&connection)?;
    let schema_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('records', 'expenses', 'attachments', 'image_blobs', 'app_meta')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("数据库结构检查失败：{error}"))?;
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("数据库版本检查失败：{error}"))?;
    if schema_tables != 5 || user_version < MIN_DATABASE_SCHEMA_VERSION {
        return Err("数据库结构不完整或版本不受支持".to_string());
    }
    if user_version >= DATABASE_SCHEMA_VERSION && !records_have_created_at(&connection)? {
        return Err("数据库缺少单据创建时间字段".to_string());
    }
    let foreign_key_error: Option<i64> = connection
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()
        .map_err(|error| format!("数据库外键检查失败：{error}"))?;
    if foreign_key_error.is_some() {
        return Err("数据库存在外键关系错误".to_string());
    }
    Ok(())
}

pub fn bootstrap_at_root(
    root: &Path,
    app: Option<&AppHandle>,
    allow_default_settings: bool,
) -> BootstrapResult {
    if let Err(error) = fs::create_dir_all(root) {
        return bootstrap_failure(
            root,
            "migrationFailed",
            error.to_string(),
            Vec::new(),
            false,
        );
    }
    let database = database_path(root);
    if !database.exists() {
        match resume_interrupted_database_activation(root) {
            Ok(_) => {}
            Err(error) => {
                return bootstrap_failure(
                    root,
                    "recoveryRequired",
                    format!("数据库恢复操作曾被中断：{error}"),
                    vec![database.to_string_lossy().into_owned()],
                    false,
                );
            }
        }
    }
    if database.exists() {
        return match open_database(root, false)
            .and_then(|connection| {
                quick_check(&connection)?;
                upgrade_database_schema(&connection)
            })
            .and_then(|_| validate_database_file(&database))
            .and_then(|_| {
                let connection = open_database_readonly_at(&database)?;
                validate_referenced_images(root, &connection, true)
            }) {
            Ok(()) => {
                let image_organization_warning = organize_images_by_record_at_root(root).err();
                let migrated_legacy_remains = open_database_readonly_at(&database)
                    .and_then(|connection| get_meta(&connection, "legacy_migrated_at"))
                    .ok()
                    .flatten()
                    .is_some()
                    && legacy_data_exists(root);
                let mut message = if migrated_legacy_remains {
                    archive_legacy_json(root).map_or_else(
                        |error| format!("本地数据库已就绪，但旧 JSON 归档未完成：{error}"),
                        |_| "本地数据库已就绪，已完成中断的旧 JSON 归档".to_string(),
                    )
                } else {
                    "本地数据库已就绪".to_string()
                };
                if let Some(error) = image_organization_warning {
                    message.push_str(&format!("，但按单据整理图片失败：{error}"));
                }
                BootstrapResult {
                    status: "ready".to_string(),
                    message,
                    data_directory: root.to_string_lossy().into_owned(),
                    migrated_records: 0,
                    migrated_expenses: 0,
                    migrated_attachments: 0,
                    corrupt_files: Vec::new(),
                    can_use_default_settings: false,
                    backup_scheduled: false,
                }
            }
            Err(error) => bootstrap_failure(
                root,
                "recoveryRequired",
                format!("主数据库损坏、无法读取或无法升级：{error}"),
                vec![database.to_string_lossy().into_owned()],
                false,
            ),
        };
    }

    if database_backup_exists(root) {
        return bootstrap_failure(
            root,
            "recoveryRequired",
            "主数据库不存在，但检测到历史数据库备份。为避免创建空工作区覆盖恢复入口，请选择备份恢复。"
                .to_string(),
            vec![database.to_string_lossy().into_owned()],
            false,
        );
    }

    if legacy_data_exists(root) {
        cleanup_interrupted_migrations(root);
        return migrate_legacy(root, app, allow_default_settings);
    }

    match open_database(root, true).and_then(|connection| {
        initialize_schema(&connection)?;
        quick_check(&connection)
    }) {
        Ok(()) => BootstrapResult {
            status: "ready".to_string(),
            message: "已创建本地数据库".to_string(),
            data_directory: root.to_string_lossy().into_owned(),
            migrated_records: 0,
            migrated_expenses: 0,
            migrated_attachments: 0,
            corrupt_files: Vec::new(),
            can_use_default_settings: false,
            backup_scheduled: false,
        },
        Err(error) => bootstrap_failure(root, "migrationFailed", error, Vec::new(), false),
    }
}

fn resume_interrupted_database_activation(root: &Path) -> Result<bool, String> {
    let mut candidates = fs::read_dir(root)
        .map_err(|error| format!("检查恢复临时文件失败：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!(".{DATABASE_FILE}.restore-"))
                        && name.ends_with(".tmp")
                })
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    let Some(candidate) = candidates
        .into_iter()
        .rev()
        .find(|path| validate_database_file(path).is_ok())
    else {
        return Ok(false);
    };

    let recovery_id = Uuid::new_v4().simple().to_string();
    for suffix in ["-wal", "-shm"] {
        let sidecar = root.join(format!("{DATABASE_FILE}{suffix}"));
        if sidecar.exists() {
            let preserved = root.join(format!(
                "recovery-preserved-interrupted-{recovery_id}-{DATABASE_FILE}{suffix}"
            ));
            fs::rename(&sidecar, &preserved)
                .map_err(|error| format!("保留中断恢复文件失败：{error}"))?;
        }
    }
    fs::rename(&candidate, database_path(root))
        .map_err(|error| format!("继续启用恢复数据库失败：{error}"))?;
    Ok(true)
}

fn database_backup_exists(root: &Path) -> bool {
    fs::read_dir(root.join(DATABASE_BACKUP_DIRECTORY))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .any(|path| {
            path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("db")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("SheepFinance-"))
        })
}

fn bootstrap_failure(
    root: &Path,
    status: &str,
    message: String,
    corrupt_files: Vec<String>,
    can_use_default_settings: bool,
) -> BootstrapResult {
    BootstrapResult {
        status: status.to_string(),
        message,
        data_directory: root.to_string_lossy().into_owned(),
        migrated_records: 0,
        migrated_expenses: 0,
        migrated_attachments: 0,
        corrupt_files,
        can_use_default_settings,
        backup_scheduled: false,
    }
}

fn legacy_data_exists(root: &Path) -> bool {
    root.join("workspace.json").exists()
        || root.join("workspace.bak").exists()
        || root.join("workspace.recovered.json").exists()
        || root.join("records").is_dir()
}

fn cleanup_interrupted_migrations(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && name.starts_with(".migration-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    for name in [
        "sheepfinance.db.migrating",
        "sheepfinance.db.migrating-wal",
        "sheepfinance.db.migrating-shm",
    ] {
        let path = root.join(name);
        if path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
}

fn emit_migration_progress(
    app: Option<&AppHandle>,
    stage: &str,
    current: usize,
    total: usize,
    message: impl Into<String>,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "storage-migration-progress",
            MigrationProgress {
                stage: stage.to_string(),
                current,
                total,
                message: message.into(),
            },
        );
    }
}

fn migrate_legacy(
    root: &Path,
    app: Option<&AppHandle>,
    allow_default_settings: bool,
) -> BootstrapResult {
    let record_files = legacy_record_files(root);
    let workspace_path = root.join("workspace.json");
    let workspace = match read_workspace_with_backup(&workspace_path) {
        Ok(value) => Some(value),
        Err(error) if allow_default_settings => {
            emit_migration_progress(
                app,
                "settings",
                0,
                record_files.len(),
                "工作区设置损坏，将仅恢复单据",
            );
            let _ = error;
            None
        }
        Err(error) => {
            return bootstrap_failure(
                root,
                "migrationFailed",
                format!("旧版工作区设置无法读取：{error}"),
                vec![
                    workspace_path.to_string_lossy().into_owned(),
                    workspace_path
                        .with_extension("bak")
                        .to_string_lossy()
                        .into_owned(),
                ],
                true,
            );
        }
    };

    if record_files.is_empty() && workspace.is_none() {
        return bootstrap_failure(
            root,
            "migrationFailed",
            "检测到旧版工作区，但未找到可迁移的设置或单据".to_string(),
            Vec::new(),
            false,
        );
    }

    let mut legacy_records = Vec::with_capacity(record_files.len());
    let mut corrupt_files = Vec::new();
    for path in &record_files {
        match read_legacy_record_with_backup(path) {
            Ok(value) => legacy_records.push((path.clone(), value)),
            Err(_) => {
                corrupt_files.push(path.to_string_lossy().into_owned());
                corrupt_files.push(path.with_extension("bak").to_string_lossy().into_owned());
            }
        }
    }
    if !corrupt_files.is_empty() {
        return bootstrap_failure(
            root,
            "migrationFailed",
            "部分单据的主文件和备份均已损坏，迁移已停止".to_string(),
            corrupt_files,
            false,
        );
    }

    let staging = root.join(format!(".migration-{}", Uuid::new_v4().simple()));
    if let Err(error) = fs::create_dir_all(&staging) {
        return bootstrap_failure(
            root,
            "migrationFailed",
            error.to_string(),
            Vec::new(),
            false,
        );
    }
    let staging_database = database_path(&staging);
    let result = (|| -> Result<(usize, usize, usize), String> {
        let mut connection = open_database_at(&staging_database, true)?;
        initialize_schema(&connection)?;
        let mut expense_count = 0usize;
        let mut attachment_count = 0usize;

        if let Some(workspace) = workspace.as_ref() {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开启设置迁移事务失败：{error}"))?;
            save_settings_tx(&transaction, workspace)?;
            transaction
                .commit()
                .map_err(|error| format!("提交设置迁移失败：{error}"))?;
        } else {
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开启默认设置事务失败：{error}"))?;
            save_settings_tx(&transaction, &default_workspace_settings())?;
            transaction
                .commit()
                .map_err(|error| format!("提交默认设置失败：{error}"))?;
        }

        for (index, (path, mut record)) in legacy_records.into_iter().enumerate() {
            emit_migration_progress(
                app,
                "records",
                index + 1,
                record_files.len(),
                format!(
                    "正在迁移 {}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ),
            );
            let converted = convert_legacy_record_images(&staging, &mut record)?;
            attachment_count += converted;
            expense_count += record
                .get("expenses")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            let transaction = connection
                .transaction()
                .map_err(|error| format!("开启单据迁移事务失败：{error}"))?;
            save_draft_tx(&transaction, &record)?;
            transaction
                .commit()
                .map_err(|error| format!("提交单据迁移失败：{error}"))?;
        }

        let transaction = connection
            .transaction()
            .map_err(|error| format!("开启迁移图片整理事务失败：{error}"))?;
        organize_images_by_record_tx(&staging, &transaction)?;
        transaction
            .commit()
            .map_err(|error| format!("提交迁移图片整理失败：{error}"))?;

        migrate_request_logs(&mut connection, root)?;
        if let Some(workspace) = workspace.as_ref() {
            let current = workspace
                .get("currentRecordId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !current.is_empty() {
                let exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
                        [current],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("检查当前单据失败：{error}"))?;
                if exists {
                    set_meta(&connection, "current_record_id", current)?;
                }
            }
        }
        set_meta(&connection, "storage_version", "2")?;
        set_meta(&connection, "legacy_migrated_at", &now_iso8601())?;
        quick_check(&connection)?;
        connection
            .execute_batch("PRAGMA foreign_key_check; PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("验证迁移数据失败：{error}"))?;
        drop(connection);
        verify_staged_images(&staging, &staging_database)?;
        Ok((record_files.len(), expense_count, attachment_count))
    })();

    let (record_count, expense_count, attachment_count) = match result {
        Ok(counts) => counts,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return bootstrap_failure(root, "migrationFailed", error, Vec::new(), false);
        }
    };

    emit_migration_progress(
        app,
        "activate",
        record_count,
        record_count,
        "正在启用新数据库",
    );
    if let Err(error) = merge_directory(&staging.join(IMAGE_DIRECTORY), &root.join(IMAGE_DIRECTORY))
    {
        let _ = fs::remove_dir_all(&staging);
        return bootstrap_failure(root, "migrationFailed", error, Vec::new(), false);
    }
    if let Err(error) = fs::rename(&staging_database, database_path(root)) {
        let _ = fs::remove_dir_all(&staging);
        return bootstrap_failure(
            root,
            "migrationFailed",
            format!("启用新数据库失败：{error}"),
            Vec::new(),
            false,
        );
    }
    let _ = fs::remove_dir_all(&staging);
    let archive_warning = archive_legacy_json(root).err();
    let message = archive_warning.map_or_else(
        || "旧版 JSON 已成功迁移并归档".to_string(),
        |error| format!("数据已迁移，但旧 JSON 归档失败：{error}"),
    );
    BootstrapResult {
        status: "migrated".to_string(),
        message,
        data_directory: root.to_string_lossy().into_owned(),
        migrated_records: record_count,
        migrated_expenses: expense_count,
        migrated_attachments: attachment_count,
        corrupt_files: Vec::new(),
        can_use_default_settings: false,
        backup_scheduled: true,
    }
}

fn legacy_record_files(root: &Path) -> Vec<PathBuf> {
    let records = root.join("records");
    let mut stems = BTreeSet::new();
    let Ok(entries) = fs::read_dir(&records) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let extension = path.extension().and_then(|value| value.to_str());
        if matches!(extension, Some("json" | "bak")) {
            if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
                stems.insert(stem.to_string());
            }
        }
    }
    stems
        .into_iter()
        .map(|stem| records.join(format!("{stem}.json")))
        .collect()
}

fn read_json_with_backup(path: &Path) -> Result<Value, String> {
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

fn read_workspace_with_backup(path: &Path) -> Result<Value, String> {
    match read_validated_json_with_backup(path, validate_workspace_json) {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let recovered = path.with_file_name("workspace.recovered.json");
            read_json(&recovered)
                .and_then(|value| {
                    validate_workspace_json(&value)?;
                    Ok(value)
                })
                .map_err(|recovered_error| {
                    format!(
                        "工作区主文件/备份错误：{primary_error}；恢复文件错误：{recovered_error}"
                    )
                })
        }
    }
}

fn validate_workspace_json(value: &Value) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "工作区根节点不是对象".to_string())?;
    if !object.contains_key("currentRecordId")
        && !object.contains_key("profiles")
        && !object.contains_key("dictionaries")
        && !object.contains_key("services")
    {
        return Err("工作区缺少必要设置字段".to_string());
    }
    Ok(())
}

fn read_legacy_record_with_backup(path: &Path) -> Result<Value, String> {
    read_validated_json_with_backup(path, |value| {
        let object = value
            .as_object()
            .ok_or_else(|| "单据根节点不是对象".to_string())?;
        required_id(object.get("id"), "旧版单据")?;
        let expenses = object
            .get("expenses")
            .and_then(Value::as_array)
            .ok_or_else(|| "旧版单据缺少费用列表".to_string())?;
        for expense in expenses {
            let expense = expense
                .as_object()
                .ok_or_else(|| "旧版费用项不是对象".to_string())?;
            required_id(expense.get("id"), "旧版费用项")?;
        }
        Ok(())
    })
}

fn read_validated_json_with_backup<F>(path: &Path, validate: F) -> Result<Value, String>
where
    F: Fn(&Value) -> Result<(), String>,
{
    let primary = read_json(path).and_then(|value| {
        validate(&value)?;
        Ok(value)
    });
    match primary {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let backup_path = path.with_extension("bak");
            read_json(&backup_path)
                .and_then(|value| {
                    validate(&value)?;
                    Ok(value)
                })
                .map_err(|backup_error| {
                    format!("主文件错误：{primary_error}；备份文件错误：{backup_error}")
                })
        }
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

fn convert_legacy_record_images(root: &Path, record: &mut Value) -> Result<usize, String> {
    let record_id = required_id(record.get("id"), "旧版单据")?.to_string();
    let expenses = record
        .get_mut("expenses")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "旧版单据缺少费用列表".to_string())?;
    let mut count = 0usize;
    for expense in expenses {
        let object = expense
            .as_object_mut()
            .ok_or_else(|| "旧版费用数据格式无效".to_string())?;
        if let Some(data_url) = object
            .get("imageDataUrl")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        {
            let width = json_u32(object.get("naturalWidth"));
            let height = json_u32(object.get("naturalHeight"));
            let original = store_data_url_blob(root, &record_id, &data_url, width, height)?;
            apply_blob_metadata(object, &original, "");
            count += 1;

            let original_size = original.size_bytes;
            if original_size > 8 * 1024 * 1024 {
                if let Some(recognition_url) = object
                    .get("recognitionImageDataUrl")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && *value != data_url)
                    .map(str::to_string)
                {
                    let recognition =
                        store_data_url_blob(root, &record_id, &recognition_url, width, height)?;
                    if recognition.hash != original.hash {
                        apply_blob_metadata(object, &recognition, "recognition");
                    }
                }
            }
        }
        object.remove("imageDataUrl");
        object.remove("recognitionImageDataUrl");

        if let Some(attachments) = object
            .get_mut("extraAttachments")
            .and_then(Value::as_array_mut)
        {
            for attachment in attachments {
                let attachment_object = attachment
                    .as_object_mut()
                    .ok_or_else(|| "旧版附加图片数据格式无效".to_string())?;
                if let Some(data_url) = attachment_object
                    .get("imageDataUrl")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                {
                    let width = json_u32(attachment_object.get("naturalWidth"));
                    let height = json_u32(attachment_object.get("naturalHeight"));
                    let blob = store_data_url_blob(root, &record_id, &data_url, width, height)?;
                    apply_blob_metadata(attachment_object, &blob, "");
                    count += 1;
                }
                attachment_object.remove("imageDataUrl");
            }
        }
    }
    Ok(count)
}

fn json_u32(value: Option<&Value>) -> u32 {
    value
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or_default()
}

fn apply_blob_metadata(object: &mut Map<String, Value>, blob: &BlobMetadata, prefix: &str) {
    let names = if prefix.is_empty() {
        (
            "blobHash",
            "mimeType",
            "blobExtension",
            "sizeBytes",
            "blobRelativePath",
        )
    } else {
        (
            "recognitionBlobHash",
            "recognitionMimeType",
            "recognitionBlobExtension",
            "recognitionSizeBytes",
            "recognitionBlobRelativePath",
        )
    };
    object.insert(names.0.to_string(), Value::String(blob.hash.clone()));
    object.insert(names.1.to_string(), Value::String(blob.mime_type.clone()));
    object.insert(names.2.to_string(), Value::String(blob.extension.clone()));
    object.insert(names.3.to_string(), Value::from(blob.size_bytes));
    object.insert(
        names.4.to_string(),
        Value::String(blob.relative_path.clone()),
    );
}

pub fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, String), String> {
    let (metadata, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "图片数据格式无效".to_string())?;
    let mime_type = metadata
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "图片必须为 Base64 数据".to_string())?;
    if !mime_type.starts_with("image/") {
        return Err("仅支持图片数据".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "图片 Base64 解码失败".to_string())?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    let detected = detect_image_type(&bytes)?;
    if detected.0 != mime_type && !(detected.0 == "image/jpeg" && mime_type == "image/jpg") {
        return Err("图片内容与声明格式不一致".to_string());
    }
    Ok((bytes, detected.0.to_string()))
}

pub fn detect_image_type(bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Ok(("image/jpeg", "jpg"))
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Ok(("image/png", "png"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok(("image/gif", "gif"))
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Ok(("image/webp", "webp"))
    } else if bytes.starts_with(b"BM") {
        Ok(("image/bmp", "bmp"))
    } else {
        Err("不支持或损坏的图片格式".to_string())
    }
}

pub fn store_image_bytes(
    root: &Path,
    record_id: &str,
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<BlobMetadata, String> {
    validate_record_id(record_id)?;
    let (mime_type, extension) = detect_image_type(bytes)?;
    let hash = hex::encode(Sha256::digest(bytes));
    let relative_path = record_image_relative_path(record_id, &hash, extension)?;
    let final_path = root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if final_path.exists() {
        let stored = fs::read(&final_path).map_err(|error| format!("读取已存图片失败：{error}"))?;
        if hex::encode(Sha256::digest(&stored)) != hash {
            return Err(format!("本地图片池文件已损坏：{}", final_path.display()));
        }
    } else {
        let parent = final_path
            .parent()
            .ok_or_else(|| "图片存储路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建图片目录失败：{error}"))?;
        let temporary = parent.join(format!(".{}.{}.tmp", hash, Uuid::new_v4().simple()));
        let mut file =
            fs::File::create(&temporary).map_err(|error| format!("创建临时图片失败：{error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("写入临时图片失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步临时图片失败：{error}"))?;
        drop(file);
        let stored = fs::read(&temporary).map_err(|error| format!("校验临时图片失败：{error}"))?;
        if hex::encode(Sha256::digest(&stored)) != hash {
            let _ = fs::remove_file(&temporary);
            return Err("临时图片哈希校验失败".to_string());
        }
        if let Err(error) = fs::rename(&temporary, &final_path) {
            if !final_path.exists() {
                let _ = fs::remove_file(&temporary);
                return Err(format!("提交图片文件失败：{error}"));
            }
            let _ = fs::remove_file(&temporary);
        }
    }
    Ok(BlobMetadata {
        hash,
        relative_path,
        extension: extension.to_string(),
        mime_type: mime_type.to_string(),
        size_bytes: bytes.len() as u64,
        width,
        height,
    })
}

fn store_data_url_blob(
    root: &Path,
    record_id: &str,
    data_url: &str,
    width: u32,
    height: u32,
) -> Result<BlobMetadata, String> {
    let (bytes, _) = decode_image_data_url(data_url)?;
    store_image_bytes(root, record_id, &bytes, width, height)
}

pub fn insert_blob(connection: &Connection, blob: &BlobMetadata) -> Result<(), String> {
    validate_blob_relative_path(&blob.hash, &blob.extension, &blob.relative_path)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO image_blobs
             (hash, relative_path, extension, mime_type, size_bytes, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                blob.hash,
                blob.relative_path,
                blob.extension,
                blob.mime_type,
                blob.size_bytes as i64,
                blob.width,
                blob.height,
                now_iso8601(),
            ],
        )
        .map_err(|error| format!("记录图片元数据失败：{error}"))?;
    Ok(())
}

pub fn image_path_for_hash(
    connection: &Connection,
    root: &Path,
    hash: &str,
) -> Result<PathBuf, String> {
    validate_hash(hash)?;
    let (relative, extension): (String, String) = connection
        .query_row(
            "SELECT relative_path, extension FROM image_blobs WHERE hash=?1",
            [hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "图片文件引用不存在".to_string())?;
    validate_blob_relative_path(hash, &extension, &relative)?;
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    ensure_path_inside(root, &path)?;
    Ok(path)
}

pub fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.len() == 64 && hash.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("图片哈希格式无效".to_string())
    }
}

pub fn validate_blob_relative_path(
    hash: &str,
    extension: &str,
    relative_path: &str,
) -> Result<(), String> {
    validate_hash(hash)?;
    if !matches!(extension, "jpg" | "png" | "gif" | "webp" | "bmp") {
        return Err("图片扩展名无效".to_string());
    }
    let legacy = format!("{IMAGE_DIRECTORY}/{}/{}.{}", &hash[..2], hash, extension);
    let parts = relative_path.split('/').collect::<Vec<_>>();
    let record_path_valid = parts.len() == 3
        && parts[0] == IMAGE_DIRECTORY
        && validate_record_id(parts[1]).is_ok()
        && parts[2] == format!("{hash}.{extension}");
    if relative_path == legacy || record_path_valid {
        Ok(())
    } else {
        Err("图片存储路径与哈希不匹配".to_string())
    }
}

pub fn record_image_relative_path(
    record_id: &str,
    hash: &str,
    extension: &str,
) -> Result<String, String> {
    validate_record_id(record_id)?;
    validate_hash(hash)?;
    if !matches!(extension, "jpg" | "png" | "gif" | "webp" | "bmp") {
        return Err("图片扩展名无效".to_string());
    }
    Ok(format!("{IMAGE_DIRECTORY}/{record_id}/{hash}.{extension}"))
}

pub fn ensure_path_inside(root: &Path, path: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("规范化应用数据目录失败：{error}"))?;
    let mut existing_ancestor = if path.exists() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| "文件路径缺少有效父目录".to_string())?;
    }
    let existing_ancestor = existing_ancestor
        .canonicalize()
        .map_err(|error| format!("规范化文件路径失败：{error}"))?;
    if existing_ancestor.starts_with(&root) {
        Ok(())
    } else {
        Err("文件路径超出应用数据目录".to_string())
    }
}

fn record_image_links(
    connection: &Connection,
) -> Result<Vec<(String, String, String, String)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT e.record_id, b.hash, b.relative_path, b.extension
             FROM attachments a
             JOIN expenses e ON e.id=a.expense_id
             JOIN image_blobs b ON b.hash=a.blob_hash
             UNION
             SELECT DISTINCT e.record_id, b.hash, b.relative_path, b.extension
             FROM attachments a
             JOIN expenses e ON e.id=a.expense_id
             JOIN image_blobs b ON b.hash=a.recognition_blob_hash
             WHERE a.recognition_blob_hash IS NOT NULL
             ORDER BY 1, 2",
        )
        .map_err(|error| format!("准备单据图片目录查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|error| format!("查询单据图片目录失败：{error}"))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|error| error.to_string())?);
    }
    Ok(result)
}

fn materialize_record_image(source: &Path, target: &Path, hash: &str) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    if target.exists() {
        let bytes = fs::read(target).map_err(|error| format!("读取单据图片失败：{error}"))?;
        if hex::encode(Sha256::digest(&bytes)) == hash {
            return Ok(());
        }
        return Err(format!("单据图片文件内容冲突：{}", target.display()));
    }

    let source_bytes = fs::read(source).map_err(|error| format!("读取原始图片失败：{error}"))?;
    if hex::encode(Sha256::digest(&source_bytes)) != hash {
        return Err(format!("原始图片哈希错误：{}", source.display()));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "单据图片目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建单据图片目录失败：{error}"))?;
    let temporary = parent.join(format!(".{hash}.{}.tmp", Uuid::new_v4().simple()));
    if fs::hard_link(source, &temporary).is_err() {
        let mut file =
            fs::File::create(&temporary).map_err(|error| format!("创建单据图片失败：{error}"))?;
        let write_result = file.write_all(&source_bytes).and_then(|_| file.sync_all());
        drop(file);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("写入单据图片失败：{error}"));
        }
    }
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        if !target.exists() {
            return Err(format!("提交单据图片失败：{error}"));
        }
        let bytes = fs::read(target).map_err(|read_error| read_error.to_string())?;
        if hex::encode(Sha256::digest(&bytes)) != hash {
            return Err(format!("单据图片文件内容冲突：{}", target.display()));
        }
    }
    Ok(())
}

fn organize_images_by_record_tx(root: &Path, transaction: &Transaction<'_>) -> Result<(), String> {
    let mut groups = HashMap::<String, (String, String, BTreeSet<String>)>::new();
    for (record_id, hash, relative_path, extension) in record_image_links(transaction)? {
        validate_record_id(&record_id)?;
        validate_blob_relative_path(&hash, &extension, &relative_path)?;
        let entry = groups
            .entry(hash)
            .or_insert_with(|| (relative_path, extension, BTreeSet::new()));
        entry.2.insert(record_id);
    }

    for (hash, (current_relative_path, extension, record_ids)) in groups {
        let source = root.join(current_relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        ensure_path_inside(root, &source)?;
        let mut preferred_relative_path = None;
        for record_id in record_ids {
            let relative_path = record_image_relative_path(&record_id, &hash, &extension)?;
            let target = root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            ensure_path_inside(root, &target)?;
            materialize_record_image(&source, &target, &hash)?;
            if current_relative_path == relative_path || preferred_relative_path.is_none() {
                preferred_relative_path = Some(relative_path);
            }
        }
        if let Some(relative_path) = preferred_relative_path {
            if relative_path != current_relative_path {
                transaction
                    .execute(
                        "UPDATE image_blobs SET relative_path=?1 WHERE hash=?2",
                        params![relative_path, hash],
                    )
                    .map_err(|error| format!("更新单据图片目录失败：{error}"))?;
            }
        }
    }
    Ok(())
}

fn organize_images_by_record_at_root(root: &Path) -> Result<(), String> {
    let mut connection = open_database(root, false)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启单据图片整理事务失败：{error}"))?;
    organize_images_by_record_tx(root, &transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("提交单据图片整理失败：{error}"))
}

pub fn record_image_path_for_hash(
    connection: &Connection,
    root: &Path,
    record_id: &str,
    hash: &str,
) -> Result<PathBuf, String> {
    validate_record_id(record_id)?;
    validate_hash(hash)?;
    let referenced: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM attachments a
                JOIN expenses e ON e.id=a.expense_id
                WHERE e.record_id=?1 AND (a.blob_hash=?2 OR a.recognition_blob_hash=?2)
             )",
            params![record_id, hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查单据图片关系失败：{error}"))?;
    if !referenced {
        return Err("该图片不属于指定报销单".to_string());
    }
    let (source_relative_path, extension): (String, String) = connection
        .query_row(
            "SELECT relative_path, extension FROM image_blobs WHERE hash=?1",
            [hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "图片文件引用不存在".to_string())?;
    validate_blob_relative_path(hash, &extension, &source_relative_path)?;
    let source = root.join(source_relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    ensure_path_inside(root, &source)?;
    let target_relative_path = record_image_relative_path(record_id, hash, &extension)?;
    let target = root.join(target_relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    ensure_path_inside(root, &target)?;
    materialize_record_image(&source, &target, hash)?;
    Ok(target)
}

pub fn save_workspace_at_root(root: &Path, request: SaveWorkspaceRequest) -> Result<(), String> {
    let mut connection = open_database(root, false)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启自动保存事务失败：{error}"))?;
    let saved = save_draft_tx(&transaction, &request.draft)?;
    if saved {
        save_workspace_settings_tx(
            &transaction,
            &request.profiles,
            &request.dictionaries,
            &request.services,
            &request.ui_preferences,
        )?;
        let record_id = request
            .draft
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "报销单缺少记录编号".to_string())?;
        set_meta_tx(&transaction, "current_record_id", record_id)?;
        set_meta_tx(&transaction, "storage_version", "2")?;
        organize_images_by_record_tx(root, &transaction)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交自动保存事务失败：{error}"))
}

fn save_draft_tx(transaction: &Transaction<'_>, raw_draft: &Value) -> Result<bool, String> {
    let mut draft = raw_draft.clone();
    strip_runtime_image_fields(&mut draft);
    let object = draft
        .as_object()
        .ok_or_else(|| "报销单数据格式无效".to_string())?;
    let id = required_id(object.get("id"), "报销单")?;
    let expenses = object
        .get("expenses")
        .and_then(Value::as_array)
        .ok_or_else(|| "报销单缺少费用列表".to_string())?;
    let total = object
        .get("totalOverrideCents")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| {
            expenses
                .iter()
                .filter_map(|expense| expense.get("amountCents").and_then(Value::as_i64))
                .sum()
        });
    let updated_at = string_field(object, "updatedAt");
    let updated_at = if updated_at.is_empty() {
        now_iso8601()
    } else {
        updated_at
    };
    let created_at = infer_record_created_at(id, &updated_at);
    let existing_updated_at: Option<String> = transaction
        .query_row("SELECT updated_at FROM records WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| format!("检查单据保存版本失败：{error}"))?;
    if existing_updated_at
        .as_deref()
        .is_some_and(|existing| timestamp_is_newer(existing, &updated_at))
    {
        return Ok(false);
    }
    let first_occurred_date = expenses
        .first()
        .and_then(|expense| expense.get("occurredDate"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let draft_json =
        serde_json::to_string(&draft).map_err(|error| format!("序列化报销单失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO records
             (id, label, status, company_name, applicant, reimbursement_date,
              first_occurred_date, expense_count, total_cents, created_at, updated_at, data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
              label=excluded.label, status=excluded.status, company_name=excluded.company_name,
              applicant=excluded.applicant, reimbursement_date=excluded.reimbursement_date,
              first_occurred_date=excluded.first_occurred_date,
              expense_count=excluded.expense_count, total_cents=excluded.total_cents,
              updated_at=excluded.updated_at, data_json=excluded.data_json",
            params![
                id,
                string_field(object, "label"),
                string_field_or(object, "status", "未报销"),
                string_field(object, "companyName"),
                string_field(object, "applicant"),
                string_field(object, "reimbursementDate"),
                first_occurred_date,
                expenses.len() as i64,
                total,
                created_at,
                updated_at,
                draft_json,
            ],
        )
        .map_err(|error| format!("保存报销单失败：{error}"))?;
    transaction
        .execute("DELETE FROM expenses WHERE record_id=?1", [id])
        .map_err(|error| format!("更新费用明细失败：{error}"))?;

    for (index, expense) in expenses.iter().enumerate() {
        save_expense_tx(transaction, id, index, expense)?;
    }
    Ok(true)
}

fn timestamp_is_newer(existing: &str, candidate: &str) -> bool {
    match (
        OffsetDateTime::parse(existing, &Rfc3339),
        OffsetDateTime::parse(candidate, &Rfc3339),
    ) {
        (Ok(existing), Ok(candidate)) => existing > candidate,
        _ => existing > candidate,
    }
}

fn save_expense_tx(
    transaction: &Transaction<'_>,
    record_id: &str,
    index: usize,
    expense: &Value,
) -> Result<(), String> {
    let object = expense
        .as_object()
        .ok_or_else(|| "费用明细数据格式无效".to_string())?;
    let expense_id = required_id(object.get("id"), "费用明细")?;
    let data_json =
        serde_json::to_string(expense).map_err(|error| format!("序列化费用明细失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO expenses
             (id, record_id, sort_order, occurred_date, reason, description, arranger, amount_cents, data_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                expense_id,
                record_id,
                index as i64,
                string_field(object, "occurredDate"),
                string_field(object, "reason"),
                string_field(object, "description"),
                string_field(object, "arranger"),
                object.get("amountCents").and_then(Value::as_i64).unwrap_or(0),
                data_json,
            ],
        )
        .map_err(|error| format!("保存费用明细失败：{error}"))?;

    if object
        .get("blobHash")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        save_attachment_tx(transaction, expense_id, "primary", 0, object)?;
    }
    if let Some(attachments) = object.get("extraAttachments").and_then(Value::as_array) {
        for (attachment_index, attachment) in attachments.iter().enumerate() {
            let attachment_object = attachment
                .as_object()
                .ok_or_else(|| "附加图片数据格式无效".to_string())?;
            save_attachment_tx(
                transaction,
                expense_id,
                "extra",
                attachment_index,
                attachment_object,
            )?;
        }
    }
    Ok(())
}

fn save_attachment_tx(
    transaction: &Transaction<'_>,
    expense_id: &str,
    kind: &str,
    index: usize,
    object: &Map<String, Value>,
) -> Result<(), String> {
    let id = if kind == "primary" {
        expense_id.to_string()
    } else {
        required_id(object.get("id"), "附加图片")?.to_string()
    };
    let hash = object
        .get("blobHash")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("图片 {id} 缺少本地文件引用"))?;
    validate_hash(hash)?;
    let recognition_hash = object
        .get("recognitionBlobHash")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(value) = recognition_hash {
        validate_hash(value)?;
    }
    ensure_blob_row_from_object(transaction, hash, object, "")?;
    if let Some(value) = recognition_hash {
        ensure_blob_row_from_object(transaction, value, object, "recognition")?;
    }
    let transform = serde_json::to_string(object.get("transform").unwrap_or(&json!({})))
        .map_err(|error| format!("序列化图片布局失败：{error}"))?;
    transaction
        .execute(
            "INSERT INTO attachments
             (id, expense_id, kind, sort_order, file_name, blob_hash, recognition_blob_hash,
              natural_width, natural_height, transform_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                id,
                expense_id,
                kind,
                index as i64,
                string_field(object, "fileName"),
                hash,
                recognition_hash,
                object
                    .get("naturalWidth")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                object
                    .get("naturalHeight")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                transform,
            ],
        )
        .map_err(|error| format!("保存图片关系失败：{error}"))?;
    Ok(())
}

fn ensure_blob_row_from_object(
    transaction: &Transaction<'_>,
    hash: &str,
    object: &Map<String, Value>,
    prefix: &str,
) -> Result<(), String> {
    let existing: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM image_blobs WHERE hash=?1)",
            [hash],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查图片引用失败：{error}"))?;
    if existing {
        return Ok(());
    }
    let (mime_key, extension_key, size_key, relative_path_key) = if prefix.is_empty() {
        ("mimeType", "blobExtension", "sizeBytes", "blobRelativePath")
    } else {
        (
            "recognitionMimeType",
            "recognitionBlobExtension",
            "recognitionSizeBytes",
            "recognitionBlobRelativePath",
        )
    };
    let mime_type = object
        .get(mime_key)
        .and_then(Value::as_str)
        .unwrap_or("image/jpeg");
    let extension = object
        .get(extension_key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| extension_for_mime(mime_type));
    let relative_path = object
        .get(relative_path_key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{IMAGE_DIRECTORY}/{}/{}.{}", &hash[..2], hash, extension));
    validate_blob_relative_path(hash, extension, &relative_path)?;
    transaction
        .execute(
            "INSERT INTO image_blobs
             (hash, relative_path, extension, mime_type, size_bytes, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                hash,
                relative_path,
                extension,
                mime_type,
                object.get(size_key).and_then(Value::as_i64).unwrap_or(0),
                object
                    .get("naturalWidth")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                object
                    .get("naturalHeight")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                now_iso8601(),
            ],
        )
        .map_err(|error| format!("补全图片元数据失败：{error}"))?;
    Ok(())
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "jpg",
    }
}

fn strip_runtime_image_fields(value: &mut Value) {
    if let Some(expenses) = value.get_mut("expenses").and_then(Value::as_array_mut) {
        for expense in expenses {
            if let Some(object) = expense.as_object_mut() {
                object.remove("imageDataUrl");
                object.remove("recognitionImageDataUrl");
                if let Some(attachments) = object
                    .get_mut("extraAttachments")
                    .and_then(Value::as_array_mut)
                {
                    for attachment in attachments {
                        if let Some(attachment) = attachment.as_object_mut() {
                            attachment.remove("imageDataUrl");
                        }
                    }
                }
            }
        }
    }
}

fn required_id<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label}缺少编号"))?;
    validate_record_id(value)?;
    Ok(value)
}

pub fn validate_record_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Err("本地记录编号格式无效".to_string())
    } else {
        Ok(())
    }
}

fn string_field(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string_field_or(object: &Map<String, Value>, key: &str, fallback: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn save_settings_tx(transaction: &Transaction<'_>, workspace: &Value) -> Result<(), String> {
    save_workspace_settings_tx(
        transaction,
        workspace
            .get("profiles")
            .unwrap_or(&Value::Array(Vec::new())),
        workspace.get("dictionaries").unwrap_or(&json!({})),
        workspace.get("services").unwrap_or(&json!({})),
        workspace.get("uiPreferences").unwrap_or(&json!({})),
    )
}

fn default_workspace_settings() -> Value {
    json!({
        "profiles": [{
            "id":"default-profile", "name":"默认申请人", "applicant":"",
            "department":"", "payeeName":"", "account":"", "bank":"", "isDefault":true
        }],
        "dictionaries": {
            "companies":["xxxx有限公司"],
            "reasons":["办公费","招待费","差旅费","固定资产"],
            "arrangers":["王董","张英姿","解柳婷","用户自行选择"],
            "defaultCompany":"xxxx有限公司", "defaultReason":"办公费", "defaultArranger":"王董"
        },
        "services": {
            "ocrProfiles":[{
                "id":"aliyun-default", "name":"阿里云 OCR",
                "endpoint":"https://ocr-api.cn-hangzhou.aliyuncs.com", "region":"cn-hangzhou",
                "accessKeyId":"", "accessKeySecret":"", "timeoutSeconds":30, "isDefault":true
            }],
            "llmProfiles":[{
                "id":"deepseek-default", "name":"DeepSeek", "baseUrl":"https://api.deepseek.com/v1",
                "apiKey":"", "model":"deepseek-v4-flash", "timeoutSeconds":30,
                "multimodal":false, "isDefault":true
            }]
        },
        "uiPreferences": {}
    })
}

fn save_workspace_settings_tx(
    transaction: &Transaction<'_>,
    profiles: &Value,
    dictionaries: &Value,
    services: &Value,
    ui_preferences: &Value,
) -> Result<(), String> {
    replace_json_profiles(transaction, "profiles", profiles)?;
    replace_dictionaries(transaction, dictionaries)?;
    replace_json_profiles(
        transaction,
        "ocr_profiles",
        services
            .get("ocrProfiles")
            .unwrap_or(&Value::Array(Vec::new())),
    )?;
    replace_json_profiles(
        transaction,
        "llm_profiles",
        services
            .get("llmProfiles")
            .unwrap_or(&Value::Array(Vec::new())),
    )?;
    transaction
        .execute("DELETE FROM ui_preferences", [])
        .map_err(|error| format!("更新界面设置失败：{error}"))?;
    if let Some(object) = ui_preferences.as_object() {
        for (key, value) in object {
            transaction
                .execute(
                    "INSERT INTO ui_preferences(key, value_json) VALUES (?1, ?2)",
                    params![key, value.to_string()],
                )
                .map_err(|error| format!("保存界面设置失败：{error}"))?;
        }
    }
    Ok(())
}

fn replace_json_profiles(
    transaction: &Transaction<'_>,
    table: &str,
    values: &Value,
) -> Result<(), String> {
    if !matches!(table, "profiles" | "ocr_profiles" | "llm_profiles") {
        return Err("设置表名无效".to_string());
    }
    transaction
        .execute(&format!("DELETE FROM {table}"), [])
        .map_err(|error| format!("更新配置列表失败：{error}"))?;
    for (index, item) in values.as_array().into_iter().flatten().enumerate() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| validate_record_id(value).is_ok())
            .map(str::to_string)
            .unwrap_or_else(|| format!("migrated-{table}-{index}"));
        let is_default = item
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        transaction
            .execute(
                &format!(
                    "INSERT INTO {table}(id, sort_order, is_default, data_json) VALUES (?1, ?2, ?3, ?4)"
                ),
                params![id, index as i64, is_default, item.to_string()],
            )
            .map_err(|error| format!("保存配置列表失败：{error}"))?;
    }
    Ok(())
}

fn replace_dictionaries(transaction: &Transaction<'_>, value: &Value) -> Result<(), String> {
    transaction
        .execute("DELETE FROM dictionary_items", [])
        .map_err(|error| format!("更新字典失败：{error}"))?;
    for (kind, list_key, default_key) in [
        ("company", "companies", "defaultCompany"),
        ("reason", "reasons", "defaultReason"),
        ("arranger", "arrangers", "defaultArranger"),
    ] {
        let default_value = value
            .get(default_key)
            .and_then(Value::as_str)
            .unwrap_or_default();
        for (index, item) in value
            .get(list_key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .enumerate()
        {
            transaction
                .execute(
                    "INSERT INTO dictionary_items(kind, value, sort_order, is_default)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![kind, item, index as i64, item == default_value],
                )
                .map_err(|error| format!("保存字典项失败：{error}"))?;
        }
    }
    Ok(())
}

pub fn load_workspace_at_root(root: &Path) -> Result<LoadedWorkspace, String> {
    let connection = open_database(root, false)?;
    let indexed_current = get_meta(&connection, "current_record_id")?;
    let current_record_id = indexed_current
        .filter(|record_id| {
            connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM records WHERE id=?1)",
                    [record_id],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
        })
        .or_else(|| {
            connection
                .query_row(
                    "SELECT id FROM records ORDER BY updated_at DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .ok()
                .flatten()
        });
    let draft = current_record_id
        .as_deref()
        .map(|record_id| load_record_from_connection(&connection, record_id))
        .transpose()?;
    let profiles = load_json_profiles(&connection, "profiles")?;
    let ocr_profiles = load_json_profiles(&connection, "ocr_profiles")?;
    let llm_profiles = load_json_profiles(&connection, "llm_profiles")?;
    let dictionaries = load_dictionaries(&connection)?;
    let ui_preferences = load_ui_preferences(&connection)?;
    let history = Value::Array(
        query_history_records(
            &connection,
            &HistoryQuery {
                page: 1,
                page_size: 10_000,
                ..HistoryQuery::default()
            },
        )?
        .0
        .into_iter()
        .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
        .collect(),
    );
    Ok(LoadedWorkspace {
        draft,
        profiles,
        dictionaries,
        services: json!({ "ocrProfiles": ocr_profiles, "llmProfiles": llm_profiles }),
        history,
        ui_preferences,
        data_directory: root.to_string_lossy().into_owned(),
    })
}

pub fn load_record_at_root(root: &Path, record_id: &str) -> Result<Value, String> {
    validate_record_id(record_id)?;
    let connection = open_database(root, false)?;
    load_record_from_connection(&connection, record_id)
}

fn load_record_from_connection(connection: &Connection, record_id: &str) -> Result<Value, String> {
    let data: String = connection
        .query_row(
            "SELECT data_json FROM records WHERE id=?1",
            [record_id],
            |row| row.get(0),
        )
        .map_err(|_| "历史报销单不存在".to_string())?;
    serde_json::from_str(&data).map_err(|error| format!("解析报销单失败：{error}"))
}

fn load_json_profiles(connection: &Connection, table: &str) -> Result<Value, String> {
    if !matches!(table, "profiles" | "ocr_profiles" | "llm_profiles") {
        return Err("设置表名无效".to_string());
    }
    let mut statement = connection
        .prepare(&format!(
            "SELECT data_json FROM {table} ORDER BY sort_order"
        ))
        .map_err(|error| format!("读取配置列表失败：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询配置列表失败：{error}"))?;
    let mut values = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        values.push(serde_json::from_str(&raw).map_err(|error| error.to_string())?);
    }
    Ok(Value::Array(values))
}

fn load_dictionaries(connection: &Connection) -> Result<Value, String> {
    let mut result = json!({
        "companies": [], "reasons": [], "arrangers": [],
        "defaultCompany": "", "defaultReason": "", "defaultArranger": ""
    });
    for (kind, list_key, default_key) in [
        ("company", "companies", "defaultCompany"),
        ("reason", "reasons", "defaultReason"),
        ("arranger", "arrangers", "defaultArranger"),
    ] {
        let mut statement = connection
            .prepare(
                "SELECT value, is_default FROM dictionary_items WHERE kind=?1 ORDER BY sort_order",
            )
            .map_err(|error| format!("读取字典失败：{error}"))?;
        let rows = statement
            .query_map([kind], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
            })
            .map_err(|error| format!("查询字典失败：{error}"))?;
        let mut values = Vec::new();
        let mut default_value = String::new();
        for row in rows {
            let (value, is_default) = row.map_err(|error| error.to_string())?;
            if is_default {
                default_value = value.clone();
            }
            values.push(Value::String(value));
        }
        result[list_key] = Value::Array(values);
        result[default_key] = Value::String(default_value);
    }
    Ok(result)
}

fn load_ui_preferences(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare("SELECT key, value_json FROM ui_preferences")
        .map_err(|error| format!("读取界面设置失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("查询界面设置失败：{error}"))?;
    let mut result = Map::new();
    for row in rows {
        let (key, raw) = row.map_err(|error| error.to_string())?;
        result.insert(
            key,
            serde_json::from_str(&raw).map_err(|error| error.to_string())?,
        );
    }
    Ok(Value::Object(result))
}

pub fn delete_record_at_root(root: &Path, record_id: &str) -> Result<(), String> {
    validate_record_id(record_id)?;
    let connection = open_database(root, false)?;
    connection
        .execute("DELETE FROM records WHERE id=?1", [record_id])
        .map_err(|error| format!("删除本地记录失败：{error}"))?;
    if get_meta(&connection, "current_record_id")?.as_deref() == Some(record_id) {
        connection
            .execute("DELETE FROM app_meta WHERE key='current_record_id'", [])
            .map_err(|error| format!("更新当前单据失败：{error}"))?;
    }
    Ok(())
}

pub fn update_record_status_at_root(
    root: &Path,
    record_id: &str,
    status: &str,
) -> Result<(), String> {
    validate_record_id(record_id)?;
    if !matches!(status, "未报销" | "报销中" | "已报销") {
        return Err("报销状态无效".to_string());
    }
    let connection = open_database(root, false)?;
    let mut draft = load_record_from_connection(&connection, record_id)?;
    draft["status"] = Value::String(status.to_string());
    draft["updatedAt"] = Value::String(now_iso8601());
    let object = draft
        .as_object()
        .ok_or_else(|| "报销单数据格式无效".to_string())?;
    connection
        .execute(
            "UPDATE records SET status=?1, updated_at=?2, data_json=?3 WHERE id=?4",
            params![
                status,
                string_field(object, "updatedAt"),
                draft.to_string(),
                record_id
            ],
        )
        .map_err(|error| format!("更新报销状态失败：{error}"))?;
    Ok(())
}

pub fn query_history_at_root(
    root: &Path,
    query: HistoryQuery,
) -> Result<HistoryQueryResult, String> {
    let connection = open_database(root, false)?;
    let (items, total) = query_history_records(&connection, &query)?;
    Ok(HistoryQueryResult { items, total })
}

fn query_history_records(
    connection: &Connection,
    query: &HistoryQuery,
) -> Result<(Vec<HistoryRecord>, i64), String> {
    let mut conditions = Vec::new();
    let mut values = Vec::<String>::new();
    if !query.keyword.trim().is_empty() {
        conditions.push("(label LIKE ? OR company_name LIKE ? OR applicant LIKE ? OR id LIKE ?)");
        let keyword = format!("%{}%", query.keyword.trim());
        values.extend([keyword.clone(), keyword.clone(), keyword.clone(), keyword]);
    }
    if !query.date.is_empty() {
        conditions.push("substr(first_occurred_date, 1, 10)=?");
        values.push(query.date.clone());
    }
    if !query.status.is_empty() {
        conditions.push("status=?");
        values.push(query.status.clone());
    }
    if query.folder_kind == "company" {
        conditions.push("company_name=?");
        values.push(query.folder_key.clone());
    } else if query.folder_kind == "status" {
        conditions.push("status=?");
        values.push(query.folder_key.clone());
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let count_sql = format!("SELECT COUNT(*) FROM records{where_sql}");
    let total: i64 = connection
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(values.iter()),
            |row| row.get(0),
        )
        .map_err(|error| format!("统计历史记录失败：{error}"))?;
    let page = query.page.max(1);
    let page_size = query.page_size.clamp(1, 10_000);
    let offset = (page - 1) * page_size;
    let sql = format!(
        "SELECT id, label, status, company_name, applicant, reimbursement_date,
         expense_count, total_cents, first_occurred_date, updated_at
         FROM records{where_sql} ORDER BY created_at DESC, id DESC LIMIT {page_size} OFFSET {offset}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("准备历史记录查询失败：{error}"))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok(HistoryRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                status: row.get(2)?,
                company_name: row.get(3)?,
                applicant: row.get(4)?,
                reimbursement_date: row.get(5)?,
                expense_count: row.get(6)?,
                total_cents: row.get(7)?,
                first_occurred_date: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| format!("查询历史记录失败：{error}"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| error.to_string())?);
    }
    Ok((items, total))
}

fn set_meta(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO app_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(|error| format!("保存应用元数据失败：{error}"))?;
    Ok(())
}

fn set_meta_tx(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO app_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(|error| format!("保存应用元数据失败：{error}"))?;
    Ok(())
}

pub fn get_meta(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT value FROM app_meta WHERE key=?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| format!("读取应用元数据失败：{error}"))
}

fn migrate_request_logs(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let path = root.join("request-records.json");
    if !path.exists() && !path.with_extension("bak").exists() {
        return Ok(());
    }
    let records = read_json_with_backup(&path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开启请求记录迁移失败：{error}"))?;
    for record in records.as_array().into_iter().flatten() {
        let object = record.as_object().cloned().unwrap_or_default();
        transaction
            .execute(
                "INSERT OR REPLACE INTO request_logs
                 (id, service, record_id, expense_id, file_name, profile_name, model, action,
                  request_url, requested_at, duration_ms, http_status, success, error,
                  request_content, response_content)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    string_field(&object, "id"),
                    string_field(&object, "service"),
                    string_field(&object, "recordId"),
                    string_field(&object, "expenseId"),
                    string_field(&object, "fileName"),
                    string_field(&object, "profileName"),
                    object.get("model").and_then(Value::as_str),
                    object.get("action").and_then(Value::as_str),
                    string_field(&object, "requestUrl"),
                    string_field(&object, "requestedAt"),
                    object
                        .get("durationMs")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                    object.get("httpStatus").and_then(Value::as_i64),
                    object
                        .get("success")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    object.get("error").and_then(Value::as_str),
                    string_field(&object, "requestContent"),
                    object.get("responseContent").and_then(Value::as_str),
                ],
            )
            .map_err(|error| format!("迁移请求记录失败：{error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("提交请求记录迁移失败：{error}"))
}

fn verify_staged_images(root: &Path, database: &Path) -> Result<(), String> {
    let connection = open_database_at(database, false)?;
    let mut statement = connection
        .prepare("SELECT hash, relative_path, extension FROM image_blobs")
        .map_err(|error| format!("准备图片校验失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("查询图片校验列表失败：{error}"))?;
    for row in rows {
        let (expected_hash, relative_path, extension) = row.map_err(|error| error.to_string())?;
        validate_blob_relative_path(&expected_hash, &extension, &relative_path)?;
        let path = root.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        ensure_path_inside(root, &path)?;
        let bytes =
            fs::read(&path).map_err(|error| format!("迁移图片缺失 {}: {error}", path.display()))?;
        let actual_hash = hex::encode(Sha256::digest(bytes));
        if actual_hash != expected_hash {
            return Err(format!("迁移图片哈希错误：{}", path.display()));
        }
    }
    Ok(())
}

fn merge_directory(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| format!("创建图片池失败：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            merge_directory(&source_path, &target_path)?;
        } else if target_path.exists() {
            let source_bytes =
                fs::read(&source_path).map_err(|error| format!("读取迁移图片失败：{error}"))?;
            let target_bytes =
                fs::read(&target_path).map_err(|error| format!("读取已有图片失败：{error}"))?;
            if Sha256::digest(&source_bytes) != Sha256::digest(&target_bytes) {
                return Err(format!("本地图片池存在内容冲突：{}", target_path.display()));
            }
        } else {
            fs::rename(&source_path, &target_path)
                .map_err(|error| format!("启用迁移图片失败：{error}"))?;
        }
    }
    Ok(())
}

fn archive_legacy_json(root: &Path) -> Result<PathBuf, String> {
    let timestamp = OffsetDateTime::now_utc()
        .format(format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string());
    let archive = root.join(format!("legacy-json-{timestamp}"));
    fs::create_dir_all(&archive).map_err(|error| format!("创建旧数据归档目录失败：{error}"))?;
    for name in [
        "workspace.json",
        "workspace.bak",
        "workspace.recovered.json",
        "request-records.json",
        "request-records.bak",
    ] {
        let source = root.join(name);
        if source.exists() {
            fs::rename(&source, archive.join(name))
                .map_err(|error| format!("归档 {name} 失败：{error}"))?;
        }
    }
    let records = root.join("records");
    if records.exists() {
        fs::rename(&records, archive.join("records"))
            .map_err(|error| format!("归档旧单据目录失败：{error}"))?;
    }
    Ok(archive)
}

pub fn referenced_hashes(connection: &Connection) -> Result<BTreeSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT blob_hash FROM attachments
             UNION SELECT recognition_blob_hash FROM attachments WHERE recognition_blob_hash IS NOT NULL",
        )
        .map_err(|error| format!("准备图片引用查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询图片引用失败：{error}"))?;
    let mut result = BTreeSet::new();
    for row in rows {
        result.insert(row.map_err(|error| error.to_string())?);
    }
    Ok(result)
}

pub fn referenced_image_paths(connection: &Connection) -> Result<BTreeSet<String>, String> {
    let manifest = image_manifest(connection)?;
    let mut paths = BTreeSet::new();
    for hash in referenced_hashes(connection)? {
        let blob = manifest
            .get(&hash)
            .ok_or_else(|| format!("数据库缺少图片元数据：{hash}"))?;
        validate_blob_relative_path(&hash, &blob.extension, &blob.relative_path)?;
        paths.insert(blob.relative_path.clone());
    }
    for (record_id, hash, _, extension) in record_image_links(connection)? {
        paths.insert(record_image_relative_path(&record_id, &hash, &extension)?);
    }
    Ok(paths)
}

pub fn image_manifest(connection: &Connection) -> Result<HashMap<String, BlobMetadata>, String> {
    let mut statement = connection
        .prepare(
            "SELECT hash, relative_path, extension, mime_type, size_bytes, width, height FROM image_blobs",
        )
        .map_err(|error| format!("准备图片清单查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(BlobMetadata {
                hash: row.get(0)?,
                relative_path: row.get(1)?,
                extension: row.get(2)?,
                mime_type: row.get(3)?,
                size_bytes: row.get::<_, i64>(4)? as u64,
                width: row.get(5)?,
                height: row.get(6)?,
            })
        })
        .map_err(|error| format!("查询图片清单失败：{error}"))?;
    let mut result = HashMap::new();
    for row in rows {
        let blob = row.map_err(|error| error.to_string())?;
        result.insert(blob.hash.clone(), blob);
    }
    Ok(result)
}

pub fn validate_referenced_images(
    root: &Path,
    connection: &Connection,
    verify_hash: bool,
) -> Result<(), String> {
    let manifest = image_manifest(connection)?;
    for hash in referenced_hashes(connection)? {
        let blob = manifest
            .get(&hash)
            .ok_or_else(|| format!("数据库缺少图片元数据：{hash}"))?;
        validate_blob_relative_path(&hash, &blob.extension, &blob.relative_path)?;
        let path = root.join(
            blob.relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        ensure_path_inside(root, &path)?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("数据库引用的图片缺失 {}: {error}", path.display()))?;
        if bytes.len() as u64 != blob.size_bytes {
            return Err(format!("数据库引用的图片大小错误：{}", path.display()));
        }
        if verify_hash && hex::encode(Sha256::digest(&bytes)) != hash {
            return Err(format!("数据库引用的图片哈希错误：{}", path.display()));
        }
    }
    Ok(())
}

pub fn load_profile_json(
    connection: &Connection,
    table: &str,
    requested_id: Option<&str>,
) -> Result<Value, String> {
    if !matches!(table, "ocr_profiles" | "llm_profiles") {
        return Err("服务配置表名无效".to_string());
    }
    let sql = if requested_id.is_some() {
        format!("SELECT data_json FROM {table} WHERE id=?1")
    } else {
        format!("SELECT data_json FROM {table} ORDER BY is_default DESC, sort_order ASC LIMIT 1")
    };
    let raw: Option<String> = if let Some(id) = requested_id {
        connection
            .query_row(&sql, [id], |row| row.get(0))
            .optional()
            .map_err(|error| format!("读取服务配置失败：{error}"))?
    } else {
        connection
            .query_row(&sql, [], |row| row.get(0))
            .optional()
            .map_err(|error| format!("读取默认服务配置失败：{error}"))?
    };
    let raw = raw.ok_or_else(|| "未找到可用的服务配置".to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("解析服务配置失败：{error}"))
}

pub fn load_dictionary_values(connection: &Connection, kind: &str) -> Result<Vec<String>, String> {
    if !matches!(kind, "company" | "reason" | "arranger") {
        return Err("字典类型无效".to_string());
    }
    let mut statement = connection
        .prepare("SELECT value FROM dictionary_items WHERE kind=?1 ORDER BY sort_order")
        .map_err(|error| format!("读取字典失败：{error}"))?;
    let rows = statement
        .query_map([kind], |row| row.get::<_, String>(0))
        .map_err(|error| format!("查询字典失败：{error}"))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|error| error.to_string())?);
    }
    Ok(result)
}

pub fn recognition_blob(
    connection: &Connection,
    attachment_id: &str,
) -> Result<(String, String), String> {
    validate_record_id(attachment_id)?;
    connection
        .query_row(
            "SELECT COALESCE(recognition_blob_hash, blob_hash), file_name
             FROM attachments WHERE id=?1",
            [attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "识别图片引用不存在，请先保存单据".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sheepfinance-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn schema_enables_safety_pragmas() {
        let root = temporary_root("schema");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            DATABASE_SCHEMA_VERSION
        );
        assert!(records_have_created_at(&connection).unwrap());
        quick_check(&connection).unwrap();
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_query_accepts_null_optional_filters() {
        let query: HistoryQuery = serde_json::from_value(json!({
            "keyword": null,
            "date": null,
            "status": null,
            "folderKind": null,
            "folderKey": null
        }))
        .unwrap();
        assert!(query.keyword.is_empty());
        assert!(query.date.is_empty());
        assert!(query.status.is_empty());
        assert!(query.folder_kind.is_empty());
        assert!(query.folder_key.is_empty());
        assert_eq!(query.page, 1);
        assert_eq!(query.page_size, 20);
    }

    #[test]
    fn database_upgrade_backfills_record_creation_time() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE records (
                    id TEXT PRIMARY KEY,
                    updated_at TEXT NOT NULL,
                    data_json TEXT NOT NULL
                 );
                 INSERT INTO records(id, updated_at, data_json)
                 VALUES
                    ('record-0-from-id', '2026-09-02T10:00:00.000Z', '{}'),
                    ('legacy-record', '2026-09-02T11:22:33.000Z', '{}');
                 PRAGMA user_version = 2;",
            )
            .unwrap();

        upgrade_database_schema(&connection).unwrap();

        let from_id: String = connection
            .query_row(
                "SELECT created_at FROM records WHERE id='record-0-from-id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let fallback: String = connection
            .query_row(
                "SELECT created_at FROM records WHERE id='legacy-record'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(from_id, "1970-01-01T00:00:00.000Z");
        assert_eq!(fallback, "2026-09-02T11:22:33.000Z");
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            DATABASE_SCHEMA_VERSION
        );
    }

    #[test]
    fn history_order_stays_by_creation_time_after_edit_and_status_change() {
        let root = temporary_root("history-created-order");
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        let save_record =
            |connection: &mut Connection, record_id: &str, label: &str, updated_at: &str| {
                let transaction = connection.transaction().unwrap();
                save_draft_tx(
                    &transaction,
                    &json!({
                        "id": record_id,
                        "label": label,
                        "status": "未报销",
                        "updatedAt": updated_at,
                        "expenses": []
                    }),
                )
                .unwrap();
                transaction.commit().unwrap();
            };
        let older_id = "record-1767225600000-older";
        let newer_id = "record-1767312000000-newer";
        save_record(
            &mut connection,
            older_id,
            "较早创建",
            "2026-01-01T00:00:00.000Z",
        );
        save_record(
            &mut connection,
            newer_id,
            "较晚创建",
            "2026-01-02T00:00:00.000Z",
        );

        save_record(
            &mut connection,
            older_id,
            "较早创建但刚编辑",
            "2026-09-03T08:00:00.000Z",
        );
        let history_query = HistoryQuery {
            page: 1,
            page_size: 20,
            ..HistoryQuery::default()
        };
        let records = query_history_records(&connection, &history_query)
            .unwrap()
            .0;
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec![newer_id, older_id]
        );
        let older_created_at: String = connection
            .query_row(
                "SELECT created_at FROM records WHERE id=?1",
                [older_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(older_created_at, "2026-01-01T00:00:00.000Z");
        drop(connection);

        update_record_status_at_root(&root, older_id, "已报销").unwrap();
        let connection = open_database(&root, false).unwrap();
        let records = query_history_records(&connection, &history_query)
            .unwrap()
            .0;
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            vec![newer_id, older_id]
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn image_pool_deduplicates_by_hash() {
        let root = temporary_root("images");
        fs::create_dir_all(&root).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let first = store_image_bytes(&root, "record-images", &bytes, 10, 20).unwrap();
        let second = store_image_bytes(&root, "record-images", &bytes, 10, 20).unwrap();
        assert_eq!(first.hash, second.hash);
        assert_eq!(first.relative_path, second.relative_path);
        assert!(root
            .join(
                first
                    .relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR)
            )
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_transaction_rolls_back_invalid_attachment() {
        let root = temporary_root("rollback");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        drop(connection);
        let request = SaveWorkspaceRequest {
            draft: json!({
                "id": "record-rollback",
                "label": "test",
                "status": "未报销",
                "updatedAt": now_iso8601(),
                "expenses": [{
                    "id": "expense-1",
                    "fileName": "bad.png",
                    "blobHash": "bad",
                    "extraAttachments": []
                }]
            }),
            profiles: json!([]),
            dictionaries: json!({}),
            services: json!({}),
            ui_preferences: json!({}),
        };
        assert!(save_workspace_at_root(&root, request).is_err());
        let connection = open_database(&root, false).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn record_id_validation_blocks_path_traversal() {
        assert!(validate_record_id("record-123_ab").is_ok());
        assert!(validate_record_id("../workspace").is_err());
        assert!(validate_record_id("C:\\temp").is_err());
    }

    #[test]
    fn blob_path_must_match_content_addressed_layout() {
        let hash = "ab".repeat(32);
        let legacy = format!("images/ab/{hash}.png");
        let record_path = format!("images/record-path/{hash}.png");
        assert!(validate_blob_relative_path(&hash, "png", &legacy).is_ok());
        assert!(validate_blob_relative_path(&hash, "png", &record_path).is_ok());
        assert!(validate_blob_relative_path(&hash, "png", "images/../../outside.png").is_err());
        assert!(validate_blob_relative_path(&hash, "exe", &legacy).is_err());
    }

    #[test]
    fn bootstrap_organizes_legacy_image_into_record_directory() {
        let root = temporary_root("organize-legacy-image");
        fs::create_dir_all(&root).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 8, 6, 4];
        let hash = hex::encode(Sha256::digest(bytes));
        let legacy_relative_path = format!("images/{}/{}.png", &hash[..2], hash);
        let legacy_path =
            root.join(legacy_relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(&legacy_path, bytes).unwrap();

        let mut connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        insert_blob(
            &connection,
            &BlobMetadata {
                hash: hash.clone(),
                relative_path: legacy_relative_path,
                extension: "png".to_string(),
                mime_type: "image/png".to_string(),
                size_bytes: bytes.len() as u64,
                width: 10,
                height: 20,
            },
        )
        .unwrap();
        let transaction = connection.transaction().unwrap();
        save_draft_tx(
            &transaction,
            &json!({
                "id": "record-organized",
                "updatedAt": now_iso8601(),
                "expenses": [{
                    "id": "expense-organized",
                    "fileName": "legacy.png",
                    "blobHash": hash,
                    "naturalWidth": 10,
                    "naturalHeight": 20,
                    "extraAttachments": []
                }]
            }),
        )
        .unwrap();
        transaction.commit().unwrap();
        drop(connection);

        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "ready", "{}", result.message);
        assert!(
            !result.message.contains("整理图片失败"),
            "{}",
            result.message
        );
        let expected_relative_path = format!("images/record-organized/{hash}.png");
        let expected_path =
            root.join(expected_relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        assert_eq!(fs::read(&expected_path).unwrap(), bytes);
        let connection = open_database(&root, false).unwrap();
        let stored_path: String = connection
            .query_row(
                "SELECT relative_path FROM image_blobs WHERE hash=?1",
                [&hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_path, expected_relative_path);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn timestamp_comparison_handles_fractional_seconds() {
        assert!(timestamp_is_newer(
            "2026-09-02T10:00:00.500Z",
            "2026-09-02T10:00:00Z"
        ));
        assert!(!timestamp_is_newer(
            "2026-09-02T10:00:00Z",
            "2026-09-02T10:00:00.500Z"
        ));
    }

    #[test]
    fn existing_corrupt_content_addressed_image_is_rejected() {
        let root = temporary_root("corrupt-image-pool");
        fs::create_dir_all(&root).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        let hash = hex::encode(Sha256::digest(bytes));
        let path = root.join(format!("images/record-corrupt/{hash}.png"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"corrupt").unwrap();
        assert!(store_image_bytes(&root, "record-corrupt", &bytes, 10, 20).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uncommitted_transaction_is_rolled_back_after_connection_drop() {
        let root = temporary_root("interrupted-save");
        fs::create_dir_all(&root).unwrap();
        let mut connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        {
            let transaction = connection.transaction().unwrap();
            transaction
                .execute(
                    "INSERT INTO records(id, updated_at, data_json) VALUES ('interrupted', ?1, '{}')",
                    [now_iso8601()],
                )
                .unwrap();
        }
        drop(connection);
        let connection = open_database(&root, false).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires SHEEPFINANCE_MIGRATION_FIXTURE"]
    fn migrates_external_legacy_fixture_without_base64() {
        let source = PathBuf::from(
            std::env::var("SHEEPFINANCE_MIGRATION_FIXTURE")
                .expect("SHEEPFINANCE_MIGRATION_FIXTURE"),
        );
        let root = temporary_root("real-migration");
        copy_directory(&source, &root).expect("copy migration fixture");
        let original_workspace =
            read_json_with_backup(&root.join("workspace.json")).expect("legacy workspace");

        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "migrated", "{}", result.message);
        assert_eq!(result.migrated_records, 17);
        assert_eq!(result.migrated_expenses, 62);
        assert_eq!(result.migrated_attachments, 77);

        let connection = open_database(&root, false).expect("migrated database");
        let counts = (
            connection
                .query_row("SELECT COUNT(*) FROM records", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            connection
                .query_row("SELECT COUNT(*) FROM expenses", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            connection
                .query_row("SELECT COUNT(*) FROM attachments", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
        );
        assert_eq!(counts, (17, 62, 77));
        let contains_base64: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM records WHERE data_json LIKE '%data:image/%')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!contains_base64);
        drop(connection);

        let migrated = load_workspace_at_root(&root).expect("load migrated workspace");
        assert_eq!(migrated.profiles, original_workspace["profiles"]);
        assert_eq!(migrated.dictionaries, original_workspace["dictionaries"]);
        assert_eq!(migrated.services, original_workspace["services"]);
        assert_eq!(migrated.ui_preferences, original_workspace["uiPreferences"]);
        assert!(migrated
            .draft
            .as_ref()
            .and_then(|draft| draft.get("expenses"))
            .is_some());
        quick_check(&open_database(&root, false).unwrap()).unwrap();
        fs::remove_dir_all(root).expect("cleanup migration fixture");
    }

    fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
        fs::create_dir_all(target).map_err(|error| error.to_string())?;
        for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let source_path = entry.path();
            let target_path = target.join(entry.file_name());
            if source_path.is_dir() {
                copy_directory(&source_path, &target_path)?;
            } else {
                fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn write_legacy_fixture(root: &Path, corrupt_primary: bool, corrupt_backup: bool) {
        fs::create_dir_all(root.join("records")).unwrap();
        let data_url = "data:image/png;base64,iVBORw0KGgoBAgM=";
        let record = json!({
            "id": "record-fixture",
            "label": "测试单据",
            "status": "未报销",
            "companyName": "测试公司",
            "applicant": "申请人",
            "reimbursementDate": "2026-09-02",
            "updatedAt": "2026-09-02T00:00:00Z",
            "expenses": [{
                "id": "expense-fixture",
                "fileName": "ticket.png",
                "imageDataUrl": data_url,
                "recognitionImageDataUrl": data_url,
                "naturalWidth": 100,
                "naturalHeight": 200,
                "occurredDate": "2026-09-01",
                "reason": "办公费",
                "description": "测试",
                "arranger": "",
                "amountCents": 1234,
                "extraAttachments": []
            }]
        });
        let workspace = json!({
            "currentRecordId": "record-fixture",
            "profiles": [{"id":"profile-1","isDefault":true}],
            "dictionaries": {
                "companies":["测试公司"], "reasons":["办公费"], "arrangers":[],
                "defaultCompany":"测试公司", "defaultReason":"办公费", "defaultArranger":""
            },
            "services": {"ocrProfiles":[],"llmProfiles":[]},
            "history": [],
            "uiPreferences": {"leftPanelWidth":404}
        });
        fs::write(
            root.join("workspace.json"),
            if corrupt_primary {
                b"broken".to_vec()
            } else {
                serde_json::to_vec(&workspace).unwrap()
            },
        )
        .unwrap();
        fs::write(
            root.join("workspace.bak"),
            serde_json::to_vec(&workspace).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("records/record-fixture.json"),
            if corrupt_primary {
                b"broken".to_vec()
            } else {
                serde_json::to_vec(&record).unwrap()
            },
        )
        .unwrap();
        fs::write(
            root.join("records/record-fixture.bak"),
            if corrupt_backup {
                b"broken".to_vec()
            } else {
                serde_json::to_vec(&record).unwrap()
            },
        )
        .unwrap();
    }

    #[test]
    fn migration_retries_interrupted_work_and_uses_json_backups() {
        let root = temporary_root("fallback");
        write_legacy_fixture(&root, true, false);
        fs::create_dir_all(root.join(".migration-interrupted/images")).unwrap();
        fs::write(root.join(".migration-interrupted/partial"), b"partial").unwrap();
        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "migrated", "{}", result.message);
        assert_eq!(result.migrated_records, 1);
        assert_eq!(result.migrated_expenses, 1);
        assert_eq!(result.migrated_attachments, 1);
        assert!(!root.join(".migration-interrupted").exists());
        assert!(load_record_at_root(&root, "record-fixture").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_preserves_settings_without_records() {
        let root = temporary_root("settings-only");
        fs::create_dir_all(&root).unwrap();
        let workspace = json!({
            "currentRecordId":"",
            "profiles":[{"id":"profile-only","name":"仅设置","isDefault":true}],
            "dictionaries":{
                "companies":["设置公司"], "reasons":["办公费"], "arrangers":["安排人"],
                "defaultCompany":"设置公司", "defaultReason":"办公费", "defaultArranger":"安排人"
            },
            "services":{"ocrProfiles":[],"llmProfiles":[]},
            "history":[],
            "uiPreferences":{"leftPanelWidth":480}
        });
        fs::write(
            root.join("workspace.json"),
            serde_json::to_vec(&workspace).unwrap(),
        )
        .unwrap();

        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "migrated", "{}", result.message);
        assert_eq!(result.migrated_records, 0);
        let migrated = load_workspace_at_root(&root).unwrap();
        assert_eq!(migrated.profiles, workspace["profiles"]);
        assert_eq!(migrated.dictionaries, workspace["dictionaries"]);
        assert_eq!(migrated.ui_preferences, workspace["uiPreferences"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_does_not_activate_when_record_and_backup_are_corrupt() {
        let root = temporary_root("corrupt-legacy");
        write_legacy_fixture(&root, true, true);
        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "migrationFailed");
        assert_eq!(result.corrupt_files.len(), 2);
        assert!(!database_path(&root).exists());
        assert!(root.join("records/record-fixture.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_database_requires_recovery_without_overwrite() {
        let root = temporary_root("corrupt-database");
        fs::create_dir_all(&root).unwrap();
        let database = database_path(&root);
        fs::write(&database, b"not a sqlite database").unwrap();
        let before = fs::read(&database).unwrap();
        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "recoveryRequired");
        assert_eq!(fs::read(&database).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_database_with_backup_requires_recovery() {
        let root = temporary_root("missing-database");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(connection);
        let backup_directory = root.join(DATABASE_BACKUP_DIRECTORY);
        fs::create_dir_all(&backup_directory).unwrap();
        fs::copy(
            database_path(&root),
            backup_directory.join("SheepFinance-20260902-120000.db"),
        )
        .unwrap();
        fs::remove_file(database_path(&root)).unwrap();

        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "recoveryRequired");
        assert!(!database_path(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_database_activation_resumes_before_bootstrap() {
        let root = temporary_root("interrupted-activation");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(connection);
        let temporary = root.join(format!(".{DATABASE_FILE}.restore-test.tmp"));
        fs::copy(database_path(&root), &temporary).unwrap();
        fs::remove_file(database_path(&root)).unwrap();
        fs::write(root.join(format!("{DATABASE_FILE}-wal")), b"interrupted").unwrap();

        let result = bootstrap_at_root(&root, None, false);
        assert_eq!(result.status, "ready", "{}", result.message);
        assert!(database_path(&root).exists());
        let preserved_wal = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| {
                        name.starts_with("recovery-preserved-interrupted-")
                            && name.ends_with(&format!("{DATABASE_FILE}-wal"))
                    })
            })
            .expect("preserved interrupted WAL");
        assert_eq!(fs::read(preserved_wal).unwrap(), b"interrupted");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_autosave_cannot_overwrite_newer_record_or_settings() {
        let root = temporary_root("stale-save");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        drop(connection);
        let request = |updated_at: &str, label: &str, profile_name: &str| SaveWorkspaceRequest {
            draft: json!({
                "id":"record-stale", "label":label, "updatedAt":updated_at, "expenses":[]
            }),
            profiles: json!([{"id":"profile-stale","name":profile_name,"isDefault":true}]),
            dictionaries: json!({}),
            services: json!({}),
            ui_preferences: json!({}),
        };
        save_workspace_at_root(
            &root,
            request("2026-09-02T10:00:00.000Z", "新单据", "新配置"),
        )
        .unwrap();
        save_workspace_at_root(
            &root,
            request("2026-09-02T09:00:00.000Z", "旧单据", "旧配置"),
        )
        .unwrap();
        let workspace = load_workspace_at_root(&root).unwrap();
        assert_eq!(workspace.draft.unwrap()["label"], "新单据");
        assert_eq!(workspace.profiles[0]["name"], "新配置");
        fs::remove_dir_all(root).unwrap();
    }
}
