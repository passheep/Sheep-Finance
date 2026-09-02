use std::{fs, path::Path, process::Command};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::database;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreAttachmentRequest {
    pub record_id: String,
    pub data_url: String,
    pub recognition_data_url: Option<String>,
    #[serde(default)]
    pub natural_width: u32,
    #[serde(default)]
    pub natural_height: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    pub blob_hash: String,
    pub mime_type: String,
    pub blob_extension: String,
    pub size_bytes: u64,
    pub recognition_blob_hash: Option<String>,
    pub recognition_mime_type: Option<String>,
    pub recognition_blob_extension: Option<String>,
    pub recognition_size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBytes {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub extension: String,
}

#[tauri::command]
pub async fn store_attachment(
    app: AppHandle,
    request: StoreAttachmentRequest,
) -> Result<StoredAttachment, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let connection = database::open_database(&root, false)?;
        let (bytes, _) = database::decode_image_data_url(&request.data_url)?;
        let original = database::store_image_bytes(
            &root,
            &request.record_id,
            &bytes,
            request.natural_width,
            request.natural_height,
        )?;
        database::insert_blob(&connection, &original)?;

        let recognition = if original.size_bytes > 8 * 1024 * 1024 {
            request
                .recognition_data_url
                .as_deref()
                .filter(|value| !value.is_empty() && *value != request.data_url)
                .map(|value| {
                    let (bytes, _) = database::decode_image_data_url(value)?;
                    let blob = database::store_image_bytes(
                        &root,
                        &request.record_id,
                        &bytes,
                        request.natural_width,
                        request.natural_height,
                    )?;
                    database::insert_blob(&connection, &blob)?;
                    Ok::<_, String>(blob)
                })
                .transpose()?
                .filter(|value| value.hash != original.hash)
        } else {
            None
        };

        Ok(StoredAttachment {
            blob_hash: original.hash,
            mime_type: original.mime_type,
            blob_extension: original.extension,
            size_bytes: original.size_bytes,
            recognition_blob_hash: recognition.as_ref().map(|value| value.hash.clone()),
            recognition_mime_type: recognition.as_ref().map(|value| value.mime_type.clone()),
            recognition_blob_extension: recognition.as_ref().map(|value| value.extension.clone()),
            recognition_size_bytes: recognition.as_ref().map(|value| value.size_bytes),
        })
    })
    .await
    .map_err(|_| "图片本地存储任务异常结束".to_string())?
}

#[tauri::command]
pub async fn read_attachment(app: AppHandle, blob_hash: String) -> Result<AttachmentBytes, String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        read_attachment_at_root(&root, &blob_hash)
    })
    .await
    .map_err(|_| "图片读取任务异常结束".to_string())?
}

#[tauri::command]
pub async fn save_attachment_as(
    app: AppHandle,
    blob_hash: String,
    destination: String,
) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let attachment = read_attachment_at_root(&root, &blob_hash)?;
        let destination = Path::new(&destination);
        if destination.as_os_str().is_empty() {
            return Err("图片保存路径为空".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建图片保存目录失败：{error}"))?;
        }
        fs::write(destination, attachment.bytes).map_err(|error| format!("保存原图失败：{error}"))
    })
    .await
    .map_err(|_| "图片另存任务异常结束".to_string())?
}

#[tauri::command]
pub async fn open_attachment_folder(
    app: AppHandle,
    blob_hash: String,
    record_id: Option<String>,
) -> Result<(), String> {
    let root = database::storage_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database::storage_guard()?;
        let connection = database::open_database(&root, false)?;
        let path = if let Some(record_id) = record_id.as_deref() {
            database::record_image_path_for_hash(&connection, &root, record_id, &blob_hash)?
        } else {
            database::image_path_for_hash(&connection, &root, &blob_hash)?
        };
        if !path.exists() {
            return Err("图片文件已丢失".to_string());
        }
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("打开图片所在目录失败：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|_| "打开图片目录任务异常结束".to_string())?
}

pub fn read_attachment_at_root(root: &Path, blob_hash: &str) -> Result<AttachmentBytes, String> {
    let connection = database::open_database(root, false)?;
    let path = database::image_path_for_hash(&connection, root, blob_hash)?;
    let bytes = fs::read(&path).map_err(|error| format!("读取图片文件失败：{error}"))?;
    let actual_hash = hex::encode(Sha256::digest(&bytes));
    if actual_hash != blob_hash {
        return Err("图片文件哈希校验失败".to_string());
    }
    let (mime_type, extension) = database::detect_image_type(&bytes)?;
    Ok(AttachmentBytes {
        bytes,
        mime_type: mime_type.to_string(),
        extension: extension.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_data_is_rejected() {
        assert!(database::decode_image_data_url("data:text/plain;base64,dGVzdA==").is_err());
    }
}
