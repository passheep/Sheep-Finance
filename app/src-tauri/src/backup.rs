use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::Write,
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime},
};

use rusqlite::{backup::Backup, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use time::{macros::format_description, OffsetDateTime};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::database::{
    self, database_path, image_manifest, referenced_hashes, BACKUP_INTERVAL_SECONDS,
    DATABASE_BACKUP_DIRECTORY, DATABASE_FILE, FULL_BACKUP_DIRECTORY, IMAGE_DIRECTORY,
    MAX_DATABASE_BACKUPS,
};

static BACKUP_RUNNING: AtomicBool = AtomicBool::new(false);
static STARTUP_BACKUP_CHECK_COMPLETE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupItem {
    pub file_name: String,
    pub path: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub valid: bool,
    pub images_complete: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchiveItem {
    pub directory_name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub last_backup_at: Option<String>,
    pub valid_backup_count: usize,
    pub backup_due: bool,
    pub backups: Vec<DatabaseBackupItem>,
    pub legacy_archives: Vec<LegacyArchiveItem>,
    pub data_directory: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullBackupManifest {
    format: String,
    version: u32,
    created_at: String,
    database_sha256: String,
    images: Vec<FullBackupImage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FullBackupImage {
    hash: String,
    relative_path: String,
    size_bytes: u64,
}

pub fn schedule_startup_backup(app: AppHandle) -> bool {
    if STARTUP_BACKUP_CHECK_COMPLETE.load(Ordering::Acquire) {
        return false;
    }
    let Ok(root) = database::storage_root(&app) else {
        return false;
    };
    if BACKUP_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<bool, String> {
            let _guard = database::storage_guard()?;
            if raw_database_backup_count(&root) > MAX_DATABASE_BACKUPS {
                rotate_database_backups(&root)?;
            }
            if backup_due_at_root(&root)? {
                create_database_backup_at_root(&root)?;
            }
            let connection = database::open_database(&root, false)?;
            Ok(!database_has_user_data(&connection)? && raw_database_backup_count(&root) == 0)
        })();
        match result {
            Ok(waiting_for_first_record) => {
                STARTUP_BACKUP_CHECK_COMPLETE.store(!waiting_for_first_record, Ordering::Release);
            }
            Err(error) => {
                STARTUP_BACKUP_CHECK_COMPLETE.store(true, Ordering::Release);
                let _ = app.emit("database-backup-failed", error);
            }
        }
        BACKUP_RUNNING.store(false, Ordering::Release);
    });
    true
}

fn raw_database_backup_count(root: &Path) -> usize {
    fs::read_dir(root.join(DATABASE_BACKUP_DIRECTORY))
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("db")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("SheepFinance-"))
        })
        .count()
}

#[tauri::command]
pub async fn get_backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        backup_status_at_root(&root)
    })
    .await
    .map_err(|_| "备份状态读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn create_database_backup(app: AppHandle) -> Result<DatabaseBackupItem, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        create_database_backup_at_root(&root)
    })
    .await
    .map_err(|_| "数据库备份任务异常结束".to_string())?
}

#[tauri::command]
pub async fn restore_database_backup(app: AppHandle, file_name: String) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        restore_database_backup_at_root(&root, &file_name)
    })
    .await
    .map_err(|_| "数据库恢复任务异常结束".to_string())?
}

#[tauri::command]
pub async fn export_full_backup(app: AppHandle, destination: String) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        export_full_backup_at_root(&root, Path::new(&destination))
    })
    .await
    .map_err(|_| "完整备份导出任务异常结束".to_string())?
}

#[tauri::command]
pub async fn import_full_backup(app: AppHandle, source: String) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        import_full_backup_at_root(&root, Path::new(&source))
    })
    .await
    .map_err(|_| "完整备份导入任务异常结束".to_string())?
}

