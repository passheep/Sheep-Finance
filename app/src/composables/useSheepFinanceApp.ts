import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ATTACHMENTS_PER_PAGE } from "../constants/app";
import { buildPreviewAttachments } from "../utils/pagination";
import { ChineseAmount, transform } from "../utils/format";
import type {
  AppTab,
  BackupStatus,
  Draft,
  Expense,
  HistoryViewMode,
  LanUploadSessionInfo,
  PreviewAttachment,
} from "../types/models";
import {
  listenBackupFailure,
  listenStorageMigrationProgress,
} from "../services/storageService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";
import { createHistoryState, useHistory } from "./useHistory";
import { useSettings } from "./useSettings";
import { useWorkspace } from "./useWorkspace";
import { useExpenseEditing } from "./useExpenseEditing";
import { useAttachments } from "./useAttachments";
import { useRecognition } from "./useRecognition";
import { usePreview } from "./usePreview";
import { useLanUpload } from "./useLanUpload";
import { useBackups } from "./useBackups";
import { useConfigurationTransfer } from "./useConfigurationTransfer";
import { useRequestLogs } from "./useRequestLogs";
import { useDocumentExport } from "../export/useDocumentExport";

// 设置先构造，workspace 通过闭包读取其状态；其余模块再延迟连接这些 getter 和回调，保持每份共享状态只有一个所有者。
export function useSheepFinanceApp() {
  const settingsApi = useSettings({
    getDraft: () => workspaceApi.draft,
    dirty: () => workspaceApi.dirty(),
    changePreviewProfile: (profile) => editingApi.changePreviewProfile(profile),
  });
  const historyState = createHistoryState();
  const workspaceApi = useWorkspace({
    profiles: settingsApi.profiles,
    companyNames: settingsApi.companyNames,
    expenseReasons: settingsApi.expenseReasons,
    arrangers: settingsApi.arrangers,
    defaultCompany: settingsApi.defaultCompany,
    defaultReason: settingsApi.defaultReason,
    defaultArranger: settingsApi.defaultArranger,
    ocrProfiles: settingsApi.ocrProfiles,
    llmProfiles: settingsApi.llmProfiles,
    historyRecords: historyState.historyRecords,
    normalizeOcrProfile: settingsApi.normalizeOcrProfile,
    normalizeLlmProfile: settingsApi.normalizeLlmProfile,
    normalizeHistory: (value) => historyApi.normalizeHistory(value),
    hydrateDraftImages: (value) => attachmentsApi.hydrateDraftImages(value),
    revokeDraftImageUrls: (value) => attachmentsApi.revokeDraftImageUrls(value),
    setSelectedIds,
    clearSelection,
    getUiPreferences,
    setUiPreferences,
    clampLeftPanelWidth,
    loadBackupStatus: () => backupsApi.loadBackupStatus(),
    refreshHistoryQuery: () => historyApi.refreshHistoryQuery(),
    getActiveTab: () => activeTab.value,
    commitActiveEdit: () => editingApi.commitActiveEdit(),
    onDraftReplaced: () => {
      if (!workspaceApi.getSuppressAutoSave()) editingApi.resetPreviewHistory();
    },
  });
  const { draft } = workspaceApi;
  const activeTab = ref<AppTab>("reimbursement");
  const uploadZone = ref<HTMLElement | null>(null);
  const fileInput = ref<HTMLInputElement | null>(null);
  const uploadFocused = ref(false);
  const isExtraUploadOpen = ref(false);
  const extraUploadFocused = ref(false);
  const extraUploadExpenseId = ref<string | null>(null);
  const extraUploadZone = ref<HTMLElement | null>(null);
  const extraFileInput = ref<HTMLInputElement | null>(null);
  const configImportInput = ref<HTMLInputElement | null>(null);
  const backupStatus = ref<BackupStatus | null>(null);
  const backupLoading = ref(false);
  const selectedRecoveryBackup = ref("");
  const isLanUploadOpen = ref(false);
  const isLanUploadLoading = ref(false);
  const lanUploadSession = ref<LanUploadSessionInfo | null>(null);
  const lanUploadQrCode = ref("");
  const lanUploadError = ref("");
  const lanUploadNow = ref(Date.now());
  const lanUploadTargetExpenseId = ref<string | null>(null);
  let storageMigrationUnlisten: UnlistenFn | null = null;
  let backupFailureUnlisten: UnlistenFn | null = null;
  let lanUploadClockTimer: number | null = null;

  const previewAttachments = computed<PreviewAttachment[]>(() =>
    buildPreviewAttachments(draft.expenses),
  );
  const calculatedTotal = computed(() =>
    draft.expenses.reduce((sum, item) => sum + item.amountCents, 0),
  );
  const effectiveTotal = computed(
    () => draft.totalOverrideCents ?? calculatedTotal.value,
  );
  const manualTotal = computed(() => draft.totalOverrideCents !== null);
  const extraUploadExpense = computed(
    () =>
      draft.expenses.find((item) => item.id === extraUploadExpenseId.value) ??
      null,
  );

  const recognitionApi = useRecognition({
    draft,
    defaultOcrProfile: settingsApi.defaultOcrProfile,
    defaultLlmProfile: settingsApi.defaultLlmProfile,
    persistDraft: workspaceApi.persistDraft,
    dirty: workspaceApi.dirty,
    switchTab,
  });
  const editingApi = useExpenseEditing({
    draft,
    formPages: computed(() => previewApi.formPages.value),
    getPreviewAttachments: () => previewAttachments.value,
    dirty: workspaceApi.dirty,
    persistDraft: workspaceApi.persistDraft,
    reflowExpenses,
    revokeManagedImageUrl: (url) => attachmentsApi.revokeManagedImageUrl(url),
    setSelectedIds,
    isPreviewActive: () =>
      activeTab.value === "reimbursement" &&
      !workspaceApi.getSuppressAutoSave(),
  });
  const { selectedId, selectedAttachmentId, selectedAttachment } = editingApi;
  const attachmentsApi = useAttachments({
    draft,
    previewAttachments,
    selectedAttachment,
    defaultReason: settingsApi.defaultReason,
    expenseReasons: settingsApi.expenseReasons,
    defaultArranger: settingsApi.defaultArranger,
    arrangers: settingsApi.arrangers,
    handwritingMode: recognitionApi.handwritingMode,
    recognitionConfigured: recognitionApi.recognitionConfigured,
    recognizeExpense: recognitionApi.recognizeExpense,
    dirty: workspaceApi.dirty,
    persistDraft: workspaceApi.persistDraft,
    reflowExpenses,
    reflowAttachments,
    scrollExpenseIntoView,
    setSelectedIds,
    saveAttachmentFile: tauriSave,
  });
  const previewApi = usePreview({
    draft,
    previewAttachments,
    selectedAttachment,
    findAttachment: editingApi.findAttachment,
    selectAttachment: editingApi.selectAttachment,
    dirty: workspaceApi.dirty,
    scheduleAutoSave: workspaceApi.scheduleAutoSave,
  });
  const requestLogs = useRequestLogs();
  const historyApi = useHistory({
    draft,
    historyState,
    companyNames: settingsApi.companyNames,
    storageReady: workspaceApi.storageReady,
    isTauriRuntime,
    persistDraft: workspaceApi.persistDraft,
    cloneDraft: workspaceApi.cloneDraft,
    normalizeDraftForUse: workspaceApi.normalizeDraftForUse,
    hydrateDraftImages: attachmentsApi.hydrateDraftImages,
    revokeDraftImageUrls: attachmentsApi.revokeDraftImageUrls,
    replaceActiveDraft: workspaceApi.replaceActiveDraft,
    createDraft: workspaceApi.createDraft,
    dirty: workspaceApi.dirty,
    switchTab,
    withTemporaryDraft,
    exportExcel: (sourceDraft) => exportApi.exportExcel(sourceDraft),
    exportPdf: (sourceDraft) => exportApi.exportPdf(sourceDraft),
    isSaved: workspaceApi.isSaved,
    saveText: workspaceApi.saveText,
    setSuppressAutoSave: workspaceApi.setSuppressAutoSave,
    clearSelection,
  });
  const backupsApi = useBackups({
    backupStatus,
    backupLoading,
    selectedRecoveryBackup,
    storageReady: workspaceApi.storageReady,
    storageRecoveryError: workspaceApi.storageRecoveryError,
    persistDraft: workspaceApi.persistDraft,
  });
  const configurationApi = useConfigurationTransfer({
    profiles: settingsApi.profiles,
    companyNames: settingsApi.companyNames,
    expenseReasons: settingsApi.expenseReasons,
    arrangers: settingsApi.arrangers,
    defaultCompany: settingsApi.defaultCompany,
    defaultReason: settingsApi.defaultReason,
    defaultArranger: settingsApi.defaultArranger,
    ocrProfiles: settingsApi.ocrProfiles,
    llmProfiles: settingsApi.llmProfiles,
    configImportInput,
    normalizeOcrProfile: settingsApi.normalizeOcrProfile,
    normalizeLlmProfile: settingsApi.normalizeLlmProfile,
    normalizeProfile: settingsApi.normalizeProfile,
    ensureSingleDefault: settingsApi.ensureSingleDefault,
    dirty: workspaceApi.dirty,
    persistDraft: workspaceApi.persistDraft,
  });
  const lanUploadApi = useLanUpload({
    draft,
    previewAttachments,
    isLanUploadOpen,
    isLanUploadLoading,
    lanUploadSession,
    lanUploadQrCode,
    lanUploadError,
    lanUploadNow,
    lanUploadTargetExpenseId,
    addFile: attachmentsApi.addFile,
    addExtraAttachmentFile: attachmentsApi.addExtraAttachmentFile,
    extraAttachmentSlots: attachmentsApi.extraAttachmentSlots,
  });
  const exportApi = useDocumentExport({
    draft,
    activeTab,
    formPages: previewApi.formPages,
    previewPageCount: previewApi.previewPageCount,
    sharedAttachmentPage: previewApi.sharedAttachmentPage,
    calculatedTotal,
    effectiveTotal,
    commitActiveEdit: editingApi.commitActiveEdit,
    updateScale: previewApi.updateScale,
    persistDraft: workspaceApi.persistDraft,
    isAutoSaveSuppressed: workspaceApi.getSuppressAutoSave,
    withTemporaryDraft,
  });

  function setSelectedIds(
    expenseId: string | null,
    attachmentId: string | null = expenseId,
  ) {
    selectedId.value = expenseId;
    selectedAttachmentId.value = attachmentId;
  }

  function clearSelection() {
    editingApi.clearSelection();
  }

  function reflowAttachments() {
    const attachments = previewAttachments.value;
    attachments.forEach((attachment, index) => {
      const pageStart =
        Math.floor(index / ATTACHMENTS_PER_PAGE) * ATTACHMENTS_PER_PAGE;
      const pageTotal = Math.min(
        ATTACHMENTS_PER_PAGE,
        attachments.length - pageStart,
      );
      const slot = transform(index - pageStart, pageTotal);
      Object.assign(attachment.transform, {
        x: slot.x,
        y: slot.y,
        width: slot.width,
        height: slot.height,
      });
    });
  }

  function reflowExpenses() {
    reflowAttachments();
  }

  function clampLeftPanelWidth(value: number) {
    return previewApi.clampLeftPanelWidth(value);
  }

  function getUiPreferences() {
    return {
      leftPanelWidth: previewApi.leftPanelWidth.value,
      historyViewMode: historyState.historyViewMode.value,
    };
  }

  function setUiPreferences(value: {
    leftPanelWidth: number;
    historyViewMode: HistoryViewMode;
  }) {
    previewApi.leftPanelWidth.value = value.leftPanelWidth;
    historyState.historyViewMode.value = value.historyViewMode;
  }

  async function scrollExpenseIntoView(expenseId: string) {
    await nextTick();
    document
      .querySelector(`[data-expense-id="${expenseId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // 临时草稿仅用于渲染导出；恢复工作区后只回收来源草稿的图片地址。
  async function withTemporaryDraft<T>(
    source: Draft,
    callback: () => Promise<T>,
  ) {
    editingApi.commitActiveEdit();
    const current = workspaceApi.cloneDraft();
    const previousTab = activeTab.value;
    const previousSelectedId = selectedId.value;
    const previousSelectedAttachmentId = selectedAttachmentId.value;
    workspaceApi.setSuppressAutoSave(true);
    try {
      workspaceApi.applyDraft(workspaceApi.cloneDraft(source));
      activeTab.value = "reimbursement";
      await nextTick();
      previewApi.updateScale();
      await nextTick();
      return await callback();
    } finally {
      workspaceApi.applyDraft(current);
      attachmentsApi.revokeDraftImageUrls(source);
      selectedId.value = previousSelectedId;
      selectedAttachmentId.value = previousSelectedAttachmentId;
      activeTab.value = previousTab;
      await nextTick();
      previewApi.updateScale();
      workspaceApi.setSuppressAutoSave(false);
    }
  }

  function switchTab(tab: AppTab) {
    editingApi.commitActiveEdit();
    activeTab.value = tab;
    if (tab === "requests") void requestLogs.loadRequestLogs();
    if (tab === "settings") void backupsApi.loadBackupStatus();
    if (tab === "history") void historyApi.refreshHistoryQuery();
    nextTick(() => {
      if (tab === "reimbursement") previewApi.updateScale();
    });
  }

  function newRecord() {
    editingApi.commitActiveEdit();
    switchTab("reimbursement");
    if (!workspaceApi.isSaved.value || draft.expenses.length)
      void workspaceApi.persistDraft(false);
    attachmentsApi.revokeDraftImageUrls(draft);
    Object.assign(draft, workspaceApi.createDraft());
    editingApi.resetPreviewHistory();
    selectedId.value = null;
    selectedAttachmentId.value = null;
    workspaceApi.dirty();
    ElMessage.success("已创建新的空白报销单");
  }

  function openPicker() {
    uploadZone.value?.focus();
    fileInput.value?.click();
  }

  function openExtraUpload(expense: Expense) {
    extraUploadExpenseId.value = expense.id;
    isExtraUploadOpen.value = true;
    nextTick(() => extraUploadZone.value?.focus());
  }

  function openExtraPicker() {
    extraUploadZone.value?.focus();
    extraFileInput.value?.click();
  }

  async function extraFilesChanged(event: Event) {
    const input = event.target as HTMLInputElement;
    const expense = extraUploadExpense.value;
    if (expense) {
      for (const file of Array.from(input.files ?? []))
        await attachmentsApi.addExtraAttachmentFile(file, expense.id);
    }
    input.value = "";
  }

  async function extraDropped(event: DragEvent) {
    extraUploadFocused.value = true;
    const expense = extraUploadExpense.value;
    if (!expense) return;
    for (const file of Array.from(event.dataTransfer?.files ?? []))
      await attachmentsApi.addExtraAttachmentFile(file, expense.id);
  }

  async function extraPasted(event: ClipboardEvent) {
    if (!extraUploadFocused.value || !extraUploadExpense.value) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((value) =>
      value.type.startsWith("image/"),
    );
    if (!item) return;
    event.preventDefault();
    const file = item.getAsFile();
    if (file)
      await attachmentsApi.addExtraAttachmentFile(
        file,
        extraUploadExpense.value.id,
      );
  }

  async function filesChanged(event: Event) {
    const input = event.target as HTMLInputElement;
    for (const file of Array.from(input.files ?? []))
      await attachmentsApi.addFile(file);
    input.value = "";
  }

  async function dropped(event: DragEvent) {
    uploadFocused.value = true;
    for (const file of Array.from(event.dataTransfer?.files ?? []))
      await attachmentsApi.addFile(file);
  }

  async function pasted(event: ClipboardEvent) {
    if (!uploadFocused.value) return;
    const item = Array.from(event.clipboardData?.items ?? []).find((value) =>
      value.type.startsWith("image/"),
    );
    if (!item) return;
    event.preventDefault();
    const file = item.getAsFile();
    if (file) await attachmentsApi.addFile(file);
  }

  async function removeSelectedAttachment() {
    const attachment = selectedAttachment.value;
    if (!attachment) return;
    const expense = draft.expenses.find(
      (item) => item.id === attachment.expenseId,
    );
    if (!expense) return;
    if (attachment.isPrimary) await editingApi.removeExpense(expense);
    else {
      const extra = expense.extraAttachments.find(
        (item) => item.id === attachment.id,
      );
      if (extra) await attachmentsApi.removeExtraAttachment(expense, extra);
    }
  }

  async function openExternalUrl(url: string) {
    try {
      if (isTauriRuntime()) await openUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      ElMessage.error(`链接打开失败：${errorMessage(error)}`);
    }
  }

  function reloadApplication() {
    window.location.reload();
  }

  function preventContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  // 与旧脚本保持相同注册顺序，领域模块不单独注册生命周期副作用。
  watch(draft, workspaceApi.scheduleAutoSave, { deep: true });
  watch(
    [
      settingsApi.profiles,
      settingsApi.companyNames,
      settingsApi.expenseReasons,
      settingsApi.arrangers,
      settingsApi.defaultCompany,
      settingsApi.defaultReason,
      settingsApi.defaultArranger,
      settingsApi.ocrProfiles,
      settingsApi.llmProfiles,
    ],
    workspaceApi.scheduleAutoSave,
    { deep: true },
  );
  watch(
    [previewApi.leftPanelWidth, historyState.historyViewMode],
    workspaceApi.scheduleAutoSave,
  );
  watch(
    [
      historyState.historySearch,
      historyState.historyDate,
      historyState.historyStatus,
    ],
    () => {
      historyState.historyPage.value = 1;
      void historyApi.refreshHistoryQuery();
    },
  );
  watch(historyState.historyViewMode, () => {
    historyState.historyPage.value = 1;
    historyState.historyFolderKey.value = "";
    void historyApi.refreshHistoryQuery();
  });
  watch(
    [historyState.historyPage, historyState.historyPageSize],
    () => void historyApi.refreshHistoryQuery(),
  );
  watch(
    [
      requestLogs.requestSearch,
      requestLogs.requestService,
      requestLogs.requestStatus,
    ],
    () => {
      requestLogs.requestPage.value = 1;
    },
  );
  watch(historyState.isHistoryPreviewOpen, (open) => {
    if (open) return;
    historyApi.cleanupPreviewDraft();
  });
  watch(
    [
      () => draft.label,
      () => previewAttachments.value.length,
      lanUploadTargetExpenseId,
    ],
    () => {
      void lanUploadApi.synchronizeLanUploadSession();
    },
  );
  watch(
    () => draft.id,
    (recordId) => {
      if (!workspaceApi.getSuppressAutoSave()) editingApi.resetPreviewHistory();
      if (
        lanUploadSession.value &&
        lanUploadSession.value.recordId !== recordId
      ) {
        isLanUploadOpen.value = false;
        void lanUploadApi.stopLanUploadSession();
      }
      isExtraUploadOpen.value = false;
      extraUploadExpenseId.value = null;
    },
  );

  onMounted(() => {
    void (async () => {
      if (isTauriRuntime()) {
        try {
          storageMigrationUnlisten = await listenStorageMigrationProgress(
            (payload) => {
              workspaceApi.migrationProgress.value = payload;
            },
          );
          backupFailureUnlisten = await listenBackupFailure((message) =>
            ElMessage.error(`自动备份失败：${message}`),
          );
        } catch {
          storageMigrationUnlisten = null;
          backupFailureUnlisten = null;
        }
      }
      await workspaceApi.loadDraft();
    })();
    lanUploadClockTimer = window.setInterval(() => {
      lanUploadNow.value = Date.now();
    }, 1000);
    previewApi.updateScale();
    window.addEventListener("resize", previewApi.updateScale);
    window.addEventListener("pointerdown", editingApi.expenseDragStart);
    window.addEventListener("pointermove", previewApi.pointerMove);
    window.addEventListener("pointermove", editingApi.expenseDragMove);
    window.addEventListener("pointermove", settingsApi.moveDictionaryDrag);
    window.addEventListener("pointermove", editingApi.trackPaperCellSelection);
    window.addEventListener("pointerup", previewApi.pointerStop);
    window.addEventListener("pointerup", editingApi.expenseDragStop);
    window.addEventListener("pointerup", settingsApi.stopDictionaryDrag);
    window.addEventListener("pointercancel", settingsApi.stopDictionaryDrag);
    window.addEventListener("wheel", previewApi.adjustImageByWheel, {
      passive: false,
    });
    window.addEventListener("wheel", previewApi.adjustPreviewZoom, {
      passive: false,
    });
    window.addEventListener("contextmenu", preventContextMenu);
    window.addEventListener("keydown", editingApi.handleGlobalKeydown);
    window.addEventListener("pointerup", editingApi.endPaperCellSelection);
    window.addEventListener(
      "pointercancel",
      editingApi.cancelPaperCellSelection,
    );
    window.addEventListener("pointermove", previewApi.moveLeftPanelResize);
    window.addEventListener("pointerup", previewApi.stopLeftPanelResize);
  });

  onUnmounted(() => {
    const saveTimer = workspaceApi.saveTimer.value;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (lanUploadClockTimer !== null) window.clearInterval(lanUploadClockTimer);
    const lanUploadNoticeTimer = lanUploadApi.getLanUploadNoticeTimer();
    if (lanUploadNoticeTimer !== null) lanUploadApi.clearLanUploadNoticeTimer();
    lanUploadApi.cleanupLanUploadListener();
    storageMigrationUnlisten?.();
    storageMigrationUnlisten = null;
    backupFailureUnlisten?.();
    backupFailureUnlisten = null;
    attachmentsApi.revokeDraftImageUrls(draft);
    attachmentsApi.revokeDraftImageUrls(historyState.historyPreviewDraft.value);
    void lanUploadApi.stopLanUploadSession();
    window.removeEventListener("resize", previewApi.updateScale);
    window.removeEventListener("pointerdown", editingApi.expenseDragStart);
    window.removeEventListener("pointermove", previewApi.pointerMove);
    window.removeEventListener("pointermove", editingApi.expenseDragMove);
    window.removeEventListener("pointermove", settingsApi.moveDictionaryDrag);
    window.removeEventListener(
      "pointermove",
      editingApi.trackPaperCellSelection,
    );
    window.removeEventListener("pointerup", previewApi.pointerStop);
    window.removeEventListener("pointerup", editingApi.expenseDragStop);
    window.removeEventListener("pointerup", settingsApi.stopDictionaryDrag);
    window.removeEventListener("pointercancel", settingsApi.stopDictionaryDrag);
    window.removeEventListener("wheel", previewApi.adjustImageByWheel);
    window.removeEventListener("wheel", previewApi.adjustPreviewZoom);
    window.removeEventListener("contextmenu", preventContextMenu);
    window.removeEventListener("keydown", editingApi.handleGlobalKeydown);
    window.removeEventListener("pointerup", editingApi.endPaperCellSelection);
    window.removeEventListener(
      "pointercancel",
      editingApi.cancelPaperCellSelection,
    );
    window.removeEventListener("pointermove", previewApi.moveLeftPanelResize);
    window.removeEventListener("pointerup", previewApi.stopLeftPanelResize);
  });

  return {
    ...settingsApi,
    ...workspaceApi,
    ...editingApi,
    ...attachmentsApi,
    ...previewApi,
    ...recognitionApi,
    ...lanUploadApi,
    ...historyApi,
    ...requestLogs,
    ...backupsApi,
    ...configurationApi,
    ...exportApi,
    activeTab,
    uploadZone,
    fileInput,
    uploadFocused,
    isExtraUploadOpen,
    extraUploadFocused,
    extraUploadExpenseId,
    extraUploadExpense,
    extraUploadZone,
    extraFileInput,
    configImportInput,
    backupStatus,
    backupLoading,
    selectedRecoveryBackup,
    isLanUploadOpen,
    isLanUploadLoading,
    lanUploadSession,
    lanUploadQrCode,
    lanUploadError,
    lanUploadNow,
    lanUploadTargetExpenseId,
    previewAttachments,
    calculatedTotal,
    effectiveTotal,
    manualTotal,
    ChineseAmount,
    isTauriRuntime,
    switchTab,
    newRecord,
    openPicker,
    openExtraUpload,
    openExtraPicker,
    extraFilesChanged,
    extraDropped,
    extraPasted,
    filesChanged,
    dropped,
    pasted,
    removeSelectedAttachment,
    openExternalUrl,
    reloadApplication,
    reflowAttachments,
    reflowExpenses,
    scrollExpenseIntoView,
    setSelectedIds,
    clearSelection,
    getUiPreferences,
    setUiPreferences,
    clampLeftPanelWidth,
    withTemporaryDraft,
    preventContextMenu,
  };
}
