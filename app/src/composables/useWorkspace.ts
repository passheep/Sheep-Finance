import { reactive, ref, type Ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  id,
  today,
  formatSaveTime,
  normalizeHistoryViewMode,
  normalizeReimbursementStatus,
  transform,
} from "../utils/format";
import {
  DICTIONARY_KEY,
  HISTORY_KEY,
  MAX_EXPENSES,
  PROFILE_KEY,
  SERVICE_KEY,
  STORAGE_KEY,
  UI_PREFERENCES_KEY,
} from "../constants/app";
import type {
  AppTab,
  Draft,
  Expense,
  ExtraAttachment,
  HistoryRecord,
  HistoryViewMode,
  LoadedWorkspace,
  LlmProfile,
  OcrProfile,
  Profile,
  StorageBootstrapResult,
} from "../types/models";
import {
  bootstrapStorage,
  loadWorkspace,
  saveWorkspace,
  scheduleStorageBackup,
} from "../services/storageService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";

export interface WorkspaceContext {
  profiles: Ref<Profile[]>;
  companyNames: Ref<string[]>;
  expenseReasons: Ref<string[]>;
  arrangers: Ref<string[]>;
  defaultCompany: Ref<string>;
  defaultReason: Ref<string>;
  defaultArranger: Ref<string>;
  ocrProfiles: Ref<OcrProfile[]>;
  llmProfiles: Ref<LlmProfile[]>;
  historyRecords: Ref<HistoryRecord[]>;
  normalizeOcrProfile: (value: Partial<OcrProfile>) => OcrProfile;
  normalizeLlmProfile: (value: Partial<LlmProfile>) => LlmProfile;
  normalizeHistory: (value: Partial<HistoryRecord>) => HistoryRecord;
  hydrateDraftImages: (value: Draft) => Promise<Draft>;
  revokeDraftImageUrls: (value: Draft | null | undefined) => void;
  setSelectedIds: (
    expenseId: string | null,
    attachmentId?: string | null,
  ) => void;
  clearSelection: () => void;
  getUiPreferences: () => {
    leftPanelWidth: number;
    historyViewMode: HistoryViewMode;
  };
  setUiPreferences: (value: {
    leftPanelWidth: number;
    historyViewMode: HistoryViewMode;
  }) => void;
  clampLeftPanelWidth: (value: number) => number;
  loadBackupStatus: () => Promise<void>;
  refreshHistoryQuery: () => Promise<void>;
  getActiveTab: () => AppTab;
  commitActiveEdit: () => void;
  onDraftReplaced?: () => void;
}