#[tauri::command]
pub async fn open_backup_directory(app: AppHandle) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    let directory = root.join(DATABASE_BACKUP_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败：{error}"))?;
    Command::new("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("打开备份目录失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn cleanup_legacy_archives(app: AppHandle) -> Result<u64, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let status = backup_status_at_root(&root)?;
        if status.valid_backup_count == 0 {
            return Err("至少创建一份有效数据库备份后才能清理旧 JSON".to_string());
        }
        let mut removed = 0u64;
        for archive in list_legacy_archives(&root)? {
            let path = root.join(&archive.directory_name);
            if !archive.directory_name.starts_with("legacy-json-") || !path.starts_with(&root) {
                continue;
            }
            fs::remove_dir_all(&path).map_err(|error| format!("清理旧数据归档失败：{error}"))?;
            removed = removed.saturating_add(archive.size_bytes);
        }
        Ok(removed)
    })
    .await
    .map_err(|_| "旧数据清理任务异常结束".to_string())?
}

#[tauri::command]
pub async fn cleanup_orphan_images(app: AppHandle) -> Result<u64, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        cleanup_orphan_images_at_root(&root)
    })
    .await
    .map_err(|_| "孤立图片清理任务异常结束".to_string())?
}

pub fn backup_due_at_root(root: &Path) -> Result<bool, String> {
    let connection = database::open_database(root, false)?;
    if !database_has_user_data(&connection)? {
        return Ok(false);
    }
    let backups = list_database_backups(root)?;
    let latest = backups
        .iter()
        .filter(|item| item.valid && item.images_complete)
        .filter_map(|item| parse_backup_time(&item.file_name).ok())
        .max();
    let Some(latest) = latest else {
        return Ok(true);
    };
    Ok(
        OffsetDateTime::now_utc().unix_timestamp() - latest.unix_timestamp()
            >= BACKUP_INTERVAL_SECONDS,
    )
}

fn database_has_user_data(connection: &Connection) -> Result<bool, String> {
    let stored_item_count: i64 = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM records) +
                (SELECT COUNT(*) FROM profiles) +
                (SELECT COUNT(*) FROM dictionary_items) +
                (SELECT COUNT(*) FROM ocr_profiles) +
                (SELECT COUNT(*) FROM llm_profiles) +
                (SELECT COUNT(*) FROM ui_preferences) +
                (SELECT COUNT(*) FROM request_logs)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查数据库备份条件失败：{error}"))?;
    Ok(stored_item_count > 0)
}

pub fn backup_status_at_root(root: &Path) -> Result<BackupStatus, String> {
    let backups = list_database_backups(root)?;
    let valid_backup_count = backups
        .iter()
        .filter(|item| item.valid && item.images_complete)
        .count();
    let last_backup_at = backups
        .iter()
        .filter(|item| item.valid && item.images_complete)
        .map(|item| item.created_at.clone())
        .max();
    Ok(BackupStatus {
        last_backup_at,
        valid_backup_count,
        backup_due: backup_due_at_root(root).unwrap_or(true),
        backups,
        legacy_archives: list_legacy_archives(root)?,
        data_directory: root.to_string_lossy().into_owned(),
    })
}

pub fn create_database_backup_at_root(root: &Path) -> Result<DatabaseBackupItem, String> {
    let source_path = database_path(root);
    database::validate_database_file(&source_path)?;
    let directory = root.join(DATABASE_BACKUP_DIRECTORY);
    fs::create_dir_all(&directory).map_err(|error| format!("创建数据库备份目录失败：{error}"))?;
    let (file_name, destination) = next_backup_destination(&directory)?;
    let temporary = directory.join(format!(".{file_name}.{}.tmp", Uuid::new_v4().simple()));

    let source = database::open_database(root, false)?;
    let mut target =
        Connection::open(&temporary).map_err(|error| format!("创建备份数据库失败：{error}"))?;
    {
        let backup = Backup::new(&source, &mut target)
            .map_err(|error| format!("开启 SQLite 在线备份失败：{error}"))?;
        backup
            .run_to_completion(128, Duration::from_millis(20), None)
            .map_err(|error| format!("SQLite 在线备份失败：{error}"))?;
    }
    drop(target);
    drop(source);
    database::validate_database_file(&temporary)?;
    validate_backup_images(root, &temporary)?;
    fs::rename(&temporary, &destination).map_err(|error| format!("提交数据库备份失败：{error}"))?;
    rotate_database_backups(root)?;
    inspect_database_backup(root, &destination)
}

