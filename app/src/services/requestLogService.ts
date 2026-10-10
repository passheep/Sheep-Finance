import { invoke } from "@tauri-apps/api/core";
import type { RequestLogRecord, RequestLogSummary } from "../types/models";

export function listRequestLogs() {
  return invoke<RequestLogSummary[]>("list_request_logs");
}

export function getRequestLog(id: string) {
  return invoke<RequestLogRecord>("get_request_log", { id });
}

export function clearRequestLogs() {
  return invoke<void>("clear_request_logs");
}
