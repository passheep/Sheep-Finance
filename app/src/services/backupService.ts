import { invoke } from "@tauri-apps/api/core";
import type { BackupStatus, DatabaseBackupItem } from "../types/models";

export function getBackupStatus() {
  return invoke<BackupStatus>("get_backup_status");
}

export function createDatabaseBackup() {
  return invoke<DatabaseBackupItem>("create_database_backup");
}

export function restoreDatabaseBackup(fileName: string) {
  return invoke<void>("restore_database_backup", { fileName });
}

export function openBackupDirectory() {
  return invoke<void>("open_backup_directory");
}

export function exportFullBackup(destination: string) {
  return invoke<void>("export_full_backup", { destination });
}

export function importFullBackup(source: string) {
  return invoke<void>("import_full_backup", { source });
}

export function cleanupLegacyArchives() {
  return invoke<number>("cleanup_legacy_archives");
}
