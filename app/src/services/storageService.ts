import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Draft,
  HistoryQueryResult,
  LoadedWorkspace,
  MigrationProgress,
  Profile,
  OcrProfile,
  LlmProfile,
  StorageBootstrapResult,
  HistoryViewMode,
} from "../types/models";

export interface SaveWorkspaceRequest {
  draft: Draft;
  profiles: Profile[];
  dictionaries: {
    companies: string[];
    reasons: string[];
    arrangers: string[];
    defaultCompany: string;
    defaultReason: string;
    defaultArranger: string;
  };
  services: { ocrProfiles: OcrProfile[]; llmProfiles: LlmProfile[] };
  uiPreferences: { leftPanelWidth: number; historyViewMode: HistoryViewMode };
}

export function bootstrapStorage(allowDefaultSettings: boolean) {
  return invoke<StorageBootstrapResult>("bootstrap_storage", {
    allowDefaultSettings,
  });
}

export function scheduleStorageBackup() {
  return invoke<boolean>("schedule_storage_backup");
}

export function saveWorkspace(request: SaveWorkspaceRequest) {
  return invoke<void>("save_workspace", { request });
}

export function loadWorkspace() {
  return invoke<LoadedWorkspace>("load_workspace");
}

export function loadRecord(recordId: string) {
  return invoke<Draft>("load_record", { recordId });
}

export function deleteRecord(recordId: string) {
  return invoke<void>("delete_record", { recordId });
}

export function updateRecordStatus(recordId: string, status: string) {
  return invoke<void>("update_record_status", { recordId, status });
}

export function queryHistory(query: {
  keyword: string;
  date: string;
  status: string;
  folderKind: string;
  folderKey: string;
  page: number;
  pageSize: number;
}) {
  return invoke<HistoryQueryResult>("query_history", { query });
}

export function listenStorageMigrationProgress(
  callback: (payload: MigrationProgress) => void,
): Promise<UnlistenFn> {
  return listen<MigrationProgress>("storage-migration-progress", (event) => {
    callback(event.payload);
  });
}

export function listenBackupFailure(
  callback: (message: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("database-backup-failed", (event) => {
    callback(event.payload);
  });
}