export function useWorkspace(context: WorkspaceContext) {
  const profiles = context.profiles;
  const companyNames = context.companyNames;
  const expenseReasons = context.expenseReasons;
  const arrangers = context.arrangers;
  const defaultCompany = context.defaultCompany;
  const defaultReason = context.defaultReason;
  const defaultArranger = context.defaultArranger;
  const ocrProfiles = context.ocrProfiles;
  const llmProfiles = context.llmProfiles;
  const historyRecords = context.historyRecords;
  const normalizeOcrProfile = context.normalizeOcrProfile;
  const normalizeLlmProfile = context.normalizeLlmProfile;
  const normalizeHistory = context.normalizeHistory;
  const hydrateDraftImages = context.hydrateDraftImages;
  const revokeDraftImageUrls = context.revokeDraftImageUrls;
  const clampLeftPanelWidth = context.clampLeftPanelWidth;
  const loadBackupStatus = context.loadBackupStatus;
  const refreshHistoryQuery = context.refreshHistoryQuery;
  const commitActiveEdit = context.commitActiveEdit;

  const isSaved = ref(true);
  const saveText = ref("等待保存");
  const isLoadingWorkspace = ref(true);
  const storageReady = ref(!isTauriRuntime());
  const storageBootstrap = ref<StorageBootstrapResult | null>(null);
  const migrationProgress = ref<
    import("../types/models").MigrationProgress | null
  >(null);
  const storageRecoveryError = ref("");
  const dataDirectory = ref("");
  const saveTimer = ref<number | null>(null);
  let autoSaveRevision = 0;
  let suppressAutoSave = false;

  function createDraft(): Draft {
    const profile =
      profiles.value.find((item) => item.isDefault) ?? profiles.value[0];
    return {
      id: id("record"),
      label: "",
      status: "未报销",
      companyName: "",
      reimbursementDate: "",
      applicant: profile?.applicant ?? "",
      department: profile?.department ?? "",
      payeeName: profile?.payeeName ?? "",
      account: profile?.account ?? "",
      bank: profile?.bank ?? "",
      totalOverrideCents: null,
      previewMode: "single",
      financeReviewer: "财务",
      showManagerApproval: true,
      expenses: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const draft = reactive<Draft>(createDraft());

  function uiPreferencesSnapshot() {
    return context.getUiPreferences();
  }

  function cloneDraft(value: Draft = draft) {
    return JSON.parse(JSON.stringify(value)) as Draft;
  }

  function historyItem(value: Draft, includeDraft = false): HistoryRecord {
    const item: HistoryRecord = {
      id: value.id,
      label: value.label,
      status: value.status,
      companyName: value.companyName,
      applicant: value.applicant,
      reimbursementDate: value.reimbursementDate,
      expenseCount: value.expenses.length,
      totalCents:
        value.totalOverrideCents ??
        value.expenses.reduce((sum, expense) => sum + expense.amountCents, 0),
      firstOccurredDate: value.expenses[0]?.occurredDate || "",
      updatedAt: value.updatedAt,
    };
    if (includeDraft) item.draft = cloneDraft(value);
    return item;
  }

  function normalizeExtraAttachment(
    value: Partial<ExtraAttachment>,
    index: number,
    total: number,
  ): ExtraAttachment {
    const fallbackTransform = transform(index, total);
    return {
      id: value.id ?? id("attachment"),
      fileName: value.fileName ?? `附加图片-${index + 1}.png`,
      imageDataUrl: value.imageDataUrl ?? "",
      blobHash: value.blobHash,
      mimeType: value.mimeType,
      blobExtension: value.blobExtension,
      sizeBytes: value.sizeBytes,
      naturalWidth: value.naturalWidth ?? 1,
      naturalHeight: value.naturalHeight ?? 1,
      transform: { ...fallbackTransform, ...(value.transform ?? {}) },
    };
  }

  function normalizeExpense(
    value: Partial<Expense>,
    index: number,
    total = 6,
  ): Expense {
    const fallbackTransform = transform(index, total);
    return {
      id: value.id ?? id("expense"),
      fileName: value.fileName ?? `费用截图-${index + 1}.png`,
      imageDataUrl: value.imageDataUrl ?? "",
      recognitionImageDataUrl: value.recognitionImageDataUrl,
      blobHash: value.blobHash,
      mimeType: value.mimeType,
      blobExtension: value.blobExtension,
      sizeBytes: value.sizeBytes,
      recognitionBlobHash: value.recognitionBlobHash,
      recognitionMimeType: value.recognitionMimeType,
      recognitionBlobExtension: value.recognitionBlobExtension,
      originalSizeBytes: value.originalSizeBytes,
      recognitionSizeBytes: value.recognitionSizeBytes,
      occurredDate: value.occurredDate ?? today(),
      reason:
        value.reason ??
        defaultReason.value ??
        expenseReasons.value[0] ??
        "办公费",
      description: value.description ?? "",
      arranger:
        value.arranger ?? defaultArranger.value ?? arrangers.value[0] ?? "",
      amountCents: Number.isFinite(value.amountCents)
        ? Number(value.amountCents)
        : 0,
      ocrMode: value.ocrMode === "handwriting" ? "handwriting" : "advanced",
      ocrStatus: value.ocrStatus ?? "queued",
      ocrText: value.ocrText,
      llmText: value.llmText,
      recognitionError: value.recognitionError,
      recognitionVersion: value.recognitionVersion ?? 0,
      recognizedFields: value.recognizedFields,
      lastOcrProfile: value.lastOcrProfile,
      lastLlmProfile: value.lastLlmProfile,
      lastRecognitionMs: value.lastRecognitionMs,
      transform: { ...fallbackTransform, ...(value.transform ?? {}) },
      naturalWidth: value.naturalWidth ?? 1,
      naturalHeight: value.naturalHeight ?? 1,
      extraAttachments: (value.extraAttachments ?? []).map(
        (attachment, extraIndex) =>
          normalizeExtraAttachment(
            attachment,
            extraIndex + 1,
            (value.extraAttachments?.length ?? 0) + 1,
          ),
      ),
      manualFields: value.manualFields ?? {},
    };
  }

  function normalizeDraftForUse(value: Partial<Draft>): Draft {
    const defaults = createDraft();
    const expenses = (value.expenses ?? []).slice(0, MAX_EXPENSES);
    return {
      ...defaults,
      ...value,
      id: value.id ?? defaults.id,
      label: value.label ?? "",
      status: normalizeReimbursementStatus(value.status),
      companyName: value.companyName ?? "",
      reimbursementDate: value.reimbursementDate ?? "",
      applicant: value.applicant ?? defaults.applicant,
      department: value.department ?? defaults.department,
      payeeName: value.payeeName ?? defaults.payeeName,
      account: value.account ?? defaults.account,
      bank: value.bank ?? defaults.bank,
      totalOverrideCents: value.totalOverrideCents ?? null,
      previewMode: value.previewMode === "double" ? "double" : "single",
      financeReviewer: value.financeReviewer === "秘书处" ? "秘书处" : "财务",
      showManagerApproval: value.showManagerApproval !== false,
      expenses: expenses.map((item, index) =>
        normalizeExpense(item, index, expenses.length),
      ),
      updatedAt: value.updatedAt ?? defaults.updatedAt,
    };
  }

  async function persistDraft(showMessage = false) {
    if (
      isLoadingWorkspace.value ||
      suppressAutoSave ||
      (isTauriRuntime() && !storageReady.value)
    )
      return false;
    const revision = autoSaveRevision;
    saveText.value = showMessage ? "正在保存" : "正在自动保存";
    const snapshot = cloneDraft();
    const nextHistory = [
      historyItem(snapshot, !isTauriRuntime()),
      ...historyRecords.value.filter((item) => item.id !== snapshot.id),
    ];
    historyRecords.value = nextHistory;
    try {
      if (isTauriRuntime()) {
        await saveWorkspace({
          draft: snapshot,
          profiles: profiles.value,
          dictionaries: {
            companies: companyNames.value,
            reasons: expenseReasons.value,
            arrangers: arrangers.value,
            defaultCompany: defaultCompany.value,
            defaultReason: defaultReason.value,
            defaultArranger: defaultArranger.value,
          },
          services: {
            ocrProfiles: ocrProfiles.value,
            llmProfiles: llmProfiles.value,
          },
          uiPreferences: uiPreferencesSnapshot(),
        });
      } else {
        const browserHistory = nextHistory
          .slice(0, 20)
          .map((item) =>
            item.draft
              ? item
              : item.id === snapshot.id
                ? historyItem(snapshot, true)
                : item,
          );
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles.value));
        localStorage.setItem(
          DICTIONARY_KEY,
          JSON.stringify({
            companies: companyNames.value,
            reasons: expenseReasons.value,
            arrangers: arrangers.value,
            defaultCompany: defaultCompany.value,
            defaultReason: defaultReason.value,
            defaultArranger: defaultArranger.value,
          }),
        );
        localStorage.setItem(
          SERVICE_KEY,
          JSON.stringify({
            ocrProfiles: ocrProfiles.value,
            llmProfiles: llmProfiles.value,
          }),
        );
        localStorage.setItem(HISTORY_KEY, JSON.stringify(browserHistory));
        localStorage.setItem(
          UI_PREFERENCES_KEY,
          JSON.stringify(uiPreferencesSnapshot()),
        );
      }
      isSaved.value = revision === autoSaveRevision;
      saveText.value = isSaved.value
        ? `已保存 ${formatSaveTime(new Date())}`
        : "尚未保存";
      if (isTauriRuntime() && context.getActiveTab() === "history")
        await refreshHistoryQuery();
      if (showMessage) ElMessage.success("草稿已保存到本机");
      return true;
    } catch (error) {
      isSaved.value = false;
      saveText.value = "自动保存失败";
      if (showMessage) ElMessage.error(errorMessage(error));
      return false;
    }
  }

  function saveDraft() {
    commitActiveEdit();
    void persistDraft(true);
  }

  function applyDraft(value: Draft) {
    Object.assign(draft, normalizeDraftForUse(value));
    context.onDraftReplaced?.();
    context.setSelectedIds(draft.expenses[0]?.id ?? null);
  }

  function replaceActiveDraft(value: Draft) {
    revokeDraftImageUrls(draft);
    applyDraft(value);
  }

  async function applyWorkspace(value: LoadedWorkspace) {
    if (value.profiles?.length) profiles.value = value.profiles;
    if (value.dictionaries?.companies?.length)
      companyNames.value = value.dictionaries.companies;
    if (value.dictionaries?.reasons?.length)
      expenseReasons.value = value.dictionaries.reasons;
    if (value.dictionaries?.arrangers?.length)
      arrangers.value = value.dictionaries.arrangers;
    if (
      value.dictionaries?.defaultCompany &&
      companyNames.value.includes(value.dictionaries.defaultCompany)
    )
      defaultCompany.value = value.dictionaries.defaultCompany;
    if (
      value.dictionaries?.defaultReason &&
      expenseReasons.value.includes(value.dictionaries.defaultReason)
    )
      defaultReason.value = value.dictionaries.defaultReason;
    if (
      value.dictionaries?.defaultArranger &&
      arrangers.value.includes(value.dictionaries.defaultArranger)
    )
      defaultArranger.value = value.dictionaries.defaultArranger;
    if (Array.isArray(value.history))
      historyRecords.value = value.history
        .filter((item) => item?.id)
        .map(normalizeHistory);
    if (value.services?.ocrProfiles?.length)
      ocrProfiles.value = value.services.ocrProfiles.map(normalizeOcrProfile);
    if (value.services?.llmProfiles?.length)
      llmProfiles.value = value.services.llmProfiles.map(normalizeLlmProfile);
    if (value.uiPreferences?.leftPanelWidth)
      context.setUiPreferences({
        ...context.getUiPreferences(),
        leftPanelWidth: clampLeftPanelWidth(value.uiPreferences.leftPanelWidth),
      });
    if (value.uiPreferences?.historyViewMode)
      context.setUiPreferences({
        ...context.getUiPreferences(),
        historyViewMode: normalizeHistoryViewMode(
          value.uiPreferences.historyViewMode,
        ),
      });
    if (value.draft?.id) {
      const restored = normalizeDraftForUse(value.draft);
      await hydrateDraftImages(restored);
      replaceActiveDraft(restored);
    } else {
      replaceActiveDraft(createDraft());
    }
    dataDirectory.value = value.dataDirectory;
  }

  function loadBrowserWorkspace() {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Draft | null;
    if (saved?.id) applyDraft(saved);
    const savedProfiles = JSON.parse(
      localStorage.getItem(PROFILE_KEY) ?? "null",
    ) as Profile[] | null;
    if (savedProfiles?.length) profiles.value = savedProfiles;
    const dictionaries = JSON.parse(
      localStorage.getItem(DICTIONARY_KEY) ?? "null",
    ) as LoadedWorkspace["dictionaries"] | null;
    if (dictionaries?.companies?.length)
      companyNames.value = dictionaries.companies;
    if (dictionaries?.reasons?.length)
      expenseReasons.value = dictionaries.reasons;
    if (dictionaries?.arrangers?.length)
      arrangers.value = dictionaries.arrangers;
    if (
      dictionaries?.defaultCompany &&
      companyNames.value.includes(dictionaries.defaultCompany)
    )
      defaultCompany.value = dictionaries.defaultCompany;
    if (
      dictionaries?.defaultReason &&
      expenseReasons.value.includes(dictionaries.defaultReason)
    )
      defaultReason.value = dictionaries.defaultReason;
    if (
      dictionaries?.defaultArranger &&
      arrangers.value.includes(dictionaries.defaultArranger)
    )
      defaultArranger.value = dictionaries.defaultArranger;
    const savedHistory = JSON.parse(
      localStorage.getItem(HISTORY_KEY) ?? "[]",
    ) as HistoryRecord[];
    if (Array.isArray(savedHistory))
      historyRecords.value = savedHistory
        .filter((item) => item?.id)
        .map(normalizeHistory);
    const services = JSON.parse(
      localStorage.getItem(SERVICE_KEY) ?? "null",
    ) as {
      ocrProfiles?: OcrProfile[];
      llmProfiles?: LlmProfile[];
    } | null;
    if (services?.ocrProfiles?.length)
      ocrProfiles.value = services.ocrProfiles.map(normalizeOcrProfile);
    if (services?.llmProfiles?.length)
      llmProfiles.value = services.llmProfiles.map(normalizeLlmProfile);
    const savedUiPreferences = JSON.parse(
      localStorage.getItem(UI_PREFERENCES_KEY) ?? "null",
    ) as LoadedWorkspace["uiPreferences"] | null;
    if (savedUiPreferences?.leftPanelWidth)
      context.setUiPreferences({
        ...context.getUiPreferences(),
        leftPanelWidth: clampLeftPanelWidth(savedUiPreferences.leftPanelWidth),
      });
    if (savedUiPreferences?.historyViewMode)
      context.setUiPreferences({
        ...context.getUiPreferences(),
        historyViewMode: normalizeHistoryViewMode(
          savedUiPreferences.historyViewMode,
        ),
      });
    return Boolean(
      saved?.id ||
      savedProfiles?.length ||
      dictionaries?.companies?.length ||
      dictionaries?.reasons?.length ||
      dictionaries?.arrangers?.length ||
      services?.ocrProfiles?.length ||
      services?.llmProfiles?.length,
    );
  }

  async function loadDraft() {
    try {
      if (isTauriRuntime()) {
        let bootstrap = await bootstrapStorage(false);
        if (
          bootstrap.status === "migrationFailed" &&
          bootstrap.canUseDefaultSettings
        ) {
          try {
            await ElMessageBox.confirm(
              `${bootstrap.message}\n\n是否仅恢复所有可读单据，并对损坏的设置使用默认值？`,
              "旧版设置损坏",
              {
                confirmButtonText: "仅恢复单据",
                cancelButtonText: "暂不处理",
                type: "warning",
                closeOnClickModal: false,
                closeOnPressEscape: false,
              },
            );
            bootstrap = await bootstrapStorage(true);
          } catch {
            /* 用户保留旧数据，不启用空工作区 */
          }
        }
        storageBootstrap.value = bootstrap;
        dataDirectory.value = bootstrap.dataDirectory;
        if (bootstrap.status === "recoveryRequired") {
          storageRecoveryError.value = bootstrap.message;
          await loadBackupStatus();
          return;
        }
        if (bootstrap.status === "migrationFailed") {
          storageRecoveryError.value = bootstrap.message;
          return;
        }
        storageReady.value = true;
        const workspace = await loadWorkspace();
        await applyWorkspace(workspace);
        await scheduleStorageBackup();
        if (bootstrap.status === "migrated") {
          ElMessage.success(
            `已迁移 ${bootstrap.migratedRecords} 份单据、${bootstrap.migratedExpenses} 条费用和 ${bootstrap.migratedAttachments} 张图片`,
          );
        }
      } else {
        loadBrowserWorkspace();
      }
      isSaved.value = true;
      saveText.value = `已保存 ${formatSaveTime(draft.updatedAt)}`;
    } catch (error) {
      storageReady.value = false;
      storageRecoveryError.value = `本地数据未能安全打开：${errorMessage(error)}`;
      storageBootstrap.value = {
        status: "migrationFailed",
        message: storageRecoveryError.value,
        dataDirectory: dataDirectory.value,
        migratedRecords: 0,
        migratedExpenses: 0,
        migratedAttachments: 0,
        corruptFiles: [],
        canUseDefaultSettings: false,
        backupScheduled: false,
      };
    } finally {
      isLoadingWorkspace.value = false;
    }
  }

  function dirty() {
    context.clearSelection();
    isSaved.value = false;
    saveText.value = "尚未保存";
    draft.updatedAt = new Date().toISOString();
  }

  function scheduleAutoSave() {
    if (
      isLoadingWorkspace.value ||
      suppressAutoSave ||
      (isTauriRuntime() && !storageReady.value)
    )
      return;
    autoSaveRevision += 1;
    isSaved.value = false;
    saveText.value = "尚未保存";
    if (saveTimer.value !== null) window.clearTimeout(saveTimer.value);
    saveTimer.value = window.setTimeout(() => {
      saveTimer.value = null;
      void persistDraft(false);
    }, 900);
  }

  function setSuppressAutoSave(value: boolean) {
    suppressAutoSave = value;
  }
  function getSuppressAutoSave() {
    return suppressAutoSave;
  }
  function getAutoSaveRevision() {
    return autoSaveRevision;
  }
  function getSaveTimer() {
    return saveTimer.value;
  }

  return {
    draft,
    isSaved,
    saveText,
    isLoadingWorkspace,
    storageReady,
    storageBootstrap,
    migrationProgress,
    storageRecoveryError,
    dataDirectory,
    saveTimer,
    createDraft,
    cloneDraft,
    uiPreferencesSnapshot,
    historyItem,
    normalizeExtraAttachment,
    normalizeExpense,
    normalizeDraftForUse,
    persistDraft,
    saveDraft,
    applyDraft,
    replaceActiveDraft,
    applyWorkspace,
    loadBrowserWorkspace,
    loadDraft,
    dirty,
    scheduleAutoSave,
    setSuppressAutoSave,
    getSuppressAutoSave,
    getAutoSaveRevision,
    getSaveTimer,
  };
}
