use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use time::{macros::format_description, OffsetDateTime};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

const ALIYUN_API_VERSION: &str = "2021-07-07";
const ADVANCED_OCR_QUERY: &str = "NeedRotate=true&NeedSortPage=true&Paragraph=true&Row=true";
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const EXTRACTION_SYSTEM_PROMPT: &str = concat!(
    "你是严格的中文报销单据字段提取器。只根据 OCR 原文提取，不得编造。",
    "不要输出分析、思考过程或 reasoning_content。无论信息是否完整，都必须返回且只能返回一个合法 JSON 对象，禁止 Markdown、解释、前后缀和空响应。",
    "JSON 必须包含 occurredDate、reasonName、description、amount、confidence、evidence 六个键；",
    "无法确定的标量填 null，confidence 和 evidence 无内容时填空对象。",
    "occurredDate 使用 YYYY-MM-DD，优先取支付时间或交易时间；",
    "reasonName 必须严格选自给定事由字典，不能确定时填 null；",
    "description 用简短中文概括商品、服务或商户；",
    "amount 是本笔可报销的实际支付金额，返回正数两位小数字符串，支付截图中的支出负号要去掉；",
    "金额中的英文逗号或中文全角逗号可能是千分位，例如 1,546.69 或 1，546.69 都表示 1546.69，不能截断；",
    "优先取实付、支付金额、付款金额或合计，不要把优惠金额、商品原价、余额或授信额度当作实付。"
);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionRequest {
    pub image_data_url: String,
    pub ocr_mode: OcrMode,
    pub ocr_profile: OcrProfile,
    pub llm_profile: LlmProfile,
    #[serde(default)]
    pub reason_dictionary: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrProfile {
    pub name: String,
    pub endpoint: String,
    pub region: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProfile {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrMode {
    Advanced,
    Handwriting,
}

impl OcrMode {
    fn action(self) -> &'static str {
        match self {
            Self::Advanced => "RecognizeAdvanced",
            Self::Handwriting => "RecognizeHandwriting",
        }
    }

    fn query(self) -> &'static str {
        match self {
            Self::Advanced => ADVANCED_OCR_QUERY,
            Self::Handwriting => "",
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedExpense {
    pub occurred_date: Option<String>,
    pub reason_name: Option<String>,
    pub description: Option<String>,
    pub amount_cents: Option<i64>,
    pub confidence: Value,
    pub evidence: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionResponse {
    pub ocr_text: String,
    pub llm_text: Option<String>,
    pub extracted: Option<ExtractedExpense>,
    pub ocr_profile_name: String,
    pub llm_profile_name: String,
    pub ocr_elapsed_ms: u128,
    pub llm_elapsed_ms: u128,
    pub llm_error: Option<String>,
}

#[tauri::command]
pub async fn recognize_expense(request: RecognitionRequest) -> Result<RecognitionResponse, String> {
    validate_request(&request)?;
    let image = decode_image_data_url(&request.image_data_url)?;
    let ocr_started = Instant::now();
    let ocr_text = call_aliyun_ocr(&request.ocr_profile, request.ocr_mode, image).await?;
    let ocr_elapsed_ms = ocr_started.elapsed().as_millis();

    if ocr_text.trim().is_empty() {
        return Err("OCR 请求成功，但未识别到文字".to_string());
    }

    let llm_started = Instant::now();
    let extraction = call_llm(&request.llm_profile, &ocr_text, &request.reason_dictionary).await;
    let llm_elapsed_ms = llm_started.elapsed().as_millis();
    let (extracted, llm_text, llm_error) = match extraction {
        Ok((value, content)) => (Some(value), Some(content), None),
        Err((message, content)) => (None, content, Some(message)),
    };

    Ok(RecognitionResponse {
        ocr_text,
        llm_text,
        extracted,
        ocr_profile_name: request.ocr_profile.name,
        llm_profile_name: request.llm_profile.name,
        ocr_elapsed_ms,
        llm_elapsed_ms,
        llm_error,
    })
}

fn default_timeout_seconds() -> u64 {
    30
}

fn validate_request(request: &RecognitionRequest) -> Result<(), String> {
    if request.ocr_profile.access_key_id.trim().is_empty()
        || request.ocr_profile.access_key_secret.trim().is_empty()
    {
        return Err("请先填写阿里云 OCR 的 AccessKey ID 和 AccessKey Secret".to_string());
    }
    if request.llm_profile.api_key.trim().is_empty() || request.llm_profile.model.trim().is_empty()
    {
        return Err("请先填写大模型 API Key 和模型名称".to_string());
    }
    Ok(())
}

fn decode_image_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (metadata, content) = data_url
        .split_once(',')
        .ok_or_else(|| "识别图片数据格式无效".to_string())?;
    if !metadata.starts_with("data:image/") || !metadata.ends_with(";base64") {
        return Err("识别图片必须是 Base64 图片数据".to_string());
    }
    let bytes = BASE64
        .decode(content)
        .map_err(|_| "识别图片 Base64 解码失败".to_string())?;
    if bytes.is_empty() {
        return Err("识别图片内容为空".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("识别图片超过 10 MB，请重新压缩后再试".to_string());
    }
    Ok(bytes)
}

async fn call_aliyun_ocr(
    profile: &OcrProfile,
    mode: OcrMode,
    image: Vec<u8>,
) -> Result<String, String> {
    let mut endpoint = normalized_endpoint(&profile.endpoint, "阿里云 OCR")?;
    let canonical_query = mode.query();
    if !canonical_query.is_empty() {
        endpoint.set_query(Some(canonical_query));
    }
    let host = endpoint
        .host_str()
        .ok_or_else(|| "阿里云 OCR 服务地址缺少主机名".to_string())?;
    let action = mode.action();
    let date = aliyun_timestamp(OffsetDateTime::now_utc())?;
    let nonce = Uuid::new_v4().to_string();
    let payload_hash = sha256_hex(&image);
    let canonical_uri = if endpoint.path().is_empty() {
        "/"
    } else {
        endpoint.path()
    };
    let (canonical_headers, signed_headers) = if profile.region.trim().is_empty() {
        (
            format!(
                "host:{host}\nx-acs-action:{action}\nx-acs-content-sha256:{payload_hash}\nx-acs-date:{date}\nx-acs-signature-nonce:{nonce}\nx-acs-version:{ALIYUN_API_VERSION}\n"
            ),
            "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version".to_string(),
        )
    } else {
        (
            format!(
                "host:{host}\nx-acs-action:{action}\nx-acs-content-sha256:{payload_hash}\nx-acs-date:{date}\nx-acs-region-id:{}\nx-acs-signature-nonce:{nonce}\nx-acs-version:{ALIYUN_API_VERSION}\n",
                profile.region.trim()
            ),
            "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-region-id;x-acs-signature-nonce;x-acs-version".to_string(),
        )
    };
    let canonical_request = format!(
        "POST\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let string_to_sign = format!(
        "ACS3-HMAC-SHA256\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let signature = hmac_sha256_hex(
        profile.access_key_secret.trim().as_bytes(),
        string_to_sign.as_bytes(),
    )?;
    let authorization = format!(
        "ACS3-HMAC-SHA256 Credential={},SignedHeaders={},Signature={}",
        profile.access_key_id.trim(),
        signed_headers,
        signature
    );

    let timeout = Duration::from_secs(profile.timeout_seconds.clamp(5, 180));
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "创建 OCR 网络客户端失败".to_string())?;
    let mut request = client
        .post(endpoint)
        .header("content-type", "application/octet-stream")
        .header("x-acs-action", action)
        .header("x-acs-version", ALIYUN_API_VERSION)
        .header("x-acs-date", date)
        .header("x-acs-signature-nonce", nonce)
        .header("x-acs-content-sha256", payload_hash)
        .header("authorization", authorization);
    if !profile.region.trim().is_empty() {
        request = request.header("x-acs-region-id", profile.region.trim());
    }
    let response = request
        .body(image)
        .send()
        .await
        .map_err(|error| network_error("阿里云 OCR", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "读取阿里云 OCR 响应失败".to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|_| {
        format!(
            "阿里云 OCR 返回了无法解析的响应（HTTP {}）",
            status.as_u16()
        )
    })?;
    if !status.is_success() {
        return Err(api_error("阿里云 OCR", status.as_u16(), &value));
    }
    extract_ocr_text(&value).ok_or_else(|| "阿里云 OCR 响应中缺少文字内容".to_string())
}

async fn call_llm(
    profile: &LlmProfile,
    ocr_text: &str,
    reasons: &[String],
) -> Result<(ExtractedExpense, String), (String, Option<String>)> {
    let endpoint =
        chat_completions_endpoint(&profile.base_url).map_err(|message| (message, None))?;
    let reason_json = serde_json::to_string(reasons).unwrap_or_else(|_| "[]".to_string());
    let user_prompt = format!(
        "事由字典：{reason_json}\n\nOCR 原文：\n{ocr_text}\n\n严格按此结构返回 JSON：{{\"occurredDate\":null,\"reasonName\":null,\"description\":null,\"amount\":null,\"confidence\":{{}},\"evidence\":{{}}}}"
    );
    let request_body = llm_request_body(profile, &endpoint, &user_prompt);
    let timeout = Duration::from_secs(profile.timeout_seconds.clamp(5, 180));
    let client = Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| ("创建大模型网络客户端失败".to_string(), None))?;
    let first_response = send_llm_request(&client, &endpoint, profile, &request_body)
        .await
        .map_err(|message| (message, None))?;
    let first_content = extract_llm_content(&first_response);
    let first_error = match first_content.as_deref() {
        Some(content) => match parse_extracted_expense(content, reasons) {
            Ok(extracted) => return Ok((extracted, normalized_json_record(content))),
            Err(message) => message,
        },
        None => "大模型响应中没有可用文本内容".to_string(),
    };
    let first_record = first_content.as_deref().unwrap_or("未返回 content");

    let retry_prompt = format!(
        "上一次响应未通过 JSON 校验：{first_error}\n\n事由字典：{reason_json}\n\nOCR 原文：\n{ocr_text}\n\n上一次响应记录：\n{first_record}\n\n重新提取并只返回一个合法 JSON 对象。必须包含 occurredDate、reasonName、description、amount、confidence、evidence。"
    );
    let retry_body = llm_request_body(profile, &endpoint, &retry_prompt);
    let retry_response = send_llm_request(&client, &endpoint, profile, &retry_body)
        .await
        .map_err(|message| {
            (
                format!("{first_error}；严格 JSON 重试失败：{message}"),
                None,
            )
        })?;
    let retry_content = extract_llm_content(&retry_response)
        .ok_or_else(|| ("大模型严格重试后仍未返回可用文本内容".to_string(), None))?;
    let extracted = parse_extracted_expense(&retry_content, reasons).map_err(|message| {
        (
            format!("大模型严格重试后仍未返回合法 JSON：{message}"),
            None,
        )
    })?;
    Ok((extracted, normalized_json_record(&retry_content)))
}

fn llm_request_body(profile: &LlmProfile, endpoint: &Url, user_prompt: &str) -> Value {
    let mut body = json!({
        "model": profile.model.trim(),
        "messages": [
            { "role": "system", "content": EXTRACTION_SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0,
        "max_tokens": 700,
        "stream": false
    });
    if endpoint
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("api.deepseek.com"))
    {
        body["thinking"] = json!({ "type": "disabled" });
    }
    body
}

async fn send_llm_request(
    client: &Client,
    endpoint: &Url,
    profile: &LlmProfile,
    request_body: &Value,
) -> Result<Value, String> {
    let response = client
        .post(endpoint.clone())
        .bearer_auth(profile.api_key.trim())
        .json(request_body)
        .send()
        .await
        .map_err(|error| network_error("大模型", error))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "读取大模型响应失败".to_string())?;
    let value: Value = serde_json::from_str(&body)
        .map_err(|_| format!("大模型返回了无法解析的响应（HTTP {}）", status.as_u16()))?;
    if !status.is_success() {
        return Err(api_error("大模型", status.as_u16(), &value));
    }
    Ok(value)
}

fn extract_llm_content(response: &Value) -> Option<String> {
    [
        response.pointer("/choices/0/message/content"),
        response.pointer("/choices/0/text"),
        response.get("output_text"),
    ]
    .into_iter()
    .flatten()
    .find_map(content_value_text)
}

fn content_value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| text.trim().to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(content_value_text)
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        Value::Object(object) => ["text", "content", "output_text", "value"]
            .into_iter()
            .filter_map(|key| object.get(key))
            .find_map(content_value_text),
        _ => None,
    }
}

fn normalized_json_record(content: &str) -> String {
    first_json_object(content)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| content.trim().to_string())
}

fn normalized_endpoint(value: &str, service: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| format!("{service} 服务地址格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{service} 服务地址只支持 HTTP 或 HTTPS"));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn chat_completions_endpoint(base_url: &str) -> Result<Url, String> {
    let mut url = normalized_endpoint(base_url, "大模型")?;
    let current = url.path().trim_end_matches('/');
    if !current.ends_with("/chat/completions") {
        let next = if current.is_empty() {
            "/chat/completions".to_string()
        } else {
            format!("{current}/chat/completions")
        };
        url.set_path(&next);
    }
    Ok(url)
}

fn extract_ocr_text(response: &Value) -> Option<String> {
    let data = response.get("Data").or_else(|| response.get("data"))?;
    let parsed = match data {
        Value::String(value) => serde_json::from_str(value).unwrap_or_else(|_| {
            json!({
                "content": value
            })
        }),
        other => other.clone(),
    };
    join_ocr_items(&parsed, &["prism_rowsInfo", "rowsInfo", "RowsInfo"])
        .or_else(|| {
            join_ocr_items(
                &parsed,
                &["prism_paragraphsInfo", "paragraphsInfo", "ParagraphsInfo"],
            )
        })
        .or_else(|| {
            parsed
                .get("content")
                .or_else(|| parsed.get("Content"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| join_ocr_items(&parsed, &["prism_wordsInfo", "wordsInfo", "WordsInfo"]))
}

fn join_ocr_items(value: &Value, keys: &[&str]) -> Option<String> {
    let items = keys
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))?;
    let text = items
        .iter()
        .filter_map(|item| item.get("word").or_else(|| item.get("text")))
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn parse_extracted_expense(content: &str, reasons: &[String]) -> Result<ExtractedExpense, String> {
    let trimmed = content.trim();
    let json_object = first_json_object(trimmed).ok_or_else(|| {
        if trimmed.contains('{') {
            "大模型返回的 JSON 对象不完整".to_string()
        } else {
            "大模型没有返回 JSON 对象".to_string()
        }
    })?;
    let value: Value =
        serde_json::from_str(json_object).map_err(|_| "大模型返回的 JSON 格式无效".to_string())?;
    let occurred_date = optional_string(&value, "occurredDate").filter(|date| valid_date(date));
    let reason_name = optional_string(&value, "reasonName")
        .filter(|reason| reasons.iter().any(|item| item == reason));
    let description = optional_string(&value, "description");
    let amount_cents = value.get("amount").and_then(|amount| match amount {
        Value::String(value) => decimal_to_cents(value),
        Value::Number(value) => decimal_to_cents(&value.to_string()),
        _ => None,
    });
    Ok(ExtractedExpense {
        occurred_date,
        reason_name,
        description,
        amount_cents,
        confidence: value
            .get("confidence")
            .cloned()
            .unwrap_or_else(|| json!({})),
        evidence: value.get("evidence").cloned().unwrap_or_else(|| json!({})),
    })
}

fn first_json_object(content: &str) -> Option<&str> {
    let mut start = None;
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in content.char_indices() {
        if start.is_none() {
            if character == '{' {
                start = Some(index);
                depth = 1;
            }
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return start.map(|start| &content[start..=index]);
                }
            }
            _ => {}
        }
    }
    None
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let year = value[0..4].parse::<i32>().ok();
    let month = value[5..7].parse::<u8>().ok();
    let day = value[8..10].parse::<u8>().ok();
    match (year, month, day) {
        (Some(year), Some(month), Some(day)) => {
            (1900..=2200).contains(&year)
                && (1..=12).contains(&month)
                && day >= 1
                && day <= days_in_month(year, month)
        }
        _ => false,
    }
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn decimal_to_cents(value: &str) -> Option<i64> {
    let normalized = value.trim().replace([',', '，', '￥', '¥', '元', ' '], "");
    if normalized.is_empty() || normalized.starts_with('-') {
        return None;
    }
    let (yuan, fraction) = normalized.split_once('.').unwrap_or((&normalized, ""));
    if yuan.is_empty() || !yuan.chars().all(|value| value.is_ascii_digit()) {
        return None;
    }
    if !fraction.chars().all(|value| value.is_ascii_digit()) || fraction.len() > 2 {
        return None;
    }
    let yuan = yuan.parse::<i64>().ok()?;
    let fraction = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<i64>().ok()? * 10,
        _ => fraction.parse::<i64>().ok()?,
    };
    yuan.checked_mul(100)?.checked_add(fraction)
}

fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn aliyun_timestamp(value: OffsetDateTime) -> Result<String, String> {
    value
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
        ))
        .map_err(|_| "生成请求时间失败".to_string())
}

