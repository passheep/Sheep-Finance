import { invoke } from "@tauri-apps/api/core";
import type { AttachmentBytes, StoredAttachment } from "../types/models";

export function readAttachment(blobHash: string) {
  return invoke<AttachmentBytes>("read_attachment", { blobHash });
}

export function storeAttachment(request: {
  recordId: string;
  dataUrl: string;
  recognitionDataUrl?: string;
  naturalWidth: number;
  naturalHeight: number;
}) {
  return invoke<StoredAttachment>("store_attachment", { request });
}

export function saveAttachmentAs(blobHash: string, destination: string) {
  return invoke<void>("save_attachment_as", { blobHash, destination });
}

export function openAttachmentFolder(blobHash: string, recordId: string) {
  return invoke<void>("open_attachment_folder", { blobHash, recordId });
}

export function cleanupOrphanImages() {
  return invoke<number>("cleanup_orphan_images");
}
