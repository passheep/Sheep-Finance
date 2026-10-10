import { type Ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  open as tauriOpen,
  save as tauriSave,
} from "@tauri-apps/plugin-dialog";
import { today } from "../utils/format";
import type { BackupStatus, DatabaseBackupItem } from "../types/models";
import {
  cleanupLegacyArchives as cleanupLegacyArchivesService,
  createDatabaseBackup as createDatabaseBackupService,
  exportFullBackup as exportFullBackupService,
  getBackupStatus,
  importFullBackup as importFullBackupService,
  openBackupDirectory as openBackupDirectoryService,
  restoreDatabaseBackup as restoreDatabaseBackupService,
} from "../services/backupService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";

export interface BackupsContext {
  backupStatus: Ref<BackupStatus | null>;
  backupLoading: Ref<boolean>;
  selectedRecoveryBackup: Ref<string>;
  storageReady: Ref<boolean>;
  storageRecoveryError: Ref<string>;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
}

export function useBackups(context: BackupsContext) {
  const {
    backupStatus,
    backupLoading,
    selectedRecoveryBackup,
    storageReady,
    storageRecoveryError,
    persistDraft,
  } = context;

  function formatFileSize(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024)
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  async function loadBackupStatus() {
    if (!isTauriRuntime()) return;
    try {
      backupStatus.value = await getBackupStatus();
      if (
        !selectedRecoveryBackup.value ||
        !backupStatus.value.backups.some(
          (item) => item.fileName === selectedRecoveryBackup.value,
        )
      ) {
        selectedRecoveryBackup.value =
          backupStatus.value.backups.find(
            (item) => item.valid && item.imagesComplete,
          )?.fileName ?? "";
      }
    } catch (error) {
      backupStatus.value = null;
      storageRecoveryError.value =
        `${storageRecoveryError.value}\n${errorMessage(error)}`.trim();
    }
  }

  async function createDatabaseBackup() {
    if (!isTauriRuntime()) return;
    backupLoading.value = true;
    try {
      if (!(await persistDraft(false)))
        throw new Error("当前单据保存失败，已取消数据库备份");
      await createDatabaseBackupService();
      await loadBackupStatus();
      ElMessage.success("数据库备份已创建并通过完整性检查");
    } catch (error) {
      ElMessage.error(`数据库备份失败：${errorMessage(error)}`);
    } finally {
      backupLoading.value = false;
    }
  }

  async function restoreDatabaseBackup(item?: DatabaseBackupItem) {
    const target =
      item ??
      backupStatus.value?.backups.find(
        (value) => value.fileName === selectedRecoveryBackup.value,
      );
    if (!target || !target.valid || !target.imagesComplete) {
      ElMessage.warning("请选择一份数据库和图片都完整的备份");
      return;
    }
    try {
      await ElMessageBox.confirm(
        `将恢复备份 ${target.fileName}。当前数据库文件会先保留为 recovery-preserved 文件，是否继续？`,
        "恢复数据库",
        {
          confirmButtonText: "恢复",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      backupLoading.value = true;
      if (storageReady.value && !(await persistDraft(false)))
        throw new Error("当前单据保存失败，已取消数据库恢复");
      await restoreDatabaseBackupService(target.fileName);
      window.location.reload();
    } catch (error) {
      if (error !== "cancel" && error !== "close")
        ElMessage.error(`恢复数据库失败：${errorMessage(error)}`);
    } finally {
      backupLoading.value = false;
    }
  }

  async function openBackupDirectory() {
    try {
      await openBackupDirectoryService();
    } catch (error) {
      ElMessage.error(errorMessage(error));
    }
  }

  async function exportFullBackup() {
    const destination = await tauriSave({
      defaultPath: `报销单助手-完整备份-${today()}.zip`,
      filters: [{ name: "ZIP 备份", extensions: ["zip"] }],
    });
    if (!destination) return;
    backupLoading.value = true;
    try {
      if (!(await persistDraft(false)))
        throw new Error("当前单据保存失败，已取消完整备份导出");
      await exportFullBackupService(destination);
      ElMessage.success("完整备份已导出，其中包含 API 密钥，请妥善保管");
    } catch (error) {
      ElMessage.error(`完整备份导出失败：${errorMessage(error)}`);
    } finally {
      backupLoading.value = false;
    }
  }

  async function importFullBackup() {
    const selected = await tauriOpen({
      multiple: false,
      directory: false,
      filters: [{ name: "ZIP 备份", extensions: ["zip"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      await ElMessageBox.confirm(
        "导入前会校验数据库、图片和哈希清单，并先备份当前数据库。导入后软件将重新加载，是否继续？",
        "导入完整备份",
        {
          confirmButtonText: "导入",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      backupLoading.value = true;
      if (storageReady.value && !(await persistDraft(false)))
        throw new Error("当前单据保存失败，已取消完整备份导入");
      await importFullBackupService(selected);
      window.location.reload();
    } catch (error) {
      if (error !== "cancel" && error !== "close")
        ElMessage.error(`完整备份导入失败：${errorMessage(error)}`);
    } finally {
      backupLoading.value = false;
    }
  }

  async function cleanupLegacyArchives() {
    const archives = backupStatus.value?.legacyArchives ?? [];
    if (!archives.length) return;
    const size = archives.reduce((sum, item) => sum + item.sizeBytes, 0);
    try {
      await ElMessageBox.confirm(
        `将永久删除 ${archives.length} 个旧 JSON 归档（${formatFileSize(size)}）。已迁移的数据库和图片不受影响，是否继续？`,
        "清理旧数据",
        {
          confirmButtonText: "永久删除",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      const removed = await cleanupLegacyArchivesService();
      await loadBackupStatus();
      ElMessage.success(`已清理 ${formatFileSize(removed)} 旧数据`);
    } catch (error) {
      if (error !== "cancel" && error !== "close")
        ElMessage.error(errorMessage(error));
    }
  }

  return {
    formatFileSize,
    loadBackupStatus,
    createDatabaseBackup,
    restoreDatabaseBackup,
    openBackupDirectory,
    exportFullBackup,
    importFullBackup,
    cleanupLegacyArchives,
  };
}
