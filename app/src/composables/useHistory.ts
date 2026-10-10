import { computed, ref, type Ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { REIMBURSEMENT_STATUSES } from "../constants/app";
import {
  formatSaveTime,
  normalizeReimbursementStatus,
  id,
} from "../utils/format";
import type {
  Draft,
  Expense,
  HistoryFolder,
  HistoryRecord,
  HistoryViewMode,
  ReimbursementStatus,
} from "../types/models";
import {
  deleteRecord,
  loadRecord,
  queryHistory,
  updateRecordStatus,
} from "../services/storageService";
import { errorMessage } from "../services/runtimeService";

export interface HistoryState {
  historyRecords: Ref<HistoryRecord[]>;
  historySearch: Ref<string>;
  historyDate: Ref<string>;
  historyStatus: Ref<ReimbursementStatus | "">;
  historyPage: Ref<number>;
  historyPageSize: Ref<number>;
  historyQueryRecords: Ref<HistoryRecord[]>;
  historyQueryTotal: Ref<number>;
  isHistoryQueryLoading: Ref<boolean>;
  historyViewMode: Ref<HistoryViewMode>;
  historyFolderKey: Ref<string>;
  isHistoryPreviewOpen: Ref<boolean>;
  isHistoryPreviewLoading: Ref<boolean>;
  historyPreviewItem: Ref<HistoryRecord | null>;
  historyPreviewDraft: Ref<Draft | null>;
}

export function createHistoryState(): HistoryState {
  return {
    historyRecords: ref<HistoryRecord[]>([]),
    historySearch: ref(""),
    historyDate: ref(""),
    historyStatus: ref<ReimbursementStatus | "">(""),
    historyPage: ref(1),
    historyPageSize: ref(8),
    historyQueryRecords: ref<HistoryRecord[]>([]),
    historyQueryTotal: ref(0),
    isHistoryQueryLoading: ref(false),
    historyViewMode: ref<HistoryViewMode>("company"),
    historyFolderKey: ref(""),
    isHistoryPreviewOpen: ref(false),
    isHistoryPreviewLoading: ref(false),
    historyPreviewItem: ref<HistoryRecord | null>(null),
    historyPreviewDraft: ref<Draft | null>(null),
  };
}

export interface HistoryContext {
  draft: Draft;
  historyState: HistoryState;
  companyNames: Ref<string[]>;
  storageReady: Ref<boolean>;
  isTauriRuntime: () => boolean;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
  cloneDraft: (value?: Draft) => Draft;
  normalizeDraftForUse: (value: Partial<Draft>) => Draft;
  hydrateDraftImages: (value: Draft) => Promise<Draft>;
  revokeDraftImageUrls: (value: Draft | null | undefined) => void;
  replaceActiveDraft: (value: Draft) => void;
  createDraft: () => Draft;
  dirty: () => void;
  switchTab: (
    tab: "reimbursement" | "history" | "requests" | "settings" | "about",
  ) => void;
  withTemporaryDraft: <T>(
    source: Draft,
    callback: () => Promise<T>,
  ) => Promise<T>;
  exportExcel: (sourceDraft?: Draft) => Promise<unknown>;
  exportPdf: (sourceDraft?: Draft) => Promise<unknown>;
  isSaved: Ref<boolean>;
  saveText: Ref<string>;
  setSuppressAutoSave: (value: boolean) => void;
  clearSelection: () => void;
}

export function useHistory(context: HistoryContext) {
  const {
    historyRecords,
    historySearch,
    historyDate,
    historyStatus,
    historyPage,
    historyPageSize,
    historyQueryRecords,
    historyQueryTotal,
    isHistoryQueryLoading,
    historyViewMode,
    historyFolderKey,
    isHistoryPreviewOpen,
    isHistoryPreviewLoading,
    historyPreviewItem,
    historyPreviewDraft,
  } = context.historyState;
  const { draft } = context;
  const companyNames = context.companyNames;
  const storageReady = context.storageReady;
  const isTauriRuntime = context.isTauriRuntime;
  const persistDraft = context.persistDraft;
  const cloneDraft = context.cloneDraft;
  const normalizeDraftForUse = context.normalizeDraftForUse;
  const hydrateDraftImages = context.hydrateDraftImages;
  const revokeDraftImageUrls = context.revokeDraftImageUrls;
  const replaceActiveDraft = context.replaceActiveDraft;
  const createDraft = context.createDraft;
  const dirty = context.dirty;
  const switchTab = context.switchTab;
  const withTemporaryDraft = context.withTemporaryDraft;
  const exportExcel = context.exportExcel;
  const exportPdf = context.exportPdf;
  const isSaved = context.isSaved;
  const saveText = context.saveText;
  const setSuppressAutoSave = context.setSuppressAutoSave;
  const filteredHistory = computed(() => {
    const keyword = historySearch.value.trim().toLowerCase();
    return historyRecords.value.filter((item) => {
      const matchesKeyword =
        !keyword ||
        `${item.label} ${item.companyName} ${item.applicant} ${item.id}`
          .toLowerCase()
          .includes(keyword);
      const matchesDate =
        !historyDate.value ||
        item.firstOccurredDate?.slice(0, 10) === historyDate.value;
      const matchesStatus =
        !historyStatus.value || item.status === historyStatus.value;
      return matchesKeyword && matchesDate && matchesStatus;
    });
  });
  const historyFolders = computed<HistoryFolder[]>(() => {
    if (historyViewMode.value === "list") return [];
    const groups = new Map<string, HistoryFolder>();
    filteredHistory.value.forEach((item) => {
      const key =
        historyViewMode.value === "status"
          ? `status:${item.status}`
          : `company:${item.companyName || "未填写公司"}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      const companyLabel = item.companyName || "未填写公司";
      groups.set(key, {
        key,
        label: historyViewMode.value === "status" ? item.status : companyLabel,
        count: 1,
        deleted:
          historyViewMode.value === "company" &&
          companyLabel !== "未填写公司" &&
          !companyNames.value.includes(companyLabel),
      });
    });
    return [...groups.values()].sort((left, right) => {
      if (historyViewMode.value === "status") {
        return (
          REIMBURSEMENT_STATUSES.indexOf(left.label as ReimbursementStatus) -
          REIMBURSEMENT_STATUSES.indexOf(right.label as ReimbursementStatus)
        );
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
  });
  const historyScopedRecords = computed(() => {
    if (historyViewMode.value === "list" || !historyFolderKey.value)
      return historyViewMode.value === "list" ? filteredHistory.value : [];
    return filteredHistory.value.filter((item) => {
      if (historyViewMode.value === "status")
        return historyFolderKey.value === `status:${item.status}`;
      return (
        historyFolderKey.value === `company:${item.companyName || "未填写公司"}`
      );
    });
  });
  const historyCurrentFolder = computed(() =>
    historyFolders.value.find((item) => item.key === historyFolderKey.value),
  );
  const lastEditedHistoryId = computed(
    () =>
      [...historyRecords.value]
        .filter((item) => item.id !== draft.id)
        .sort(
          (left, right) =>
            new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime(),
        )[0]?.id ?? "",
  );
  const pagedHistory = computed(() =>
    isTauriRuntime()
      ? historyQueryRecords.value
      : historyScopedRecords.value.slice(
          (historyPage.value - 1) * historyPageSize.value,
          historyPage.value * historyPageSize.value,
        ),
  );
  const historyResultTotal = computed(() =>
    isTauriRuntime()
      ? historyQueryTotal.value
      : historyScopedRecords.value.length,
  );

  async function cycleHistoryStatus(item: HistoryRecord) {
    const previousStatus = item.status;
    const index = REIMBURSEMENT_STATUSES.indexOf(item.status);
    item.status =
      REIMBURSEMENT_STATUSES[(index + 1) % REIMBURSEMENT_STATUSES.length];
    item.updatedAt = new Date().toISOString();
    if (historyPreviewItem.value?.id === item.id && historyPreviewDraft.value)
      historyPreviewDraft.value.status = item.status;
    if (item.id === draft.id) {
      draft.status = item.status;
      dirty();
      if (
        historyViewMode.value === "status" &&
        historyFolderKey.value &&
        !historyScopedRecords.value.length
      )
        leaveHistoryFolder();
      return;
    }
    try {
      if (isTauriRuntime()) await updateRecordStatus(item.id, item.status);
    } catch (error) {
      item.status = previousStatus;
      if (historyPreviewDraft.value?.id === item.id)
        historyPreviewDraft.value.status = previousStatus;
      ElMessage.error(`状态保存失败：${errorMessage(error)}`);
      return;
    }
    const indexed = historyRecords.value.find((value) => value.id === item.id);
    if (indexed) {
      indexed.status = item.status;
      indexed.updatedAt = item.updatedAt;
    }
    await refreshHistoryQuery();
    if (
      historyViewMode.value === "status" &&
      historyFolderKey.value &&
      !historyScopedRecords.value.length
    )
      leaveHistoryFolder();
  }
  function normalizeHistory(value: Partial<HistoryRecord>): HistoryRecord {
    return {
      id: value.id ?? id("record"),
      label: value.label ?? value.draft?.label ?? "",
      status: normalizeReimbursementStatus(value.status ?? value.draft?.status),
      companyName: value.companyName ?? value.draft?.companyName ?? "",
      applicant: value.applicant ?? value.draft?.applicant ?? "",
      reimbursementDate: value.reimbursementDate ?? "",
      expenseCount: Number(value.expenseCount) || 0,
      totalCents: Number(value.totalCents) || 0,
      firstOccurredDate:
        value.firstOccurredDate ??
        value.draft?.expenses?.[0]?.occurredDate ??
        "",
      updatedAt: value.updatedAt ?? new Date().toISOString(),
      draft: value.draft,
    };
  }
  async function loadHistoryDraft(item: HistoryRecord) {
    const raw = item.draft ? cloneDraft(item.draft) : await loadRecord(item.id);
    const restored = normalizeDraftForUse(raw);
    restored.label = item.label;
    restored.status = item.status;
    restored.updatedAt = item.updatedAt;
    await hydrateDraftImages(restored);
    return restored;
  }
  async function openHistoryPreview(item: HistoryRecord) {
    isHistoryPreviewOpen.value = true;
    isHistoryPreviewLoading.value = true;
    historyPreviewItem.value = item;
    revokeDraftImageUrls(historyPreviewDraft.value);
    historyPreviewDraft.value = null;
    try {
      const restored = await loadHistoryDraft(item);
      historyPreviewDraft.value = restored;
      if (!item.firstOccurredDate && restored.expenses[0]?.occurredDate) {
        item.firstOccurredDate = restored.expenses[0].occurredDate;
        await persistDraft(false);
      }
    } catch (error) {
      isHistoryPreviewOpen.value = false;
      ElMessage.error(errorMessage(error));
    } finally {
      isHistoryPreviewLoading.value = false;
    }
  }
  async function editHistory(item: HistoryRecord) {
    try {
      const restored = await loadHistoryDraft(item);
      replaceActiveDraft(restored);
      isHistoryPreviewOpen.value = false;
      switchTab("reimbursement");
      isSaved.value = true;
      saveText.value = `已保存 ${formatSaveTime(restored.updatedAt)}`;
      ElMessage.success("已打开历史报销单，可继续修改");
    } catch (error) {
      ElMessage.error(errorMessage(error));
    }
  }
  function resetRecognitionMetadata(expense: Expense) {
    expense.ocrStatus = "manual";
    expense.ocrText = undefined;
    expense.llmText = undefined;
    expense.recognitionError = undefined;
    expense.recognitionVersion = 0;
    expense.recognizedFields = undefined;
    expense.lastOcrProfile = undefined;
    expense.lastLlmProfile = undefined;
    expense.lastRecognitionMs = undefined;
    expense.recognitionImageDataUrl = undefined;
    expense.recognitionBlobHash = undefined;
    expense.recognitionMimeType = undefined;
    expense.recognitionBlobExtension = undefined;
    expense.originalSizeBytes = undefined;
    expense.recognitionSizeBytes = undefined;
    expense.manualFields = {};
  }
  async function createFromHistoryTemplate(item: HistoryRecord) {
    try {
      const template = await loadHistoryDraft(item);
      const created = cloneDraft(template);
      created.id = id("record");
      created.companyName = "";
      created.label = template.label
        ? `${template.label} - 副本`
        : `${template.companyName || "报销单"} - 副本`;
      created.status = "未报销";
      created.updatedAt = new Date().toISOString();
      created.expenses.forEach((expense) => {
        expense.id = id("expense");
        resetRecognitionMetadata(expense);
        expense.extraAttachments.forEach((attachment) => {
          attachment.id = id("attachment");
        });
      });
      replaceActiveDraft(created);
      isHistoryPreviewOpen.value = false;
      switchTab("reimbursement");
      dirty();
      ElMessage.success("已按历史单据创建新的未报销单");
    } catch (error) {
      ElMessage.error(errorMessage(error));
    }
  }
  async function refreshHistoryQuery() {
    if (!isTauriRuntime() || !storageReady.value) return;
    if (historyViewMode.value !== "list" && !historyFolderKey.value) {
      historyQueryRecords.value = [];
      historyQueryTotal.value = 0;
      return;
    }
    const prefix = `${historyViewMode.value}:`;
    const folderKey = historyFolderKey.value.startsWith(prefix)
      ? historyFolderKey.value.slice(prefix.length)
      : "";
    isHistoryQueryLoading.value = true;
    try {
      const result = await queryHistory({
        keyword: (historySearch.value ?? "").trim(),
        date: historyDate.value ?? "",
        status: historyStatus.value ?? "",
        folderKind:
          historyViewMode.value === "list" ? "" : historyViewMode.value,
        folderKey:
          folderKey === "未填写公司" && historyViewMode.value === "company"
            ? ""
            : folderKey,
        page: historyPage.value,
        pageSize: historyPageSize.value,
      });
      historyQueryRecords.value = result.items.map(normalizeHistory);
      historyQueryTotal.value = result.total;
    } catch (error) {
      ElMessage.error(`历史记录查询失败：${errorMessage(error)}`);
    } finally {
      isHistoryQueryLoading.value = false;
    }
  }
  function openHistoryFolder(folder: HistoryFolder) {
    historyFolderKey.value = folder.key;
    historyPage.value = 1;
    void refreshHistoryQuery();
  }
  function leaveHistoryFolder() {
    historyFolderKey.value = "";
    historyPage.value = 1;
    historyQueryRecords.value = [];
    historyQueryTotal.value = 0;
  }
  async function removeHistory(item: HistoryRecord): Promise<boolean> {
    const deletingCurrent = item.id === draft.id;
    try {
      await ElMessageBox.confirm(
        deletingCurrent
          ? "当前正在编辑这张单据，删除后将自动创建一张空白报销单。已经导出的文件不受影响。"
          : "将删除这条本地报销记录，不影响已经导出的文件。",
        "删除历史记录",
        {
          confirmButtonText: "删除",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      if (deletingCurrent) {
        setSuppressAutoSave(true);
        revokeDraftImageUrls(draft);
        Object.assign(draft, createDraft());
        context.clearSelection();
        setSuppressAutoSave(false);
      }
      historyRecords.value = historyRecords.value.filter(
        (entry) => entry.id !== item.id,
      );
      const saved = await persistDraft(false);
      if (!saved) throw new Error("本地工作区保存失败，未执行记录删除");
      if (isTauriRuntime()) await deleteRecord(item.id);
      await refreshHistoryQuery();
      if (historyFolderKey.value && !historyScopedRecords.value.length)
        leaveHistoryFolder();
      ElMessage.success("历史记录已删除");
      return true;
    } catch (error) {
      if (error !== "cancel" && error !== "close")
        ElMessage.error(errorMessage(error));
      return false;
    }
  }
  async function removeHistoryFromPreview(item: HistoryRecord) {
    if (await removeHistory(item)) {
      isHistoryPreviewOpen.value = false;
      historyPreviewItem.value = null;
      historyPreviewDraft.value = null;
    }
  }
  async function printHistory(item: HistoryRecord) {
    try {
      const source = await loadHistoryDraft(item);
      await withTemporaryDraft(source, async () => {
        window.print();
      });
    } catch (error) {
      ElMessage.error(`历史单据打印失败：${errorMessage(error)}`);
    }
  }
  async function exportHistoryExcel(item: HistoryRecord) {
    try {
      const source = await loadHistoryDraft(item);
      await exportExcel(source);
    } catch (error) {
      ElMessage.error(`历史单据 Excel 导出失败：${errorMessage(error)}`);
    }
  }
  async function exportHistoryPdf(item: HistoryRecord) {
    try {
      const source = await loadHistoryDraft(item);
      await exportPdf(source);
    } catch (error) {
      ElMessage.error(`历史单据 PDF 导出失败：${errorMessage(error)}`);
    }
  }
  function cleanupPreviewDraft() {
    if (isHistoryPreviewOpen.value) return;
    revokeDraftImageUrls(historyPreviewDraft.value);
    historyPreviewDraft.value = null;
    historyPreviewItem.value = null;
  }

  return {
    historyRecords,
    historySearch,
    historyDate,
    historyStatus,
    historyPage,
    historyPageSize,
    historyQueryRecords,
    historyQueryTotal,
    isHistoryQueryLoading,
    historyViewMode,
    historyFolderKey,
    isHistoryPreviewOpen,
    isHistoryPreviewLoading,
    historyPreviewItem,
    historyPreviewDraft,
    filteredHistory,
    historyFolders,
    historyScopedRecords,
    historyCurrentFolder,
    lastEditedHistoryId,
    pagedHistory,
    historyResultTotal,
    cycleHistoryStatus,
    normalizeHistory,
    loadHistoryDraft,
    openHistoryPreview,
    editHistory,
    resetRecognitionMetadata,
    createFromHistoryTemplate,
    refreshHistoryQuery,
    openHistoryFolder,
    leaveHistoryFolder,
    removeHistory,
    removeHistoryFromPreview,
    printHistory,
    exportHistoryExcel,
    exportHistoryPdf,
    cleanupPreviewDraft,
  };
}
