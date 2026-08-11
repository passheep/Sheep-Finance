use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex, RwLock},
};
use uuid::Uuid;

const MAX_FILES: usize = 10;
const MAX_FILE_BYTES: usize = 15 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 120 * 1024 * 1024;
const DEFAULT_TTL_SECONDS: u64 = 15 * 60;

#[derive(Clone)]
struct UploadSession {
    record_id: String,
    label: String,
    token: String,
    expires_at: u64,
    remaining_slots: usize,
}

struct ServerRuntime {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct UploadRouterState {
    app: AppHandle,
    session: Arc<RwLock<Option<UploadSession>>>,
}

pub struct LanUploadManager {
    session: Arc<RwLock<Option<UploadSession>>>,
    runtime: Mutex<Option<ServerRuntime>>,
    operation: Mutex<()>,
}

impl Default for LanUploadManager {
    fn default() -> Self {
        Self {
            session: Arc::new(RwLock::new(None)),
            runtime: Mutex::new(None),
            operation: Mutex::new(()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLanUploadRequest {
    record_id: String,
    label: String,
    remaining_slots: usize,
    #[serde(default = "default_ttl_seconds")]
    ttl_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLanUploadRequest {
    record_id: String,
    label: String,
    remaining_slots: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanUploadSessionInfo {
    url: String,
    record_id: String,
    label: String,
    expires_at: u64,
    remaining_slots: usize,
    local_address: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LanUploadEvent {
    record_id: String,
    remaining_slots: usize,
    file: LanUploadFile,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LanUploadFile {
    file_name: String,
    mime_type: String,
    data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    ok: bool,
    message: String,
    accepted_count: usize,
    remaining_slots: usize,
}

#[tauri::command]
pub async fn start_lan_upload_session(
    app: AppHandle,
    manager: TauriState<'_, LanUploadManager>,
    request: StartLanUploadRequest,
) -> Result<LanUploadSessionInfo, String> {
    let _operation = manager.operation.lock().await;
    validate_record_id(&request.record_id)?;
    if request.remaining_slots == 0 {
        return Err("当前报销单已达到 10 张图片上限".to_string());
    }

    let address = ensure_server(&app, &manager).await?;
    let session = UploadSession {
        record_id: request.record_id,
        label: clean_label(&request.label),
        token: Uuid::new_v4().simple().to_string(),
        expires_at: now_millis()
            .saturating_add(request.ttl_seconds.clamp(60, 3600).saturating_mul(1000)),
        remaining_slots: request.remaining_slots.min(MAX_FILES),
    };
    *manager.session.write().await = Some(session.clone());
    Ok(session_info(&session, address))
}

#[tauri::command]
pub async fn update_lan_upload_session(
    manager: TauriState<'_, LanUploadManager>,
    request: UpdateLanUploadRequest,
) -> Result<(), String> {
    let _operation = manager.operation.lock().await;
    let mut current = manager.session.write().await;
    let Some(session) = current.as_mut() else {
        return Ok(());
    };
    if session.record_id != request.record_id || session.expires_at <= now_millis() {
        *current = None;
        return Ok(());
    }
    session.label = clean_label(&request.label);
    session.remaining_slots = request.remaining_slots.min(MAX_FILES);
    Ok(())
}

#[tauri::command]
pub async fn stop_lan_upload_session(
    manager: TauriState<'_, LanUploadManager>,
) -> Result<(), String> {
    let _operation = manager.operation.lock().await;
    *manager.session.write().await = None;
    if let Some(mut runtime) = manager.runtime.lock().await.take() {
        if let Some(shutdown) = runtime.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

async fn ensure_server(app: &AppHandle, manager: &LanUploadManager) -> Result<SocketAddr, String> {
    let mut runtime = manager.runtime.lock().await;
    if let Some(server) = runtime.as_ref() {
        return Ok(server.address);
    }

    let local_ip = preferred_local_ipv4()?;
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(local_ip), 0))
        .await
        .map_err(|error| format!("启动局域网上传服务失败：{error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("读取局域网上传地址失败：{error}"))?;
    let router_state = UploadRouterState {
        app: app.clone(),
        session: manager.session.clone(),
    };
    let router = upload_router(router_state);
    let (shutdown_sender, shutdown_receiver) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.await;
            })
            .await;
        if let Err(error) = result {
            eprintln!("局域网上传服务异常结束：{error}");
        }
    });
    *runtime = Some(ServerRuntime {
        address,
        shutdown: Some(shutdown_sender),
    });
    Ok(address)
}

fn upload_router(state: UploadRouterState) -> Router {
    Router::new()
        .route(
            "/upload/{record_id}/{token}",
            get(upload_page).post(upload_files),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

async fn upload_page(
    Path((record_id, token)): Path<(String, String)>,
    State(state): State<UploadRouterState>,
) -> Response {
    let response_headers = [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        (
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; form-action 'self'; base-uri 'none'",
        ),
    ];
    match authorized_session(&state.session, &record_id, &token).await {
        Ok(session) => (response_headers, Html(mobile_page(&session))).into_response(),
        Err((status, message)) => {
            (status, response_headers, Html(error_page(&message))).into_response()
        }
    }
}

async fn upload_files(
    Path((record_id, token)): Path<(String, String)>,
    State(state): State<UploadRouterState>,
    mut multipart: Multipart,
) -> Response {
    let session = match authorized_session(&state.session, &record_id, &token).await {
        Ok(session) => session,
        Err(error) => return json_error(error.0, &error.1),
    };
    if session.remaining_slots == 0 {
        return json_error(StatusCode::CONFLICT, "当前报销单已没有可上传位置");
    }

    let mut files = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "上传内容无法解析"),
        };
        if field.name() != Some("files") {
            continue;
        }
        if files.len() >= session.remaining_slots {
            return json_error(StatusCode::CONFLICT, "所选图片超过当前报销单的剩余数量");
        }
        let original_name = field.file_name().unwrap_or("手机图片").to_string();
        let bytes = match field.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "图片读取失败"),
        };
        if bytes.is_empty() {
            return json_error(StatusCode::BAD_REQUEST, "不能上传空图片");
        }
        if bytes.len() > MAX_FILE_BYTES {
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "单张图片不能超过 15 MB");
        }
        let Some(mime_type) = detected_image_mime(&bytes) else {
            return json_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "仅支持 JPEG、PNG、WebP、GIF 或 BMP 图片",
            );
        };
        files.push(LanUploadFile {
            file_name: clean_file_name(&original_name, mime_type, files.len()),
            mime_type: mime_type.to_string(),
            data_url: format!("data:{mime_type};base64,{}", BASE64.encode(bytes)),
        });
    }

    if files.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "请至少选择一张图片");
    }