fn list_database_backups(root: &Path) -> Result<Vec<DatabaseBackupItem>, String> {
    let directory = root.join(DATABASE_BACKUP_DIRECTORY);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(&directory)
        .map_err(|error| format!("读取备份目录失败：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("db")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("SheepFinance-"))
        })
        .collect::<Vec<_>>();
    paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    paths
        .iter()
        .map(|path| inspect_database_backup(root, path))
        .collect::<Result<Vec<_>, _>>()
}

fn inspect_database_backup(root: &Path, path: &Path) -> Result<DatabaseBackupItem, String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let validation = database::validate_database_file(path);
    let images_complete = validation.is_ok() && validate_backup_images(root, path).is_ok();
    Ok(DatabaseBackupItem {
        created_at: parse_backup_time(&file_name)
            .and_then(|value| {
                value
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|error| error.to_string())
            })
            .unwrap_or_else(|_| file_modified_iso(&metadata)),
        path: path.to_string_lossy().into_owned(),
        file_name,
        size_bytes: metadata.len(),
        valid: validation.is_ok(),
        images_complete,
        error: validation.err(),
    })
}

fn validate_backup_images(root: &Path, path: &Path) -> Result<(), String> {
    let connection = database::open_database_readonly_at(path)?;
    database::validate_referenced_images(root, &connection, true)
}

fn rotate_database_backups(root: &Path) -> Result<(), String> {
    let valid = list_database_backups(root)?
        .into_iter()
        .filter(|item| item.valid && item.images_complete)
        .collect::<Vec<_>>();
    for item in valid.into_iter().skip(MAX_DATABASE_BACKUPS) {
        fs::remove_file(&item.path).map_err(|error| format!("清理过期备份失败：{error}"))?;
    }
    Ok(())
}

fn restore_database_backup_at_root(root: &Path, file_name: &str) -> Result<(), String> {
    validate_backup_file_name(file_name)?;
    let source = root.join(DATABASE_BACKUP_DIRECTORY).join(file_name);
    database::validate_database_file(&source)?;
    validate_backup_images(root, &source)?;
    let staged_source = root.join(format!(
        ".{DATABASE_FILE}.selected-{}.tmp",
        Uuid::new_v4().simple()
    ));
    fs::copy(&source, &staged_source).map_err(|error| format!("暂存待恢复数据库失败：{error}"))?;
    let result = (|| {
        database::validate_database_file(&staged_source)?;
        if current_database_is_fully_valid(root) {
            create_database_backup_at_root(root)?;
        }
        activate_database_file(root, &staged_source)
    })();
    let _ = fs::remove_file(staged_source);
    result
}

fn validate_backup_file_name(file_name: &str) -> Result<(), String> {
    if file_name.starts_with("SheepFinance-")
        && file_name.ends_with(".db")
        && !file_name.contains(['/', '\\'])
    {
        Ok(())
    } else {
        Err("备份文件名无效".to_string())
    }
}

fn current_database_is_fully_valid(root: &Path) -> bool {
    let path = database_path(root);
    database::validate_database_file(&path).is_ok()
        && database::open_database_readonly_at(&path)
            .and_then(|connection| database::validate_referenced_images(root, &connection, true))
            .is_ok()
}

fn activate_database_file(root: &Path, source: &Path) -> Result<(), String> {
    let temporary = root.join(format!(
        ".{DATABASE_FILE}.restore-{}.tmp",
        Uuid::new_v4().simple()
    ));
    fs::copy(source, &temporary).map_err(|error| format!("复制恢复数据库失败：{error}"))?;
    database::validate_database_file(&temporary)?;
    let timestamp = backup_timestamp();
    let recovery_id = Uuid::new_v4().simple().to_string();
    for suffix in ["", "-wal", "-shm"] {
        let current = root.join(format!("{DATABASE_FILE}{suffix}"));
        if current.exists() {
            let preserved = root.join(format!(
                "recovery-preserved-{timestamp}-{recovery_id}-{DATABASE_FILE}{suffix}"
            ));
            fs::rename(&current, &preserved)
                .map_err(|error| format!("保留当前数据库文件失败：{error}"))?;
        }
    }
    fs::rename(&temporary, database_path(root))
        .map_err(|error| format!("启用恢复数据库失败：{error}"))?;
    Ok(())
}

