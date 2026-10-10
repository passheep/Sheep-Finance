<script setup lang="ts">
import { reactive, toRefs } from "vue";
import {
  Check,
  Clock,
  Connection,
  DocumentAdd,
  Download,
  InfoFilled,
  Printer,
  Setting,
  WarningFilled,
} from "@element-plus/icons-vue";
import RequestLogsPage from "./components/RequestLogsPage.vue";
import StorageGate from "./features/workbench/StorageGate.vue";
import WorkbenchPage from "./features/workbench/WorkbenchPage.vue";
import WorkbenchDialogs from "./features/workbench/WorkbenchDialogs.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import ApplicantProfiles from "./features/settings/ApplicantProfiles.vue";
import HistoryPage from "./features/history/HistoryPage.vue";
import AboutPage from "./features/about/AboutPage.vue";
import { provideAppContext } from "./composables/appContext";
import { useSheepFinanceApp } from "./composables/useSheepFinanceApp";

const workbench = reactive(useSheepFinanceApp());
provideAppContext(workbench);
const {
  activeTab,
  switchTab,
  isSaved,
  saveText,
  newRecord,
  saveDraft,
  printCurrentPage,
  exportExcel,
  isExportingPdf,
  exportPdf,
} = toRefs(workbench);
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'reimbursement-active': activeTab === 'reimbursement' }"
    @contextmenu.prevent
  >
    <StorageGate />
    <header class="topbar">
      <nav class="main-tabs" aria-label="主功能导航">
        <button
          class="main-tab"
          :class="{ active: activeTab === 'reimbursement' }"
          type="button"
          @click="switchTab('reimbursement')"
        >
          <DocumentAdd :size="17" />报销
        </button>
        <button
          class="main-tab"
          :class="{ active: activeTab === 'history' }"
          type="button"
          @click="switchTab('history')"
        >
          <Clock :size="17" />历史记录
        </button>
        <button
          class="main-tab"
          :class="{ active: activeTab === 'requests' }"
          type="button"
          @click="switchTab('requests')"
        >
          <Connection :size="17" />请求记录
        </button>
        <button
          class="main-tab"
          :class="{ active: activeTab === 'settings' }"
          type="button"
          @click="switchTab('settings')"
        >
          <Setting :size="17" />设置
        </button>
        <button
          class="main-tab"
          :class="{ active: activeTab === 'about' }"
          type="button"
          @click="switchTab('about')"
        >
          <InfoFilled :size="17" />关于
        </button>
      </nav>
      <div class="topbar-actions">
        <span class="save-state" :class="{ dirty: !isSaved }" :title="saveText"
          ><Check v-if="isSaved" :size="14" /><WarningFilled
            v-else
            :size="14"
          />{{ saveText }}</span
        ><el-button type="primary" plain @click="newRecord"
          ><DocumentAdd :size="16" />新建</el-button
        ><el-button type="primary" plain @click="saveDraft"
          ><Check :size="16" />保存</el-button
        ><el-button type="primary" plain @click="printCurrentPage"
          ><Printer :size="16" />打印</el-button
        ><el-dropdown trigger="click"
          ><el-button type="primary"><Download :size="16" />导出</el-button
          ><template #dropdown
            ><el-dropdown-menu
              ><el-dropdown-item @click="exportExcel"
                ><Download :size="15" />导出 Excel</el-dropdown-item
              ><el-dropdown-item :disabled="isExportingPdf" @click="exportPdf"
                ><Download :size="15" />导出 PDF</el-dropdown-item
              ></el-dropdown-menu
            ></template
          ></el-dropdown
        >
      </div>
    </header>
    <WorkbenchPage />
    <WorkbenchDialogs />

    <SettingsPage />
    <HistoryPage />

    <RequestLogsPage />

    <ApplicantProfiles />
    <AboutPage />
  </div>
</template>

<style src="./styles/app.css"></style>