    let requested_count = files.len();
    let remaining_slots = {
        let mut current = state.session.write().await;
        let Some(current_session) = current.as_mut() else {
            return json_error(StatusCode::GONE, "上传会话已关闭");
        };
        if current_session.record_id != record_id
            || current_session.token != token
            || current_session.expires_at <= now_millis()
        {
            return json_error(StatusCode::GONE, "二维码已失效，请在电脑端重新生成");
        }
        if files.len() > current_session.remaining_slots {
            return json_error(
                StatusCode::CONFLICT,
                "报销单剩余位置已发生变化，请刷新手机页面",
            );
        }
        current_session.remaining_slots -= files.len();
        current_session.remaining_slots
    };

    let mut accepted_count = 0;
    for file in files {
        if state
            .app
            .emit(
                "lan-upload-received",
                LanUploadEvent {
                    record_id: record_id.clone(),
                    remaining_slots,
                    file,
                },
            )
            .is_ok()
        {
            accepted_count += 1;
        }
    }
    let mut response_remaining = remaining_slots;
    let rejected_count = requested_count.saturating_sub(accepted_count);
    if rejected_count > 0 {
        if let Some(current) = state.session.write().await.as_mut() {
            if current.record_id == record_id && current.token == token {
                current.remaining_slots = current
                    .remaining_slots
                    .saturating_add(rejected_count)
                    .min(MAX_FILES);
                response_remaining = current.remaining_slots;
            }
        }
    }
    if accepted_count == 0 {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "电脑端未能接收图片");
    }

    Json(UploadResponse {
        ok: true,
        message: format!("已发送 {accepted_count} 张图片到电脑"),
        accepted_count,
        remaining_slots: response_remaining,
    })
    .into_response()
}

async fn authorized_session(
    state: &Arc<RwLock<Option<UploadSession>>>,
    record_id: &str,
    token: &str,
) -> Result<UploadSession, (StatusCode, String)> {
    let mut current = state.write().await;
    let Some(session) = current.as_ref() else {
        return Err((StatusCode::GONE, "上传会话已关闭".to_string()));
    };
    if session.expires_at <= now_millis() {
        *current = None;
        return Err((
            StatusCode::GONE,
            "二维码已过期，请在电脑端重新生成".to_string(),
        ));
    }
    if session.record_id != record_id || session.token != token {
        return Err((StatusCode::NOT_FOUND, "二维码无效".to_string()));
    }
    Ok(session.clone())
}

fn session_info(session: &UploadSession, address: SocketAddr) -> LanUploadSessionInfo {
    LanUploadSessionInfo {
        url: format!(
            "http://{}/upload/{}/{}",
            address, session.record_id, session.token
        ),
        record_id: session.record_id.clone(),
        label: session.label.clone(),
        expires_at: session.expires_at,
        remaining_slots: session.remaining_slots,
        local_address: address.to_string(),
    }
}