fn export_full_backup_at_root(root: &Path, destination: &Path) -> Result<(), String> {
    if destination.as_os_str().is_empty() {
        return Err("完整备份保存路径为空".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建导出目录失败：{error}"))?;
    }
    let working = root.join(FULL_BACKUP_DIRECTORY);
    fs::create_dir_all(&working).map_err(|error| format!("创建完整备份临时目录失败：{error}"))?;
    let snapshot = working.join(format!("snapshot-{}.db", Uuid::new_v4().simple()));
    create_snapshot(root, &snapshot)?;
    let connection = database::open_database_readonly_at(&snapshot)?;
    let manifest_rows = image_manifest(&connection)?;
    let hashes = referenced_hashes(&connection)?;
    drop(connection);

    let database_bytes =
        fs::read(&snapshot).map_err(|error| format!("读取完整备份快照失败：{error}"))?;
    let mut images = Vec::new();
    for hash in hashes {
        let blob = manifest_rows
            .get(&hash)
            .ok_or_else(|| format!("图片清单缺少：{hash}"))?;
        database::validate_blob_relative_path(&hash, &blob.extension, &blob.relative_path)?;
        let path = root.join(
            blob.relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        let bytes = fs::read(&path).map_err(|error| format!("读取完整备份图片失败：{error}"))?;
        if hex::encode(Sha256::digest(&bytes)) != hash {
            return Err(format!("图片哈希校验失败：{}", path.display()));
        }
        images.push(FullBackupImage {
            hash,
            relative_path: blob.relative_path.clone(),
            size_bytes: bytes.len() as u64,
        });
    }
    let manifest = FullBackupManifest {
        format: "sheepfinance-full-backup".to_string(),
        version: 1,
        created_at: database::now_iso8601(),
        database_sha256: hex::encode(Sha256::digest(&database_bytes)),
        images,
    };
    let temporary = destination.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let file = File::create(&temporary).map_err(|error| format!("创建完整备份失败：{error}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("database/sheepfinance.db", options)
        .map_err(|error| format!("写入备份数据库失败：{error}"))?;
    zip.write_all(&database_bytes)
        .map_err(|error| error.to_string())?;
    for image in &manifest.images {
        let path = root.join(
            image
                .relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        zip.start_file(&image.relative_path, options)
            .map_err(|error| format!("写入备份图片失败：{error}"))?;
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        zip.write_all(&bytes).map_err(|error| error.to_string())?;
    }
    zip.start_file("manifest.json", options)
        .map_err(|error| format!("写入备份清单失败：{error}"))?;
    zip.write_all(
        &serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("序列化备份清单失败：{error}"))?,
    )
    .map_err(|error| error.to_string())?;
    zip.finish()
        .map_err(|error| format!("完成 ZIP 备份失败：{error}"))?;
    fs::rename(&temporary, destination).map_err(|error| format!("提交完整备份失败：{error}"))?;
    let _ = fs::remove_file(snapshot);
    Ok(())
}

fn import_full_backup_at_root(root: &Path, source: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Err("完整备份文件不存在".to_string());
    }
    let staging = root.join(format!(".full-import-{}", Uuid::new_v4().simple()));
    fs::create_dir_all(&staging).map_err(|error| format!("创建导入临时目录失败：{error}"))?;
    let result = (|| -> Result<(), String> {
        let file = File::open(source).map_err(|error| format!("打开完整备份失败：{error}"))?;
        let mut archive =
            ZipArchive::new(file).map_err(|error| format!("解析 ZIP 备份失败：{error}"))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| "ZIP 包含不安全路径".to_string())?
                .to_path_buf();
            let output = staging.join(enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&output).map_err(|error| error.to_string())?;
                continue;
            }
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut target = File::create(&output).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut target).map_err(|error| error.to_string())?;
        }
        let manifest: FullBackupManifest = serde_json::from_slice(
            &fs::read(staging.join("manifest.json"))
                .map_err(|error| format!("读取备份清单失败：{error}"))?,
        )
        .map_err(|error| format!("解析备份清单失败：{error}"))?;
        if manifest.format != "sheepfinance-full-backup" || manifest.version != 1 {
            return Err("完整备份版本不受支持".to_string());
        }
        let imported_database = staging.join("database/sheepfinance.db");
        let database_bytes =
            fs::read(&imported_database).map_err(|error| format!("读取备份数据库失败：{error}"))?;
        if hex::encode(Sha256::digest(&database_bytes)) != manifest.database_sha256 {
            return Err("备份数据库哈希校验失败".to_string());
        }
        database::validate_database_file(&imported_database)?;
        let imported_connection = database::open_database_readonly_at(&imported_database)?;
        let database_hashes = referenced_hashes(&imported_connection)?;
        let database_manifest = image_manifest(&imported_connection)?;
        drop(imported_connection);
        let manifest_hashes = manifest
            .images
            .iter()
            .map(|image| image.hash.clone())
            .collect::<BTreeSet<_>>();
        if database_hashes != manifest_hashes {
            return Err("备份图片清单与数据库引用不一致".to_string());
        }
        for image in &manifest.images {
            database::validate_hash(&image.hash)?;
            let Some(blob) = database_manifest.get(&image.hash) else {
                return Err(format!("备份图片清单缺少：{}", image.hash));
            };
            database::validate_blob_relative_path(
                &image.hash,
                &blob.extension,
                &image.relative_path,
            )?;
            if blob.relative_path != image.relative_path {
                return Err(format!("备份图片路径与数据库不一致：{}", image.hash));
            }
            let path = staging.join(
                image
                    .relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            let bytes = fs::read(&path).map_err(|error| format!("读取备份图片失败：{error}"))?;
            if bytes.len() as u64 != image.size_bytes
                || hex::encode(Sha256::digest(&bytes)) != image.hash
            {
                return Err(format!("备份图片校验失败：{}", image.relative_path));
            }
        }
        if current_database_is_fully_valid(root) {
            create_database_backup_at_root(root)?;
        }
        merge_imported_images(&staging.join(IMAGE_DIRECTORY), &root.join(IMAGE_DIRECTORY))?;
        activate_database_file(root, &imported_database)
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

fn create_snapshot(root: &Path, destination: &Path) -> Result<(), String> {
    let source = database::open_database(root, false)?;
    let mut target =
        Connection::open(destination).map_err(|error| format!("创建数据库快照失败：{error}"))?;
    {
        let backup = Backup::new(&source, &mut target)
            .map_err(|error| format!("开启数据库快照失败：{error}"))?;
        backup
            .run_to_completion(128, Duration::from_millis(20), None)
            .map_err(|error| format!("创建数据库快照失败：{error}"))?;
    }
    drop(target);
    drop(source);
    database::validate_database_file(destination)
}

fn merge_imported_images(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|error| format!("创建图片池失败：{error}"))?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            merge_imported_images(&source_path, &target_path)?;
        } else if target_path.exists() {
            let source_bytes =
                fs::read(&source_path).map_err(|error| format!("读取导入图片失败：{error}"))?;
            let target_bytes =
                fs::read(&target_path).map_err(|error| format!("读取已有图片失败：{error}"))?;
            if Sha256::digest(&source_bytes) != Sha256::digest(&target_bytes) {
                return Err(format!("本地图片池存在内容冲突：{}", target_path.display()));
            }
        } else {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("导入图片失败：{error}"))?;
        }
    }
    Ok(())
}

