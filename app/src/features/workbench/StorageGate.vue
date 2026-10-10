<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { formatDateTime } from "../../utils/format";
import { WarningFilled } from "@element-plus/icons-vue";

const {
  isLoadingWorkspace,
  isTauriRuntime,
  storageReady,
  migrationProgress,
  storageRecoveryError,
  dataDirectory,
  storageBootstrap,
  selectedRecoveryBackup,
  backupStatus,
  formatFileSize,
  openBackupDirectory,
  importFullBackup,
  backupLoading,
  restoreDatabaseBackup,
  reloadApplication,
} = toRefs(useAppContext());
</script>

<template>
  <div
    v-if="isLoadingWorkspace || (isTauriRuntime() && !storageReady)"
    class="storage-gate"
  >
    <section class="storage-gate-panel">
      <template v-if="isLoadingWorkspace">
        <span class="eyebrow">LOCAL STORAGE</span>
        <h1>
          {{ migrationProgress ? "正在迁移旧版数据" : "正在检查本地数据" }}
        </h1>
        <p>{{ migrationProgress?.message || "请勿关闭软件" }}</p>
        <el-progress
          v-if="migrationProgress?.total"
          :percentage="
            Math.round(
              (migrationProgress.current / migrationProgress.total) * 100,
            )
          "
          :stroke-width="10"
        />
        <div v-else class="storage-spinner" />
      </template>
      <template v-else>
        <WarningFilled :size="36" />
        <span class="eyebrow">RECOVERY REQUIRED</span>
        <h1>本地数据未启用</h1>
        <p class="storage-gate-error">{{ storageRecoveryError }}</p>
        <p v-if="dataDirectory" class="storage-gate-path">
          数据目录：{{ dataDirectory }}
        </p>
        <template v-if="storageBootstrap?.status === 'recoveryRequired'">
          <el-select
            v-model="selectedRecoveryBackup"
            placeholder="选择一份可恢复备份"
            class="storage-recovery-select"
          >
            <el-option
              v-for="item in backupStatus?.backups ?? []"
              :key="item.fileName"
              :label="`${formatDateTime(item.createdAt)} · ${formatFileSize(item.sizeBytes)}${item.valid && item.imagesComplete ? '' : ' · 不可用'}`"
              :value="item.fileName"
              :disabled="!item.valid || !item.imagesComplete"
            />
          </el-select>
          <div class="storage-gate-actions">
            <el-button @click="openBackupDirectory">打开备份目录</el-button>
            <el-button @click="importFullBackup">导入完整备份</el-button>
            <el-button
              type="primary"
              :loading="backupLoading"
              :disabled="!selectedRecoveryBackup"
              @click="restoreDatabaseBackup()"
              >恢复选中备份</el-button
            >
          </div>
        </template>
        <template v-else>
          <div
            v-if="storageBootstrap?.corruptFiles.length"
            class="storage-file-list"
          >
            <span v-for="file in storageBootstrap.corruptFiles" :key="file">{{
              file
            }}</span>
          </div>
          <el-button type="primary" @click="reloadApplication"
            >重新检查</el-button
          >
        </template>
      </template>
    </section>
  </div>
</template>