fn preferred_local_ipv4() -> Result<Ipv4Addr, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("读取本机网络失败：{error}"))?;
    socket
        .connect((Ipv4Addr::new(8, 8, 8, 8), 80))
        .map_err(|_| "未找到可用的局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络".to_string())?;
    match socket.local_addr().map(|address| address.ip()) {
        Ok(IpAddr::V4(ip)) if !ip.is_loopback() && !ip.is_unspecified() => Ok(ip),
        _ => Err("未找到可用的局域网 IPv4 地址，请检查网络连接".to_string()),
    }
}

fn detected_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

fn clean_file_name(value: &str, mime_type: &str, index: usize) -> String {
    let name = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect::<String>();
    if !name.trim().is_empty() {
        return name;
    }
    let extension = match mime_type {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "jpg",
    };
    format!("手机图片-{}.{}", index + 1, extension)
}

fn clean_label(value: &str) -> String {
    value.trim().chars().take(30).collect()
}

fn validate_record_id(record_id: &str) -> Result<(), String> {
    if record_id.is_empty()
        || record_id.len() > 120
        || !record_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        return Err("报销单编号格式无效".to_string());
    }
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn default_ttl_seconds() -> u64 {
    DEFAULT_TTL_SECONDS
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "message": message,
        })),
    )
        .into_response()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn mobile_page(session: &UploadSession) -> String {
    let title = if session.label.is_empty() {
        "当前报销单".to_string()
    } else {
        escape_html(&session.label)
    };
    let record_suffix = session
        .record_id
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>SheepFinance 手机上传</title>
  <style>
    *{{box-sizing:border-box}}body{{margin:0;color:#26352f;background:#eef1ef;font-family:"Microsoft YaHei","PingFang SC",sans-serif}}button,input{{font:inherit}}header{{padding:22px 20px 18px;color:#fff;background:#4e7164}}header small{{display:block;margin-bottom:5px;opacity:.75}}header h1{{margin:0;font-size:22px;letter-spacing:0}}header p{{margin:7px 0 0;opacity:.84;font-size:12px}}main{{max-width:620px;margin:0 auto;padding:18px 16px 34px}}.summary{{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #d9e1dc;color:#6b7b74;font-size:12px}}.picker{{display:grid;place-items:center;min-height:128px;margin-top:18px;border:1px dashed #9db2a7;border-radius:8px;color:#48675b;background:#fff;cursor:pointer}}.picker strong{{display:block;margin-bottom:5px;font-size:16px}}.picker span{{font-size:12px;color:#87958f}}#files{{display:none}}.previews{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}}.preview{{position:relative;aspect-ratio:1;overflow:hidden;border-radius:6px;background:#dfe6e2}}.preview img{{width:100%;height:100%;display:block;object-fit:cover}}.preview span{{position:absolute;right:4px;bottom:4px;max-width:calc(100% - 8px);overflow:hidden;padding:2px 5px;color:#fff;background:rgba(28,40,35,.72);font-size:10px;text-overflow:ellipsis;white-space:nowrap}}.action{{width:100%;height:46px;margin-top:16px;border:0;border-radius:8px;color:#fff;background:#c85f47;font-weight:700;cursor:pointer}}.action:disabled{{cursor:not-allowed;opacity:.45}}.status{{min-height:42px;margin-top:12px;padding:10px 12px;border-radius:7px;color:#61726a;background:#f8faf8;font-size:12px;line-height:1.7}}.status.success{{color:#27725c;background:#edf8f3}}.status.error{{color:#a5433c;background:#fff2ef}}footer{{padding-top:22px;color:#95a19b;text-align:center;font-size:11px}}@media(max-width:390px){{.previews{{grid-template-columns:repeat(2,minmax(0,1fr))}}}}
  </style>
</head>
<body>
  <header><small>SHEEPFINANCE</small><h1>{title}</h1><p>报销单 #{record_suffix}</p></header>
  <main>
    <div class="summary"><span>可上传 <b id="remaining">{remaining}</b> 张</span><span id="expires"></span></div>
    <label class="picker" for="files"><div><strong>选择票据图片</strong><span>支持从相册多选</span></div></label>
    <input id="files" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" multiple>
    <div id="previews" class="previews"></div>
    <button id="upload" class="action" type="button" disabled>上传到电脑</button>
    <div id="status" class="status">等待选择图片</div>
    <footer>SheepFinance 局域网上传</footer>
  </main>
  <script>
    const input=document.querySelector('#files');const previews=document.querySelector('#previews');const upload=document.querySelector('#upload');const status=document.querySelector('#status');const remaining=document.querySelector('#remaining');const expires=document.querySelector('#expires');const expiresAt={expires_at};let urls=[];
    function setStatus(text,type=''){{status.textContent=text;status.className='status '+type}}
    function render(){{urls.forEach(URL.revokeObjectURL);urls=[];previews.innerHTML='';const files=[...input.files];upload.disabled=!files.length||files.length>Number(remaining.textContent);files.forEach((file,index)=>{{const url=URL.createObjectURL(file);urls.push(url);const item=document.createElement('div');item.className='preview';const image=document.createElement('img');image.src=url;image.alt=file.name;const label=document.createElement('span');label.textContent=(index+1)+'. '+file.name;item.append(image,label);previews.append(item)}});if(!files.length)setStatus('等待选择图片');else if(files.length>Number(remaining.textContent))setStatus('所选图片超过剩余数量','error');else setStatus('已选择 '+files.length+' 张图片')}}
    function tick(){{const seconds=Math.max(0,Math.floor((expiresAt-Date.now())/1000));expires.textContent=seconds?'二维码剩余 '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'二维码已过期';if(!seconds)upload.disabled=true}}tick();setInterval(tick,1000);input.addEventListener('change',render);
    upload.addEventListener('click',async()=>{{const files=[...input.files];if(!files.length)return;upload.disabled=true;setStatus('正在发送到电脑...');const body=new FormData();files.forEach(file=>body.append('files',file,file.name));try{{const response=await fetch(location.pathname,{{method:'POST',body}});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.message||'上传失败');remaining.textContent=String(result.remainingSlots);input.value='';render();setStatus(result.message,'success')}}catch(error){{setStatus(error.message||'上传失败','error');upload.disabled=false}}}});
  </script>
</body>
</html>"#,
        title = title,
        record_suffix = escape_html(&record_suffix),
        remaining = session.remaining_slots,
        expires_at = session.expires_at,
    )
}