fn cleanup_orphan_images_at_root(root: &Path) -> Result<u64, String> {
    let connection = database::open_database(root, false)?;
    let mut retained = referenced_hashes(&connection)?;
    drop(connection);
    for backup in list_database_backups(root)?
        .into_iter()
        .filter(|item| item.valid)
        .take(MAX_DATABASE_BACKUPS)
    {
        let connection = database::open_database_readonly_at(Path::new(&backup.path))?;
        retained.extend(referenced_hashes(&connection)?);
    }
    let connection = database::open_database(root, false)?;
    let manifest = image_manifest(&connection)?;
    let mut reclaimed = 0u64;
    for path in image_pool_files(&root.join(IMAGE_DIRECTORY))? {
        let Some(hash) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| database::validate_hash(value).is_ok())
        else {
            continue;
        };
        if retained.contains(hash) {
            continue;
        }
        reclaimed =
            reclaimed.saturating_add(fs::metadata(&path).map(|value| value.len()).unwrap_or(0));
        fs::remove_file(&path).map_err(|error| format!("清理孤立图片失败：{error}"))?;
    }
    for hash in manifest.keys().filter(|hash| !retained.contains(*hash)) {
        connection
            .execute("DELETE FROM image_blobs WHERE hash=?1", [hash])
            .map_err(|error| format!("清理图片元数据失败：{error}"))?;
    }
    Ok(reclaimed)
}

