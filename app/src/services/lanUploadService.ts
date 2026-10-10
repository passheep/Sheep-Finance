import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  LanUploadReceivedEvent,
  LanUploadSessionInfo,
} from "../types/models";

export interface StartLanUploadRequest {
  recordId: string;
  targetExpenseId: string | null;
  label: string;
  remainingSlots: number;
  ttlSeconds: number;
}

export interface UpdateLanUploadRequest {
  recordId: string;
  targetExpenseId: string | null;
  label: string;
  remainingSlots: number;
}

export function startLanUploadSession(request: StartLanUploadRequest) {
  return invoke<LanUploadSessionInfo>("start_lan_upload_session", { request });
}

export function updateLanUploadSession(request: UpdateLanUploadRequest) {
  return invoke<void>("update_lan_upload_session", { request });
}

export function stopLanUploadSession() {
  return invoke<void>("stop_lan_upload_session");
}

export function listenLanUploadReceived(
  callback: (payload: LanUploadReceivedEvent) => void,
): Promise<UnlistenFn> {
  return listen<LanUploadReceivedEvent>("lan-upload-received", (event) => {
    callback(event.payload);
  });
}