fn error_page(message: &str) -> String {
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>二维码已失效</title><style>body{{display:grid;min-height:100vh;place-items:center;margin:0;padding:24px;color:#35483f;background:#eef1ef;font-family:"Microsoft YaHei",sans-serif}}main{{max-width:420px;text-align:center}}h1{{font-size:22px}}p{{color:#718078;line-height:1.7}}</style></head><body><main><h1>无法继续上传</h1><p>{}</p></main></body></html>"#,
        escape_html(message)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detected_image_mime(&[0xFF, 0xD8, 0xFF, 0x00]),
            Some("image/jpeg")
        );
        assert_eq!(
            detected_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            Some("image/png")
        );
        assert_eq!(detected_image_mime(b"plain text"), None);
    }

    #[test]
    fn sanitizes_html_and_file_names() {
        assert_eq!(escape_html("<a & 'b'>"), "&lt;a &amp; &#39;b&#39;&gt;");
        assert_eq!(
            clean_file_name("C:\\fake\\ticket.jpg", "image/jpeg", 0),
            "ticket.jpg"
        );
    }

    #[test]
    fn validates_record_ids() {
        assert!(validate_record_id("record-123_ab").is_ok());
        assert!(validate_record_id("../record").is_err());
    }

    #[test]
    fn mobile_page_contains_current_session_only() {
        let session = UploadSession {
            record_id: "record-12345678".to_string(),
            label: "办公费<script>".to_string(),
            token: "secret".to_string(),
            expires_at: 123,
            remaining_slots: 4,
        };
        let page = mobile_page(&session);
        assert!(page.contains("办公费&lt;script&gt;"));
        assert!(page.contains("可上传 <b id=\"remaining\">4</b> 张"));
        assert!(!page.contains("secret"));
    }

    #[test]
    fn rejects_old_token_after_session_replacement() {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(async {
                let state = Arc::new(RwLock::new(Some(UploadSession {
                    record_id: "record-token-test".to_string(),
                    label: "办公费".to_string(),
                    token: "old-token".to_string(),
                    expires_at: now_millis() + 60_000,
                    remaining_slots: 2,
                })));
                assert!(authorized_session(&state, "record-token-test", "old-token")
                    .await
                    .is_ok());

                *state.write().await = Some(UploadSession {
                    record_id: "record-token-test".to_string(),
                    label: "办公费".to_string(),
                    token: "new-token".to_string(),
                    expires_at: now_millis() + 60_000,
                    remaining_slots: 2,
                });

                let error = authorized_session(&state, "record-token-test", "old-token")
                    .await
                    .err()
                    .expect("old token should be rejected");
                assert_eq!(error.0, StatusCode::NOT_FOUND);
                assert!(authorized_session(&state, "record-token-test", "new-token")
                    .await
                    .is_ok());
            });
    }
}