fn image_pool_files(directory: &Path) -> Result<Vec<std::path::PathBuf>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| format!("读取图片池失败：{error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            files.extend(image_pool_files(&path)?);
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(files)
}

fn list_legacy_archives(root: &Path) -> Result<Vec<LegacyArchiveItem>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("读取数据目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && name.starts_with("legacy-json-") {
            result.push(LegacyArchiveItem {
                directory_name: name,
                path: entry.path().to_string_lossy().into_owned(),
                size_bytes: directory_size(&entry.path())?,
            });
        }
    }
    result.sort_by(|left, right| right.directory_name.cmp(&left.directory_name));
    Ok(result)
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let mut size = 0u64;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        size = size.saturating_add(if metadata.is_dir() {
            directory_size(&entry.path())?
        } else {
            metadata.len()
        });
    }
    Ok(size)
}

fn backup_timestamp() -> String {
    backup_timestamp_at(OffsetDateTime::now_utc())
}

fn backup_timestamp_at(value: OffsetDateTime) -> String {
    value
        .format(format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn next_backup_destination(directory: &Path) -> Result<(String, std::path::PathBuf), String> {
    let now = OffsetDateTime::now_utc();
    for offset in 0..86_400 {
        let timestamp = backup_timestamp_at(now + time::Duration::seconds(offset));
        let file_name = format!("SheepFinance-{timestamp}.db");
        let destination = directory.join(&file_name);
        if !destination.exists() {
            return Ok((file_name, destination));
        }
    }
    Err("无法生成唯一的数据库备份文件名".to_string())
}

fn parse_backup_time(file_name: &str) -> Result<OffsetDateTime, String> {
    let raw = file_name
        .strip_prefix("SheepFinance-")
        .and_then(|value| value.strip_suffix(".db"))
        .ok_or_else(|| "备份文件名无效".to_string())?;
    time::PrimitiveDateTime::parse(
        raw,
        format_description!("[year][month][day]-[hour][minute][second]"),
    )
    .map(|value| value.assume_utc())
    .map_err(|error| error.to_string())
}

fn file_modified_iso(metadata: &fs::Metadata) -> String {
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let timestamp = modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    OffsetDateTime::from_unix_timestamp(timestamp)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| timestamp.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{initialize_schema, open_database};
    use std::path::PathBuf;

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sheepfinance-backup-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn backup_rule_requires_records_and_respects_interval() {
        let root = temporary_root("interval");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        assert!(!backup_due_at_root(&root).unwrap());
        connection
            .execute(
                "INSERT INTO records(id, updated_at, data_json) VALUES ('record-1', ?1, '{}')",
                [database::now_iso8601()],
            )
            .unwrap();
        drop(connection);
        assert!(backup_due_at_root(&root).unwrap());
        create_database_backup_at_root(&root).unwrap();
        assert!(!backup_due_at_root(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backups_created_in_the_same_second_use_distinct_names() {
        let root = temporary_root("unique-name");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO profiles(id, sort_order, is_default, data_json)
                 VALUES ('profile-unique', 0, 1, '{}')",
                [],
            )
            .unwrap();
        drop(connection);

        let first = create_database_backup_at_root(&root).unwrap();
        let second = create_database_backup_at_root(&root).unwrap();
        assert_ne!(first.file_name, second.file_name);
        assert!(Path::new(&first.path).is_file());
        assert!(Path::new(&second.path).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restoring_oldest_backup_survives_rotation() {
        let root = temporary_root("restore-oldest");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO records(id, updated_at, data_json)
                 VALUES ('current-record', ?1, '{\"id\":\"current-record\",\"expenses\":[]}')",
                [database::now_iso8601()],
            )
            .unwrap();
        drop(connection);

        let directory = root.join(DATABASE_BACKUP_DIRECTORY);
        fs::create_dir_all(&directory).unwrap();
        for day in 1..=5 {
            let path = directory.join(format!("SheepFinance-2000010{day}-010101.db"));
            let connection = database::open_database_at(&path, true).unwrap();
            initialize_schema(&connection).unwrap();
            let record_id = format!("backup-record-{day}");
            let data = serde_json::json!({ "id": record_id, "expenses": [] }).to_string();
            connection
                .execute(
                    "INSERT INTO records(id, updated_at, data_json) VALUES (?1, ?2, ?3)",
                    rusqlite::params![record_id, database::now_iso8601(), data],
                )
                .unwrap();
        }

        let oldest = "SheepFinance-20000101-010101.db";
        restore_database_backup_at_root(&root, oldest).unwrap();
        assert!(database::load_record_at_root(&root, "backup-record-1").is_ok());
        assert!(!directory.join(oldest).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_is_not_blocked_by_missing_current_image() {
        let root = temporary_root("restore-missing-image");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 3, 2, 1];
        let blob = database::store_image_bytes(&root, &bytes, 10, 10).unwrap();
        database::insert_blob(&connection, &blob).unwrap();
        drop(connection);
        database::save_workspace_at_root(
            &root,
            database::SaveWorkspaceRequest {
                draft: serde_json::json!({
                    "id":"broken-current", "updatedAt":database::now_iso8601(),
                    "expenses":[{
                        "id":"broken-expense", "fileName":"missing.png", "blobHash":blob.hash,
                        "mimeType":blob.mime_type, "blobExtension":blob.extension,
                        "sizeBytes":blob.size_bytes, "naturalWidth":10, "naturalHeight":10,
                        "extraAttachments":[]
                    }]
                }),
                profiles: serde_json::json!([]),
                dictionaries: serde_json::json!({}),
                services: serde_json::json!({}),
                ui_preferences: serde_json::json!({}),
            },
        )
        .unwrap();
        fs::remove_file(
            root.join(
                blob.relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            ),
        )
        .unwrap();
        assert!(!current_database_is_fully_valid(&root));

        let directory = root.join(DATABASE_BACKUP_DIRECTORY);
        fs::create_dir_all(&directory).unwrap();
        let file_name = "SheepFinance-20000101-010101.db";
        let backup_path = directory.join(file_name);
        let connection = database::open_database_at(&backup_path, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO records(id, updated_at, data_json)
                 VALUES ('restored-record', ?1, '{\"id\":\"restored-record\",\"expenses\":[]}')",
                [database::now_iso8601()],
            )
            .unwrap();
        drop(connection);

        restore_database_backup_at_root(&root, file_name).unwrap();
        assert!(database::load_record_at_root(&root, "restored-record").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_without_records_require_first_backup() {
        let root = temporary_root("settings-backup");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO profiles(id, sort_order, is_default, data_json)
                 VALUES ('profile-only', 0, 1, '{}')",
                [],
            )
            .unwrap();
        drop(connection);
        assert!(backup_due_at_root(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn backup_file_name_rejects_traversal() {
        assert!(validate_backup_file_name("SheepFinance-20260101-010101.db").is_ok());
        assert!(validate_backup_file_name("../SheepFinance-test.db").is_err());
    }

    #[test]
    fn imported_image_collision_is_rejected() {
        let root = temporary_root("import-collision");
        let source = root.join("source/images/aa");
        let target = root.join("target/images/aa");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("image.png"), b"source").unwrap();
        fs::write(target.join("image.png"), b"target").unwrap();
        assert!(
            merge_imported_images(&root.join("source/images"), &root.join("target/images"))
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_image_without_current_metadata_is_removed() {
        let root = temporary_root("orphan-file");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        drop(connection);
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7];
        let blob = database::store_image_bytes(&root, &bytes, 1, 1).unwrap();
        let path = root.join(
            blob.relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        assert!(path.exists());
        assert_eq!(
            cleanup_orphan_images_at_root(&root).unwrap(),
            bytes.len() as u64
        );
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotation_keeps_latest_five_valid_backups() {
        let root = temporary_root("rotation");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        drop(connection);
        let directory = root.join(DATABASE_BACKUP_DIRECTORY);
        fs::create_dir_all(&directory).unwrap();
        for day in 1..=6 {
            fs::copy(
                database_path(&root),
                directory.join(format!("SheepFinance-2026010{day}-010101.db")),
            )
            .unwrap();
        }
        rotate_database_backups(&root).unwrap();
        let backups = list_database_backups(&root).unwrap();
        assert_eq!(
            backups
                .iter()
                .filter(|item| item.valid && item.images_complete)
                .count(),
            5
        );
        assert!(!directory.join("SheepFinance-20260101-010101.db").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn orphan_image_is_retained_while_database_backup_references_it() {
        let root = temporary_root("gc");
        fs::create_dir_all(&root).unwrap();
        let connection = open_database(&root, true).unwrap();
        initialize_schema(&connection).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6];
        let blob = database::store_image_bytes(&root, &bytes, 10, 10).unwrap();
        database::insert_blob(&connection, &blob).unwrap();
        drop(connection);
        database::save_workspace_at_root(
            &root,
            database::SaveWorkspaceRequest {
                draft: serde_json::json!({
                    "id":"record-gc", "updatedAt":database::now_iso8601(),
                    "expenses":[{
                        "id":"expense-gc", "fileName":"gc.png", "blobHash":blob.hash,
                        "mimeType":blob.mime_type, "blobExtension":blob.extension,
                        "sizeBytes":blob.size_bytes, "naturalWidth":10, "naturalHeight":10,
                        "extraAttachments":[]
                    }]
                }),
                profiles: serde_json::json!([]),
                dictionaries: serde_json::json!({}),
                services: serde_json::json!({}),
                ui_preferences: serde_json::json!({}),
            },
        )
        .unwrap();
        let backup = create_database_backup_at_root(&root).unwrap();
        database::delete_record_at_root(&root, "record-gc").unwrap();
        cleanup_orphan_images_at_root(&root).unwrap();
        let image_path = root.join(
            blob.relative_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        assert!(image_path.exists());
        fs::remove_file(backup.path).unwrap();
        cleanup_orphan_images_at_root(&root).unwrap();
        assert!(!image_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_backup_roundtrip_validates_database_and_images() {
        let source_root = temporary_root("full-source");
        let target_root = temporary_root("full-target");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        let connection = open_database(&source_root, true).unwrap();
        initialize_schema(&connection).unwrap();
        let bytes = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9];
        let blob = database::store_image_bytes(&source_root, &bytes, 20, 20).unwrap();
        database::insert_blob(&connection, &blob).unwrap();
        drop(connection);
        database::save_workspace_at_root(
            &source_root,
            database::SaveWorkspaceRequest {
                draft: serde_json::json!({
                    "id":"record-full", "updatedAt":database::now_iso8601(),
                    "expenses":[{
                        "id":"expense-full", "fileName":"full.png", "blobHash":blob.hash,
                        "mimeType":blob.mime_type, "blobExtension":blob.extension,
                        "sizeBytes":blob.size_bytes, "naturalWidth":20, "naturalHeight":20,
                        "extraAttachments":[]
                    }]
                }),
                profiles: serde_json::json!([]),
                dictionaries: serde_json::json!({}),
                services: serde_json::json!({}),
                ui_preferences: serde_json::json!({}),
            },
        )
        .unwrap();
        let archive = source_root.join("roundtrip.zip");
        export_full_backup_at_root(&source_root, &archive).unwrap();

        let connection = open_database(&target_root, true).unwrap();
        initialize_schema(&connection).unwrap();
        drop(connection);
        import_full_backup_at_root(&target_root, &archive).unwrap();
        let restored = database::load_record_at_root(&target_root, "record-full").unwrap();
        assert_eq!(restored["expenses"][0]["fileName"], "full.png");
        let restored_hash = restored["expenses"][0]["blobHash"].as_str().unwrap();
        let connection = open_database(&target_root, false).unwrap();
        assert!(
            database::image_path_for_hash(&connection, &target_root, restored_hash)
                .unwrap()
                .exists()
        );
        drop(connection);
        fs::remove_dir_all(source_root).unwrap();
        fs::remove_dir_all(target_root).unwrap();
    }
}