fn hmac_sha256_hex(key: &[u8], value: &[u8]) -> Result<String, String> {
    let mut mac =
        HmacSha256::new_from_slice(key).map_err(|_| "生成阿里云请求签名失败".to_string())?;
    mac.update(value);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn network_error(service: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("{service} 请求超时")
    } else if error.is_connect() {
        format!("无法连接到{service}服务，请检查网络和服务地址")
    } else {
        format!("{service} 请求失败：{error}")
    }
}

fn api_error(service: &str, status: u16, value: &Value) -> String {
    let code = value
        .get("Code")
        .or_else(|| value.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("UnknownError");
    let message = value
        .get("Message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("服务返回错误");
    format!("{service} 请求失败（HTTP {status}，{code}）：{message}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_aliyun_data() {
        let value = json!({ "Data": "{\"content\":\"第一行\\n第二行\"}" });
        assert_eq!(extract_ocr_text(&value).as_deref(), Some("第一行\n第二行"));
    }

    #[test]
    fn prefers_aliyun_rows_and_falls_back_to_paragraphs() {
        let rows = json!({
            "Data": serde_json::to_string(&json!({
                "content": "无格式全文",
                "prism_paragraphsInfo": [{ "word": "段落内容" }],
                "prism_rowsInfo": [{ "word": "第一行" }, { "word": "第二行" }]
            })).expect("ocr data")
        });
        assert_eq!(extract_ocr_text(&rows).as_deref(), Some("第一行\n第二行"));

        let paragraphs = json!({
            "Data": {
                "content": "无格式全文",
                "prism_paragraphsInfo": [{ "word": "第一段" }, { "word": "第二段" }]
            }
        });
        assert_eq!(
            extract_ocr_text(&paragraphs).as_deref(),
            Some("第一段\n第二段")
        );
    }

    #[test]
    fn advanced_ocr_enables_layout_parameters_only() {
        assert_eq!(OcrMode::Advanced.query(), ADVANCED_OCR_QUERY);
        assert_eq!(OcrMode::Handwriting.query(), "");
    }

    #[test]
    fn validates_and_normalizes_model_result() {
        let result = parse_extracted_expense(
            "```json\n{\"occurredDate\":\"2026-08-07\",\"reasonName\":\"办公费\",\"description\":\"购买纸张\",\"amount\":\"1,028.50\"}\n```",
            &["办公费".to_string(), "差旅费".to_string()],
        )
        .expect("valid result");
        assert_eq!(result.occurred_date.as_deref(), Some("2026-08-07"));
        assert_eq!(result.reason_name.as_deref(), Some("办公费"));
        assert_eq!(result.amount_cents, Some(102_850));
        assert_eq!(decimal_to_cents("￥1，546.69"), Some(154_669));
        assert!(EXTRACTION_SYSTEM_PROMPT.contains("1,546.69"));
    }

    #[test]
    fn rejects_reason_outside_dictionary_and_bad_date() {
        let result = parse_extracted_expense(
            "{\"occurredDate\":\"2026-02-30\",\"reasonName\":\"其他\",\"amount\":\"12.3\"}",
            &["办公费".to_string()],
        )
        .expect("valid json");
        assert_eq!(result.occurred_date, None);
        assert_eq!(result.reason_name, None);
        assert_eq!(result.amount_cents, Some(1230));
    }

    #[test]
    fn extracts_array_style_llm_content() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "{\"amount\":\"18.20\"," },
                        { "type": "text", "text": "\"confidence\":{},\"evidence\":{}}" }
                    ]
                }
            }]
        });
        assert_eq!(
            extract_llm_content(&response).as_deref(),
            Some("{\"amount\":\"18.20\",\n\"confidence\":{},\"evidence\":{}}")
        );
    }

    #[test]
    fn ignores_reasoning_and_keeps_legacy_text_compatibility() {
        let reasoning = json!({
            "choices": [{ "message": { "content": null, "reasoning_content": "{\"amount\":\"9.90\"}" } }]
        });
        assert!(extract_llm_content(&reasoning).is_none());
        let legacy = json!({ "choices": [{ "text": "{\"amount\":\"8.80\"}" }] });
        assert_eq!(
            extract_llm_content(&legacy).as_deref(),
            Some("{\"amount\":\"8.80\"}")
        );
    }

    #[test]
    fn deepseek_request_disables_thinking_and_requires_json() {
        let profile = LlmProfile {
            name: "DeepSeek".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            timeout_seconds: 30,
        };
        let endpoint = chat_completions_endpoint(&profile.base_url).expect("endpoint");
        let request = llm_request_body(&profile, &endpoint, "返回 JSON");
        assert_eq!(
            request.pointer("/response_format/type"),
            Some(&json!("json_object"))
        );
        assert_eq!(request.pointer("/thinking/type"), Some(&json!("disabled")));

        let openai = Url::parse("https://api.openai.com/v1/chat/completions").expect("url");
        let request = llm_request_body(&profile, &openai, "返回 JSON");
        assert!(request.get("thinking").is_none());
    }

    #[test]
    fn keeps_only_normalized_json_as_ai_record() {
        assert_eq!(
            normalized_json_record("说明：```json\n{\"amount\":\"18.20\"}\n```"),
            "{\n  \"amount\": \"18.20\"\n}"
        );
    }

    #[test]
    fn parses_first_balanced_json_object_only() {
        let result = parse_extracted_expense(
            "说明 {\"description\":\"商品包含 { 型号 }\",\"amount\":\"20.00\"} 后续 {不是结果}",
            &[],
        )
        .expect("first object");
        assert_eq!(result.description.as_deref(), Some("商品包含 { 型号 }"));
        assert_eq!(result.amount_cents, Some(2000));
    }

    #[test]
    fn appends_chat_completions_path_once() {
        assert_eq!(
            chat_completions_endpoint("https://api.deepseek.com/v1")
                .expect("url")
                .as_str(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_endpoint("https://example.com/v1/chat/completions")
                .expect("url")
                .as_str(),
            "https://example.com/v1/chat/completions"
        );
    }

    #[test]
    fn data_url_limit_is_enforced() {
        assert_eq!(
            decode_image_data_url("data:image/png;base64,SGVsbG8=").expect("decode"),
            b"Hello"
        );
    }

    #[test]
    fn aliyun_timestamp_uses_second_precision_utc_format() {
        let value = OffsetDateTime::from_unix_timestamp(0).expect("unix epoch");
        assert_eq!(
            aliyun_timestamp(value).expect("timestamp"),
            "1970-01-01T00:00:00Z"
        );
    }
}
