<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  ArrowLeftBold,
  ArrowRightBold,
  Check,
  Clock,
  Connection,
  CopyDocument,
  Delete,
  Document,
  DocumentAdd,
  Download,
  EditPen,
  Folder,
  InfoFilled,
  Iphone,
  Picture,
  Plus,
  Printer,
  Refresh,
  Setting,
  Sort,
  Upload,
  View,
  WarningFilled,
  ZoomIn,
  ZoomOut,
} from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ExcelJS from "exceljs";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import {
  open as tauriOpen,
  save as tauriSave,
} from "@tauri-apps/plugin-dialog";
import { writeFile as tauriWriteFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as QRCode from "qrcode";
import AttachmentSurface from "./components/AttachmentSurface.vue";

type OcrMode = "advanced" | "handwriting";
type OcrStatus =
  "queued" | "recognizing" | "success" | "partial" | "error" | "manual";
type AppTab = "reimbursement" | "history" | "requests" | "settings" | "about";
type PreviewMode = "single" | "double";
type HistoryViewMode = "company" | "status" | "list";
type DictionaryType = "company" | "reason" | "arranger";
type ReimbursementStatus = "未报销" | "报销中" | "已报销";
type ExpenseEditableField =
  "occurredDate" | "reason" | "description" | "arranger" | "amountCents";
type HeaderEditableField =
  | "companyName"
  | "reimbursementDate"
  | "applicant"
  | "department"
  | "payeeName"
  | "account"
  | "bank";
interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  cropZoom: number;
  cropX: number;
  cropY: number;
}
interface RecognizedFields {
  occurredDate?: string;
  reason?: string;
  description?: string;
  amountCents?: number;
  confidence?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}
interface ExtraAttachment {
  id: string;
  fileName: string;
  imageDataUrl: string;
  blobHash?: string;
  mimeType?: string;
  blobExtension?: string;
  sizeBytes?: number;
  naturalWidth: number;
  naturalHeight: number;
  transform: Transform;
}
interface Expense {
  id: string;
  fileName: string;
  imageDataUrl: string;
  recognitionImageDataUrl?: string;
  blobHash?: string;
  mimeType?: string;
  blobExtension?: string;
  sizeBytes?: number;
  recognitionBlobHash?: string;
  recognitionMimeType?: string;
  recognitionBlobExtension?: string;
  originalSizeBytes?: number;
  recognitionSizeBytes?: number;
  occurredDate: string;
  reason: string;
  description: string;
  arranger: string;
  amountCents: number;
  ocrMode: OcrMode;
  ocrStatus: OcrStatus;
  ocrText?: string;
  llmText?: string;
  recognitionError?: string;
  recognitionVersion?: number;
  recognizedFields?: RecognizedFields;
  lastOcrProfile?: string;
  lastLlmProfile?: string;
  lastRecognitionMs?: number;
  transform: Transform;
  naturalWidth: number;
  naturalHeight: number;
  extraAttachments: ExtraAttachment[];
  manualFields: Record<string, boolean>;
}
interface PreviewAttachment extends ExtraAttachment {
  expenseId: string;
  isPrimary: boolean;
  label: string;
}
interface Profile {
  id: string;
  name: string;
  applicant: string;
  department: string;
  payeeName: string;
  account: string;
  bank: string;
  isDefault: boolean;
}
interface Draft {
  id: string;
  label: string;
  status: ReimbursementStatus;
  companyName: string;
  reimbursementDate: string;
  applicant: string;
  department: string;
  payeeName: string;
  account: string;
  bank: string;
  totalOverrideCents: number | null;
  previewMode: PreviewMode;
  expenses: Expense[];
  updatedAt: string;
}
interface HistoryRecord {
  id: string;
  label: string;
  status: ReimbursementStatus;
  companyName: string;
  applicant: string;
  reimbursementDate: string;
  expenseCount: number;
  totalCents: number;
  firstOccurredDate?: string;
  updatedAt: string;
  draft?: Draft;
}
interface HistoryFolder {
  key: string;
  label: string;
  count: number;
  deleted?: boolean;
}
interface HistoryQueryResult {
  items: HistoryRecord[];
  total: number;
}
interface CellSelection {
  recordId: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}
interface OcrProfile {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  timeoutSeconds: number;
  isDefault: boolean;
}
interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  multimodal: boolean;
  isDefault: boolean;
}
interface FormExpenseRow {
  expense: Expense;
  index: number;
  height: number;
}
interface FormPage {
  rows: FormExpenseRow[];
  isFirst: boolean;
  isLast: boolean;
}
interface RequestLogSummary {
  id: string;
  service: "ocr" | "llm";
  recordId: string;
  expenseId: string;
  fileName: string;
  profileName: string;
  model?: string;
  action?: string;
  requestUrl: string;
  requestedAt: string;
  durationMs: number;
  httpStatus?: number;
  success: boolean;
  error?: string;
}
interface RequestLogRecord extends RequestLogSummary {
  requestContent: string;
  responseContent?: string;
}
interface RecognitionResponse {
  ocrText: string;
  llmText?: string;
  extracted?: {
    occurredDate?: string;
    reasonName?: string;
    description?: string;
    amountCents?: number;
    confidence: Record<string, unknown>;
    evidence: Record<string, unknown>;
  };
  ocrProfileName: string;
  llmProfileName: string;
  ocrElapsedMs: number;
  llmElapsedMs: number;
  llmError?: string;
}
interface LoadedWorkspace {
  draft?: Draft;
  profiles: Profile[];
  dictionaries: {
    companies?: string[];
    reasons?: string[];
    arrangers?: string[];
    defaultCompany?: string;
    defaultReason?: string;
    defaultArranger?: string;
  };
  services: { ocrProfiles?: OcrProfile[]; llmProfiles?: LlmProfile[] };
  history: HistoryRecord[];
  uiPreferences?: {
    leftPanelWidth?: number;
    historyViewMode?: HistoryViewMode;
  };
  dataDirectory: string;
}
interface StorageBootstrapResult {
  status: "ready" | "migrated" | "recoveryRequired" | "migrationFailed";
  message: string;
  dataDirectory: string;
  migratedRecords: number;
  migratedExpenses: number;
  migratedAttachments: number;
  corruptFiles: string[];
  canUseDefaultSettings: boolean;
  backupScheduled: boolean;
}
interface MigrationProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}
interface StoredAttachment {
  blobHash: string;
  mimeType: string;
  blobExtension: string;
  sizeBytes: number;
  recognitionBlobHash?: string;
  recognitionMimeType?: string;
  recognitionBlobExtension?: string;
  recognitionSizeBytes?: number;
}
interface AttachmentBytes {
  bytes: number[];
  mimeType: string;
  extension: string;
}
interface DatabaseBackupItem {
  fileName: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  valid: boolean;
  imagesComplete: boolean;
  error?: string;
}
interface LegacyArchiveItem {
  directoryName: string;
  path: string;
  sizeBytes: number;
}
interface BackupStatus {
  lastBackupAt?: string;
  validBackupCount: number;
  backupDue: boolean;
  backups: DatabaseBackupItem[];
  legacyArchives: LegacyArchiveItem[];
  dataDirectory: string;
}
interface ConfigurationTransferPayload {
  format: "sheepfinance-configuration";
  version: 1;
  exportedAt: string;
  profiles: Profile[];
  dictionaries: LoadedWorkspace["dictionaries"];
  services: { ocrProfiles: OcrProfile[]; llmProfiles: LlmProfile[] };
}
interface EncryptedConfigurationEnvelope {
  format: "sheepfinance-encrypted-configuration";
  version: 1;
  algorithm: "AES-256-GCM";
  keyDerivation: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}
interface LanUploadSessionInfo {
  url: string;
  recordId: string;
  targetExpenseId?: string;
  label: string;
  expiresAt: number;
  remainingSlots: number;
  localAddress: string;
}
interface LanUploadReceivedEvent {
  recordId: string;
  targetExpenseId?: string;
  remainingSlots: number;
  file: {
    fileName: string;
    mimeType: string;
    dataUrl: string;
  };
}

const STORAGE_KEY = "sheepfinance:workbench:v1";
const PROFILE_KEY = "sheepfinance:profiles:v1";
const DICTIONARY_KEY = "sheepfinance:dictionaries:v1";
const HISTORY_KEY = "sheepfinance:history:v1";
const SERVICE_KEY = "sheepfinance:services:v1";
const UI_PREFERENCES_KEY = "sheepfinance:ui-preferences:v1";
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const MAX_EXPENSES = 10;
const ATTACHMENTS_PER_PAGE = 6;
const MAX_TOTAL_ATTACHMENTS = 30;
const MAX_ATTACHMENTS_PER_EXPENSE = 10;
const FIRST_FORM_ROW_BUDGET = 785;
const CONTINUATION_FORM_ROW_BUDGET = 816;
const MIN_SHARED_ATTACHMENT_HEIGHT = 126;
const DEFAULT_LLM_MODEL = "deepseek-v4-flash";
const REIMBURSEMENT_STATUSES: ReimbursementStatus[] = [
  "未报销",
  "报销中",
  "已报销",
];
const CONFIG_TRANSFER_ITERATIONS = 180_000;
const CONFIG_TRANSFER_SECRET = "SheepFinance::local-configuration-transfer::v1";
const companyNames = ref(["xxxx有限公司"]);
const expenseReasons = ref(["办公费", "招待费", "差旅费", "固定资产"]);
const arrangers = ref(["王董", "张英姿", "解柳婷", "用户自行选择"]);
const defaultCompany = ref("xxxx有限公司");
const defaultReason = ref("办公费");
const defaultArranger = ref("王董");
const profiles = ref<Profile[]>([
  {
    id: "default-profile",
    name: "默认申请人",
    applicant: "",
    department: "",
    payeeName: "",
    account: "",
    bank: "",
    isDefault: true,
  },
]);
const historyRecords = ref<HistoryRecord[]>([]);
const ocrProfiles = ref<OcrProfile[]>([
  {
    id: "aliyun-default",
    name: "阿里云 OCR",
    endpoint: "https://ocr-api.cn-hangzhou.aliyuncs.com",
    region: "cn-hangzhou",
    accessKeyId: "",
    accessKeySecret: "",
    timeoutSeconds: 30,
    isDefault: true,
  },
]);
const llmProfiles = ref<LlmProfile[]>([
  {
    id: "deepseek-default",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: DEFAULT_LLM_MODEL,
    timeoutSeconds: 30,
    multimodal: false,
    isDefault: true,
  },
]);

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}
function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function transform(index: number, total = 6): Transform {
  const columns = 3;
  const rows = total <= 6 ? 2 : Math.ceil(total / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: (column * 100) / columns,
    y: (row * 100) / rows,
    width: 100 / columns,
    height: 100 / rows,
    rotation: 0,
    cropZoom: 1,
    cropX: 50,
    cropY: 50,
  };
}
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
    expenses: [],
    updatedAt: new Date().toISOString(),
  };
}

const draft = reactive<Draft>(createDraft());
const selectedId = ref<string | null>(null);
const selectedAttachmentId = ref<string | null>(null);
const uploadZone = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const extraFileInput = ref<HTMLInputElement | null>(null);
const extraUploadZone = ref<HTMLElement | null>(null);
const configImportInput = ref<HTMLInputElement | null>(null);
const previewViewport = ref<HTMLElement | null>(null);
const editInput = ref<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
>(null);
const isOcrResultOpen = ref(false);
const isExtraUploadOpen = ref(false);
const extraUploadFocused = ref(false);
const extraUploadExpenseId = ref<string | null>(null);
const isLanUploadOpen = ref(false);
const isLanUploadLoading = ref(false);
const lanUploadSession = ref<LanUploadSessionInfo | null>(null);
const lanUploadQrCode = ref("");
const lanUploadError = ref("");
const lanUploadNow = ref(Date.now());
const lanUploadTargetExpenseId = ref<string | null>(null);
const ocrResultExpense = ref<Expense | null>(null);
const handwritingMode = ref(false);
const uploadFocused = ref(false);
const editingKey = ref<string | null>(null);
const editValue = ref("");
const amountInputValues = reactive<Record<string, string>>({});
const paperScale = ref(0.78);
const previewZoom = ref(1);
const isExportingPdf = ref(false);
const isSaved = ref(true);
const saveText = ref("等待保存");
const isLoadingWorkspace = ref(true);
const storageReady = ref(!isTauriRuntime());
const storageBootstrap = ref<StorageBootstrapResult | null>(null);
const migrationProgress = ref<MigrationProgress | null>(null);
const storageRecoveryError = ref("");
const dataDirectory = ref("");
const activeTab = ref<AppTab>("reimbursement");
const historySearch = ref("");
const historyDate = ref("");
const historyStatus = ref<ReimbursementStatus | "">("");
const historyPage = ref(1);
const historyPageSize = ref(8);
const historyQueryRecords = ref<HistoryRecord[]>([]);
const historyQueryTotal = ref(0);
const isHistoryQueryLoading = ref(false);
const historyViewMode = ref<HistoryViewMode>("company");
const historyFolderKey = ref("");
const isHistoryPreviewOpen = ref(false);
const isHistoryPreviewLoading = ref(false);
const historyPreviewItem = ref<HistoryRecord | null>(null);
const historyPreviewDraft = ref<Draft | null>(null);
const requestRecords = ref<RequestLogSummary[]>([]);
const requestSearch = ref("");
const requestService = ref<"ocr" | "llm" | "">("");
const requestStatus = ref<"success" | "error" | "">("");
const requestPage = ref(1);
const requestPageSize = ref(10);
const isRequestLoading = ref(false);
const isRequestDetailOpen = ref(false);
const isRequestDetailLoading = ref(false);
const requestDetail = ref<RequestLogRecord | null>(null);
const backupStatus = ref<BackupStatus | null>(null);
const backupLoading = ref(false);
const selectedRecoveryBackup = ref("");
const newCompany = ref("");
const newReason = ref("");
const newArranger = ref("");
const saveTimer = ref<number | null>(null);
const lanReceivedCount = ref(0);
const leftPanelWidth = ref(404);
const leftPanelResizeState = ref<{
  startX: number;
  startWidth: number;
} | null>(null);
const cellSelection = ref<CellSelection | null>(null);
let autoSaveRevision = 0;
let suppressAutoSave = false;
let lanUploadClockTimer: number | null = null;
let lanUploadNoticeTimer: number | null = null;
let lanUploadUnlisten: UnlistenFn | null = null;
let storageMigrationUnlisten: UnlistenFn | null = null;
let backupFailureUnlisten: UnlistenFn | null = null;
let lanUploadListenerReady: Promise<void> | null = null;
let lanUploadQueue = Promise.resolve();
let lanUploadPendingEvents = 0;
let lanUploadRequestVersion = 0;
const pointerState = ref<{
  type: "move" | "resize";
  id: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
} | null>(null);
const expenseDragState = ref<{
  id: string;
  surface: "list" | "paper";
} | null>(null);
const dictionaryDragState = ref<{
  type: DictionaryType;
  value: string;
  pointerId: number;
} | null>(null);
const dictionaryDropTarget = ref<{
  type: DictionaryType;
  value: string;
  placement: "before" | "after";
} | null>(null);
const paperCellPointerState = ref<{
  pointerId: number;
  startX: number;
  startY: number;
  startRow: number;
  startColumn: number;
  dragged: boolean;
} | null>(null);
let suppressPaperCellClick = false;

const extraUploadExpense = computed(
  () =>
    draft.expenses.find((item) => item.id === extraUploadExpenseId.value) ??
    null,
);
function wrappedLineCount(value: string, lineCapacity: number) {
  return Math.max(
    1,
    value.split(/\r?\n/).reduce((total, line) => {
      const width = Array.from(line).reduce(
        (sum, character) =>
          sum + (/^[\u0000-\u00ff]$/.test(character) ? 0.55 : 1),
        0,
      );
      return total + Math.max(1, Math.ceil(width / lineCapacity));
    }, 0),
  );
}
function expenseRowHeight(expense: Expense) {
  const lines = Math.max(
    2,
    wrappedLineCount(expense.description || "", 18),
    wrappedLineCount(expense.arranger || "", 8),
  );
  return Math.max(42, Math.ceil(10 + lines * 15.6));
}
const previewAttachments = computed<PreviewAttachment[]>(() =>
  draft.expenses.flatMap((expense, expenseIndex) => [
    {
      id: expense.id,
      expenseId: expense.id,
      isPrimary: true,
      label: `${expenseIndex + 1}`,
      fileName: expense.fileName,
      imageDataUrl: expense.imageDataUrl,
      blobHash: expense.blobHash,
      mimeType: expense.mimeType,
      blobExtension: expense.blobExtension,
      sizeBytes: expense.sizeBytes,
      naturalWidth: expense.naturalWidth,
      naturalHeight: expense.naturalHeight,
      transform: expense.transform,
    },
    ...expense.extraAttachments.map((attachment, attachmentIndex) => ({
      ...attachment,
      expenseId: expense.id,
      isPrimary: false,
      label: `${expenseIndex + 1}-${attachmentIndex + 2}`,
    })),
  ]),
);
function findAttachment(attachmentId: string | null) {
  if (!attachmentId) return null;
  return (
    previewAttachments.value.find((item) => item.id === attachmentId) ?? null
  );
}
const selectedAttachment = computed(() =>
  findAttachment(selectedAttachmentId.value),
);
const formPages = computed<FormPage[]>(() => {
  const rows = draft.expenses.map((expense, index) => ({
    expense,
    index,
    height: expenseRowHeight(expense),
  }));
  if (!rows.length) return [{ rows: [], isFirst: true, isLast: true }];

  const pages: FormExpenseRow[][] = [];
  let currentRows: FormExpenseRow[] = [];
  let currentHeight = 0;
  let budget = FIRST_FORM_ROW_BUDGET;
  rows.forEach((row) => {
    if (currentRows.length && currentHeight + row.height > budget) {
      pages.push(currentRows);
      currentRows = [];
      currentHeight = 0;
      budget = CONTINUATION_FORM_ROW_BUDGET;
    }
    currentRows.push(row);
    currentHeight += row.height;
  });
  if (currentRows.length) pages.push(currentRows);

  return pages.map((pageRows, index) => ({
    rows: pageRows,
    isFirst: index === 0,
    isLast: index === pages.length - 1,
  }));
});
const attachmentPages = computed(() => {
  const pages: PreviewAttachment[][] = [];
  for (
    let index = 0;
    index < previewAttachments.value.length;
    index += ATTACHMENTS_PER_PAGE
  ) {
    pages.push(
      previewAttachments.value.slice(index, index + ATTACHMENTS_PER_PAGE),
    );
  }
  return pages;
});
const lastFormPageRemainingHeight = computed(() => {
  const page = formPages.value[formPages.value.length - 1];
  const rowHeight = page.rows.reduce((sum, row) => sum + row.height, 0);
  const fixedHeight = page.isFirst ? 281 : 250;
  return PAGE_HEIGHT - 57 - fixedHeight - rowHeight;
});
const sharedAttachmentPage = computed(() =>
  draft.previewMode === "single" &&
  formPages.value.length === 1 &&
  attachmentPages.value.length > 0 &&
  lastFormPageRemainingHeight.value >= MIN_SHARED_ATTACHMENT_HEIGHT
    ? attachmentPages.value[0]
    : null,
);
const separateAttachmentPages = computed(() =>
  sharedAttachmentPage.value
    ? attachmentPages.value.slice(1)
    : attachmentPages.value,
);
const previewPageCount = computed(
  () => formPages.value.length + separateAttachmentPages.value.length,
);
const lanUploadLabel = computed(() => {
  const base = draft.label.trim() || draft.companyName.trim() || "未命名报销单";
  return lanUploadTargetExpenseId.value
    ? `${base} · 费用 ${draft.expenses.findIndex((item) => item.id === lanUploadTargetExpenseId.value) + 1} 附图`
    : base;
});
const lanUploadSecondsRemaining = computed(() =>
  lanUploadSession.value
    ? Math.max(
        0,
        Math.floor(
          (lanUploadSession.value.expiresAt - lanUploadNow.value) / 1000,
        ),
      )
    : 0,
);
const lanUploadExpiryText = computed(() => {
  const seconds = lanUploadSecondsRemaining.value;
  if (!seconds) return "已过期";
  return `${Math.floor(seconds / 60)}:${`${seconds % 60}`.padStart(2, "0")}`;
});
const calculatedTotal = computed(() =>
  draft.expenses.reduce((sum, item) => sum + item.amountCents, 0),
);
const effectiveTotal = computed(
  () => draft.totalOverrideCents ?? calculatedTotal.value,
);
const manualTotal = computed(() => draft.totalOverrideCents !== null);
const displayScale = computed(() => paperScale.value * previewZoom.value);
const paperSize = computed(() => ({
  "--paper-scale": `${displayScale.value}`,
  "--scaled-paper-width": `${PAGE_WIDTH * displayScale.value}px`,
  "--scaled-paper-height": `${PAGE_HEIGHT * displayScale.value}px`,
  "--scaled-preview-height": `${
    PAGE_HEIGHT * displayScale.value * previewPageCount.value +
    28 * displayScale.value * Math.max(0, previewPageCount.value - 1)
  }px`,
}));
const defaultOcrProfile = computed(
  () =>
    ocrProfiles.value.find((item) => item.isDefault) ?? ocrProfiles.value[0],
);
const defaultLlmProfile = computed(
  () =>
    llmProfiles.value.find((item) => item.isDefault) ?? llmProfiles.value[0],
);
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
const filteredRequests = computed(() => {
  const keyword = requestSearch.value.trim().toLowerCase();
  return requestRecords.value.filter((item) => {
    const matchesKeyword =
      !keyword ||
      `${item.fileName} ${item.profileName} ${item.model ?? ""} ${item.action ?? ""} ${item.requestUrl} ${item.error ?? ""}`
        .toLowerCase()
        .includes(keyword);
    const matchesService =
      !requestService.value || item.service === requestService.value;
    const matchesStatus =
      !requestStatus.value ||
      (requestStatus.value === "success" ? item.success : !item.success);
    return matchesKeyword && matchesService && matchesStatus;
  });
});
const pagedRequests = computed(() =>
  filteredRequests.value.slice(
    (requestPage.value - 1) * requestPageSize.value,
    requestPage.value * requestPageSize.value,
  ),
);
const currentProfileId = computed({
  get() {
    return (
      profiles.value.find(
        (profile) =>
          profile.applicant === draft.applicant &&
          profile.department === draft.department &&
          profile.payeeName === draft.payeeName &&
          profile.account === draft.account &&
          profile.bank === draft.bank,
      )?.id ?? ""
    );
  },
  set(profileId: string) {
    const profile = profiles.value.find((item) => item.id === profileId);
    if (!profile) return;
    draft.applicant = profile.applicant;
    draft.department = profile.department;
    draft.payeeName = profile.payeeName;
    draft.account = profile.account;
    draft.bank = profile.bank;
    dirty();
  },
});

function parseAmountExpression(raw: string) {
  let source = raw.trim().replace(/[,，]/g, "");
  if (!source) return 0;
  if (source.startsWith("=")) source = source.slice(1).trim();
  if (!source || source.length > 160) return null;
  let cursor = 0;
  function skipSpaces() {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  function parseNumber() {
    skipSpaces();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(cursor));
    if (!match) return null;
    cursor += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  }
  function parsePrimary(): number | null {
    skipSpaces();
    if (source[cursor] === "(") {
      cursor += 1;
      const value = parseExpression();
      skipSpaces();
      if (source[cursor] !== ")" || value === null) return null;
      cursor += 1;
      return value;
    }
    return parseNumber();
  }
  function parseUnary(): number | null {
    skipSpaces();
    if (source[cursor] === "+" || source[cursor] === "-") {
      const sign = source[cursor] === "-" ? -1 : 1;
      cursor += 1;
      const value = parseUnary();
      return value === null ? null : sign * value;
    }
    return parsePrimary();
  }
  function parseTerm(): number | null {
    let value = parseUnary();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const operator = source[cursor];
      if (operator !== "*" && operator !== "/") return value;
      cursor += 1;
      const right = parseUnary();
      if (right === null || (operator === "/" && right === 0)) return null;
      value = operator === "*" ? value * right : value / right;
      if (!Number.isFinite(value)) return null;
    }
  }
  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;
    while (true) {
      skipSpaces();
      const operator = source[cursor];
      if (operator !== "+" && operator !== "-") return value;
      cursor += 1;
      const right = parseTerm();
      if (right === null) return null;
      value = operator === "+" ? value + right : value - right;
      if (!Number.isFinite(value)) return null;
    }
  }
  const result = parseExpression();
  skipSpaces();
  return result !== null && cursor === source.length && Number.isFinite(result)
    ? Math.abs(result) <= 1_000_000_000_000
      ? result
      : null
    : null;
}
function amountExpressionToCents(raw: string) {
  const value = parseAmountExpression(raw);
  return value === null ? null : Math.round(value * 100);
}
function money(cents: number) {
  const value = Object.is(cents, -0) ? 0 : cents;
  return (value / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function normalizeReimbursementStatus(value: unknown): ReimbursementStatus {
  return REIMBURSEMENT_STATUSES.includes(value as ReimbursementStatus)
    ? (value as ReimbursementStatus)
    : "未报销";
}
function normalizeHistoryViewMode(value: unknown): HistoryViewMode {
  return value === "status" || value === "list" ? value : "company";
}
function reimbursementStatusType(status: ReimbursementStatus) {
  if (status === "已报销") return "success";
  if (status === "报销中") return "warning";
  return "info";
}
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
    if (isTauriRuntime())
      await invoke("update_record_status", {
        recordId: item.id,
        status: item.status,
      });
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
function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function formatSaveTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
function ChineseAmount(cents: number) {
  const digits = "零壹贰叁肆伍陆柒捌玖";
  const units = ["", "拾", "佰", "仟"];
  const bigUnits = ["", "万", "亿", "兆"];
  const negative = cents < 0;
  const value = Math.abs(Math.round(cents));
  const withSign = (text: string) => (negative && value ? `负${text}` : text);
  const yuan = Math.floor(value / 100);
  const jiao = Math.floor((value % 100) / 10);
  const fen = value % 10;
  function groupToText(group: number) {
    let text = "";
    let zero = false;
    for (let i = 0; i < 4; i += 1) {
      const digit = Math.floor(group / 10 ** (3 - i)) % 10;
      if (!digit) {
        if (text) zero = true;
        continue;
      }
      if (zero) text += "零";
      text += `${digits[digit]}${units[3 - i]}`;
      zero = false;
    }
    return text;
  }
  if (!yuan && !jiao && !fen) return "零元整";
  let rest = yuan;
  const groups: number[] = [];
  while (rest) {
    groups.unshift(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let text = "";
  let needZero = false;
  groups.forEach((group, index) => {
    const unit = bigUnits[groups.length - index - 1] ?? "";
    if (!group) {
      if (text) needZero = true;
      return;
    }
    if (text && (needZero || group < 1000)) text += "零";
    text += `${groupToText(group)}${unit}`;
    needZero = false;
  });
  text += "元";
  if (jiao) text += `${digits[jiao]}角`;
  if (!jiao && fen) text += "零";
  if (fen) text += `${digits[fen]}分`;
  if (!jiao && !fen) text += "整";
  return withSign(text);
}
function fieldKey(expense: Expense, field: string) {
  return `expense:${expense.id}:${field}`;
}
function dirty() {
  cellSelection.value = null;
  isSaved.value = false;
  saveText.value = "尚未保存";
  draft.updatedAt = new Date().toISOString();
}
function beginEdit(key: string, value: string) {
  if (editingKey.value && editingKey.value !== key) commitActiveEdit();
  editingKey.value = key;
  editValue.value = value;
  nextTick(() => editInput.value?.focus());
}
function cancelEdit() {
  editingKey.value = null;
  editValue.value = "";
}
function commitHeader(field: HeaderEditableField) {
  if (editingKey.value !== field) return;
  draft[field] = editValue.value as never;
  cancelEdit();
  dirty();
}
function commitExpense(expense: Expense, field: ExpenseEditableField) {
  if (editingKey.value !== fieldKey(expense, field)) return;
  if (field === "amountCents") {
    const amount = amountExpressionToCents(editValue.value);
    if (amount === null) {
      ElMessage.warning("金额表达式无法计算，请检查数字和运算符");
      cancelEdit();
      return;
    }
    expense.amountCents = amount;
  } else expense[field] = editValue.value as never;
  expense.manualFields[field] = true;
  expense.ocrStatus = "manual";
  cancelEdit();
  dirty();
}
function commitActiveEdit() {
  const key = editingKey.value;
  if (!key) return;
  const expenseMatch =
    /^expense:(.+):(occurredDate|reason|description|arranger|amountCents)$/.exec(
      key,
    );
  if (expenseMatch) {
    const expense = draft.expenses.find((item) => item.id === expenseMatch[1]);
    if (expense) {
      commitExpense(expense, expenseMatch[2] as ExpenseEditableField);
      return;
    }
    cancelEdit();
    return;
  }
  const headerFields: HeaderEditableField[] = [
    "companyName",
    "reimbursementDate",
    "applicant",
    "department",
    "payeeName",
    "account",
    "bank",
  ];
  if (headerFields.includes(key as HeaderEditableField)) {
    commitHeader(key as HeaderEditableField);
    return;
  }
  cancelEdit();
}
function amountInputValue(expense: Expense) {
  return (
    amountInputValues[expense.id] ?? (expense.amountCents / 100).toFixed(2)
  );
}
function beginAmountInput(expense: Expense) {
  if (!(expense.id in amountInputValues))
    amountInputValues[expense.id] = (expense.amountCents / 100).toFixed(2);
}
function updateAmountInput(expense: Expense, value: string) {
  amountInputValues[expense.id] = value;
}
function commitAmountInput(expense: Expense) {
  const rawValue = amountInputValues[expense.id];
  if (rawValue === undefined) return;
  const amount = amountExpressionToCents(rawValue);
  if (amount === null) {
    ElMessage.warning("金额表达式无法计算，请检查数字和运算符");
    delete amountInputValues[expense.id];
    return;
  }
  expense.amountCents = amount;
  delete amountInputValues[expense.id];
  expense.manualFields.amountCents = true;
  expense.ocrStatus = "manual";
  dirty();
}

function ocrStatusLabel(expense: Expense) {
  const labels: Record<OcrStatus, string> = {
    queued: "等待识别",
    recognizing: "识别中",
    success: "识别完成",
    partial: "识别完成",
    error: "识别失败",
    manual: "识别完成",
  };
  return labels[expense.ocrStatus] ?? labels.queued;
}
function recognitionConfigured() {
  const ocr = defaultOcrProfile.value;
  const llm = defaultLlmProfile.value;
  return Boolean(
    ocr?.accessKeyId.trim() &&
    ocr?.accessKeySecret.trim() &&
    llm?.apiKey.trim() &&
    llm?.model.trim(),
  );
}
function openOcrResult(expense: Expense) {
  ocrResultExpense.value = expense;
  isOcrResultOpen.value = true;
}
function errorMessage(error: unknown) {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "识别请求失败";
}
function applyRecognizedField<
  T extends keyof Pick<
    Expense,
    "occurredDate" | "reason" | "description" | "amountCents"
  >,
>(expense: Expense, field: T, value: Expense[T] | undefined) {
  if (value === undefined || value === null || expense.manualFields[field])
    return;
  expense[field] = value;
}
function clearUnconfirmedExpenseFields(expense: Expense) {
  let changed = false;
  if (!expense.manualFields.reason && expense.reason) {
    expense.reason = "";
    changed = true;
  }
  if (!expense.manualFields.arranger && expense.arranger) {
    expense.arranger = "";
    changed = true;
  }
  return changed;
}
async function recognizeExpense(expense: Expense, notify = true) {
  if (expense.ocrStatus === "recognizing") return;
  if (clearUnconfirmedExpenseFields(expense)) dirty();
  if (!isTauriRuntime()) {
    expense.ocrStatus = "queued";
    expense.recognitionError = "OCR/大模型请求仅在桌面应用中运行";
    if (notify) ElMessage.warning(expense.recognitionError);
    return;
  }
  const ocrProfile = defaultOcrProfile.value;
  const llmProfile = defaultLlmProfile.value;
  if (!ocrProfile?.accessKeyId.trim() || !ocrProfile.accessKeySecret.trim()) {
    expense.ocrStatus = "queued";
    expense.recognitionError = "请先在设置中填写阿里云 OCR 密钥";
    if (notify) {
      ElMessage.warning(expense.recognitionError);
      switchTab("settings");
    }
    return;
  }
  if (!llmProfile?.apiKey.trim() || !llmProfile.model.trim()) {
    expense.ocrStatus = "queued";
    expense.recognitionError = "请先在设置中填写大模型 API Key 和模型名称";
    if (notify) {
      ElMessage.warning(expense.recognitionError);
      switchTab("settings");
    }
    return;
  }
  const version = (expense.recognitionVersion ?? 0) + 1;
  expense.recognitionVersion = version;
  expense.ocrStatus = "recognizing";
  expense.recognitionError = "";
  dirty();
  try {
    if (!(await persistDraft(false)))
      throw new Error("识别前保存单据失败，已取消本次请求");
    const result = await invoke<RecognitionResponse>("recognize_expense", {
      request: {
        recordId: draft.id,
        expenseId: expense.id,
        attachmentId: expense.id,
        ocrMode: expense.ocrMode,
        ocrProfileId: ocrProfile.id,
        llmProfileId: llmProfile.id,
      },
    });
    const current = draft.expenses.find((item) => item.id === expense.id);
    if (!current || current.recognitionVersion !== version) return;
    current.ocrText = result.ocrText;
    current.llmText = result.llmText ?? "";
    current.lastOcrProfile = result.ocrProfileName;
    current.lastLlmProfile = result.llmProfileName;
    current.lastRecognitionMs = result.ocrElapsedMs + result.llmElapsedMs;
    if (result.extracted) {
      current.recognizedFields = {
        occurredDate: result.extracted.occurredDate,
        reason: result.extracted.reasonName,
        description: result.extracted.description,
        amountCents: result.extracted.amountCents,
        confidence: result.extracted.confidence,
        evidence: result.extracted.evidence,
      };
      applyRecognizedField(
        current,
        "occurredDate",
        result.extracted.occurredDate,
      );
      applyRecognizedField(current, "reason", result.extracted.reasonName);
      applyRecognizedField(
        current,
        "description",
        result.extracted.description,
      );
      applyRecognizedField(
        current,
        "amountCents",
        result.extracted.amountCents,
      );
      // 事由和安排人必须人工确认，避免识别或字典默认值被直接带入单据。
      clearUnconfirmedExpenseFields(current);
    }
    current.recognitionError = result.llmError ?? "";
    current.ocrStatus = result.llmError ? "partial" : "success";
    dirty();
    if (notify)
      ElMessage.success(
        result.llmError
          ? "OCR 已完成，大模型提取失败，可查看原文后手工填写"
          : "识别完成，请人工确认事由和安排人",
      );
  } catch (error) {
    const current = draft.expenses.find((item) => item.id === expense.id);
    if (!current || current.recognitionVersion !== version) return;
    current.ocrStatus = "error";
    current.recognitionError = errorMessage(error);
    dirty();
    if (notify) ElMessage.error(current.recognitionError);
  }
}

function selectExpense(expense: Expense) {
  selectedId.value = expense.id;
  selectedAttachmentId.value = expense.id;
}
function selectAttachment(
  attachment: Pick<PreviewAttachment, "id" | "expenseId">,
) {
  selectedId.value = attachment.expenseId;
  selectedAttachmentId.value = attachment.id;
}
function paperCellValue(expense: Expense, columnIndex: number) {
  return (
    [
      String(draft.expenses.indexOf(expense) + 1),
      expense.occurredDate || "",
      expense.reason || "",
      expense.description || "",
      expense.arranger || "",
      (expense.amountCents / 100).toFixed(2),
    ][columnIndex] ?? ""
  );
}
function paperCellField(columnIndex: number): ExpenseEditableField | null {
  return ([
    null,
    "occurredDate",
    "reason",
    "description",
    "arranger",
    "amountCents",
  ][columnIndex] ?? null) as ExpenseEditableField | null;
}
function openPaperCellEditor(expense: Expense, columnIndex: number) {
  const field = paperCellField(columnIndex);
  if (!field) return;
  const value =
    field === "amountCents"
      ? (expense.amountCents / 100).toFixed(2)
      : String(expense[field] ?? "");
  beginEdit(fieldKey(expense, field), value);
  if (field !== "reason" && field !== "arranger") return;
  void nextTick(() => {
    const select = editInput.value;
    if (!(select instanceof HTMLSelectElement)) return;
    select.focus();
    try {
      (
        select as HTMLSelectElement & {
          showPicker?: () => void;
        }
      ).showPicker?.();
    } catch {
      /* 旧版 WebView2 聚焦后仍可手动展开 */
    }
  });
}
function handlePaperCellClick(
  event: MouseEvent,
  expense: Expense,
  columnIndex: number,
) {
  if (
    event.target instanceof Element &&
    event.target.closest("input, textarea, select, .paper-row-drag-handle")
  )
    return;
  if (suppressPaperCellClick) return;
  openPaperCellEditor(expense, columnIndex);
}
function isPaperCellSelected(
  pageIndex: number,
  rowIndex: number,
  columnIndex: number,
) {
  const selection = cellSelection.value;
  const row = formPages.value[pageIndex]?.rows[rowIndex];
  if (!selection || selection.recordId !== draft.id || !row) return false;
  const startRow = Math.min(selection.startRow, selection.endRow);
  const endRow = Math.max(selection.startRow, selection.endRow);
  const startColumn = Math.min(selection.startColumn, selection.endColumn);
  const endColumn = Math.max(selection.startColumn, selection.endColumn);
  return (
    row.index >= startRow &&
    row.index <= endRow &&
    columnIndex >= startColumn &&
    columnIndex <= endColumn
  );
}
function startPaperCellSelection(
  event: PointerEvent,
  pageIndex: number,
  rowIndex: number,
  columnIndex: number,
) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (event.target.closest("input, textarea, select, .paper-row-drag-handle"))
    return;
  event.preventDefault();
  event.stopPropagation();
  commitActiveEdit();
  window.getSelection()?.removeAllRanges();
  document.body.style.userSelect = "none";
  const row = formPages.value[pageIndex]?.rows[rowIndex];
  if (!row) return;
  selectExpense(row.expense);
  paperCellPointerState.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startRow: row.index,
    startColumn: columnIndex,
    dragged: false,
  };
  cellSelection.value = {
    recordId: draft.id,
    startRow: row.index,
    endRow: row.index,
    startColumn: columnIndex,
    endColumn: columnIndex,
  };
}
function trackPaperCellSelection(event: PointerEvent) {
  const state = paperCellPointerState.value;
  if (!state || state.pointerId !== event.pointerId) return;
  if (
    Math.abs(event.clientX - state.startX) >= 4 ||
    Math.abs(event.clientY - state.startY) >= 4
  )
    state.dragged = true;
}
function extendPaperCellSelection(
  event: PointerEvent,
  pageIndex: number,
  rowIndex: number,
  columnIndex: number,
) {
  const selection = cellSelection.value;
  const state = paperCellPointerState.value;
  if (!(event.buttons & 1)) return;
  const row = formPages.value[pageIndex]?.rows[rowIndex];
  if (
    !selection ||
    selection.recordId !== draft.id ||
    !state ||
    state.pointerId !== event.pointerId ||
    !row
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  selection.endRow = row.index;
  selection.endColumn = columnIndex;
  if (row.index !== state.startRow || columnIndex !== state.startColumn)
    state.dragged = true;
}
function finishPaperCellSelection(event: PointerEvent, canceled = false) {
  const state = paperCellPointerState.value;
  if (!state || state.pointerId !== event.pointerId) return;
  paperCellPointerState.value = null;
  document.body.style.userSelect = "";
  window.getSelection()?.removeAllRanges();
  suppressPaperCellClick = true;
  window.setTimeout(() => {
    suppressPaperCellClick = false;
  });
  if (canceled || state.dragged) return;
  const expense = draft.expenses[state.startRow];
  if (expense) openPaperCellEditor(expense, state.startColumn);
}
function endPaperCellSelection(event: PointerEvent) {
  finishPaperCellSelection(event);
}
function cancelPaperCellSelection(event: PointerEvent) {
  finishPaperCellSelection(event, true);
}
function clipboardCellValue(value: string) {
  return /["\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function selectedPaperCellText() {
  const selection = cellSelection.value;
  if (!selection || selection.recordId !== draft.id) return null;
  const startRow = Math.min(selection.startRow, selection.endRow);
  const endRow = Math.max(selection.startRow, selection.endRow);
  const startColumn = Math.min(selection.startColumn, selection.endColumn);
  const endColumn = Math.max(selection.startColumn, selection.endColumn);
  const rows: string[] = [];
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const expense = draft.expenses[rowIndex];
    if (!expense) continue;
    const columns: string[] = [];
    for (
      let columnIndex = startColumn;
      columnIndex <= endColumn;
      columnIndex += 1
    ) {
      columns.push(clipboardCellValue(paperCellValue(expense, columnIndex)));
    }
    rows.push(columns.join("\t"));
  }
  return rows.join("\r\n");
}
async function copySelectedPaperCells() {
  const value = selectedPaperCellText();
  if (value === null) return ElMessage.info("请先拖动选中要复制的单元格");
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  ElMessage.success("已复制选中单元格");
}
function handleGlobalKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c")
    return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select")) return;
  if (!cellSelection.value) return;
  event.preventDefault();
  void copySelectedPaperCells();
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
async function scrollExpenseIntoView(expenseId: string) {
  await nextTick();
  document
    .querySelector(`[data-expense-id="${expenseId}"]`)
    ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function openPicker() {
  uploadZone.value?.focus();
  fileInput.value?.click();
}
function dataUrlSize(dataUrl: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  return Math.ceil(((dataUrl.length - comma - 1) * 3) / 4);
}
const managedImageUrls = new Set<string>();
function createManagedImageUrl(value: Blob) {
  const url = URL.createObjectURL(value);
  managedImageUrls.add(url);
  return url;
}
function revokeManagedImageUrl(url?: string) {
  if (!url?.startsWith("blob:") || !managedImageUrls.has(url)) return;
  URL.revokeObjectURL(url);
  managedImageUrls.delete(url);
}
function revokeDraftImageUrls(value: Draft | null | undefined) {
  value?.expenses.forEach((expense) => {
    revokeManagedImageUrl(expense.imageDataUrl);
    revokeManagedImageUrl(expense.recognitionImageDataUrl);
    expense.extraAttachments.forEach((attachment) =>
      revokeManagedImageUrl(attachment.imageDataUrl),
    );
  });
}
async function loadStoredImageUrl(blobHash?: string) {
  if (!blobHash || !isTauriRuntime()) return "";
  const stored = await invoke<AttachmentBytes>("read_attachment", { blobHash });
  return createManagedImageUrl(
    new Blob([new Uint8Array(stored.bytes)], { type: stored.mimeType }),
  );
}
async function hydrateDraftImages(value: Draft) {
  if (!isTauriRuntime()) return value;
  const jobs: Promise<void>[] = [];
  value.expenses.forEach((expense) => {
    if (expense.blobHash && !expense.imageDataUrl) {
      jobs.push(
        loadStoredImageUrl(expense.blobHash).then((url) => {
          expense.imageDataUrl = url;
        }),
      );
    }
    expense.extraAttachments.forEach((attachment) => {
      if (!attachment.blobHash || attachment.imageDataUrl) return;
      jobs.push(
        loadStoredImageUrl(attachment.blobHash).then((url) => {
          attachment.imageDataUrl = url;
        }),
      );
    });
  });
  try {
    await Promise.all(jobs);
    return value;
  } catch (error) {
    revokeDraftImageUrls(value);
    throw error;
  }
}
function applyStoredAttachment(
  target: Expense | ExtraAttachment,
  stored: StoredAttachment,
) {
  target.blobHash = stored.blobHash;
  target.mimeType = stored.mimeType;
  target.blobExtension = stored.blobExtension;
  target.sizeBytes = stored.sizeBytes;
  if ("ocrMode" in target) {
    target.recognitionBlobHash = stored.recognitionBlobHash;
    target.recognitionMimeType = stored.recognitionMimeType;
    target.recognitionBlobExtension = stored.recognitionBlobExtension;
    target.recognitionSizeBytes = stored.recognitionSizeBytes;
  }
}
async function persistImage(
  recordId: string,
  imageDataUrl: string,
  recognitionDataUrl: string | undefined,
  width: number,
  height: number,
) {
  return invoke<StoredAttachment>("store_attachment", {
    request: {
      recordId,
      dataUrl: imageDataUrl,
      recognitionDataUrl,
      naturalWidth: width,
      naturalHeight: height,
    },
  });
}
function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法读取"));
    image.src = dataUrl;
  });
}
async function compressForRecognition(
  dataUrl: string,
  width: number,
  height: number,
) {
  const limit = 8 * 1024 * 1024;
  if (dataUrlSize(dataUrl) <= limit) return dataUrl;
  const image = await loadImage(dataUrl);
  let scale = Math.min(1, Math.sqrt(limit / dataUrlSize(dataUrl)));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) break;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const quality = Math.max(0.58, 0.88 - attempt * 0.06);
    const compressed = canvas.toDataURL("image/jpeg", quality);
    if (dataUrlSize(compressed) <= limit) return compressed;
    scale *= 0.82;
  }
  return dataUrl;
}
function readImage(file: File) {
  return new Promise<{ dataUrl: string; width: number; height: number }>(
    (resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () =>
          resolve({
            dataUrl: String(reader.result),
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
        image.onerror = () => reject(new Error("图片无法读取"));
        image.src = String(reader.result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
      reader.readAsDataURL(file);
    },
  );
}
async function addFile(file: File, notify = true, targetRecordId = draft.id) {
  if (draft.id !== targetRecordId) return false;
  if (!file.type.startsWith("image/")) {
    if (notify) ElMessage.warning("请选择图片文件");
    return false;
  }
  if (
    draft.expenses.length >= MAX_EXPENSES ||
    previewAttachments.value.length >= MAX_TOTAL_ATTACHMENTS
  ) {
    if (notify)
      ElMessage.warning(
        `一张报销单最多 ${MAX_EXPENSES} 笔费用、${MAX_TOTAL_ATTACHMENTS} 张图片`,
      );
    return false;
  }
  try {
    const image = await readImage(file);
    const recognitionImageDataUrl = await compressForRecognition(
      image.dataUrl,
      image.width,
      image.height,
    );
    const stored = isTauriRuntime()
      ? await persistImage(
          targetRecordId,
          image.dataUrl,
          recognitionImageDataUrl,
          image.width,
          image.height,
        )
      : null;
    if (draft.id !== targetRecordId) return false;
    if (
      draft.expenses.length >= MAX_EXPENSES ||
      previewAttachments.value.length >= MAX_TOTAL_ATTACHMENTS
    ) {
      if (notify)
        ElMessage.warning(
          `一张报销单最多 ${MAX_EXPENSES} 笔费用、${MAX_TOTAL_ATTACHMENTS} 张图片`,
        );
      return false;
    }
    const expense: Expense = {
      id: id("expense"),
      fileName:
        file.name || "剪贴板图片-" + (draft.expenses.length + 1) + ".png",
      imageDataUrl: isTauriRuntime()
        ? createManagedImageUrl(file)
        : image.dataUrl,
      recognitionImageDataUrl: isTauriRuntime()
        ? undefined
        : recognitionImageDataUrl,
      originalSizeBytes: dataUrlSize(image.dataUrl),
      recognitionSizeBytes: dataUrlSize(recognitionImageDataUrl),
      occurredDate: today(),
      reason: defaultReason.value || expenseReasons.value[0] || "办公费",
      description: "",
      arranger: defaultArranger.value || arrangers.value[0] || "",
      amountCents: 0,
      ocrMode: handwritingMode.value ? "handwriting" : "advanced",
      ocrStatus: "queued",
      recognitionVersion: 0,
      transform: transform(draft.expenses.length, draft.expenses.length + 1),
      naturalWidth: image.width,
      naturalHeight: image.height,
      extraAttachments: [],
      manualFields: {},
    };
    if (stored) applyStoredAttachment(expense, stored);
    draft.expenses.push(expense);
    reflowExpenses();
    selectedId.value = expense.id;
    selectedAttachmentId.value = expense.id;
    dirty();
    void scrollExpenseIntoView(expense.id);
    if (recognitionConfigured() && isTauriRuntime()) {
      if (notify)
        ElMessage.success(
          recognitionImageDataUrl === image.dataUrl
            ? "图片已加入，开始识别"
            : "图片已压缩为8MB以内，开始识别",
        );
      void recognizeExpense(expense, notify);
    } else if (notify) {
      ElMessage.success(
        recognitionImageDataUrl === image.dataUrl
          ? "图片已加入费用列表，配置服务后可开始识别"
          : "图片已加入，并生成了8MB以内的识别副本",
      );
    }
    return true;
  } catch (error) {
    if (notify)
      ElMessage.error(error instanceof Error ? error.message : "图片读取失败");
    return false;
  }
}
function extraAttachmentSlots(expense: Expense) {
  return Math.max(
    0,
    Math.min(
      MAX_ATTACHMENTS_PER_EXPENSE - expense.extraAttachments.length - 1,
      MAX_TOTAL_ATTACHMENTS - previewAttachments.value.length,
    ),
  );
}
function lanUploadRemainingSlots(
  targetExpenseId: string | null = lanUploadTargetExpenseId.value,
) {
  if (targetExpenseId) {
    const expense = draft.expenses.find((item) => item.id === targetExpenseId);
    return expense ? Math.min(10, extraAttachmentSlots(expense)) : 0;
  }
  return Math.max(
    0,
    Math.min(
      MAX_EXPENSES - draft.expenses.length,
      MAX_TOTAL_ATTACHMENTS - previewAttachments.value.length,
    ),
  );
}
async function addExtraAttachmentFile(
  file: File,
  expenseId: string,
  notify = true,
  targetRecordId = draft.id,
) {
  if (draft.id !== targetRecordId) return false;
  const expense = draft.expenses.find((item) => item.id === expenseId);
  if (!expense) return false;
  if (!file.type.startsWith("image/")) {
    if (notify) ElMessage.warning("请选择图片文件");
    return false;
  }
  if (!extraAttachmentSlots(expense)) {
    if (notify)
      ElMessage.warning(
        `每笔费用最多 ${MAX_ATTACHMENTS_PER_EXPENSE} 张图片，整张报销单最多 ${MAX_TOTAL_ATTACHMENTS} 张`,
      );
    return false;
  }
  try {
    const image = await readImage(file);
    const stored = isTauriRuntime()
      ? await persistImage(
          targetRecordId,
          image.dataUrl,
          undefined,
          image.width,
          image.height,
        )
      : null;
    const current = draft.expenses.find((item) => item.id === expenseId);
    if (
      !current ||
      draft.id !== targetRecordId ||
      !extraAttachmentSlots(current)
    )
      return false;
    const attachment: ExtraAttachment = {
      id: id("attachment"),
      fileName:
        file.name ||
        `附加图片-${current.extraAttachments.length + 1}-${Date.now()}.png`,
      imageDataUrl: isTauriRuntime()
        ? createManagedImageUrl(file)
        : image.dataUrl,
      naturalWidth: image.width,
      naturalHeight: image.height,
      transform: transform(0, 1),
    };
    if (stored) applyStoredAttachment(attachment, stored);
    current.extraAttachments.push(attachment);
    reflowAttachments();
    selectedId.value = current.id;
    selectedAttachmentId.value = attachment.id;
    dirty();
    if (notify) ElMessage.success("附加图片已加入，不会执行 OCR 或大模型识别");
    return true;
  } catch (error) {
    if (notify)
      ElMessage.error(error instanceof Error ? error.message : "图片读取失败");
    return false;
  }
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
      await addExtraAttachmentFile(file, expense.id);
  }
  input.value = "";
}
async function extraDropped(event: DragEvent) {
  extraUploadFocused.value = true;
  const expense = extraUploadExpense.value;
  if (!expense) return;
  for (const file of Array.from(event.dataTransfer?.files ?? []))
    await addExtraAttachmentFile(file, expense.id);
}
async function extraPasted(event: ClipboardEvent) {
  if (!extraUploadFocused.value || !extraUploadExpense.value) return;
  const item = Array.from(event.clipboardData?.items ?? []).find((value) =>
    value.type.startsWith("image/"),
  );
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (file) await addExtraAttachmentFile(file, extraUploadExpense.value.id);
}
async function removeExtraAttachment(
  expense: Expense,
  attachment: ExtraAttachment,
) {
  try {
    await ElMessageBox.confirm(
      `确定删除附加图片“${attachment.fileName}”吗？`,
      "删除附加图片",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
    const index = expense.extraAttachments.findIndex(
      (item) => item.id === attachment.id,
    );
    if (index < 0) return;
    revokeManagedImageUrl(attachment.imageDataUrl);
    expense.extraAttachments.splice(index, 1);
    reflowAttachments();
    selectedAttachmentId.value = expense.id;
    selectedId.value = expense.id;
    dirty();
    if (isTauriRuntime() && (await persistDraft(false)))
      void invoke("cleanup_orphan_images");
    ElMessage.success("附加图片已删除");
  } catch {
    /* 用户取消 */
  }
}
function moveExtraAttachment(
  expense: Expense,
  attachment: ExtraAttachment,
  offset: number,
) {
  const index = expense.extraAttachments.findIndex(
    (item) => item.id === attachment.id,
  );
  const nextIndex = index + offset;
  if (
    index < 0 ||
    nextIndex < 0 ||
    nextIndex >= expense.extraAttachments.length
  )
    return;
  const [current] = expense.extraAttachments.splice(index, 1);
  expense.extraAttachments.splice(nextIndex, 0, current);
  reflowAttachments();
  dirty();
}
function lanUploadFile(value: LanUploadReceivedEvent["file"]) {
  const comma = value.dataUrl.indexOf(",");
  if (comma < 0) throw new Error("手机图片数据格式无效");
  const binary = atob(value.dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return new File([bytes], value.fileName, { type: value.mimeType });
}
function showLanUploadReceived() {
  lanReceivedCount.value += 1;
  if (lanUploadNoticeTimer !== null) window.clearTimeout(lanUploadNoticeTimer);
  lanUploadNoticeTimer = window.setTimeout(() => {
    const count = lanReceivedCount.value;
    lanReceivedCount.value = 0;
    lanUploadNoticeTimer = null;
    ElMessage.success(`已从手机接收 ${count} 张图片`);
  }, 400);
}
async function receiveLanUpload(payload: LanUploadReceivedEvent) {
  try {
    if (payload.recordId !== draft.id) return;
    const targetExpenseId = payload.targetExpenseId ?? null;
    if (!lanUploadRemainingSlots(targetExpenseId)) {
      await synchronizeLanUploadSession();
      return;
    }
    if (
      lanUploadSession.value &&
      (lanUploadSession.value.targetExpenseId ?? null) === targetExpenseId
    )
      lanUploadSession.value.remainingSlots = payload.remainingSlots;
    const file = lanUploadFile(payload.file);
    const added = targetExpenseId
      ? await addExtraAttachmentFile(
          file,
          targetExpenseId,
          false,
          payload.recordId,
        )
      : await addFile(file, false, payload.recordId);
    if (added) showLanUploadReceived();
  } finally {
    lanUploadPendingEvents = Math.max(0, lanUploadPendingEvents - 1);
    if (lanUploadPendingEvents === 0) await synchronizeLanUploadSession();
  }
}
async function ensureLanUploadListener() {
  if (!isTauriRuntime()) throw new Error("手机上传仅支持在桌面应用中使用");
  if (lanUploadUnlisten) return;
  if (!lanUploadListenerReady) {
    lanUploadListenerReady = listen<LanUploadReceivedEvent>(
      "lan-upload-received",
      (event) => {
        lanUploadPendingEvents += 1;
        lanUploadQueue = lanUploadQueue
          .then(() => receiveLanUpload(event.payload))
          .catch((error) => {
            ElMessage.error(`手机图片接收失败：${errorMessage(error)}`);
          });
      },
    ).then((unlisten) => {
      lanUploadUnlisten = unlisten;
    });
  }
  try {
    await lanUploadListenerReady;
  } catch (error) {
    lanUploadListenerReady = null;
    throw error;
  }
}
async function refreshLanUploadSession() {
  const remainingSlots = lanUploadRemainingSlots();
  if (!remainingSlots) {
    lanUploadError.value = lanUploadTargetExpenseId.value
      ? `当前费用已达到 ${MAX_ATTACHMENTS_PER_EXPENSE} 张图片上限，或报销单已达到 ${MAX_TOTAL_ATTACHMENTS} 张图片上限`
      : `当前报销单已达到 ${MAX_EXPENSES} 笔费用上限`;
    return;
  }
  const requestVersion = ++lanUploadRequestVersion;
  isLanUploadLoading.value = true;
  lanUploadError.value = "";
  lanUploadSession.value = null;
  lanUploadQrCode.value = "";
  try {
    await ensureLanUploadListener();
    const session = await invoke<LanUploadSessionInfo>(
      "start_lan_upload_session",
      {
        request: {
          recordId: draft.id,
          targetExpenseId: lanUploadTargetExpenseId.value,
          label: lanUploadLabel.value,
          remainingSlots,
          ttlSeconds: 15 * 60,
        },
      },
    );
    const qrCode = await QRCode.toDataURL(session.url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 260,
      color: { dark: "#31483e", light: "#ffffff" },
    });
    if (!isLanUploadOpen.value || requestVersion !== lanUploadRequestVersion)
      return;
    lanUploadSession.value = session;
    lanUploadQrCode.value = qrCode;
    lanUploadNow.value = Date.now();
  } catch (error) {
    if (isLanUploadOpen.value && requestVersion === lanUploadRequestVersion)
      lanUploadError.value = errorMessage(error);
  } finally {
    if (requestVersion === lanUploadRequestVersion)
      isLanUploadLoading.value = false;
  }
}
async function openLanUpload(expense?: Expense) {
  if (!isTauriRuntime())
    return ElMessage.warning("手机上传仅支持在桌面应用中使用");
  lanUploadTargetExpenseId.value = expense?.id ?? null;
  isLanUploadOpen.value = true;
  await refreshLanUploadSession();
}
async function stopLanUploadSession() {
  lanUploadRequestVersion += 1;
  lanUploadSession.value = null;
  lanUploadQrCode.value = "";
  lanUploadError.value = "";
  isLanUploadLoading.value = false;
  if (!isTauriRuntime()) return;
  await invoke("stop_lan_upload_session").catch(() => {});
  lanUploadTargetExpenseId.value = null;
}
async function synchronizeLanUploadSession() {
  const session = lanUploadSession.value;
  if (
    !session ||
    session.recordId !== draft.id ||
    lanUploadPendingEvents > 0 ||
    !isTauriRuntime()
  )
    return;
  session.label = lanUploadLabel.value;
  session.remainingSlots = lanUploadRemainingSlots();
  await invoke("update_lan_upload_session", {
    request: {
      recordId: draft.id,
      targetExpenseId: lanUploadTargetExpenseId.value,
      label: session.label,
      remainingSlots: session.remainingSlots,
    },
  }).catch(() => {});
}
async function copyLanUploadUrl() {
  const url = lanUploadSession.value?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = document.createElement("textarea");
    input.value = url;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  ElMessage.success("上传地址已复制");
}
async function filesChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) await addFile(file);
  input.value = "";
}
async function dropped(event: DragEvent) {
  uploadFocused.value = true;
  for (const file of Array.from(event.dataTransfer?.files ?? []))
    await addFile(file);
}
async function pasted(event: ClipboardEvent) {
  if (!uploadFocused.value) return;
  const item = Array.from(event.clipboardData?.items ?? []).find((value) =>
    value.type.startsWith("image/"),
  );
  if (!item) return;
  event.preventDefault();
  const file = item.getAsFile();
  if (file) await addFile(file);
}
async function removeExpense(expense: Expense) {
  try {
    await ElMessageBox.confirm(
      `确定删除“${expense.fileName}”对应的费用吗？`,
      "删除费用",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
    const index = draft.expenses.findIndex((item) => item.id === expense.id);
    if (index < 0) return;
    revokeManagedImageUrl(expense.imageDataUrl);
    revokeManagedImageUrl(expense.recognitionImageDataUrl);
    expense.extraAttachments.forEach((attachment) =>
      revokeManagedImageUrl(attachment.imageDataUrl),
    );
    draft.expenses.splice(index, 1);
    reflowExpenses();
    selectedId.value = draft.expenses[Math.max(0, index - 1)]?.id ?? null;
    selectedAttachmentId.value = selectedId.value;
    dirty();
    if (isTauriRuntime() && (await persistDraft(false)))
      void invoke("cleanup_orphan_images");
    ElMessage.success("费用已删除");
  } catch {
    /* 用户取消 */
  }
}
function reorderExpense(sourceId: string, targetIndex: number) {
  const sourceIndex = draft.expenses.findIndex((item) => item.id === sourceId);
  const nextIndex = Math.max(
    0,
    Math.min(targetIndex, draft.expenses.length - 1),
  );
  if (sourceIndex < 0 || sourceIndex === nextIndex) return;
  const [source] = draft.expenses.splice(sourceIndex, 1);
  draft.expenses.splice(nextIndex, 0, source);
  reflowExpenses();
  dirty();
}
function expenseDragStart(event: PointerEvent) {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const listHandle = event.target.closest<HTMLElement>(".drag-handle");
  const paperHandle = event.target.closest<HTMLElement>(
    ".paper-row-drag-handle",
  );
  const surface = paperHandle ? "paper" : listHandle ? "list" : null;
  const handle = paperHandle ?? listHandle;
  const item =
    surface === "paper"
      ? handle?.closest<HTMLElement>("tr[data-expense-id]")
      : handle?.closest<HTMLElement>(".expense-card[data-expense-id]");
  const expenseId = item?.dataset.expenseId;
  if (!surface || !handle || !item || !expenseId) return;
  event.preventDefault();
  expenseDragState.value = { id: expenseId, surface };
  handle.setPointerCapture?.(event.pointerId);
}
function expenseDragMove(event: PointerEvent) {
  const state = expenseDragState.value;
  if (!state) return;
  event.preventDefault();
  const selector =
    state.surface === "paper"
      ? ".paper-table tbody tr[data-expense-id]"
      : ".expense-card[data-expense-id]";
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(selector),
  ).filter((item) => item.dataset.expenseId !== state.id);
  if (!items.length) return;
  if (state.surface === "list") {
    const list = document.querySelector<HTMLElement>(".expense-list");
    if (list) {
      const listRect = list.getBoundingClientRect();
      if (event.clientY < listRect.top + 28) list.scrollTop -= 14;
      else if (event.clientY > listRect.bottom - 28) list.scrollTop += 14;
    }
  }
  const targetIndex = items.findIndex((item) => {
    const rect = item.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  reorderExpense(state.id, targetIndex < 0 ? items.length : targetIndex);
}
function expenseDragStop() {
  expenseDragState.value = null;
}
function dictionaryValues(type: DictionaryType) {
  if (type === "company") return companyNames.value;
  if (type === "reason") return expenseReasons.value;
  return arrangers.value;
}
function setDictionaryValues(type: DictionaryType, values: string[]) {
  if (type === "company") companyNames.value = values;
  else if (type === "reason") expenseReasons.value = values;
  else arrangers.value = values;
}
function reorderDictionary(
  type: DictionaryType,
  sourceValue: string,
  targetValue: string,
  placement: "before" | "after",
) {
  const values = dictionaryValues(type);
  const sourceIndex = values.indexOf(sourceValue);
  if (sourceIndex < 0 || sourceValue === targetValue) return;
  const next = [...values];
  next.splice(sourceIndex, 1);
  const targetIndex = next.indexOf(targetValue);
  if (targetIndex < 0) return;
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceValue);
  if (next.every((value, index) => value === values[index])) return;
  setDictionaryValues(type, next);
  dirty();
}
function startDictionaryDrag(
  event: PointerEvent,
  type: DictionaryType,
  value: string,
) {
  if (event.button !== 0) return;
  if (
    event.target instanceof Element &&
    event.target.closest("button, input, label.el-radio") &&
    !event.target.closest(".dictionary-drag-handle")
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  dictionaryDragState.value = {
    type,
    value,
    pointerId: event.pointerId,
  };
  document.body.style.userSelect = "none";
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(
    event.pointerId,
  );
}
function isDictionaryDragging(type: DictionaryType, value: string) {
  const state = dictionaryDragState.value;
  return state?.type === type && state.value === value;
}
function isDictionaryDropTarget(
  type: DictionaryType,
  value: string,
  placement: "before" | "after",
) {
  const target = dictionaryDropTarget.value;
  return (
    target?.type === type &&
    target.value === value &&
    target.placement === placement
  );
}
function moveDictionaryDrag(event: PointerEvent) {
  const state = dictionaryDragState.value;
  if (!state) return;
  if (event.pointerId !== state.pointerId) return;
  if (!(event.buttons & 1)) {
    stopDictionaryDrag(event);
    return;
  }
  event.preventDefault();
  const container = document.querySelector<HTMLElement>(
    `.dictionary-options[data-dictionary-type="${state.type}"]`,
  );
  const target = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLElement>(".dictionary-option");
  const targetValue = target?.dataset.dictionaryValue;
  if (
    !container ||
    !target ||
    !container.contains(target) ||
    !targetValue ||
    targetValue === state.value
  ) {
    dictionaryDropTarget.value = null;
    return;
  }
  const rect = target.getBoundingClientRect();
  const placement =
    event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  dictionaryDropTarget.value = {
    type: state.type,
    value: targetValue,
    placement,
  };
  reorderDictionary(state.type, state.value, targetValue, placement);
}
function stopDictionaryDrag(event?: PointerEvent) {
  const state = dictionaryDragState.value;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  dictionaryDragState.value = null;
  dictionaryDropTarget.value = null;
  document.body.style.userSelect = "";
}
function updateScale() {
  if (!leftPanelResizeState.value)
    leftPanelWidth.value = clampLeftPanelWidth(leftPanelWidth.value);
  const viewport = previewViewport.value;
  if (!viewport) return;
  paperScale.value = Math.min(
    1,
    Math.max(0.56, (viewport.clientWidth - 52) / PAGE_WIDTH),
  );
}
function clampLeftPanelWidth(value: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 404;
  const max = Math.max(520, Math.min(720, window.innerWidth - 560));
  return Math.round(Math.min(max, Math.max(300, numeric)));
}
function startLeftPanelResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  leftPanelResizeState.value = {
    startX: event.clientX,
    startWidth: leftPanelWidth.value,
  };
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(
    event.pointerId,
  );
}
function moveLeftPanelResize(event: PointerEvent) {
  const state = leftPanelResizeState.value;
  if (!state) return;
  event.preventDefault();
  leftPanelWidth.value = clampLeftPanelWidth(
    state.startWidth + event.clientX - state.startX,
  );
}
function stopLeftPanelResize() {
  if (!leftPanelResizeState.value) return;
  leftPanelResizeState.value = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  scheduleAutoSave();
}
function pointerStart(
  event: PointerEvent,
  attachment: Pick<PreviewAttachment, "id" | "expenseId" | "transform">,
  type: "move" | "resize",
  pageIndex: number,
) {
  event.preventDefault();
  event.stopPropagation();
  selectAttachment(attachment);
  const t = attachment.transform;
  pointerState.value = {
    type,
    id: attachment.id,
    startX: event.clientX,
    startY: event.clientY,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    pageIndex,
  };
}
function pointerMove(event: PointerEvent) {
  const state = pointerState.value;
  const attachment = findAttachment(state?.id ?? null);
  const area = document.querySelector<HTMLElement>(
    `.attachment-area[data-attachment-page-index="${state?.pageIndex}"]`,
  );
  if (!state || !attachment || !area) return;
  const rect = area.getBoundingClientRect();
  const dx = ((event.clientX - state.startX) / rect.width) * 100;
  const dy = ((event.clientY - state.startY) / rect.height) * 100;
  if (state.type === "move") {
    attachment.transform.x = Math.min(
      100 - attachment.transform.width,
      Math.max(0, state.x + dx),
    );
    attachment.transform.y = Math.min(
      100 - attachment.transform.height,
      Math.max(0, state.y + dy),
    );
  } else {
    attachment.transform.width = Math.min(
      100 - attachment.transform.x,
      Math.max(12, state.width + dx),
    );
    attachment.transform.height = Math.min(
      100 - attachment.transform.y,
      Math.max(8, state.height + dy),
    );
  }
  dirty();
}
function pointerStop() {
  pointerState.value = null;
}
function adjustImageByWheel(event: WheelEvent) {
  const target =
    event.target instanceof Element
      ? event.target.closest(".attachment-object")
      : null;
  if (!target) return;
  const attachmentId = target.getAttribute("data-attachment-id");
  const attachment = findAttachment(attachmentId);
  const delta = event.deltaY || event.deltaX;
  if (!attachment || !delta) return;
  event.preventDefault();
  event.stopPropagation();
  selectAttachment(attachment);
  const change =
    Math.sign(delta) * Math.max(1, Math.min(5, Math.abs(delta) / 20));
  if (event.shiftKey)
    attachment.transform.cropX = Math.min(
      100,
      Math.max(0, attachment.transform.cropX + change),
    );
  else
    attachment.transform.cropY = Math.min(
      100,
      Math.max(0, attachment.transform.cropY + change),
    );
  dirty();
}
function changePreviewZoom(delta: number) {
  previewZoom.value = Math.min(
    2,
    Math.max(0.5, Math.round((previewZoom.value + delta) * 10) / 10),
  );
}
function adjustPreviewZoom(event: WheelEvent) {
  if (
    !event.ctrlKey ||
    !(event.target instanceof Element) ||
    !event.target.closest(".paper-stage") ||
    event.target.closest(".attachment-object")
  )
    return;
  event.preventDefault();
  changePreviewZoom(event.deltaY < 0 ? 0.1 : -0.1);
}
function rotate() {
  if (selectedAttachment.value) {
    selectedAttachment.value.transform.rotation =
      (selectedAttachment.value.transform.rotation + 90) % 360;
    dirty();
  }
}
function resetImage() {
  if (selectedAttachment.value) {
    const index = previewAttachments.value.findIndex(
      (item) => item.id === selectedAttachment.value?.id,
    );
    const pageStart =
      Math.floor(index / ATTACHMENTS_PER_PAGE) * ATTACHMENTS_PER_PAGE;
    const pageTotal = Math.min(
      ATTACHMENTS_PER_PAGE,
      previewAttachments.value.length - pageStart,
    );
    Object.assign(
      selectedAttachment.value.transform,
      transform(index - pageStart, pageTotal),
    );
    dirty();
  }
}
async function removeSelectedAttachment() {
  const attachment = selectedAttachment.value;
  if (!attachment) return;
  const expense = draft.expenses.find(
    (item) => item.id === attachment.expenseId,
  );
  if (!expense) return;
  if (attachment.isPrimary) await removeExpense(expense);
  else {
    const extra = expense.extraAttachments.find(
      (item) => item.id === attachment.id,
    );
    if (extra) await removeExtraAttachment(expense, extra);
  }
}
function printCurrentPage() {
  window.print();
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
function cloneDraft(value: Draft = draft) {
  return JSON.parse(JSON.stringify(value)) as Draft;
}
function uiPreferencesSnapshot() {
  return {
    leftPanelWidth: leftPanelWidth.value,
    historyViewMode: historyViewMode.value,
  };
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
      value.firstOccurredDate ?? value.draft?.expenses?.[0]?.occurredDate ?? "",
    updatedAt: value.updatedAt ?? new Date().toISOString(),
    draft: value.draft,
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
      await invoke("save_workspace", {
        request: {
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
        },
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
    if (isTauriRuntime() && activeTab.value === "history")
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
  selectedId.value = draft.expenses[0]?.id ?? null;
  selectedAttachmentId.value = selectedId.value;
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
    leftPanelWidth.value = clampLeftPanelWidth(
      value.uiPreferences.leftPanelWidth,
    );
  if (value.uiPreferences?.historyViewMode)
    historyViewMode.value = normalizeHistoryViewMode(
      value.uiPreferences.historyViewMode,
    );
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
  if (dictionaries?.arrangers?.length) arrangers.value = dictionaries.arrangers;
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
  const services = JSON.parse(localStorage.getItem(SERVICE_KEY) ?? "null") as {
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
    leftPanelWidth.value = clampLeftPanelWidth(
      savedUiPreferences.leftPanelWidth,
    );
  if (savedUiPreferences?.historyViewMode)
    historyViewMode.value = normalizeHistoryViewMode(
      savedUiPreferences.historyViewMode,
    );
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
      let bootstrap = await invoke<StorageBootstrapResult>(
        "bootstrap_storage",
        { allowDefaultSettings: false },
      );
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
          bootstrap = await invoke<StorageBootstrapResult>(
            "bootstrap_storage",
            { allowDefaultSettings: true },
          );
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
      const workspace = await invoke<LoadedWorkspace>("load_workspace");
      await applyWorkspace(workspace);
      await invoke<boolean>("schedule_storage_backup");
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
async function loadHistoryDraft(item: HistoryRecord) {
  const raw = item.draft
    ? cloneDraft(item.draft)
    : await invoke<Draft>("load_record", { recordId: item.id });
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
    const result = await invoke<HistoryQueryResult>("query_history", {
      query: {
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
      },
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
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
    if (deletingCurrent) {
      suppressAutoSave = true;
      revokeDraftImageUrls(draft);
      Object.assign(draft, createDraft());
      selectedId.value = null;
      selectedAttachmentId.value = null;
      suppressAutoSave = false;
    }
    historyRecords.value = historyRecords.value.filter(
      (entry) => entry.id !== item.id,
    );
    const saved = await persistDraft(false);
    if (!saved) throw new Error("本地工作区保存失败，未执行记录删除");
    if (isTauriRuntime()) await invoke("delete_record", { recordId: item.id });
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
function addCompany() {
  const value = newCompany.value.trim();
  if (!value || companyNames.value.includes(value)) return;
  companyNames.value.push(value);
  newCompany.value = "";
  dirty();
}
function removeCompany(value: string) {
  if (companyNames.value.length <= 1)
    return ElMessage.warning("至少保留一个公司名称");
  companyNames.value = companyNames.value.filter((item) => item !== value);
  if (defaultCompany.value === value)
    defaultCompany.value = companyNames.value[0];
  if (draft.companyName === value) draft.companyName = defaultCompany.value;
  dirty();
}
function addReason() {
  const value = newReason.value.trim();
  if (!value || expenseReasons.value.includes(value)) return;
  expenseReasons.value.push(value);
  newReason.value = "";
  dirty();
}
function removeReason(value: string) {
  if (expenseReasons.value.length <= 1)
    return ElMessage.warning("至少保留一个事由");
  expenseReasons.value = expenseReasons.value.filter((item) => item !== value);
  if (defaultReason.value === value)
    defaultReason.value = expenseReasons.value[0];
  dirty();
}
function addArranger() {
  const value = newArranger.value.trim();
  if (!value || arrangers.value.includes(value)) return;
  arrangers.value.push(value);
  newArranger.value = "";
  dirty();
}
function removeArranger(value: string) {
  if (arrangers.value.length <= 1)
    return ElMessage.warning("至少保留一个安排人");
  arrangers.value = arrangers.value.filter((item) => item !== value);
  if (defaultArranger.value === value)
    defaultArranger.value = arrangers.value[0];
  dirty();
}
function setDictionaryDefault(
  type: "company" | "reason" | "arranger",
  value: string,
) {
  if (type === "company") {
    defaultCompany.value = value;
    draft.companyName = value;
  } else if (type === "reason") defaultReason.value = value;
  else defaultArranger.value = value;
  dirty();
}
function makeOcrDefault(profile: OcrProfile) {
  ocrProfiles.value.forEach((item) => {
    item.isDefault = item.id === profile.id;
  });
  dirty();
}
function makeLlmDefault(profile: LlmProfile) {
  llmProfiles.value.forEach((item) => {
    item.isDefault = item.id === profile.id;
  });
  dirty();
}
function addOcrProfile() {
  ocrProfiles.value.push({
    id: id("ocr"),
    name: "阿里云 OCR 配置" + (ocrProfiles.value.length + 1),
    endpoint: "https://ocr-api.cn-hangzhou.aliyuncs.com",
    region: "cn-hangzhou",
    accessKeyId: "",
    accessKeySecret: "",
    timeoutSeconds: 30,
    isDefault: false,
  });
  dirty();
}
function addLlmProfile() {
  llmProfiles.value.push({
    id: id("llm"),
    name: "大模型配置" + (llmProfiles.value.length + 1),
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: DEFAULT_LLM_MODEL,
    timeoutSeconds: 30,
    multimodal: false,
    isDefault: false,
  });
  dirty();
}
function removeOcrProfile(profile: OcrProfile) {
  if (ocrProfiles.value.length <= 1)
    return ElMessage.warning("至少保留一个OCR配置");
  if (profile.isDefault) return ElMessage.warning("请先设置其他默认OCR配置");
  ocrProfiles.value = ocrProfiles.value.filter(
    (item) => item.id !== profile.id,
  );
  dirty();
}
function removeLlmProfile(profile: LlmProfile) {
  if (llmProfiles.value.length <= 1)
    return ElMessage.warning("至少保留一个大模型配置");
  if (profile.isDefault) return ElMessage.warning("请先设置其他默认大模型配置");
  llmProfiles.value = llmProfiles.value.filter(
    (item) => item.id !== profile.id,
  );
  dirty();
}
function switchTab(tab: AppTab) {
  commitActiveEdit();
  activeTab.value = tab;
  if (tab === "requests") void loadRequestLogs();
  if (tab === "settings") void loadBackupStatus();
  if (tab === "history") void refreshHistoryQuery();
  nextTick(() => {
    if (tab === "reimbursement") updateScale();
  });
}
function requestServiceLabel(service: RequestLogSummary["service"]) {
  return service === "ocr" ? "OCR" : "大模型";
}
function formatRequestTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}
async function loadRequestLogs() {
  if (!isTauriRuntime()) {
    requestRecords.value = [];
    return;
  }
  isRequestLoading.value = true;
  try {
    requestRecords.value =
      await invoke<RequestLogSummary[]>("list_request_logs");
  } catch (error) {
    ElMessage.error(`请求记录读取失败：${errorMessage(error)}`);
  } finally {
    isRequestLoading.value = false;
  }
}
async function openRequestDetail(item: RequestLogSummary) {
  if (!isTauriRuntime()) return;
  isRequestDetailOpen.value = true;
  isRequestDetailLoading.value = true;
  requestDetail.value = null;
  try {
    requestDetail.value = await invoke<RequestLogRecord>("get_request_log", {
      id: item.id,
    });
  } catch (error) {
    ElMessage.error(`请求详情读取失败：${errorMessage(error)}`);
    isRequestDetailOpen.value = false;
  } finally {
    isRequestDetailLoading.value = false;
  }
}
async function clearRequestLogs() {
  if (!requestRecords.value.length || !isTauriRuntime()) return;
  try {
    await ElMessageBox.confirm(
      "确定清空本机保存的全部 OCR 和大模型请求记录吗？",
      "清空请求记录",
      { confirmButtonText: "清空", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await invoke("clear_request_logs");
    requestRecords.value = [];
    requestDetail.value = null;
    ElMessage.success("请求记录已清空");
  } catch (error) {
    ElMessage.error(`请求记录清空失败：${errorMessage(error)}`);
  }
}
function newRecord() {
  commitActiveEdit();
  switchTab("reimbursement");
  if (!isSaved.value || draft.expenses.length) void persistDraft(false);
  revokeDraftImageUrls(draft);
  Object.assign(draft, createDraft());
  selectedId.value = null;
  selectedAttachmentId.value = null;
  dirty();
  ElMessage.success("已创建新的空白报销单");
}
function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
    expenses: expenses.map((item, index) =>
      normalizeExpense(item, index, expenses.length),
    ),
    updatedAt: value.updatedAt ?? defaults.updatedAt,
  };
}
function normalizeOcrProfile(value: Partial<OcrProfile>): OcrProfile {
  return {
    id: value.id ?? id("ocr"),
    name: value.name ?? "阿里云 OCR",
    endpoint: value.endpoint ?? "https://ocr-api.cn-hangzhou.aliyuncs.com",
    region: value.region ?? "cn-hangzhou",
    accessKeyId: value.accessKeyId ?? "",
    accessKeySecret: value.accessKeySecret ?? "",
    timeoutSeconds: Number(value.timeoutSeconds) || 30,
    isDefault: Boolean(value.isDefault),
  };
}
function normalizeLlmProfile(value: Partial<LlmProfile>): LlmProfile {
  const model =
    value.id === "deepseek-default" &&
    (!value.model || value.model === "deepseek-chat")
      ? DEFAULT_LLM_MODEL
      : (value.model ?? DEFAULT_LLM_MODEL);
  return {
    id: value.id ?? id("llm"),
    name: value.name ?? "大模型",
    baseUrl: value.baseUrl ?? "https://api.deepseek.com/v1",
    apiKey: value.apiKey ?? "",
    model,
    timeoutSeconds: Number(value.timeoutSeconds) || 30,
    multimodal: Boolean(value.multimodal),
    isDefault: Boolean(value.isDefault),
  };
}
function normalizeProfile(value: Partial<Profile>, index: number): Profile {
  return {
    id: value.id ?? id("profile"),
    name: value.name ?? `申请人${index + 1}`,
    applicant: value.applicant ?? "",
    department: value.department ?? "",
    payeeName: value.payeeName ?? "",
    account: value.account ?? "",
    bank: value.bank ?? "",
    isDefault: Boolean(value.isDefault),
  };
}
function ensureSingleDefault<T extends { isDefault: boolean }>(items: T[]) {
  let hasDefault = false;
  items.forEach((item) => {
    if (item.isDefault && !hasDefault) {
      hasDefault = true;
      return;
    }
    item.isDefault = false;
  });
  if (!hasDefault && items[0]) items[0].isDefault = true;
}
function uniqueStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
async function configurationTransferKey(salt: Uint8Array, usages: KeyUsage[]) {
  const encoder = new TextEncoder();
  const material = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(CONFIG_TRANSFER_SECRET),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: CONFIG_TRANSFER_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}
async function encryptConfiguration(payload: ConfigurationTransferPayload) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await configurationTransferKey(salt, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const envelope: EncryptedConfigurationEnvelope = {
    format: "sheepfinance-encrypted-configuration",
    version: 1,
    algorithm: "AES-256-GCM",
    keyDerivation: "PBKDF2-SHA256",
    iterations: CONFIG_TRANSFER_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(envelope);
}
async function decryptConfiguration(text: string) {
  const envelope = JSON.parse(text) as Partial<EncryptedConfigurationEnvelope>;
  if (
    envelope.format !== "sheepfinance-encrypted-configuration" ||
    envelope.version !== 1 ||
    envelope.algorithm !== "AES-256-GCM" ||
    envelope.keyDerivation !== "PBKDF2-SHA256" ||
    envelope.iterations !== CONFIG_TRANSFER_ITERATIONS ||
    !envelope.salt ||
    !envelope.iv ||
    !envelope.ciphertext
  ) {
    throw new Error("不是有效的 SheepFinance 加密配置文件");
  }
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const key = await configurationTransferKey(salt, ["decrypt"]);
  const plaintext = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
function validateImportedConfiguration(value: unknown) {
  const payload = value as Partial<ConfigurationTransferPayload>;
  if (
    !payload ||
    payload.format !== "sheepfinance-configuration" ||
    payload.version !== 1
  ) {
    throw new Error("配置文件版本或内容不受支持");
  }
  const importedOcrProfiles = Array.isArray(payload.services?.ocrProfiles)
    ? payload.services.ocrProfiles.map(normalizeOcrProfile)
    : [];
  const importedLlmProfiles = Array.isArray(payload.services?.llmProfiles)
    ? payload.services.llmProfiles.map(normalizeLlmProfile)
    : [];
  const importedProfiles = Array.isArray(payload.profiles)
    ? payload.profiles.map(normalizeProfile)
    : [];
  const companies = uniqueStrings(payload.dictionaries?.companies);
  const reasons = uniqueStrings(payload.dictionaries?.reasons);
  const importedArrangers = uniqueStrings(payload.dictionaries?.arrangers);
  if (
    !importedOcrProfiles.length ||
    !importedLlmProfiles.length ||
    !importedProfiles.length ||
    !companies.length ||
    !reasons.length ||
    !importedArrangers.length
  ) {
    throw new Error("配置文件缺少 OCR、大模型、申请人或字典数据");
  }
  ensureSingleDefault(importedOcrProfiles);
  ensureSingleDefault(importedLlmProfiles);
  ensureSingleDefault(importedProfiles);
  return {
    ocrProfiles: importedOcrProfiles,
    llmProfiles: importedLlmProfiles,
    profiles: importedProfiles,
    companies,
    reasons,
    arrangers: importedArrangers,
    defaultCompany: companies.includes(
      payload.dictionaries?.defaultCompany ?? "",
    )
      ? (payload.dictionaries?.defaultCompany ?? companies[0])
      : companies[0],
    defaultReason: reasons.includes(payload.dictionaries?.defaultReason ?? "")
      ? (payload.dictionaries?.defaultReason ?? reasons[0])
      : reasons[0],
    defaultArranger: importedArrangers.includes(
      payload.dictionaries?.defaultArranger ?? "",
    )
      ? (payload.dictionaries?.defaultArranger ?? importedArrangers[0])
      : importedArrangers[0],
  };
}
async function exportConfiguration() {
  try {
    if (!window.crypto?.subtle)
      throw new Error("当前系统不支持配置加密，请升级 WebView2 后重试");
    const payload: ConfigurationTransferPayload = {
      format: "sheepfinance-configuration",
      version: 1,
      exportedAt: new Date().toISOString(),
      profiles: JSON.parse(JSON.stringify(profiles.value)),
      dictionaries: {
        companies: [...companyNames.value],
        reasons: [...expenseReasons.value],
        arrangers: [...arrangers.value],
        defaultCompany: defaultCompany.value,
        defaultReason: defaultReason.value,
        defaultArranger: defaultArranger.value,
      },
      services: {
        ocrProfiles: JSON.parse(JSON.stringify(ocrProfiles.value)),
        llmProfiles: JSON.parse(JSON.stringify(llmProfiles.value)),
      },
    };
    const encrypted = await encryptConfiguration(payload);
    const path = await saveExportBytes(
      new TextEncoder().encode(encrypted),
      `SheepFinance-配置-${today()}.txt`,
      "text/plain;charset=utf-8",
      "txt",
    );
    if (isTauriRuntime() && !path) return;
    ElMessage.success("加密配置已导出");
  } catch (error) {
    ElMessage.error(`配置导出失败：${errorMessage(error)}`);
  }
}
function openConfigurationImport() {
  configImportInput.value?.click();
}
async function importConfiguration(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (!window.crypto?.subtle)
      throw new Error("当前系统不支持配置解密，请升级 WebView2 后重试");
    const decrypted = await decryptConfiguration(await file.text());
    const imported = validateImportedConfiguration(decrypted);
    await ElMessageBox.confirm(
      "导入后将覆盖本机现有的 OCR、大模型、申请人和字典配置，不会修改报销记录。",
      "导入加密配置",
      {
        confirmButtonText: "确认导入",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
    ocrProfiles.value = imported.ocrProfiles;
    llmProfiles.value = imported.llmProfiles;
    profiles.value = imported.profiles;
    companyNames.value = imported.companies;
    expenseReasons.value = imported.reasons;
    arrangers.value = imported.arrangers;
    defaultCompany.value = imported.defaultCompany;
    defaultReason.value = imported.defaultReason;
    defaultArranger.value = imported.defaultArranger;
    dirty();
    await nextTick();
    await persistDraft(false);
    ElMessage.success("配置导入完成，已保存到本机");
  } catch (error) {
    if (error !== "cancel" && error !== "close")
      ElMessage.error(`配置导入失败：${errorMessage(error)}`);
  }
}
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
    backupStatus.value = await invoke<BackupStatus>("get_backup_status");
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
    await invoke("create_database_backup");
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
      { confirmButtonText: "恢复", cancelButtonText: "取消", type: "warning" },
    );
    backupLoading.value = true;
    if (storageReady.value && !(await persistDraft(false)))
      throw new Error("当前单据保存失败，已取消数据库恢复");
    await invoke("restore_database_backup", { fileName: target.fileName });
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
    await invoke("open_backup_directory");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function exportFullBackup() {
  const destination = await tauriSave({
    defaultPath: `SheepFinance-完整备份-${today()}.zip`,
    filters: [{ name: "ZIP 备份", extensions: ["zip"] }],
  });
  if (!destination) return;
  backupLoading.value = true;
  try {
    if (!(await persistDraft(false)))
      throw new Error("当前单据保存失败，已取消完整备份导出");
    await invoke("export_full_backup", { destination });
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
      { confirmButtonText: "导入", cancelButtonText: "取消", type: "warning" },
    );
    backupLoading.value = true;
    if (storageReady.value && !(await persistDraft(false)))
      throw new Error("当前单据保存失败，已取消完整备份导入");
    await invoke("import_full_backup", { source: selected });
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
    const removed = await invoke<number>("cleanup_legacy_archives");
    await loadBackupStatus();
    ElMessage.success(`已清理 ${formatFileSize(removed)} 旧数据`);
  } catch (error) {
    if (error !== "cancel" && error !== "close")
      ElMessage.error(errorMessage(error));
  }
}
async function attachmentBlob(
  attachment: PreviewAttachment | ExtraAttachment | Expense,
) {
  if (!attachment.blobHash) throw new Error("该图片尚未存入本地图片池");
  const value = await invoke<AttachmentBytes>("read_attachment", {
    blobHash: attachment.blobHash,
  });
  return {
    blob: new Blob([new Uint8Array(value.bytes)], { type: value.mimeType }),
    extension: value.extension,
  };
}
async function copyOriginalImage(
  attachment:
    | PreviewAttachment
    | ExtraAttachment
    | Expense
    | null = selectedAttachment.value,
) {
  if (!attachment) return;
  try {
    const { blob } = await attachmentBlob(attachment);
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
      throw new Error("当前系统不支持图片剪贴板");
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
    } catch {
      const sourceUrl = URL.createObjectURL(blob);
      try {
        const image = await loadImage(sourceUrl);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法读取图片画布");
        context.drawImage(image, 0, 0);
        const png = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value ? resolve(value) : reject(new Error("图片转换失败")),
            "image/png",
          ),
        );
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": png }),
        ]);
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    }
    ElMessage.success("原图已写入剪贴板");
  } catch (error) {
    ElMessage.error(`复制原图失败：${errorMessage(error)}`);
  }
}
async function saveOriginalImage(
  attachment:
    | PreviewAttachment
    | ExtraAttachment
    | Expense
    | null = selectedAttachment.value,
) {
  if (!attachment?.blobHash) return;
  try {
    const stored = await attachmentBlob(attachment);
    const baseName = attachment.fileName.replace(/[\\/:*?"<>|]/g, "_");
    const suggested = baseName.includes(".")
      ? baseName
      : `${baseName || "票据原图"}.${stored.extension}`;
    const destination = await tauriSave({
      defaultPath: suggested,
      filters: [{ name: "图片", extensions: [stored.extension] }],
    });
    if (!destination) return;
    await invoke("save_attachment_as", {
      blobHash: attachment.blobHash,
      destination,
    });
    ElMessage.success("原图已保存");
  } catch (error) {
    ElMessage.error(`另存原图失败：${errorMessage(error)}`);
  }
}
async function openOriginalImageFolder(
  attachment:
    | PreviewAttachment
    | ExtraAttachment
    | Expense
    | null = selectedAttachment.value,
  recordId = draft.id,
) {
  if (!attachment?.blobHash) return;
  try {
    await invoke("open_attachment_folder", {
      blobHash: attachment.blobHash,
      recordId,
    });
  } catch (error) {
    ElMessage.error(errorMessage(error));
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
async function waitForExportAssets(root: HTMLElement) {
  await document.fonts?.ready;
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
      }
      if (typeof image.decode === "function")
        await image.decode().catch(() => {});
    }),
  );
}
function synchronizeExportControls(source: HTMLElement, clone: HTMLElement) {
  const sourceControls = source.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input, textarea, select");
  const cloneControls = clone.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input, textarea, select");
  sourceControls.forEach((control, index) => {
    const clonedControl = cloneControls[index];
    if (clonedControl) clonedControl.value = control.value;
  });
}
async function captureElementForExport(
  source: HTMLElement,
  width: number,
  height: number,
) {
  const host = document.createElement("div");
  host.className = "export-capture-host exporting-document";
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "-2147483647",
    background: "#ffffff",
  });
  const clone = source.cloneNode(true) as HTMLElement;
  synchronizeExportControls(source, clone);
  Object.assign(clone.style, {
    width: `${width}px`,
    height: `${height}px`,
    minWidth: `${width}px`,
    minHeight: `${height}px`,
    maxWidth: `${width}px`,
    maxHeight: `${height}px`,
    flex: "none",
    transform: "none",
    boxShadow: "none",
    letterSpacing: "0",
  });
  clone.querySelectorAll<HTMLElement>("*").forEach((element) => {
    element.style.letterSpacing = "0";
    element.style.fontKerning = "none";
  });
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    await waitForExportAssets(clone);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return await html2canvas(clone, {
      backgroundColor: "#ffffff",
      scale: 2,
      width,
      height,
      useCORS: true,
      logging: false,
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(PAGE_WIDTH, document.documentElement.clientWidth),
      windowHeight: Math.max(
        PAGE_HEIGHT,
        document.documentElement.clientHeight,
      ),
    });
  } finally {
    host.remove();
  }
}
async function captureAttachmentPagesForExport() {
  const sources = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".attachment-area[data-export-attachment-page]",
    ),
  );
  if (!sources.length) throw new Error("附件预览尚未准备完成，请稍后重试");
  const pages: { dataUrl: string; width: number; height: number }[] = [];
  for (const source of sources) {
    const width = Math.round(source.clientWidth);
    const height = Math.round(source.clientHeight);
    if (width <= 0 || height <= 0)
      throw new Error("附件预览尺寸异常，请稍后重试");
    const canvas = await captureElementForExport(source, width, height);
    pages.push({ dataUrl: canvas.toDataURL("image/png"), width, height });
  }
  return pages;
}
async function saveExportBytes(
  bytes: Uint8Array,
  filename: string,
  mime: string,
  extension: string,
) {
  if (isTauriRuntime()) {
    const selectedPath = await tauriSave({
      defaultPath: filename,
      filters: [
        { name: extension.toUpperCase() + " 文件", extensions: [extension] },
      ],
    });
    if (!selectedPath) return null;
    await tauriWriteFile(selectedPath, bytes);
    return selectedPath;
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
async function withTemporaryDraft<T>(
  source: Draft,
  callback: () => Promise<T>,
) {
  commitActiveEdit();
  const current = cloneDraft();
  const previousTab = activeTab.value;
  const previousSelectedId = selectedId.value;
  const previousSelectedAttachmentId = selectedAttachmentId.value;
  suppressAutoSave = true;
  try {
    applyDraft(cloneDraft(source));
    activeTab.value = "reimbursement";
    await nextTick();
    updateScale();
    await nextTick();
    return await callback();
  } finally {
    applyDraft(current);
    revokeDraftImageUrls(source);
    selectedId.value = previousSelectedId;
    selectedAttachmentId.value = previousSelectedAttachmentId;
    activeTab.value = previousTab;
    await nextTick();
    updateScale();
    suppressAutoSave = false;
  }
}
async function exportExcel(sourceDraft?: Draft) {
  if (sourceDraft) {
    await withTemporaryDraft(sourceDraft, () => exportExcel());
    return;
  }
  commitActiveEdit();
  if (!draft.expenses.length)
    return ElMessage.warning("请先上传至少一张费用截图");

  const previousTab = activeTab.value;
  try {
    if (previousTab !== "reimbursement") {
      activeTab.value = "reimbursement";
      await nextTick();
      updateScale();
      await nextTick();
    }

    const attachmentPagesForExport = await captureAttachmentPagesForExport();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "SheepFinance";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    const sheet = workbook.addWorksheet("报销单", {
      properties: { defaultRowHeight: 15 },
      views: [{ showGridLines: false, zoomScale: 90 }],
    });
    const columnWidths = [8, 13, 14, 32, 16, 17];
    columnWidths.forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });

    const expenseStartRow = 4;
    const expenseEndRow = expenseStartRow + draft.expenses.length - 1;
    const totalRow = expenseEndRow + 1;
    const uppercaseRow = totalRow + 1;
    const paymentRow = uppercaseRow + 1;
    const approvalRow = paymentRow + 1;
    const bodyFont: Partial<ExcelJS.Font> = {
      name: "宋体",
      size: 9,
      color: { argb: "FF2F3334" },
    };
    const thinBorder: Partial<ExcelJS.Borders> = {
      top: { style: "thin", color: { argb: "FF4C4F4F" } },
      bottom: { style: "thin", color: { argb: "FF4C4F4F" } },
      left: { style: "thin", color: { argb: "FF4C4F4F" } },
      right: { style: "thin", color: { argb: "FF4C4F4F" } },
    };

    for (let rowNumber = 1; rowNumber <= approvalRow; rowNumber += 1) {
      for (let column = 1; column <= 6; column += 1) {
        const cell = sheet.getRow(rowNumber).getCell(column);
        cell.font = { ...bodyFont };
        cell.border = thinBorder;
        cell.alignment = {
          horizontal: "center",
          vertical: "middle",
          wrapText: true,
        };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFFFFF" },
        };
      }
    }

    sheet.getRow(1).height = 32.25;
    sheet.getRow(2).height = 23.25;
    sheet.getRow(3).height = 25.5;
    draft.expenses.forEach((expense, index) => {
      sheet.getRow(expenseStartRow + index).height =
        expenseRowHeight(expense) * 0.75;
    });
    sheet.getRow(totalRow).height = 23.25;
    sheet.getRow(uppercaseRow).height = 23.25;
    sheet.getRow(paymentRow).height = 47.25;
    sheet.getRow(approvalRow).height = 36;

    sheet.mergeCells("A1:F1");
    sheet.mergeCells("A2:C2");
    sheet.mergeCells(`A${totalRow}:B${uppercaseRow}`);
    sheet.mergeCells(`C${totalRow}:F${totalRow}`);
    sheet.mergeCells(`C${uppercaseRow}:F${uppercaseRow}`);
    sheet.mergeCells(`A${paymentRow}:F${paymentRow}`);
    sheet.mergeCells(`A${approvalRow}:F${approvalRow}`);

    const titleCell = sheet.getCell("A1");
    titleCell.value = (draft.companyName || "") + "费用报销单";
    titleCell.font = {
      name: "宋体",
      size: 14.25,
      bold: true,
      color: { argb: "FF2F3334" },
    };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };

    sheet.getCell("A2").value = "报销日期：";
    sheet.getCell("D2").value = "申请人：" + (draft.applicant || "");
    sheet.getCell("E2").value = "所属部门：" + (draft.department || "");
    sheet.getCell("F2").value = "附票据（  ）张";
    sheet.getCell("A2").alignment = {
      horizontal: "left",
      vertical: "middle",
    };
    sheet.getCell("D2").alignment = {
      horizontal: "left",
      vertical: "middle",
      shrinkToFit: true,
    };
    sheet.getCell("E2").alignment = {
      horizontal: "left",
      vertical: "middle",
      shrinkToFit: true,
    };
    sheet.getCell("F2").alignment = {
      horizontal: "center",
      vertical: "middle",
      shrinkToFit: true,
    };

    const headers = [
      "序号",
      "发生日期",
      "事由",
      "内容说明、参与人员等",
      "安排人",
      "金额",
    ];
    headers.forEach((header, index) => {
      const cell = sheet.getRow(3).getCell(index + 1);
      cell.value = header;
      cell.font = { ...bodyFont, bold: true };
    });

    draft.expenses.forEach((expense, index) => {
      const row = sheet.getRow(expenseStartRow + index);
      row.getCell(1).value = index + 1;
      row.getCell(2).value = expense.occurredDate;
      row.getCell(3).value = expense.reason;
      row.getCell(4).value = expense.description || "";
      row.getCell(5).value = expense.arranger;
      row.getCell(6).value = expense.amountCents / 100;
      row.getCell(6).numFmt = "#,##0.00";
      for (let column = 1; column <= 6; column += 1) {
        row.getCell(column).alignment = {
          horizontal: "center",
          vertical: "middle",
          wrapText: true,
          shrinkToFit: column !== 4 && column !== 5,
        };
      }
    });

    sheet.getCell(`A${totalRow}`).value = "合计金额";
    sheet.getCell(`A${totalRow}`).font = { ...bodyFont, bold: true };
    sheet.getCell(`A${totalRow}`).alignment = {
      horizontal: "center",
      vertical: "middle",
    };
    const totalCell = sheet.getCell(`C${totalRow}`);
    totalCell.value =
      draft.totalOverrideCents === null
        ? {
            formula: `SUM(F${expenseStartRow}:F${expenseEndRow})`,
            result: calculatedTotal.value / 100,
          }
        : effectiveTotal.value / 100;
    totalCell.numFmt = '"￥"#,##0.00';
    totalCell.alignment = {
      horizontal: "left",
      vertical: "middle",
      indent: 1,
    };
    const uppercaseCell = sheet.getCell(`C${uppercaseRow}`);
    uppercaseCell.value = ChineseAmount(effectiveTotal.value);
    uppercaseCell.alignment = {
      horizontal: "left",
      vertical: "middle",
      indent: 1,
      shrinkToFit: true,
    };

    sheet.getCell(`A${paymentRow}`).value = {
      richText: [
        { font: { name: "宋体", size: 9 }, text: "收款信息：" },
        { font: { name: "宋体", size: 9, bold: true }, text: "名称：" },
        { font: { name: "宋体", size: 9 }, text: draft.payeeName || "" },
        {
          font: { name: "宋体", size: 9, bold: true },
          text: "\n　　　　　账号：",
        },
        { font: { name: "宋体", size: 9 }, text: draft.account || "" },
        {
          font: { name: "宋体", size: 9, bold: true },
          text: "\n　　　　　开户行：",
        },
        { font: { name: "宋体", size: 9 }, text: draft.bank || "" },
      ],
    };
    sheet.getCell(`A${paymentRow}`).alignment = {
      horizontal: "left",
      vertical: "middle",
      wrapText: true,
      indent: 1,
    };
    sheet.getCell(`A${approvalRow}`).value =
      "部门负责人：                         财务：                         总经理审核：";
    sheet.getCell(`A${approvalRow}`).alignment = {
      horizontal: "left",
      vertical: "middle",
      shrinkToFit: true,
      indent: 1,
    };

    // A:F is the complete printable table; columns G:M intentionally remain unstyled.
    for (let column = 7; column <= 13; column += 1)
      sheet.getRow(5).getCell(column).border = {};

    formPages.value.slice(0, -1).forEach((page) => {
      const lastRow = page.rows[page.rows.length - 1];
      if (lastRow) sheet.getRow(expenseStartRow + lastRow.index).addPageBreak();
    });

    let nextAttachmentRow = approvalRow + 1;
    let attachmentEndRow = approvalRow;
    if (!sharedAttachmentPage.value) sheet.getRow(approvalRow).addPageBreak();
    attachmentPagesForExport.forEach((attachment, index) => {
      const attachmentStartRow = nextAttachmentRow;
      const attachmentHeightPoints = attachment.height * 0.75;
      const attachmentRowCount = Math.max(
        1,
        Math.ceil(attachmentHeightPoints / 300),
      );
      attachmentEndRow = attachmentStartRow + attachmentRowCount - 1;
      for (
        let rowNumber = attachmentStartRow;
        rowNumber <= attachmentEndRow;
        rowNumber += 1
      ) {
        sheet.getRow(rowNumber).height =
          attachmentHeightPoints / attachmentRowCount;
      }

      const attachmentImageId = workbook.addImage({
        base64: attachment.dataUrl,
        extension: "png",
      });
      sheet.addImage(attachmentImageId, {
        tl: { col: 0, row: attachmentStartRow - 1 },
        br: { col: 6, row: attachmentEndRow },
        editAs: "oneCell",
      } as any);
      if (index < attachmentPagesForExport.length - 1)
        sheet.getRow(attachmentEndRow).addPageBreak();
      nextAttachmentRow = attachmentEndRow + 1;
    });

    sheet.pageSetup.orientation = "portrait";
    sheet.pageSetup.paperSize = 9;
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = previewPageCount.value;
    sheet.pageSetup.printTitlesRow = "1:3";
    sheet.pageSetup.margins = {
      left: 0.38,
      right: 0.38,
      top: 0.31,
      bottom: 0.28,
      header: 0,
      footer: 0,
    };
    sheet.pageSetup.horizontalCentered = true;
    sheet.pageSetup.verticalCentered = false;
    sheet.pageSetup.printArea = `A1:F${attachmentEndRow}`;

    const buffer = await workbook.xlsx.writeBuffer();
    const filename =
      today() + "_" + (draft.applicant || "未命名") + "_报销单.xlsx";
    const path = await saveExportBytes(
      new Uint8Array(buffer as ArrayBuffer),
      filename,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "xlsx",
    );
    if (!suppressAutoSave) void persistDraft(false);
    ElMessage.success(path ? "Excel 已导出到：" + path : "Excel 已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Excel 导出失败");
  } finally {
    if (activeTab.value !== previousTab) activeTab.value = previousTab;
  }
}
async function exportPdf(sourceDraft?: Draft) {
  if (sourceDraft) {
    await withTemporaryDraft(sourceDraft, () => exportPdf());
    return;
  }
  commitActiveEdit();
  if (!draft.expenses.length)
    return ElMessage.warning("请先上传至少一张费用截图");
  if (isExportingPdf.value) return;

  isExportingPdf.value = true;
  const previousTab = activeTab.value;
  try {
    if (previousTab !== "reimbursement") {
      activeTab.value = "reimbursement";
      await nextTick();
      updateScale();
      await nextTick();
    }
    const pages = Array.from(
      document.querySelectorAll<HTMLElement>(".preview-pages .paper"),
    );
    const expectedPages = previewPageCount.value;
    if (pages.length !== expectedPages)
      throw new Error("PDF 页面尚未准备完成，请稍后重试");

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true,
    });
    for (let index = 0; index < pages.length; index += 1) {
      const canvas = await captureElementForExport(
        pages[index],
        PAGE_WIDTH,
        PAGE_HEIGHT,
      );
      if (index > 0) pdf.addPage("a4", "portrait");
      pdf.addImage(
        canvas.toDataURL("image/jpeg", 0.96),
        "JPEG",
        0,
        0,
        210,
        297,
        undefined,
        "FAST",
      );
    }

    const bytes = new Uint8Array(pdf.output("arraybuffer"));
    const filename =
      today() + "_" + (draft.applicant || "未命名") + "_报销单.pdf";
    const path = await saveExportBytes(
      bytes,
      filename,
      "application/pdf",
      "pdf",
    );
    if (!suppressAutoSave) void persistDraft(false);
    ElMessage.success(path ? "PDF 已导出到：" + path : "PDF 已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "PDF 导出失败");
  } finally {
    if (activeTab.value !== previousTab) activeTab.value = previousTab;
    isExportingPdf.value = false;
  }
}
function setDefault(profile: Profile) {
  profiles.value.forEach((item) => {
    item.isDefault = item.id === profile.id;
  });
  draft.applicant = profile.applicant;
  draft.department = profile.department;
  draft.payeeName = profile.payeeName;
  draft.account = profile.account;
  draft.bank = profile.bank;
  dirty();
  ElMessage.success(`已将“${profile.name}”设为默认申请人`);
}
function addProfile() {
  profiles.value.push({
    id: id("profile"),
    name: `申请人${profiles.value.length + 1}`,
    applicant: "",
    department: "",
    payeeName: "",
    account: "",
    bank: "",
    isDefault: false,
  });
  dirty();
}
function removeProfile(profile: Profile) {
  if (profiles.value.length <= 1)
    return ElMessage.warning("至少保留一个申请人");
  if (profile.isDefault)
    return ElMessage.warning("请先设置其他默认申请人，再删除当前申请人");
  profiles.value = profiles.value.filter((item) => item.id !== profile.id);
  dirty();
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
watch(draft, scheduleAutoSave, { deep: true });
watch(
  [
    profiles,
    companyNames,
    expenseReasons,
    arrangers,
    defaultCompany,
    defaultReason,
    defaultArranger,
    ocrProfiles,
    llmProfiles,
  ],
  scheduleAutoSave,
  { deep: true },
);
watch([leftPanelWidth, historyViewMode], scheduleAutoSave);
watch([historySearch, historyDate, historyStatus], () => {
  historyPage.value = 1;
  void refreshHistoryQuery();
});
watch(historyViewMode, () => {
  historyPage.value = 1;
  historyFolderKey.value = "";
  void refreshHistoryQuery();
});
watch([historyPage, historyPageSize], () => void refreshHistoryQuery());
watch([requestSearch, requestService, requestStatus], () => {
  requestPage.value = 1;
});
watch(isHistoryPreviewOpen, (open) => {
  if (open) return;
  revokeDraftImageUrls(historyPreviewDraft.value);
  historyPreviewDraft.value = null;
  historyPreviewItem.value = null;
});
watch(
  [
    () => draft.label,
    () => previewAttachments.value.length,
    lanUploadTargetExpenseId,
  ],
  () => {
    void synchronizeLanUploadSession();
  },
);
watch(
  () => draft.id,
  (recordId) => {
    if (
      lanUploadSession.value &&
      lanUploadSession.value.recordId !== recordId
    ) {
      isLanUploadOpen.value = false;
      void stopLanUploadSession();
    }
    isExtraUploadOpen.value = false;
    extraUploadExpenseId.value = null;
  },
);
function preventContextMenu(event: MouseEvent) {
  event.preventDefault();
}
onMounted(() => {
  void (async () => {
    if (isTauriRuntime()) {
      try {
        storageMigrationUnlisten = await listen<MigrationProgress>(
          "storage-migration-progress",
          (event) => {
            migrationProgress.value = event.payload;
          },
        );
        backupFailureUnlisten = await listen<string>(
          "database-backup-failed",
          (event) => ElMessage.error(`自动备份失败：${event.payload}`),
        );
      } catch {
        storageMigrationUnlisten = null;
        backupFailureUnlisten = null;
      }
    }
    await loadDraft();
  })();
  lanUploadClockTimer = window.setInterval(() => {
    lanUploadNow.value = Date.now();
  }, 1000);
  updateScale();
  window.addEventListener("resize", updateScale);
  window.addEventListener("pointerdown", expenseDragStart);
  window.addEventListener("pointermove", pointerMove);
  window.addEventListener("pointermove", expenseDragMove);
  window.addEventListener("pointermove", moveDictionaryDrag);
  window.addEventListener("pointermove", trackPaperCellSelection);
  window.addEventListener("pointerup", pointerStop);
  window.addEventListener("pointerup", expenseDragStop);
  window.addEventListener("pointerup", stopDictionaryDrag);
  window.addEventListener("pointercancel", stopDictionaryDrag);
  window.addEventListener("wheel", adjustImageByWheel, { passive: false });
  window.addEventListener("wheel", adjustPreviewZoom, { passive: false });
  window.addEventListener("contextmenu", preventContextMenu);
  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("pointerup", endPaperCellSelection);
  window.addEventListener("pointercancel", cancelPaperCellSelection);
  window.addEventListener("pointermove", moveLeftPanelResize);
  window.addEventListener("pointerup", stopLeftPanelResize);
});
onUnmounted(() => {
  if (saveTimer.value !== null) window.clearTimeout(saveTimer.value);
  if (lanUploadClockTimer !== null) window.clearInterval(lanUploadClockTimer);
  if (lanUploadNoticeTimer !== null) window.clearTimeout(lanUploadNoticeTimer);
  lanUploadUnlisten?.();
  lanUploadUnlisten = null;
  lanUploadListenerReady = null;
  storageMigrationUnlisten?.();
  storageMigrationUnlisten = null;
  backupFailureUnlisten?.();
  backupFailureUnlisten = null;
  revokeDraftImageUrls(draft);
  revokeDraftImageUrls(historyPreviewDraft.value);
  void stopLanUploadSession();
  window.removeEventListener("resize", updateScale);
  window.removeEventListener("pointerdown", expenseDragStart);
  window.removeEventListener("pointermove", pointerMove);
  window.removeEventListener("pointermove", expenseDragMove);
  window.removeEventListener("pointermove", moveDictionaryDrag);
  window.removeEventListener("pointermove", trackPaperCellSelection);
  window.removeEventListener("pointerup", pointerStop);
  window.removeEventListener("pointerup", expenseDragStop);
  window.removeEventListener("pointerup", stopDictionaryDrag);
  window.removeEventListener("pointercancel", stopDictionaryDrag);
  window.removeEventListener("wheel", adjustImageByWheel);
  window.removeEventListener("wheel", adjustPreviewZoom);
  window.removeEventListener("contextmenu", preventContextMenu);
  window.removeEventListener("keydown", handleGlobalKeydown);
  window.removeEventListener("pointerup", endPaperCellSelection);
  window.removeEventListener("pointercancel", cancelPaperCellSelection);
  window.removeEventListener("pointermove", moveLeftPanelResize);
  window.removeEventListener("pointerup", stopLeftPanelResize);
});
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'reimbursement-active': activeTab === 'reimbursement' }"
    @contextmenu.prevent
  >
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
    <header class="topbar">
      <div class="brand-block">
        <div class="brand-mark">S</div>
        <div>
          <div class="brand-name">SheepFinance</div>
          <div class="brand-subtitle">本地报销工作台</div>
        </div>
      </div>
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
    <main
      v-if="activeTab === 'reimbursement'"
      class="workspace"
      :style="{ '--left-panel-width': `${leftPanelWidth}px` }"
    >
      <aside
        class="left-panel"
        @pointerdown.capture="commitActiveEdit"
        @focusin.capture="commitActiveEdit"
      >
        <section
          ref="uploadZone"
          class="upload-panel"
          tabindex="0"
          @focus="uploadFocused = true"
          @blur="uploadFocused = false"
          @paste="pasted"
          @dragover.prevent="uploadFocused = true"
          @drop.prevent="dropped"
        >
          <input
            ref="fileInput"
            class="hidden-file"
            type="file"
            accept="image/*"
            multiple
            @change="filesChanged"
          />
          <div class="upload-panel-header">
            <div>
              <span class="eyebrow">STEP 01</span>
              <h2>添加费用截图</h2>
            </div>
            <div class="upload-panel-actions">
              <el-button
                size="small"
                plain
                :icon="Iphone"
                :disabled="
                  draft.expenses.length >= MAX_EXPENSES ||
                  previewAttachments.length >= MAX_TOTAL_ATTACHMENTS
                "
                @click.stop="openLanUpload"
                >手机上传</el-button
              >
              <el-tag effect="plain" type="info"
                >{{ draft.expenses.length }}/{{ MAX_EXPENSES }}</el-tag
              >
            </div>
          </div>
          <button class="upload-dropzone" type="button" @click="openPicker">
            <span class="upload-icon"><Upload :size="22" /></span
            ><strong>点击选择或拖入图片</strong
            ><span>选中上传框后可直接 Ctrl+V 粘贴截图</span>
          </button>
          <div class="upload-options">
            <el-checkbox v-model="handwritingMode"
              >使用通用手写体识别</el-checkbox
            ><span class="option-note">默认：全文识别高精版</span>
          </div>
        </section>
        <section class="expense-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">STEP 02</span>
              <h2>费用列表</h2>
            </div>
            <span class="muted-count">{{ draft.expenses.length }} 笔</span>
          </div>
          <div v-if="!draft.expenses.length" class="empty-expenses">
            <Picture :size="24" /><strong>还没有费用截图</strong
            ><span>添加一张图片后，会自动生成一笔费用</span>
          </div>
          <div v-else class="expense-list">
            <article
              v-for="(expense, index) in draft.expenses"
              :key="expense.id"
              :data-expense-id="expense.id"
              class="expense-card"
              :class="{
                active: expense.id === selectedId,
                dragging:
                  expenseDragState?.surface === 'list' &&
                  expenseDragState.id === expense.id,
              }"
              @click="selectExpense(expense)"
            >
              <div class="expense-card-topline">
                <span class="drag-handle" title="拖动调整顺序" @click.stop
                  ><Sort :size="15" /></span
                ><span class="expense-index">{{ index + 1 }}</span
                ><el-image
                  class="expense-thumbnail"
                  :src="expense.imageDataUrl"
                  :alt="expense.fileName"
                  fit="cover"
                  :preview-src-list="[expense.imageDataUrl]"
                  :initial-index="0"
                  preview-teleported
                  hide-on-click-modal
                  @click.stop
                />
                <div class="expense-summary">
                  <strong>{{ expense.reason || "未选择事由" }}</strong
                  ><span>{{ expense.fileName }}</span
                  ><span
                    class="expense-status"
                    :class="expense.ocrStatus"
                    :title="expense.recognitionError || ocrStatusLabel(expense)"
                    ><span class="status-dot" />{{
                      ocrStatusLabel(expense)
                    }}</span
                  >
                </div>
                <div class="expense-actions">
                  <el-button
                    circle
                    text
                    :icon="Refresh"
                    :loading="expense.ocrStatus === 'recognizing'"
                    title="重新识别"
                    @click.stop="recognizeExpense(expense)"
                  /><el-button
                    v-if="
                      expense.ocrText ||
                      expense.llmText ||
                      expense.recognitionError
                    "
                    circle
                    text
                    :icon="Document"
                    title="查看识别结果"
                    @click.stop="openOcrResult(expense)"
                  /><el-button
                    circle
                    text
                    type="danger"
                    :icon="Delete"
                    title="删除费用"
                    @click.stop="removeExpense(expense)"
                  />
                </div>
              </div>
              <div class="expense-mini-fields">
                <el-date-picker
                  v-model="expense.occurredDate"
                  type="date"
                  value-format="YYYY-MM-DD"
                  placeholder="发生日期"
                  @change="
                    expense.manualFields.occurredDate = true;
                    expense.ocrStatus = 'manual';
                    dirty();
                  "
                /><el-select
                  v-model="expense.reason"
                  placeholder="事由"
                  @change="
                    expense.manualFields.reason = true;
                    expense.ocrStatus = 'manual';
                    dirty();
                  "
                  ><el-option
                    v-for="reason in expenseReasons"
                    :key="reason"
                    :label="reason"
                    :value="reason" /></el-select
                ><el-input
                  class="expense-amount-field"
                  :model-value="amountInputValue(expense)"
                  inputmode="decimal"
                  placeholder="金额或 =3+33*2"
                  @focus="beginAmountInput(expense)"
                  @update:model-value="
                    (value: string) => updateAmountInput(expense, value)
                  "
                  @blur="commitAmountInput(expense)"
                  @keydown.enter.prevent="
                    ($event.target as HTMLInputElement).blur()
                  "
                  ><template #prepend>￥</template></el-input
                ><el-select
                  class="expense-arranger-field"
                  v-model="expense.arranger"
                  placeholder="安排人"
                  @change="
                    expense.manualFields.arranger = true;
                    expense.ocrStatus = 'manual';
                    dirty();
                  "
                  ><el-option
                    v-for="arranger in arrangers"
                    :key="arranger"
                    :label="arranger"
                    :value="arranger" /></el-select
                ><el-input
                  v-model="expense.description"
                  type="textarea"
                  :rows="2"
                  class="expense-description-field expense-description-input"
                  placeholder="内容说明"
                  @change="
                    expense.manualFields.description = true;
                    expense.ocrStatus = 'manual';
                    dirty();
                  "
                />
              </div>
              <div class="expense-extra-section" @click.stop>
                <div class="expense-extra-heading">
                  <span
                    >附加图片
                    <small
                      >{{ expense.extraAttachments.length }} 张</small
                    ></span
                  >
                  <el-button
                    size="small"
                    plain
                    :icon="Plus"
                    :disabled="!extraAttachmentSlots(expense)"
                    @click="openExtraUpload(expense)"
                    >添加附图</el-button
                  >
                </div>
                <div
                  v-if="expense.extraAttachments.length"
                  class="expense-extra-list"
                >
                  <div
                    v-for="(
                      attachment, attachmentIndex
                    ) in expense.extraAttachments"
                    :key="attachment.id"
                    class="expense-extra-item"
                  >
                    <el-image
                      :src="attachment.imageDataUrl"
                      :alt="attachment.fileName"
                      fit="cover"
                      :preview-src-list="
                        expense.extraAttachments.map(
                          (item) => item.imageDataUrl,
                        )
                      "
                      :initial-index="attachmentIndex"
                      preview-teleported
                      hide-on-click-modal
                    />
                    <div class="expense-extra-actions">
                      <el-button
                        circle
                        text
                        :icon="ArrowLeftBold"
                        title="向前移动"
                        :disabled="attachmentIndex === 0"
                        @click="moveExtraAttachment(expense, attachment, -1)"
                      />
                      <el-button
                        circle
                        text
                        :icon="ArrowRightBold"
                        title="向后移动"
                        :disabled="
                          attachmentIndex ===
                          expense.extraAttachments.length - 1
                        "
                        @click="moveExtraAttachment(expense, attachment, 1)"
                      />
                      <el-button
                        circle
                        text
                        type="danger"
                        :icon="Delete"
                        title="删除附加图片"
                        @click="removeExtraAttachment(expense, attachment)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>
      </aside>
      <div
        class="workspace-resizer"
        role="separator"
        aria-label="调整费用列表宽度"
        title="拖动调整费用列表宽度"
        @pointerdown="startLeftPanelResize"
      />
      <section ref="previewViewport" class="preview-panel">
        <div class="preview-toolbar">
          <div>
            <span class="eyebrow">STEP 03</span>
            <h1>{{ previewPageCount }} 页 A4 预览</h1>
          </div>
          <div class="preview-toolbar-right">
            <div class="preview-context-selects">
              <label class="preview-label-input">
                <span>标签</span>
                <el-input
                  v-model="draft.label"
                  clearable
                  maxlength="80"
                  placeholder="便于查询"
                  @input="dirty"
                />
              </label>
              <label>
                <span>公司名称</span>
                <el-select v-model="draft.companyName" @change="dirty">
                  <el-option
                    v-for="company in companyNames"
                    :key="company"
                    :label="company"
                    :value="company"
                  />
                </el-select>
              </label>
              <label>
                <span>申请人</span>
                <el-select
                  v-model="currentProfileId"
                  placeholder="选择申请人"
                  aria-label="申请人"
                >
                  <el-option
                    v-for="profile in profiles"
                    :key="profile.id"
                    :label="profile.name || profile.applicant || '未命名申请人'"
                    :value="profile.id"
                  />
                </el-select>
              </label>
            </div>
            <el-segmented
              v-model="draft.previewMode"
              :options="[
                { label: '附件同页', value: 'single' },
                { label: '附件分页', value: 'double' },
              ]"
              @change="dirty"
            />
            <div class="preview-zoom-tools">
              <el-button
                circle
                text
                :icon="ZoomOut"
                title="缩小预览"
                @click="changePreviewZoom(-0.1)"
              />
              <span>{{ Math.round(previewZoom * 100) }}%</span>
              <el-button
                circle
                text
                :icon="ZoomIn"
                title="放大预览"
                @click="changePreviewZoom(0.1)"
              />
            </div>
            <el-button
              circle
              text
              :icon="Refresh"
              title="重置当前图片排版"
              :disabled="!selectedAttachment"
              @click="resetImage"
            />
            <el-button
              circle
              text
              :icon="CopyDocument"
              title="复制选中的单元格"
              :disabled="!cellSelection"
              @click="copySelectedPaperCells"
            />
          </div>
        </div>
        <div class="paper-stage" :style="paperSize">
          <div class="paper-scale">
            <div class="preview-pages">
              <div
                v-for="(formPage, formPageIndex) in formPages"
                :key="'form-' + formPageIndex"
                class="paper form-paper"
                data-export-page="form"
              >
                <div class="paper-title">
                  <div class="paper-title-text">
                    {{ draft.companyName }}费用报销单{{
                      formPage.isFirst ? "" : "（续）"
                    }}
                  </div>
                </div>
                <div v-if="formPage.isFirst" class="paper-meta">
                  <div class="meta-cell">
                    <span>报销日期：</span>
                  </div>
                  <div class="meta-cell">
                    <span>申请人：</span
                    ><template v-if="editingKey === 'applicant'"
                      ><input
                        ref="editInput"
                        v-model="editValue"
                        class="paper-edit-input"
                        @blur="commitHeader('applicant')"
                        @keydown.enter.prevent="commitHeader('applicant')"
                        @keydown.esc="cancelEdit" /></template
                    ><button
                      v-else
                      class="paper-editable"
                      type="button"
                      @click="beginEdit('applicant', draft.applicant)"
                    >
                      {{ draft.applicant || "xxx" }}
                    </button>
                  </div>
                  <div class="meta-cell">
                    <span>所属部门：</span
                    ><template v-if="editingKey === 'department'"
                      ><input
                        ref="editInput"
                        v-model="editValue"
                        class="paper-edit-input"
                        @blur="commitHeader('department')"
                        @keydown.enter.prevent="commitHeader('department')"
                        @keydown.esc="cancelEdit" /></template
                    ><button
                      v-else
                      class="paper-editable"
                      type="button"
                      @click="beginEdit('department', draft.department)"
                    >
                      {{ draft.department || "xxxx" }}
                    </button>
                  </div>
                  <div class="meta-cell ticket-cell">
                    附票据（&nbsp;&nbsp;）张
                  </div>
                </div>
                <div class="paper-table-wrap">
                  <table class="paper-table">
                    <thead>
                      <tr>
                        <th class="col-index">序号</th>
                        <th class="col-date">发生日期</th>
                        <th class="col-reason">事由</th>
                        <th class="col-description">内容说明、参与人员等</th>
                        <th class="col-arranger">安排人</th>
                        <th class="col-amount">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      <template v-if="formPage.rows.length"
                        ><tr
                          v-for="(
                            { expense, index, height }, rowIndex
                          ) in formPage.rows"
                          :key="expense.id"
                          :data-expense-id="expense.id"
                          :style="{ height: height + 'px' }"
                          :class="{
                            'selected-row': expense.id === selectedId,
                            'dragging-row':
                              expenseDragState?.surface === 'paper' &&
                              expenseDragState.id === expense.id,
                          }"
                          @click="selectExpense(expense)"
                        >
                          <td
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                0,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                0,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                0,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 0)
                            "
                          >
                            <span class="paper-row-index">
                              <span
                                class="paper-row-drag-handle"
                                title="拖动调整费用顺序"
                                @click.stop
                                ><Sort :size="12"
                              /></span>
                              <span>{{ index + 1 }}</span>
                            </span>
                          </td>
                          <td
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                1,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                1,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                1,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 1)
                            "
                          >
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'occurredDate')
                              "
                              ><input
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input"
                                type="date"
                                @blur="commitExpense(expense, 'occurredDate')"
                                @keydown.esc="cancelEdit" /></template
                            ><button
                              v-else
                              class="paper-editable paper-select-button"
                              type="button"
                              @click.stop="
                                handlePaperCellClick($event, expense, 1)
                              "
                            >
                              {{ expense.occurredDate }}
                            </button>
                          </td>
                          <td
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                2,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                2,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                2,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 2)
                            "
                          >
                            <template
                              v-if="editingKey === fieldKey(expense, 'reason')"
                              ><select
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input"
                                @blur="commitExpense(expense, 'reason')"
                              >
                                <option value="">请选择事由</option>
                                <option
                                  v-for="reason in expenseReasons"
                                  :key="reason"
                                  :value="reason"
                                >
                                  {{ reason }}
                                </option>
                              </select></template
                            ><button
                              v-else
                              class="paper-editable paper-select-button"
                              type="button"
                              @click.stop="
                                handlePaperCellClick($event, expense, 2)
                              "
                            >
                              <span v-if="expense.reason">{{
                                expense.reason
                              }}</span
                              ><span v-else class="paper-empty-hint"
                                >点击选择</span
                              >
                            </button>
                          </td>
                          <td
                            class="description-cell"
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                3,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                3,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                3,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 3)
                            "
                          >
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'description')
                              "
                            >
                              <textarea
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input description-input"
                                :style="{ height: height - 8 + 'px' }"
                                rows="2"
                                @blur="commitExpense(expense, 'description')"
                              /></template
                            ><button
                              v-else
                              class="paper-editable description-button"
                              type="button"
                              @click.stop="
                                handlePaperCellClick($event, expense, 3)
                              "
                            >
                              {{ expense.description || "xxxx" }}
                            </button>
                          </td>
                          <td
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                4,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                4,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                4,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 4)
                            "
                          >
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'arranger')
                              "
                              ><select
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input"
                                @blur="commitExpense(expense, 'arranger')"
                              >
                                <option value="">请选择安排人</option>
                                <option
                                  v-for="arranger in arrangers"
                                  :key="arranger"
                                  :value="arranger"
                                >
                                  {{ arranger }}
                                </option>
                              </select></template
                            ><button
                              v-else
                              class="paper-editable paper-select-button arranger-button"
                              type="button"
                              @click.stop="
                                handlePaperCellClick($event, expense, 4)
                              "
                            >
                              <span v-if="expense.arranger">{{
                                expense.arranger
                              }}</span
                              ><span v-else class="paper-empty-hint"
                                >点击选择</span
                              >
                            </button>
                          </td>
                          <td
                            :class="{
                              'paper-cell-selected': isPaperCellSelected(
                                formPageIndex,
                                rowIndex,
                                5,
                              ),
                            }"
                            @pointerdown="
                              startPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                5,
                              )
                            "
                            @pointerenter="
                              extendPaperCellSelection(
                                $event,
                                formPageIndex,
                                rowIndex,
                                5,
                              )
                            "
                            @click.stop="
                              handlePaperCellClick($event, expense, 5)
                            "
                          >
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'amountCents')
                              "
                              ><input
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input amount-input"
                                type="text"
                                inputmode="decimal"
                                autocomplete="off"
                                placeholder="=3+33*2"
                                @blur="commitExpense(expense, 'amountCents')"
                                @keydown.enter.prevent="
                                  commitExpense(expense, 'amountCents')
                                " /></template
                            ><button
                              v-else
                              class="paper-editable amount-button"
                              type="button"
                              @click.stop="
                                handlePaperCellClick($event, expense, 5)
                              "
                            >
                              {{ money(expense.amountCents) }}
                            </button>
                          </td>
                        </tr></template
                      >
                      <tr v-else class="empty-row">
                        <td>1</td>
                        <td>xxxxx</td>
                        <td>xxxxxx</td>
                        <td>上传图片后生成费用行</td>
                        <td>xxxx</td>
                        <td>0.00</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <template v-if="formPage.isLast">
                  <div class="paper-total-block">
                    <div class="total-label">合计金额</div>
                    <div class="total-value">
                      <button
                        v-if="!manualTotal"
                        class="paper-editable total-number"
                        type="button"
                        @click="
                          draft.totalOverrideCents = effectiveTotal;
                          dirty();
                        "
                      >
                        ￥{{ money(effectiveTotal) }}</button
                      ><input
                        v-else
                        class="paper-edit-input total-number"
                        :value="(effectiveTotal / 100).toFixed(2)"
                        type="text"
                        inputmode="decimal"
                        autocomplete="off"
                        @change="
                          (event) => {
                            const amount = amountExpressionToCents(
                              (event.target as HTMLInputElement).value,
                            );
                            if (amount === null) {
                              ElMessage.warning(
                                '金额表达式无法计算，请检查数字和运算符',
                              );
                              return;
                            }
                            draft.totalOverrideCents = amount;
                            dirty();
                          }
                        "
                      />
                    </div>
                    <div class="uppercase-value">
                      {{ ChineseAmount(effectiveTotal) }}
                    </div>
                  </div>
                  <div v-if="manualTotal" class="manual-total-action">
                    <el-button
                      text
                      size="small"
                      @click="
                        draft.totalOverrideCents = null;
                        dirty();
                      "
                      >恢复自动合计</el-button
                    >
                  </div>
                  <div class="paper-payment">
                    <span>收款信息：</span>
                    <div class="payment-content">
                      <div>
                        <b>名称：</b
                        ><button
                          class="paper-editable"
                          type="button"
                          @click="beginEdit('payeeName', draft.payeeName)"
                        >
                          {{ draft.payeeName || "xxxx" }}
                        </button>
                      </div>
                      <div>
                        <b>账号：</b
                        ><button
                          class="paper-editable"
                          type="button"
                          @click="beginEdit('account', draft.account)"
                        >
                          {{ draft.account || "xxxxx" }}
                        </button>
                      </div>
                      <div>
                        <b>开户行：</b
                        ><button
                          class="paper-editable"
                          type="button"
                          @click="beginEdit('bank', draft.bank)"
                        >
                          {{ draft.bank || "xxxxx" }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="paper-approval">
                    <span>部门负责人：</span><span>财务：</span
                    ><span>总经理审核：</span>
                  </div>
                </template>
                <AttachmentSurface
                  v-if="formPage.isLast && sharedAttachmentPage"
                  :attachments="sharedAttachmentPage"
                  :page-index="0"
                  :selected-id="selectedAttachmentId"
                  @select="selectAttachment"
                  @pointer-start="pointerStart"
                />
              </div>
              <div
                v-for="(
                  attachments, attachmentPageIndex
                ) in separateAttachmentPages"
                :key="'attachment-' + attachmentPageIndex"
                class="paper attachment-paper"
                data-export-page="attachments"
              >
                <AttachmentSurface
                  :attachments="attachments"
                  :page-index="
                    (sharedAttachmentPage ? 1 : 0) + attachmentPageIndex
                  "
                  :selected-id="selectedAttachmentId"
                  @select="selectAttachment"
                  @pointer-start="pointerStart"
                />
              </div>
            </div>
          </div>
        </div>
        <div v-if="selectedAttachment" class="image-inspector">
          <div class="inspector-title">
            <div>
              <span class="eyebrow">SELECTED IMAGE</span
              ><strong>{{ selectedAttachment.fileName }}</strong>
            </div>
            <div class="inspector-actions">
              <el-button
                circle
                text
                :icon="CopyDocument"
                title="复制原图"
                @click="copyOriginalImage()"
              /><el-button
                circle
                text
                :icon="Download"
                title="另存原图"
                @click="saveOriginalImage()"
              /><el-button
                circle
                text
                :icon="Folder"
                title="打开所在目录"
                @click="openOriginalImageFolder()"
              />
              <el-button
                circle
                text
                :icon="Refresh"
                title="恢复默认位置"
                @click="resetImage"
              /><el-button
                circle
                text
                :icon="EditPen"
                title="旋转90度"
                @click="rotate"
              /><el-button
                circle
                text
                type="danger"
                :icon="Delete"
                :title="
                  selectedAttachment.isPrimary ? '删除这笔费用' : '删除附加图片'
                "
                @click="removeSelectedAttachment"
              />
            </div>
          </div>
          <label
            >裁剪缩放<input
              v-model.number="selectedAttachment.transform.cropZoom"
              type="range"
              min="1"
              max="2.4"
              step="0.05"
              @input="dirty"
            /><output
              >{{ selectedAttachment.transform.cropZoom.toFixed(2) }}x</output
            ></label
          ><label
            >横向取景<input
              v-model.number="selectedAttachment.transform.cropX"
              type="range"
              min="0"
              max="100"
              step="1"
              @input="dirty"
            /><output>{{ selectedAttachment.transform.cropX }}%</output></label
          ><label
            >纵向取景<input
              v-model.number="selectedAttachment.transform.cropY"
              type="range"
              min="0"
              max="100"
              step="1"
              @input="dirty"
            /><output>{{ selectedAttachment.transform.cropY }}%</output></label
          >
        </div>
      </section>
    </main>
    <el-dialog v-model="isOcrResultOpen" title="识别结果" width="680px">
      <template v-if="ocrResultExpense">
        <el-alert
          v-if="ocrResultExpense.recognitionError"
          :title="ocrResultExpense.recognitionError"
          type="warning"
          :closable="false"
          show-icon
        />
        <div class="recognition-meta">
          <span>{{
            ocrResultExpense.ocrMode === "handwriting"
              ? "通用手写体识别"
              : "全文识别高精版"
          }}</span
          ><span v-if="ocrResultExpense.lastOcrProfile"
            >{{ ocrResultExpense.lastOcrProfile }} +
            {{ ocrResultExpense.lastLlmProfile }}</span
          ><span v-if="ocrResultExpense.lastRecognitionMs"
            >{{ ocrResultExpense.lastRecognitionMs }} ms</span
          >
        </div>
        <div
          v-if="ocrResultExpense.recognizedFields"
          class="recognition-fields"
        >
          <div>
            <span>发生日期</span
            ><strong>{{
              ocrResultExpense.recognizedFields.occurredDate || "未提取"
            }}</strong>
          </div>
          <div>
            <span>事由</span
            ><strong>{{
              ocrResultExpense.recognizedFields.reason || "未提取"
            }}</strong>
          </div>
          <div>
            <span>金额</span
            ><strong>{{
              ocrResultExpense.recognizedFields.amountCents === undefined
                ? "未提取"
                : `￥${money(ocrResultExpense.recognizedFields.amountCents)}`
            }}</strong>
          </div>
          <div class="recognition-description">
            <span>内容说明</span
            ><strong>{{
              ocrResultExpense.recognizedFields.description || "未提取"
            }}</strong>
          </div>
        </div>
        <h4>AI 返回记录</h4>
        <pre class="ai-text">{{
          ocrResultExpense.llmText ||
          (ocrResultExpense.recognitionError
            ? "本次未取得 AI 返回内容"
            : "尚无 AI 返回记录")
        }}</pre>
        <h4>OCR 原文</h4>
        <pre class="ocr-text">{{
          ocrResultExpense.ocrText || "尚无 OCR 原文"
        }}</pre>
      </template>
      <template #footer
        ><el-button @click="isOcrResultOpen = false">关闭</el-button
        ><el-button
          v-if="ocrResultExpense"
          type="primary"
          :loading="ocrResultExpense.ocrStatus === 'recognizing'"
          @click="recognizeExpense(ocrResultExpense)"
          >重新识别</el-button
        ></template
      >
    </el-dialog>
    <el-dialog
      v-model="isExtraUploadOpen"
      :title="
        extraUploadExpense
          ? '添加附图 · 费用 ' +
            (draft.expenses.indexOf(extraUploadExpense) + 1)
          : '添加附图'
      "
      width="680px"
      destroy-on-close
      @closed="extraUploadExpenseId = null"
    >
      <template v-if="extraUploadExpense">
        <section
          ref="extraUploadZone"
          class="upload-panel extra-upload-panel"
          tabindex="0"
          @focus="extraUploadFocused = true"
          @blur="extraUploadFocused = false"
          @paste="extraPasted"
          @dragover.prevent="extraUploadFocused = true"
          @drop.prevent="extraDropped"
        >
          <input
            ref="extraFileInput"
            class="hidden-file"
            type="file"
            accept="image/*"
            multiple
            @change="extraFilesChanged"
          />
          <div class="upload-panel-header">
            <div>
              <span class="eyebrow">EXTRA ATTACHMENTS</span>
              <h2>添加附加图片</h2>
            </div>
            <div class="upload-panel-actions">
              <el-button
                size="small"
                plain
                :icon="Iphone"
                :disabled="!extraAttachmentSlots(extraUploadExpense)"
                @click.stop="openLanUpload(extraUploadExpense)"
                >手机上传</el-button
              >
              <el-tag effect="plain" type="info"
                >本笔 {{ extraUploadExpense.extraAttachments.length + 1 }}/{{
                  MAX_ATTACHMENTS_PER_EXPENSE
                }}</el-tag
              >
            </div>
          </div>
          <button
            class="upload-dropzone"
            type="button"
            :disabled="!extraAttachmentSlots(extraUploadExpense)"
            @click="openExtraPicker"
          >
            <span class="upload-icon"><Upload :size="22" /></span
            ><strong>点击选择或拖入附加图片</strong
            ><span>选中上传框后可直接 Ctrl+V 粘贴截图，不执行智能识别</span>
          </button>
        </section>
        <div
          v-if="extraUploadExpense.extraAttachments.length"
          class="extra-dialog-list"
        >
          <div
            v-for="(
              attachment, attachmentIndex
            ) in extraUploadExpense.extraAttachments"
            :key="attachment.id"
            class="extra-dialog-item"
          >
            <el-image
              :src="attachment.imageDataUrl"
              :alt="attachment.fileName"
              fit="cover"
              :preview-src-list="
                extraUploadExpense.extraAttachments.map(
                  (item) => item.imageDataUrl,
                )
              "
              :initial-index="attachmentIndex"
              preview-teleported
              hide-on-click-modal
            />
            <span :title="attachment.fileName">{{ attachment.fileName }}</span>
            <div>
              <el-button
                circle
                text
                :icon="ArrowLeftBold"
                title="向前移动"
                :disabled="attachmentIndex === 0"
                @click="moveExtraAttachment(extraUploadExpense, attachment, -1)"
              />
              <el-button
                circle
                text
                :icon="ArrowRightBold"
                title="向后移动"
                :disabled="
                  attachmentIndex ===
                  extraUploadExpense.extraAttachments.length - 1
                "
                @click="moveExtraAttachment(extraUploadExpense, attachment, 1)"
              />
              <el-button
                circle
                text
                type="danger"
                :icon="Delete"
                title="删除附加图片"
                @click="removeExtraAttachment(extraUploadExpense, attachment)"
              />
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button @click="isExtraUploadOpen = false">完成</el-button>
      </template>
    </el-dialog>
    <el-dialog
      v-model="isLanUploadOpen"
      title="手机扫码上传"
      width="520px"
      destroy-on-close
      @closed="stopLanUploadSession"
    >
      <div v-loading="isLanUploadLoading" class="lan-upload-dialog">
        <el-alert
          v-if="lanUploadError"
          :title="lanUploadError"
          type="error"
          :closable="false"
          show-icon
        />
        <template v-if="lanUploadSession && lanUploadQrCode">
          <div class="lan-upload-main">
            <img
              class="lan-upload-qr"
              :src="lanUploadQrCode"
              alt="手机上传二维码"
            />
            <div class="lan-upload-summary">
              <span class="eyebrow">CURRENT RECORD</span>
              <strong>{{ lanUploadLabel }}</strong>
              <span>编号 {{ draft.id.slice(-12) }}</span>
              <div class="lan-upload-metrics">
                <span
                  ><b>{{ lanUploadSession.remainingSlots }}</b> 个位置</span
                >
                <span :class="{ expired: !lanUploadSecondsRemaining }"
                  ><b>{{ lanUploadExpiryText }}</b> 有效期</span
                >
              </div>
            </div>
          </div>
          <el-input
            :model-value="lanUploadSession.url"
            readonly
            aria-label="手机上传地址"
          >
            <template #append>
              <el-button
                :icon="CopyDocument"
                title="复制上传地址"
                @click="copyLanUploadUrl"
              />
            </template>
          </el-input>
          <div class="lan-upload-network">
            <span>监听地址 {{ lanUploadSession.localAddress }}</span>
            <span>手机与电脑需连接同一局域网</span>
          </div>
          <el-alert
            title="手机无法打开时，请允许 SheepFinance 通过 Windows 防火墙，并确认 Wi-Fi 未开启设备隔离。"
            type="info"
            :closable="false"
            show-icon
          />
        </template>
        <div
          v-else-if="!isLanUploadLoading && !lanUploadError"
          class="lan-upload-empty"
        >
          正在准备局域网上传地址
        </div>
      </div>
      <template #footer>
        <el-button @click="isLanUploadOpen = false">关闭</el-button>
        <el-button
          type="primary"
          :icon="Refresh"
          :loading="isLanUploadLoading"
          :disabled="!lanUploadRemainingSlots()"
          @click="refreshLanUploadSession"
          >刷新二维码</el-button
        >
      </template>
    </el-dialog>
    <section v-if="activeTab === 'settings'" class="page-shell settings-page">
      <div class="page-heading">
        <div>
          <span class="eyebrow">PREFERENCES</span>
          <h1>设置</h1>
        </div>
        <div class="settings-actions">
          <input
            ref="configImportInput"
            class="hidden-file"
            type="file"
            accept=".txt,text/plain"
            @change="importConfiguration"
          />
          <el-button @click="openConfigurationImport"
            ><Upload :size="15" />导入配置</el-button
          ><el-button @click="exportConfiguration"
            ><Download :size="15" />导出配置</el-button
          ><el-button type="primary" @click="saveDraft">保存设置</el-button>
        </div>
      </div>
      <div class="settings-grid">
        <div class="drawer-section">
          <span class="eyebrow">GENERAL</span>
          <h3>基础资料</h3>
          <el-form label-position="top">
            <el-form-item label="本地数据目录">
              <el-input
                :model-value="
                  dataDirectory || '浏览器预览模式不生成本地数据目录'
                "
                readonly
              />
            </el-form-item>
          </el-form>
        </div>
        <div class="drawer-section backup-section" v-loading="backupLoading">
          <div class="drawer-section-heading">
            <div>
              <span class="eyebrow">BACKUP &amp; RECOVERY</span>
              <h3>数据备份与恢复</h3>
            </div>
            <el-button text type="primary" @click="loadBackupStatus">
              <Refresh :size="15" />刷新
            </el-button>
          </div>
          <div class="backup-summary">
            <div>
              <span>最近有效备份</span>
              <strong>{{
                backupStatus?.lastBackupAt
                  ? formatDateTime(backupStatus.lastBackupAt)
                  : "尚未创建"
              }}</strong>
            </div>
            <div>
              <span>有效备份</span>
              <strong>{{ backupStatus?.validBackupCount ?? 0 }} / 5</strong>
            </div>
            <div>
              <span>自动备份</span>
              <strong>{{
                backupStatus?.backupDue ? "本次启动已到期" : "72 小时检查"
              }}</strong>
            </div>
          </div>
          <div class="backup-actions">
            <el-button type="primary" @click="createDatabaseBackup">
              <Download :size="15" />立即备份
            </el-button>
            <el-button @click="openBackupDirectory">
              <Folder :size="15" />打开备份目录
            </el-button>
            <el-button @click="exportFullBackup">导出完整备份</el-button>
            <el-button @click="importFullBackup">导入完整备份</el-button>
          </div>
          <div v-if="backupStatus?.backups.length" class="backup-list">
            <div v-for="item in backupStatus.backups" :key="item.fileName">
              <span class="backup-list-main">
                <strong>{{ formatDateTime(item.createdAt) }}</strong>
                <small
                  >{{ formatFileSize(item.sizeBytes) }} ·
                  {{ item.fileName }}</small
                >
              </span>
              <el-tag
                :type="item.valid && item.imagesComplete ? 'success' : 'danger'"
                >{{
                  item.valid && item.imagesComplete ? "可恢复" : "校验失败"
                }}</el-tag
              >
              <el-button
                text
                type="primary"
                :disabled="!item.valid || !item.imagesComplete"
                @click="restoreDatabaseBackup(item)"
                >恢复</el-button
              >
            </div>
          </div>
          <div
            v-if="backupStatus?.legacyArchives.length"
            class="legacy-summary"
          >
            <span>
              已保留 {{ backupStatus.legacyArchives.length }} 个旧 JSON 归档，共
              {{
                formatFileSize(
                  backupStatus.legacyArchives.reduce(
                    (sum, item) => sum + item.sizeBytes,
                    0,
                  ),
                )
              }}
            </span>
            <el-button
              text
              type="danger"
              :disabled="!backupStatus.validBackupCount"
              @click="cleanupLegacyArchives"
              >手工清理</el-button
            >
          </div>
          <p class="drawer-help">
            数据库备份和完整 ZIP 均包含
            OCR/大模型密钥，请按敏感文件保管。自动备份仅保留最近 5 份有效快照。
          </p>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-heading">
            <div>
              <span class="eyebrow">OCR</span>
              <h3>
                阿里云 OCR 配置
                <small class="drawer-current"
                  >当前：{{ defaultOcrProfile?.name }}</small
                >
              </h3>
            </div>
            <el-button text type="primary" @click="addOcrProfile"
              ><Plus :size="15" />新增配置</el-button
            >
          </div>
          <p class="drawer-help">
            默认使用全文识别高精版；勾选手写体后由对应费用项选择手写接口。密钥只保存在本机配置中。
          </p>
          <div class="service-list">
            <article
              v-for="profile in ocrProfiles"
              :key="profile.id"
              class="service-editor"
              :class="{ default: profile.isDefault }"
            >
              <div class="service-editor-head">
                <el-input
                  v-model="profile.name"
                  placeholder="配置名称"
                  @change="dirty"
                /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
                ><el-button
                  v-else
                  text
                  type="primary"
                  @click="makeOcrDefault(profile)"
                  >设为默认</el-button
                ><el-button
                  text
                  type="danger"
                  @click="removeOcrProfile(profile)"
                  >删除</el-button
                >
              </div>
              <div class="service-grid">
                <el-input
                  v-model="profile.endpoint"
                  class="service-wide"
                  placeholder="服务地址"
                  @change="dirty"
                /><el-input
                  v-model="profile.region"
                  placeholder="区域，如 cn-hangzhou"
                  @change="dirty"
                /><el-input
                  v-model="profile.timeoutSeconds"
                  type="number"
                  min="5"
                  max="180"
                  placeholder="超时（秒）"
                  @change="dirty"
                /><el-input
                  v-model="profile.accessKeyId"
                  placeholder="AccessKey ID"
                  @change="dirty"
                /><el-input
                  v-model="profile.accessKeySecret"
                  type="password"
                  show-password
                  placeholder="AccessKey Secret"
                  @change="dirty"
                />
              </div>
            </article>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-heading">
            <div>
              <span class="eyebrow">LLM</span>
              <h3>
                大模型配置
                <small class="drawer-current"
                  >当前：{{ defaultLlmProfile?.name }}</small
                >
              </h3>
            </div>
            <el-button text type="primary" @click="addLlmProfile"
              ><Plus :size="15" />新增配置</el-button
            >
          </div>
          <p class="drawer-help">
            OCR
            完成后，软件会把原文和启用的事由字典交给这里选中的模型做结构化提取。
          </p>
          <div class="service-list">
            <article
              v-for="profile in llmProfiles"
              :key="profile.id"
              class="service-editor"
              :class="{ default: profile.isDefault }"
            >
              <div class="service-editor-head">
                <el-input
                  v-model="profile.name"
                  placeholder="配置名称"
                  @change="dirty"
                /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
                ><el-button
                  v-else
                  text
                  type="primary"
                  @click="makeLlmDefault(profile)"
                  >设为默认</el-button
                ><el-button
                  text
                  type="danger"
                  @click="removeLlmProfile(profile)"
                  >删除</el-button
                >
              </div>
              <div class="service-grid">
                <el-input
                  v-model="profile.baseUrl"
                  class="service-wide"
                  placeholder="Base URL，如 https://api.deepseek.com/v1"
                  @change="dirty"
                /><el-input
                  v-model="profile.model"
                  placeholder="模型名称"
                  @change="dirty"
                /><el-input
                  v-model="profile.timeoutSeconds"
                  type="number"
                  min="5"
                  max="180"
                  placeholder="超时（秒）"
                  @change="dirty"
                /><el-input
                  v-model="profile.apiKey"
                  type="password"
                  show-password
                  placeholder="API Key"
                  @change="dirty"
                />
                <label class="service-switch service-wide">
                  <span>
                    <strong>是否多模态</strong>
                    <small>开启后会把识别图片与 OCR 文本一并发送给模型</small>
                  </span>
                  <el-switch v-model="profile.multimodal" @change="dirty" />
                </label>
              </div>
            </article>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-heading">
            <div>
              <span class="eyebrow">DICTIONARIES</span>
              <h3>字典项</h3>
            </div>
          </div>
          <p class="drawer-help">
            拖动每项左侧的排序图标调整顺序；选中的默认值会自动带入新上传的费用。
          </p>
          <p class="drawer-help configuration-transfer-help">
            导出的 TXT 会进行轻量加密，可在另一台 SheepFinance
            电脑上一键导入；请仍将其作为含密钥文件妥善保管。
          </p>
          <div class="dictionary-group">
            <h4>公司名称字典</h4>
            <div class="dictionary-options" data-dictionary-type="company">
              <div
                v-for="(company, index) in companyNames"
                :key="company"
                class="dictionary-option"
                :class="{
                  default: company === defaultCompany,
                  dragging: isDictionaryDragging('company', company),
                  'drop-before': isDictionaryDropTarget(
                    'company',
                    company,
                    'before',
                  ),
                  'drop-after': isDictionaryDropTarget(
                    'company',
                    company,
                    'after',
                  ),
                }"
                :data-dictionary-index="index"
                :data-dictionary-value="company"
                @pointerdown="startDictionaryDrag($event, 'company', company)"
              >
                <span
                  class="dictionary-drag-handle"
                  title="按住拖动调整顺序"
                  @pointerdown="startDictionaryDrag($event, 'company', company)"
                  ><Sort :size="14"
                /></span>
                <el-radio
                  :model-value="defaultCompany"
                  :value="company"
                  @change="setDictionaryDefault('company', company)"
                  >{{ company }}</el-radio
                >
                <el-button
                  circle
                  text
                  type="danger"
                  :icon="Delete"
                  title="删除公司名称"
                  @click="removeCompany(company)"
                />
              </div>
            </div>
            <div class="dictionary-add-row">
              <el-input
                v-model="newCompany"
                placeholder="添加公司名称，回车确认"
                @keyup.enter="addCompany"
              />
              <el-button
                circle
                type="primary"
                :icon="Plus"
                title="添加公司名称"
                @click="addCompany"
              />
            </div>
          </div>
          <div class="dictionary-group">
            <h4>事由字典</h4>
            <div class="dictionary-options" data-dictionary-type="reason">
              <div
                v-for="(reason, index) in expenseReasons"
                :key="reason"
                class="dictionary-option"
                :class="{
                  default: reason === defaultReason,
                  dragging: isDictionaryDragging('reason', reason),
                  'drop-before': isDictionaryDropTarget(
                    'reason',
                    reason,
                    'before',
                  ),
                  'drop-after': isDictionaryDropTarget(
                    'reason',
                    reason,
                    'after',
                  ),
                }"
                :data-dictionary-index="index"
                :data-dictionary-value="reason"
                @pointerdown="startDictionaryDrag($event, 'reason', reason)"
              >
                <span
                  class="dictionary-drag-handle"
                  title="按住拖动调整顺序"
                  @pointerdown="startDictionaryDrag($event, 'reason', reason)"
                  ><Sort :size="14"
                /></span>
                <el-radio
                  :model-value="defaultReason"
                  :value="reason"
                  @change="setDictionaryDefault('reason', reason)"
                  >{{ reason }}</el-radio
                >
                <el-button
                  circle
                  text
                  type="danger"
                  :icon="Delete"
                  title="删除事由"
                  @click="removeReason(reason)"
                />
              </div>
            </div>
            <div class="dictionary-add-row">
              <el-input
                v-model="newReason"
                placeholder="添加事由，回车确认"
                @keyup.enter="addReason"
              />
              <el-button
                circle
                type="primary"
                :icon="Plus"
                title="添加事由"
                @click="addReason"
              />
            </div>
          </div>
          <div class="dictionary-group">
            <h4>安排人字典</h4>
            <div class="dictionary-options" data-dictionary-type="arranger">
              <div
                v-for="(arranger, index) in arrangers"
                :key="arranger"
                class="dictionary-option"
                :class="{
                  default: arranger === defaultArranger,
                  dragging: isDictionaryDragging('arranger', arranger),
                  'drop-before': isDictionaryDropTarget(
                    'arranger',
                    arranger,
                    'before',
                  ),
                  'drop-after': isDictionaryDropTarget(
                    'arranger',
                    arranger,
                    'after',
                  ),
                }"
                :data-dictionary-index="index"
                :data-dictionary-value="arranger"
                @pointerdown="startDictionaryDrag($event, 'arranger', arranger)"
              >
                <span
                  class="dictionary-drag-handle"
                  title="按住拖动调整顺序"
                  @pointerdown="
                    startDictionaryDrag($event, 'arranger', arranger)
                  "
                  ><Sort :size="14"
                /></span>
                <el-radio
                  :model-value="defaultArranger"
                  :value="arranger"
                  @change="setDictionaryDefault('arranger', arranger)"
                  >{{ arranger }}</el-radio
                >
                <el-button
                  circle
                  text
                  type="danger"
                  :icon="Delete"
                  title="删除安排人"
                  @click="removeArranger(arranger)"
                />
              </div>
            </div>
            <div class="dictionary-add-row">
              <el-input
                v-model="newArranger"
                placeholder="添加安排人，回车确认"
                @keyup.enter="addArranger"
              />
              <el-button
                circle
                type="primary"
                :icon="Plus"
                title="添加安排人"
                @click="addArranger"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
    <section v-if="activeTab === 'history'" class="page-shell history-page">
      <div class="page-heading">
        <div>
          <span class="eyebrow">ARCHIVE</span>
          <h1>历史记录</h1>
        </div>
        <span class="page-count">{{ filteredHistory.length }} 条记录</span>
      </div>
      <div class="history-toolbar">
        <el-input
          v-model="historySearch"
          clearable
          placeholder="按标签、公司、申请人或记录编号搜索"
        />
        <el-date-picker
          v-model="historyDate"
          type="date"
          value-format="YYYY-MM-DD"
          clearable
          placeholder="按发生日期筛选"
        />
        <el-select v-model="historyStatus" clearable placeholder="全部状态">
          <el-option
            v-for="status in REIMBURSEMENT_STATUSES"
            :key="status"
            :label="status"
            :value="status"
          />
        </el-select>
        <el-radio-group v-model="historyViewMode" size="small">
          <el-radio-button label="company">公司文件夹</el-radio-button>
          <el-radio-button label="status">状态文件夹</el-radio-button>
          <el-radio-button label="list">列表</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="!filteredHistory.length" class="history-empty">
        <Clock :size="25" /><strong>还没有已保存的历史记录</strong
        ><span>点击“保存草稿”后，记录会保存在本机。</span>
      </div>
      <template v-else>
        <div
          v-if="historyViewMode !== 'list' && !historyFolderKey"
          class="history-folder-grid"
        >
          <button
            v-for="folder in historyFolders"
            :key="folder.key"
            type="button"
            class="history-folder-card"
            @click="openHistoryFolder(folder)"
          >
            <Folder :size="28" />
            <strong>{{ folder.label }}</strong>
            <span>{{ folder.count }} 条单据</span>
            <small v-if="folder.deleted">设置中已删除</small>
          </button>
        </div>
        <template v-else>
          <div v-if="historyViewMode !== 'list'" class="history-breadcrumb">
            <el-button text :icon="ArrowLeftBold" @click="leaveHistoryFolder"
              >全部文件夹</el-button
            ><span>/</span><strong>{{ historyCurrentFolder?.label }}</strong>
          </div>
          <div v-if="!historyResultTotal" class="history-empty">
            <Clock :size="25" /><strong>当前筛选下没有单据</strong>
          </div>
          <div v-else v-loading="isHistoryQueryLoading" class="history-list">
            <article
              v-for="item in pagedHistory"
              :key="item.id"
              class="history-item"
              @click="openHistoryPreview(item)"
            >
              <div class="history-item-main">
                <div class="history-item-title">
                  <strong>{{ item.companyName || "未填写公司" }}</strong>
                  <span>{{ item.applicant || "未填写申请人" }}</span>
                  <el-tag v-if="item.label" size="small" effect="plain">{{
                    item.label
                  }}</el-tag>
                  <el-tag
                    v-if="item.id === lastEditedHistoryId"
                    size="small"
                    effect="plain"
                    type="primary"
                    >上次编辑</el-tag
                  >
                </div>
                <strong class="history-occurred-date">{{
                  item.firstOccurredDate || "未填写发生日期"
                }}</strong>
                <span
                  >{{ item.expenseCount }} 笔 · ￥{{ money(item.totalCents) }} ·
                  编辑于 {{ formatDateTime(item.updatedAt) }}</span
                >
                <small>{{ item.id }}</small>
              </div>
              <div class="history-item-actions">
                <el-tag
                  class="history-status"
                  :type="reimbursementStatusType(item.status)"
                  effect="light"
                  title="点击切换报销状态"
                  @click.stop="cycleHistoryStatus(item)"
                  >{{ item.status }}</el-tag
                >
                <el-button
                  circle
                  text
                  :icon="View"
                  title="查看详情"
                  @click.stop="openHistoryPreview(item)"
                /><el-button
                  circle
                  text
                  :icon="EditPen"
                  title="修改"
                  @click.stop="editHistory(item)"
                /><el-button
                  circle
                  text
                  :icon="Printer"
                  title="打印"
                  @click.stop="printHistory(item)"
                /><el-dropdown trigger="click" @click.stop>
                  <el-button circle text :icon="Download" title="导出" />
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item @click="exportHistoryExcel(item)">
                        导出 Excel
                      </el-dropdown-item>
                      <el-dropdown-item @click="exportHistoryPdf(item)">
                        导出 PDF
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template> </el-dropdown
                ><el-button
                  circle
                  text
                  type="danger"
                  :icon="Delete"
                  title="删除历史记录"
                  @click.stop="removeHistory(item)"
                />
              </div>
            </article>
          </div>
          <div v-if="historyResultTotal" class="history-pagination">
            <el-pagination
              v-model:current-page="historyPage"
              v-model:page-size="historyPageSize"
              background
              layout="total, prev, pager, next"
              :total="historyResultTotal"
            />
          </div>
        </template>
      </template>
    </section>
    <el-dialog
      v-model="isHistoryPreviewOpen"
      title="历史报销单详情"
      width="980px"
      destroy-on-close
    >
      <div v-loading="isHistoryPreviewLoading" class="history-preview-dialog">
        <template v-if="historyPreviewDraft && historyPreviewItem">
          <div class="history-preview-summary">
            <div>
              <span class="eyebrow">READ ONLY PREVIEW</span>
              <h2>
                {{ historyPreviewDraft.companyName || "未填写公司" }}费用报销单
              </h2>
              <p>
                {{ historyPreviewItem.firstOccurredDate || "未填写发生日期" }} ·
                {{ historyPreviewDraft.expenses.length }} 笔 · ￥{{
                  money(historyPreviewItem.totalCents)
                }}
              </p>
              <small class="history-preview-meta">
                申请人：{{ historyPreviewDraft.applicant || "未填写" }} ·
                所属部门：{{ historyPreviewDraft.department || "未填写" }}
                <template v-if="historyPreviewDraft.reimbursementDate">
                  · 报销日期：{{ historyPreviewDraft.reimbursementDate }}
                </template>
                <br />
                报销单编号：{{ historyPreviewDraft.id }}
              </small>
            </div>
            <el-tag :type="reimbursementStatusType(historyPreviewItem.status)">
              {{ historyPreviewItem.status }}
            </el-tag>
          </div>
          <div class="history-preview-table-wrap">
            <table class="history-preview-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>发生日期</th>
                  <th>事由</th>
                  <th>内容说明、参与人员等</th>
                  <th>安排人</th>
                  <th>金额</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(expense, index) in historyPreviewDraft.expenses"
                  :key="expense.id"
                >
                  <td>{{ index + 1 }}</td>
                  <td>{{ expense.occurredDate }}</td>
                  <td>{{ expense.reason }}</td>
                  <td class="preview-description">
                    {{ expense.description || "" }}
                  </td>
                  <td class="preview-description">{{ expense.arranger }}</td>
                  <td>{{ money(expense.amountCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="history-preview-attachments">
            <template
              v-for="expense in historyPreviewDraft.expenses"
              :key="expense.id"
            >
              <div class="history-preview-image">
                <el-image
                  :src="expense.imageDataUrl"
                  fit="cover"
                  :preview-src-list="[expense.imageDataUrl]"
                />
                <div class="history-preview-image-actions">
                  <el-button
                    text
                    title="复制原图"
                    @click="copyOriginalImage(expense)"
                    ><CopyDocument :size="14"
                  /></el-button>
                  <el-button
                    text
                    title="另存原图"
                    @click="saveOriginalImage(expense)"
                    ><Download :size="14"
                  /></el-button>
                  <el-button
                    text
                    title="打开所在目录"
                    @click="
                      openOriginalImageFolder(expense, historyPreviewDraft.id)
                    "
                    ><Folder :size="14"
                  /></el-button>
                </div>
              </div>
              <div
                v-for="attachment in expense.extraAttachments"
                :key="attachment.id"
                class="history-preview-image"
              >
                <el-image
                  :src="attachment.imageDataUrl"
                  fit="cover"
                  :preview-src-list="[attachment.imageDataUrl]"
                />
                <div class="history-preview-image-actions">
                  <el-button
                    text
                    title="复制原图"
                    @click="copyOriginalImage(attachment)"
                    ><CopyDocument :size="14"
                  /></el-button>
                  <el-button
                    text
                    title="另存原图"
                    @click="saveOriginalImage(attachment)"
                    ><Download :size="14"
                  /></el-button>
                  <el-button
                    text
                    title="打开所在目录"
                    @click="
                      openOriginalImageFolder(
                        attachment,
                        historyPreviewDraft.id,
                      )
                    "
                    ><Folder :size="14"
                  /></el-button>
                </div>
              </div>
            </template>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="isHistoryPreviewOpen = false">关闭</el-button>
        <el-button
          v-if="historyPreviewItem"
          :type="reimbursementStatusType(historyPreviewItem.status)"
          @click="cycleHistoryStatus(historyPreviewItem)"
          >切换状态</el-button
        >
        <el-button
          v-if="historyPreviewItem"
          :icon="Download"
          @click="exportHistoryExcel(historyPreviewItem)"
          >导出 Excel</el-button
        >
        <el-button
          v-if="historyPreviewItem"
          :icon="Printer"
          @click="printHistory(historyPreviewItem)"
          >打印</el-button
        >
        <el-button
          v-if="historyPreviewItem"
          :icon="CopyDocument"
          @click="createFromHistoryTemplate(historyPreviewItem)"
          >以此为模板新建</el-button
        >
        <el-button
          v-if="historyPreviewItem"
          type="danger"
          :icon="Delete"
          @click="removeHistoryFromPreview(historyPreviewItem)"
          >删除</el-button
        >
        <el-button
          v-if="historyPreviewItem"
          type="primary"
          :icon="EditPen"
          @click="editHistory(historyPreviewItem)"
          >修改</el-button
        >
      </template>
    </el-dialog>
    <section v-if="activeTab === 'requests'" class="page-shell requests-page">
      <div class="page-heading">
        <div>
          <span class="eyebrow">DIAGNOSTICS</span>
          <h1>请求记录</h1>
        </div>
        <div class="request-page-actions">
          <el-button
            plain
            :icon="Refresh"
            :loading="isRequestLoading"
            @click="loadRequestLogs"
            >刷新</el-button
          >
          <el-button
            plain
            type="danger"
            :icon="Delete"
            :disabled="!requestRecords.length"
            @click="clearRequestLogs"
            >清空记录</el-button
          >
        </div>
      </div>
      <div class="request-toolbar">
        <el-input
          v-model="requestSearch"
          clearable
          placeholder="搜索文件、配置、模型、地址或错误"
        />
        <el-select v-model="requestService" clearable placeholder="全部服务">
          <el-option label="OCR" value="ocr" />
          <el-option label="大模型" value="llm" />
        </el-select>
        <el-select v-model="requestStatus" clearable placeholder="全部状态">
          <el-option label="成功" value="success" />
          <el-option label="失败" value="error" />
        </el-select>
      </div>
      <div v-loading="isRequestLoading">
        <div v-if="!filteredRequests.length" class="history-empty">
          <Connection :size="25" />
          <strong>还没有请求记录</strong>
          <span>执行 OCR 或大模型识别后，会在本机保存脱敏记录</span>
        </div>
        <div v-else class="request-list">
          <article
            v-for="item in pagedRequests"
            :key="item.id"
            class="request-item"
            @click="openRequestDetail(item)"
          >
            <div class="request-item-status">
              <el-tag
                effect="plain"
                :type="item.service === 'ocr' ? 'warning' : 'primary'"
                >{{ requestServiceLabel(item.service) }}</el-tag
              >
              <el-tag
                effect="dark"
                :type="item.success ? 'success' : 'danger'"
                >{{ item.success ? "成功" : "失败" }}</el-tag
              >
            </div>
            <div class="request-item-main">
              <strong>{{ item.fileName || "未命名费用图片" }}</strong>
              <span :title="item.requestUrl">{{ item.requestUrl }}</span>
              <small>
                {{ item.profileName }}
                <template v-if="item.model"> · {{ item.model }}</template>
                <template v-if="item.action"> · {{ item.action }}</template>
              </small>
            </div>
            <div class="request-item-meta">
              <span>{{ formatRequestTime(item.requestedAt) }}</span>
              <span>{{ item.durationMs }} ms</span>
              <span v-if="item.httpStatus">HTTP {{ item.httpStatus }}</span>
            </div>
            <el-button
              circle
              text
              :icon="View"
              title="查看请求详情"
              @click.stop="openRequestDetail(item)"
            />
          </article>
        </div>
      </div>
      <div v-if="filteredRequests.length" class="history-pagination">
        <el-pagination
          v-model:current-page="requestPage"
          v-model:page-size="requestPageSize"
          background
          layout="total, prev, pager, next"
          :total="filteredRequests.length"
        />
      </div>
    </section>
    <el-dialog
      v-model="isRequestDetailOpen"
      title="请求详情"
      width="900px"
      destroy-on-close
    >
      <div v-loading="isRequestDetailLoading" class="request-detail">
        <template v-if="requestDetail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="服务">
              {{ requestServiceLabel(requestDetail.service) }}
            </el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="requestDetail.success ? 'success' : 'danger'">
                {{ requestDetail.success ? "成功" : "失败" }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="请求时间">
              {{ formatRequestTime(requestDetail.requestedAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="耗时">
              {{ requestDetail.durationMs }} ms
            </el-descriptions-item>
            <el-descriptions-item label="配置">
              {{ requestDetail.profileName }}
            </el-descriptions-item>
            <el-descriptions-item label="模型 / Action">
              {{ requestDetail.model || requestDetail.action || "-" }}
            </el-descriptions-item>
            <el-descriptions-item label="关联图片">
              {{ requestDetail.fileName || "-" }}
            </el-descriptions-item>
            <el-descriptions-item label="HTTP 状态">
              {{ requestDetail.httpStatus || "-" }}
            </el-descriptions-item>
            <el-descriptions-item label="请求地址" :span="2">
              <span class="request-detail-url">{{
                requestDetail.requestUrl
              }}</span>
            </el-descriptions-item>
            <el-descriptions-item
              v-if="requestDetail.error"
              label="错误信息"
              :span="2"
            >
              {{ requestDetail.error }}
            </el-descriptions-item>
          </el-descriptions>
          <h4>请求内容（密钥与图片数据已脱敏）</h4>
          <pre>{{ requestDetail.requestContent }}</pre>
          <h4>响应内容</h4>
          <pre>{{ requestDetail.responseContent || "未取得响应内容" }}</pre>
        </template>
      </div>
      <template #footer>
        <el-button @click="isRequestDetailOpen = false">关闭</el-button>
      </template>
    </el-dialog>
    <section v-if="activeTab === 'settings'" class="page-shell profiles-page">
      <div class="profile-drawer-head">
        <div>
          <span class="eyebrow">PROFILES</span>
          <h2>申请人</h2>
          <p>
            新建报销单时自动带出默认申请人的部门与收款信息，单据内修改不会回写这里。
          </p>
        </div>
        <el-button type="primary" plain @click="addProfile"
          ><Plus :size="15" />新增申请人</el-button
        >
      </div>
      <div class="profiles-list">
        <article
          v-for="profile in profiles"
          :key="profile.id"
          class="profile-editor"
          :class="{ default: profile.isDefault }"
        >
          <div class="profile-editor-head">
            <el-input
              v-model="profile.name"
              placeholder="申请人选项名称"
              @change="dirty"
            /><el-tag v-if="profile.isDefault" type="success">默认</el-tag
            ><el-button v-else text type="primary" @click="setDefault(profile)"
              >设为默认</el-button
            ><el-button text type="danger" @click="removeProfile(profile)"
              >删除</el-button
            >
          </div>
          <div class="profile-grid">
            <el-input
              v-model="profile.applicant"
              placeholder="申请人"
            /><el-input
              v-model="profile.department"
              placeholder="所属部门"
            /><el-input
              v-model="profile.payeeName"
              placeholder="收款名称"
            /><el-input
              v-model="profile.account"
              placeholder="收款账号"
            /><el-input
              v-model="profile.bank"
              class="profile-wide"
              placeholder="开户行"
            />
          </div>
        </article>
      </div>
    </section>
    <section v-if="activeTab === 'about'" class="page-shell about-page">
      <div class="about-mark">S</div>
      <div>
        <span class="eyebrow">SHEEPFINANCE</span>
        <h1>SheepFinance</h1>
        <p>将票据截图识别、核对并排版为报销单的本地桌面工具。</p>
        <div class="about-meta">
          <span>版本 0.2.1</span><span>Windows 10 x64</span>
        </div>
        <div class="about-links">
          <el-link
            href="https://github.com/passheep/Sheep-Finance"
            type="primary"
            @click.prevent="
              openExternalUrl('https://github.com/passheep/Sheep-Finance')
            "
            >GitHub 开源仓库</el-link
          >
          <span>联系 QQ：903081605</span>
        </div>
        <div v-if="dataDirectory" class="about-path">
          <span>数据目录</span><strong>{{ dataDirectory }}</strong>
        </div>
      </div>
    </section>
  </div>
</template>

<style>
:root {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
  color: #25313a;
  background: #eef1ef;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-width: 1180px;
  background: #eef1ef;
}
button,
input,
textarea,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #eef1ef;
}
.topbar {
  height: 70px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 28px;
  background: #fbfcfa;
  border-bottom: 1px solid #dce4df;
}
.brand-block,
.topbar-actions,
.preview-tools,
.inspector-actions {
  display: flex;
  align-items: center;
}
.brand-block {
  gap: 11px;
}
.brand-mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #fff;
  background: #cf674d;
  font-size: 18px;
  font-weight: 800;
  box-shadow: 0 7px 14px rgba(207, 103, 77, 0.2);
}
.brand-name {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.brand-subtitle {
  margin-top: 1px;
  color: #87918d;
  font-size: 11px;
}
.topbar-actions {
  gap: 8px;
}
.topbar-actions .el-button {
  gap: 5px;
}
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: 7px;
  color: #698078;
  font-size: 12px;
  white-space: nowrap;
}
.save-state.dirty {
  color: #b45d47;
}
.workspace {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: var(--left-panel-width, 404px) 8px minmax(0, 1fr);
}
.workspace-resizer {
  position: relative;
  z-index: 5;
  cursor: col-resize;
  touch-action: none;
  background: #e1e8e3;
}
.workspace-resizer::after {
  content: "";
  position: absolute;
  inset: 0 2px;
  background: transparent;
  transition: background 0.15s;
}
.workspace-resizer:hover::after,
.workspace-resizer:active::after {
  background: #cf674d;
}
.left-panel {
  min-height: calc(100vh - 70px);
  padding: 22px 18px 30px 24px;
  overflow: auto;
  border-right: 1px solid #dce4df;
  background: #f5f7f5;
}
.preview-panel {
  min-width: 0;
  min-height: calc(100vh - 70px);
  display: flex;
  flex-direction: column;
  background: #e4e9e5;
}
.upload-panel,
.expense-panel,
.manual-panel {
  padding: 17px;
  border: 1px solid #dce4df;
  border-radius: 10px;
  background: #fbfcfa;
  box-shadow: 0 8px 22px rgba(38, 54, 48, 0.04);
}
.expense-panel,
.manual-panel {
  margin-top: 14px;
}
.upload-panel:focus {
  outline: 2px solid rgba(207, 103, 77, 0.35);
  outline-offset: 2px;
}
.upload-panel-header,
.section-heading,
.preview-toolbar,
.inspector-title,
.profile-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.upload-panel-actions {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.upload-panel-actions .el-button {
  margin: 0;
}
.eyebrow {
  color: #a06c59;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  color: #25313a;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 25px;
}
h2 {
  margin-top: 4px;
  color: #2b393f;
  font-size: 16px;
}
h3 {
  margin-top: 5px;
  font-size: 16px;
}
.upload-dropzone {
  width: 100%;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 15px;
  padding: 15px;
  border: 1px dashed #bbcbc2;
  border-radius: 8px;
  color: #5f7069;
  background: #f7faf7;
  transition:
    border 0.2s,
    background 0.2s,
    transform 0.2s;
}
.upload-dropzone:hover {
  border-color: #cf674d;
  background: #fff8f5;
  transform: translateY(-1px);
}
.upload-dropzone strong {
  color: #3d5149;
  font-size: 13px;
}
.upload-dropzone span:last-child {
  color: #9aa7a1;
  font-size: 11px;
}
.upload-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #cf674d;
  background: #fff0ea;
}
.hidden-file {
  display: none;
}
.upload-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 13px;
}
.option-note,
.muted-count,
.preview-hint,
.panel-footnote {
  color: #8b9892;
  font-size: 11px;
}
.preview-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.compact-heading {
  align-items: flex-start;
}
.compact-heading .el-button {
  padding: 0;
  font-size: 12px;
}
.empty-expenses {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #a2afa9;
  text-align: center;
}
.empty-expenses strong {
  color: #6e7d76;
  font-size: 13px;
}
.empty-expenses span {
  font-size: 11px;
}
.expense-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 14px;
}
.expense-card {
  padding: 10px;
  border: 1px solid #e0e7e2;
  border-radius: 8px;
  background: #fff;
  cursor: grab;
  transition:
    border 0.2s,
    box-shadow 0.2s;
}
.expense-card:hover {
  border-color: #b7c9bf;
  box-shadow: 0 5px 14px rgba(42, 61, 53, 0.07);
}
.expense-card.active {
  border-color: #cf674d;
  box-shadow: 0 0 0 2px rgba(207, 103, 77, 0.11);
}
.expense-card-topline {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.drag-handle {
  color: #9eaaa4;
}
.expense-index {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: #fff;
  background: #57786d;
  font-size: 11px;
  font-weight: 700;
}
.expense-card-topline img {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  object-fit: cover;
  border-radius: 5px;
  background: #edf1ee;
}
.expense-thumbnail {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 5px;
  background: #edf1ee;
  cursor: zoom-in;
}
.expense-thumbnail .el-image__inner {
  width: 100%;
  height: 100%;
}
.expense-summary {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.expense-summary strong,
.expense-summary > span:not(.expense-status) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.expense-summary strong {
  color: #364740;
  font-size: 12px;
}
.expense-summary > span:not(.expense-status) {
  color: #9aa6a0;
  font-size: 10px;
}
.expense-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #b47760;
  font-size: 10px;
}
.expense-status.manual {
  color: #3f8b75;
}
.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.expense-mini-fields {
  display: grid;
  grid-template-columns: 1.05fr 1fr 0.95fr;
  gap: 5px;
  margin-top: 9px;
}
.expense-mini-fields .el-date-editor,
.expense-mini-fields .el-select,
.expense-mini-fields .el-input {
  width: 100%;
}
.expense-mini-fields .el-input__inner,
.expense-mini-fields .el-select__wrapper,
.expense-mini-fields .el-date-editor {
  font-size: 11px;
}
.profile-summary {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
  margin-top: 14px;
}
.profile-summary div {
  min-width: 0;
  padding: 9px;
  border-radius: 7px;
  background: #f1f5f2;
}
.profile-summary span,
.profile-summary strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-summary span {
  color: #8b9991;
  font-size: 10px;
}
.profile-summary strong {
  margin-top: 4px;
  color: #3b4c44;
  font-size: 12px;
}
.panel-footnote {
  margin-top: 11px;
  line-height: 1.55;
}
.preview-toolbar {
  min-height: 73px;
  padding: 0 26px;
  background: #f2f5f2;
  border-bottom: 1px solid #d6dfd9;
}
.preview-tools {
  gap: 9px;
}
.paper-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 18px;
}
.paper-scale {
  flex: 0 0 auto;
  transform-origin: top center;
}
.paper {
  width: 794px;
  height: 1123px;
  display: flex;
  flex-direction: column;
  padding: 30px 35px 27px;
  overflow: hidden;
  color: #2f3334;
  background: #fff;
  box-shadow: 0 13px 35px rgba(43, 54, 49, 0.18);
  font-family: SimSun, "Songti SC", serif;
  letter-spacing: 0;
}
.paper * {
  letter-spacing: 0;
}
.paper-title {
  height: 43px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #4c4f4f;
  border-bottom: 0;
}
.paper-title-text {
  font-size: 19px;
  font-weight: 700;
}
.paper-meta {
  height: 31px;
  display: grid;
  grid-template-columns: 1.1fr 1fr 1fr 0.86fr;
  border: 1px solid #4c4f4f;
}
.meta-cell {
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-left: 1px solid #4c4f4f;
  font-size: 12px;
  white-space: nowrap;
}
.meta-cell:first-child {
  border-left: 0;
}
.ticket-cell {
  justify-content: center;
}
.paper-table-wrap {
  flex: 0 0 auto;
}
.paper-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}
.paper-table th,
.paper-table td {
  height: 42px;
  padding: 4px 5px;
  border: 1px solid #4c4f4f;
  text-align: center;
  vertical-align: middle;
  user-select: none;
}
.paper-table input,
.paper-table textarea,
.paper-table select {
  user-select: text;
}
.paper-table th {
  height: 34px;
  font-weight: 700;
}
.paper-table .col-index {
  width: 8%;
}
.paper-table .col-date {
  width: 13%;
}
.paper-table .col-reason {
  width: 14%;
}
.paper-table .col-description {
  width: 32%;
}
.paper-table .col-arranger {
  width: 16%;
}
.paper-table .col-amount {
  width: 17%;
}
.paper-table tr.selected-row td {
  background: #fff7f3;
}
.paper-table tr.dragging-row td {
  background: #f6e9e4;
}
.paper-table td.paper-cell-selected {
  background: #dceeff !important;
  box-shadow: inset 0 0 0 1px #6aa8d8;
  user-select: none;
}
.paper-table .empty-row td {
  color: #a7afa9;
}
.paper-row-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}
.paper-row-drag-handle {
  width: 15px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #9aa5a0;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.paper-row-drag-handle:active {
  cursor: grabbing;
}
.description-cell {
  height: 42px;
}
.paper-editable {
  max-width: 100%;
  padding: 1px 2px;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: inherit;
  white-space: inherit;
  user-select: none;
}
.paper-table .paper-editable {
  min-width: 100%;
  min-height: 28px;
}
.paper-select-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.paper-empty-hint {
  color: #a7afa9;
  font-size: 10px;
}
.paper-editable:hover {
  color: #b9533e;
  background: #fff0ea;
  outline: 1px dashed #d99a89;
}
.description-button {
  display: block;
  width: 100%;
  overflow: visible;
  text-align: left;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.amount-button {
  width: 100%;
  text-align: right;
}
.paper-edit-input,
.paper-cell-input {
  min-width: 0;
  border: 0;
  border-bottom: 1px solid #cf674d;
  outline: 0;
  color: #26343a;
  background: #fff8f5;
  font-family: inherit;
}
.paper-edit-input {
  width: 100%;
  padding: 1px 3px;
}
.paper-cell-input {
  width: 100%;
  padding: 2px;
  text-align: center;
  font-size: 11px;
}
.description-input {
  height: 34px;
  resize: none;
  text-align: left;
}
.amount-input {
  text-align: right;
}
.paper-total-row,
.paper-uppercase-row {
  display: grid;
  grid-template-columns: 21% 79%;
  min-height: 31px;
  border-left: 1px solid #4c4f4f;
  border-right: 1px solid #4c4f4f;
  border-bottom: 1px solid #4c4f4f;
}
.total-label {
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #4c4f4f;
  font-weight: 700;
}
.total-value,
.uppercase-value {
  display: flex;
  align-items: center;
  padding: 0 10px;
}
.total-number {
  width: 100%;
  color: #303434;
  text-align: left;
  font-size: 13px;
}
.paper-uppercase-row {
  min-height: 31px;
  border-top: 0;
}
.uppercase-value {
  font-size: 12px;
}
.manual-total-action {
  height: 0;
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: flex-end;
  padding-right: 10px;
  transform: translateY(-27px);
}
.paper-payment {
  min-height: 63px;
  display: flex;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #4c4f4f;
  border-top: 0;
  font-size: 12px;
  line-height: 1.55;
}
.payment-content {
  flex: 1;
}
.payment-content div {
  min-height: 17px;
}
.paper-approval {
  min-height: 38px;
  display: grid;
  grid-template-columns: 1fr 1fr 1.35fr;
  align-items: end;
  padding: 0 13px 7px;
  border: 1px solid #4c4f4f;
  border-top: 0;
  font-size: 12px;
}
.attachment-title {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  color: #6e8178;
  font-size: 10px;
}
.attachment-area {
  position: relative;
  flex: 1;
  min-height: 126px;
  overflow: hidden;
  border: 1px dashed #b9c7bf;
  background: #fbfcfb;
}
.attachment-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #bac4be;
  font-size: 11px;
}
.attachment-object {
  position: absolute;
  overflow: hidden;
  border: 1px solid transparent;
  background: #e7ece8;
  cursor: move;
  touch-action: none;
}
.attachment-object:hover,
.attachment-object.selected {
  border-color: #cf674d;
  box-shadow: 0 0 0 2px rgba(207, 103, 77, 0.16);
}
.attachment-object img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition:
    transform 0.12s,
    object-position 0.12s;
  user-select: none;
  pointer-events: none;
}
.attachment-label {
  position: absolute;
  left: 4px;
  top: 4px;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: #fff;
  background: rgba(45, 61, 55, 0.72);
  font-family: "Microsoft YaHei", sans-serif;
  font-size: 10px;
}
.resize-handle {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  background: #cf674d;
  cursor: nwse-resize;
}
.image-inspector {
  min-height: 70px;
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr;
  align-items: center;
  gap: 16px;
  padding: 10px 27px;
  border-top: 1px solid #d6dfd9;
  background: #f3f6f3;
}
.inspector-title {
  min-width: 0;
}
.inspector-title strong {
  display: block;
  max-width: 240px;
  overflow: hidden;
  margin-top: 4px;
  color: #45564e;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inspector-actions {
  gap: 2px;
}
.image-inspector > label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 7px;
  color: #74837b;
  font-size: 10px;
}
.image-inspector input {
  min-width: 60px;
  accent-color: #cf674d;
}
.image-inspector output {
  min-width: 28px;
  color: #4d6259;
  text-align: right;
}
.drawer-section {
  padding-bottom: 22px;
  margin-bottom: 22px;
  border-bottom: 1px solid #e3e9e5;
}
.drawer-section h3 {
  margin-bottom: 15px;
}
.integration-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e0e7e2;
  border-radius: 8px;
  background: #fbfcfa;
}
.integration-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #cf674d;
  background: #fff0ea;
}
.integration-card > div:nth-child(2) {
  min-width: 0;
  flex: 1;
}
.integration-card strong,
.integration-card span {
  display: block;
}
.integration-card strong {
  color: #40534b;
  font-size: 13px;
}
.integration-card span {
  margin-top: 3px;
  color: #9aa6a0;
  font-size: 10px;
}
.dictionary-line {
  display: grid;
  grid-template-columns: 60px 1fr;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid #eef2ef;
}
.dictionary-line span {
  color: #87958d;
  font-size: 12px;
}
.dictionary-line strong {
  color: #43564c;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}
.profile-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.profile-drawer-head p {
  max-width: 270px;
  color: #8b9892;
  font-size: 12px;
  line-height: 1.55;
}
.profiles-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.profile-editor {
  padding: 13px;
  border: 1px solid #e1e8e3;
  border-radius: 8px;
  background: #fbfcfa;
}
.profile-editor.default {
  border-color: #9bc7b3;
  box-shadow: 0 0 0 2px rgba(63, 139, 117, 0.09);
}
.profile-editor-head {
  margin-bottom: 11px;
}
.profile-editor-head .el-input {
  flex: 1;
}
.profile-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.profile-wide {
  grid-column: 1 / -1;
}
.drawer-current {
  margin-left: 6px;
  color: #8b9892;
  font-size: 10px;
  font-weight: 400;
}
.drawer-section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.drawer-help {
  margin: -7px 0 13px;
  color: #8b9892;
  font-size: 11px;
  line-height: 1.55;
}
.service-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.service-editor {
  padding: 11px;
  border: 1px solid #e1e8e3;
  border-radius: 8px;
  background: #fbfcfa;
}
.service-editor.default {
  border-color: #9bc7b3;
  box-shadow: 0 0 0 2px rgba(63, 139, 117, 0.09);
}
.service-editor-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 9px;
}
.service-editor-head .el-input {
  flex: 1;
}
.service-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.service-wide {
  grid-column: 1 / -1;
}
.dictionary-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 28px;
}
.dictionary-add-row {
  display: flex;
  gap: 7px;
  margin-top: 9px;
}
.arranger-heading {
  margin-top: 18px;
}
.history-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-toolbar .el-input {
  flex: 1;
}
.history-toolbar > span {
  color: #8b9892;
  font-size: 12px;
  white-space: nowrap;
}
.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 15px;
}
.history-folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.history-folder-card {
  min-height: 132px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  border: 1px solid #dce6df;
  border-radius: 8px;
  color: #4f665b;
  background: #fbfcfa;
  text-align: left;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}
.history-folder-card:hover {
  border-color: #cf674d;
  box-shadow: 0 7px 16px rgba(42, 61, 53, 0.08);
  transform: translateY(-1px);
}
.history-folder-card svg {
  color: #c47a5f;
}
.history-folder-card strong {
  max-width: 100%;
  overflow: hidden;
  color: #3f5149;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-folder-card span,
.history-folder-card small {
  color: #89968f;
  font-size: 11px;
}
.history-folder-card small {
  color: #b45d47;
}
.history-breadcrumb {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 13px;
  color: #839189;
  font-size: 12px;
}
.history-breadcrumb .el-button {
  margin: 0;
}
.history-occurred-date {
  color: #33483e !important;
  font-size: 16px !important;
  font-weight: 800 !important;
  letter-spacing: 0;
}
.history-preview-dialog {
  min-height: 260px;
}
.history-preview-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 13px;
  border-bottom: 1px solid #e1e8e3;
}
.history-preview-summary h2 {
  margin-top: 5px;
  font-size: 18px;
}
.history-preview-summary p {
  margin-top: 5px;
  color: #7d8b84;
  font-size: 11px;
}
.history-preview-meta {
  display: block;
  margin-top: 6px;
  color: #8a9790;
  font-size: 11px;
}
.history-preview-table-wrap {
  max-height: 340px;
  margin-top: 14px;
  overflow: auto;
  border: 1px solid #d7e1da;
}
.history-preview-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  color: #35483f;
  font-size: 12px;
}
.history-preview-table th,
.history-preview-table td {
  min-height: 36px;
  padding: 7px 8px;
  border: 1px solid #d7e1da;
  text-align: center;
  vertical-align: middle;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.history-preview-table th {
  background: #f1f6f2;
  font-weight: 700;
}
.history-preview-table th:nth-child(1) {
  width: 8%;
}
.history-preview-table th:nth-child(2) {
  width: 14%;
}
.history-preview-table th:nth-child(3) {
  width: 14%;
}
.history-preview-table th:nth-child(4) {
  width: 32%;
}
.history-preview-table th:nth-child(5) {
  width: 16%;
}
.history-preview-table th:nth-child(6) {
  width: 16%;
}
.history-preview-table .preview-description {
  text-align: left;
}
.history-preview-attachments {
  display: grid;
  grid-template-columns: repeat(auto-fill, 126px);
  gap: 8px;
  max-height: 150px;
  margin-top: 14px;
  overflow: auto;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid #e0e7e2;
  border-radius: 8px;
  background: #fbfcfa;
  cursor: pointer;
  transition:
    border 0.2s,
    box-shadow 0.2s;
}
.history-item:hover {
  border-color: #cf674d;
  box-shadow: 0 5px 14px rgba(42, 61, 53, 0.07);
}
.history-item-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.history-item-main strong,
.history-item-main span,
.history-item-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
.history-status {
  cursor: pointer;
  user-select: none;
}
.history-item-main strong {
  color: #3f5149;
  font-size: 13px;
}
.history-item-main span {
  color: #6f8178;
  font-size: 11px;
}
.history-item-main small {
  color: #abb6b0;
  font-size: 10px;
}
.history-empty {
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #a2afa9;
  text-align: center;
}
.history-empty strong {
  color: #6e7d76;
  font-size: 13px;
}
.history-empty span {
  color: #9aa6a0;
  font-size: 11px;
}
.expense-status.recognizing {
  color: #aa7a37;
}
.expense-status.success,
.expense-status.manual {
  color: #3f8b75;
}
.expense-status.partial {
  color: #a56f35;
}
.expense-status.error {
  color: #b44f48;
}
.expense-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0;
}
.recognition-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 14px 0 10px;
  color: #7e8c85;
  font-size: 12px;
}
.lan-upload-dialog {
  min-height: 335px;
}
.lan-upload-dialog > .el-alert {
  margin-bottom: 14px;
}
.lan-upload-main {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr);
  align-items: center;
  gap: 22px;
  margin-bottom: 16px;
}
.lan-upload-qr {
  width: 238px;
  height: 238px;
  display: block;
  border: 1px solid #dce5df;
  border-radius: 6px;
  background: #fff;
}
.lan-upload-summary {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.lan-upload-summary > strong {
  overflow: hidden;
  color: #34483f;
  font-size: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lan-upload-summary > span:not(.eyebrow) {
  color: #829089;
  font-size: 11px;
}
.lan-upload-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 9px;
  padding-top: 12px;
  border-top: 1px solid #e0e7e2;
}
.lan-upload-metrics span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #87948e;
  font-size: 10px;
}
.lan-upload-metrics b {
  color: #46665a;
  font-size: 17px;
}
.lan-upload-metrics .expired b {
  color: #b44f48;
}
.lan-upload-network {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin: 9px 0 13px;
  color: #829089;
  font-size: 10px;
}
.lan-upload-empty {
  min-height: 300px;
  display: grid;
  place-items: center;
  color: #8b9892;
  font-size: 12px;
}
.recognition-fields {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 15px;
}
.recognition-fields > div {
  min-width: 0;
  padding: 9px;
  border: 1px solid #e2e9e4;
  border-radius: 7px;
  background: #fbfcfa;
}
.recognition-fields span,
.recognition-fields strong {
  display: block;
}
.recognition-fields span {
  color: #8c9992;
  font-size: 10px;
}
.recognition-fields strong {
  margin-top: 4px;
  overflow: hidden;
  color: #3f5149;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recognition-fields .recognition-description {
  grid-column: 1 / -1;
}
.recognition-fields .recognition-description strong {
  white-space: normal;
}
.el-dialog h4 {
  margin: 15px 0 7px;
  color: #52635b;
  font-size: 12px;
}
.ocr-text {
  max-height: 260px;
  overflow: auto;
  padding: 12px;
  margin: 0;
  border: 1px solid #e2e9e4;
  border-radius: 7px;
  color: #405148;
  background: #f7faf7;
  font-family: "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}
@media print {
  @page {
    size: A4 portrait;
    margin: 0;
  }
  html,
  body {
    min-width: 0 !important;
    background: #fff !important;
  }
  .topbar,
  .left-panel,
  .workspace-resizer,
  .preview-toolbar,
  .image-inspector,
  .el-overlay,
  .el-drawer {
    display: none !important;
  }
  .workspace,
  .preview-panel,
  .paper-stage {
    display: block !important;
    min-height: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }
  .paper-scale {
    transform: none !important;
  }
  .paper {
    margin: 0;
    box-shadow: none;
  }
}
@media (max-height: 820px) {
  .topbar {
    height: 62px;
  }
  .left-panel,
  .preview-panel {
    min-height: calc(100vh - 62px);
  }
  .preview-toolbar {
    min-height: 62px;
  }
  .image-inspector {
    min-height: 62px;
  }
}
.topbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto minmax(320px, 1fr);
  position: relative;
}
.main-tabs {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px;
  border: 1px solid #e0e8e2;
  border-radius: 11px;
  background: #f2f6f3;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
}
.main-tab {
  min-width: 88px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #718079;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  transition:
    color 0.18s,
    background 0.18s,
    border-color 0.18s,
    box-shadow 0.18s;
}
.main-tab:hover {
  color: #3f5e52;
  background: #e7f0eb;
}
.main-tab.active {
  color: #a94f3d;
  border-color: #f0c7ba;
  background: #fff8f5;
  box-shadow: 0 3px 8px rgba(207, 103, 77, 0.1);
}
.page-shell {
  flex: 1 1 auto;
  min-height: calc(100vh - 70px);
  overflow: auto;
  padding: 32px 42px 44px;
  background: #eef1ef;
}
.page-heading {
  width: min(1180px, 100%);
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 0 auto 22px;
}
.page-heading h1 {
  margin-top: 5px;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 25px;
  font-weight: 750;
  letter-spacing: 0;
}
.page-count {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid #d5e2da;
  border-radius: 7px;
  color: #688078;
  background: #f7faf8;
  font-size: 11px;
}
.settings-page {
  padding-bottom: 20px;
}
.settings-grid {
  width: min(1180px, 100%);
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.settings-page .drawer-section {
  min-width: 0;
  padding: 19px;
  margin: 0;
  border: 1px solid #dce6df;
  border-radius: 12px;
  background: #fbfcfa;
  box-shadow: 0 8px 22px rgba(38, 54, 48, 0.045);
}
.settings-page .drawer-section:nth-child(3) {
  grid-column: 1 / -1;
}
.settings-page .drawer-section h3 {
  margin-top: 6px;
  margin-bottom: 15px;
}
.settings-page .drawer-section-heading h3 {
  margin-bottom: 0;
}
.settings-page .el-form-item {
  margin-bottom: 13px;
}
.profiles-page {
  min-height: auto;
  padding-top: 8px;
}
.profiles-page .profile-drawer-head,
.profiles-page .profiles-list {
  width: min(1180px, 100%);
  margin-left: auto;
  margin-right: auto;
}
.profiles-page .profile-drawer-head {
  padding: 19px;
  border: 1px solid #dce6df;
  border-radius: 12px 12px 0 0;
  background: #fbfcfa;
}
.profiles-page .profiles-list {
  margin-top: -1px;
  padding: 0 19px 19px;
  border: 1px solid #dce6df;
  border-top: 0;
  border-radius: 0 0 12px 12px;
  background: #fbfcfa;
}
.profile-editor {
  background: #f7faf8;
}
.history-page {
  padding-left: max(42px, calc((100% - 1000px) / 2));
  padding-right: max(42px, calc((100% - 1000px) / 2));
}
.history-page .page-heading {
  width: 100%;
}
.history-toolbar {
  width: 100%;
  padding: 12px;
  border: 1px solid #dce6df;
  border-radius: 10px;
  background: #fbfcfa;
  box-shadow: 0 8px 22px rgba(38, 54, 48, 0.04);
}
.history-list {
  margin-top: 12px;
}
.history-item {
  border-radius: 10px;
  background: #fbfcfa;
}
.about-page {
  display: grid;
  grid-template-columns: 112px minmax(0, 560px);
  align-content: center;
  justify-content: center;
  gap: 28px;
}
.about-mark {
  width: 112px;
  height: 112px;
  display: grid;
  place-items: center;
  align-self: start;
  border-radius: 26px;
  color: #fff;
  background: #cf674d;
  box-shadow: 0 16px 28px rgba(207, 103, 77, 0.22);
  font-family: Georgia, serif;
  font-size: 62px;
  font-weight: 800;
}
.about-page h1 {
  margin-top: 6px;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  font-size: 32px;
}
.about-page p {
  margin-top: 10px;
  color: #6e7d76;
  font-size: 15px;
}
.about-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 22px;
}
.about-meta span {
  padding: 6px 10px;
  border: 1px solid #d5e2da;
  border-radius: 7px;
  color: #698078;
  background: #f7faf8;
  font-size: 11px;
}
.about-path {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 14px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #dce6df;
  color: #8b9892;
  font-size: 11px;
}
.about-path strong {
  color: #50645a;
  font-weight: 500;
  word-break: break-all;
}
.about-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 20px;
  margin-top: 16px;
  color: #60736a;
  font-size: 12px;
}
@media (max-width: 1220px) {
  .topbar {
    grid-template-columns: 220px auto minmax(300px, 1fr);
    padding-left: 18px;
    padding-right: 18px;
  }
  .main-tab {
    min-width: 78px;
    padding-left: 9px;
    padding-right: 9px;
  }
  .page-shell {
    padding-left: 24px;
    padding-right: 24px;
  }
  .history-page {
    padding-left: 24px;
    padding-right: 24px;
  }
}
.app-shell svg {
  width: 1em;
  height: 1em;
  flex: 0 0 auto;
}
.main-tab {
  min-width: 96px;
  white-space: nowrap;
}
.main-tab > svg {
  width: 17px;
  height: 17px;
}
.topbar-actions {
  min-width: 350px;
  justify-self: end;
  white-space: nowrap;
}
.upload-icon > svg {
  width: 22px;
  height: 22px;
}
.empty-expenses > svg {
  width: 24px;
  height: 24px;
}
.attachment-title > svg {
  width: 13px;
  height: 13px;
}
.history-empty > svg {
  width: 25px;
  height: 25px;
}
.main-tab:focus {
  outline: none;
}
.main-tab:focus-visible {
  outline: 2px solid rgba(207, 103, 77, 0.35);
  outline-offset: 2px;
}
.settings-page .drawer-help {
  margin: 8px 0 13px;
}
.settings-page .drawer-section-heading h3 {
  line-height: 1.45;
}
.settings-page .drawer-current {
  display: inline-block;
  margin-top: 2px;
  vertical-align: top;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  flex: 0 0 70px;
}
.app-shell.reimbursement-active {
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
}
.reimbursement-active .workspace {
  height: calc(100vh - 70px);
  min-height: 0;
  flex: 0 0 calc(100vh - 70px);
  overflow: hidden;
}
.reimbursement-active .left-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.reimbursement-active .upload-panel,
.reimbursement-active .manual-panel {
  flex: 0 0 auto;
}
.reimbursement-active .expense-panel {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.reimbursement-active .expense-list {
  min-height: 0;
  overflow-y: auto;
  padding-right: 3px;
  scrollbar-gutter: stable;
}
.reimbursement-active .empty-expenses {
  min-height: 100px;
  flex: 1 1 auto;
}
.current-profile-select {
  width: 100%;
  margin-top: 13px;
}
.current-profile-select + .profile-summary {
  margin-top: 9px;
}
.expense-mini-fields {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.expense-mini-fields > .el-input:last-child {
  grid-column: 1 / -1;
}
.expense-mini-fields > * {
  min-width: 0;
}
.reimbursement-active .preview-panel {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.reimbursement-active .preview-toolbar {
  flex: 0 0 73px;
}
.reimbursement-active .paper-stage {
  width: auto !important;
  height: auto !important;
  min-height: 0;
  flex: 1 1 auto;
  display: block;
  overflow: auto;
  padding: 18px 26px 24px;
  overscroll-behavior: contain;
}
.reimbursement-active .paper-scale {
  width: var(--scaled-paper-width);
  height: var(--scaled-preview-height);
  margin: 0 auto;
  transform: none !important;
}
.reimbursement-active .paper {
  transform: scale(var(--paper-scale));
  transform-origin: top left;
}
.reimbursement-active .image-inspector {
  position: relative;
  z-index: 10;
  min-height: 70px;
  flex: 0 0 70px;
}
.attachment-object {
  overscroll-behavior: contain;
}
@media (max-height: 820px) {
  .topbar {
    flex-basis: 62px;
  }
  .reimbursement-active .workspace {
    height: calc(100vh - 62px);
    flex-basis: calc(100vh - 62px);
  }
  .reimbursement-active .left-panel {
    padding: 12px 14px 12px 18px;
  }
  .reimbursement-active .upload-panel,
  .reimbursement-active .expense-panel,
  .reimbursement-active .manual-panel {
    padding: 12px;
  }
  .reimbursement-active .expense-panel,
  .reimbursement-active .manual-panel {
    margin-top: 10px;
  }
  .reimbursement-active .upload-dropzone {
    min-height: 82px;
    margin-top: 10px;
    padding: 8px;
    gap: 4px;
  }
  .reimbursement-active .upload-icon {
    width: 32px;
    height: 32px;
  }
  .reimbursement-active .upload-options {
    margin-top: 8px;
  }
  .reimbursement-active .current-profile-select {
    margin-top: 8px;
  }
  .reimbursement-active .profile-summary {
    margin-top: 7px;
  }
  .reimbursement-active .profile-summary div {
    padding: 6px;
  }
  .reimbursement-active .panel-footnote {
    margin-top: 7px;
    line-height: 1.4;
  }
  .reimbursement-active .preview-toolbar {
    flex-basis: 62px;
  }
  .reimbursement-active .image-inspector {
    min-height: 62px;
    flex-basis: 62px;
  }
}
@media print {
  .app-shell.reimbursement-active {
    height: auto !important;
    overflow: visible !important;
  }
  .reimbursement-active .workspace,
  .reimbursement-active .preview-panel,
  .reimbursement-active .paper-stage {
    height: auto !important;
    overflow: visible !important;
  }
  .reimbursement-active .paper-scale {
    width: 794px !important;
    height: 1123px !important;
  }
  .reimbursement-active .paper {
    transform: none !important;
  }
}
.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.preview-toolbar-right {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.preview-profile-card {
  width: 176px;
  flex: 0 0 176px;
}
.preview-profile-card .el-select {
  width: 100%;
}
.expense-card {
  cursor: default;
}
.drag-handle {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.drag-handle:active {
  cursor: grabbing;
}
.expense-card.dragging {
  opacity: 0.72;
  border-color: #cf674d;
  box-shadow: 0 8px 18px rgba(42, 61, 53, 0.12);
}
.expense-mini-fields {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.expense-mini-fields > * {
  min-width: 0;
}
.expense-mini-fields > .expense-amount-field,
.expense-mini-fields > .expense-arranger-field,
.expense-mini-fields > .expense-description-field {
  grid-column: 1 / -1;
}
.expense-description-input .el-textarea__inner {
  min-height: 42px !important;
  resize: vertical;
  line-height: 1.45;
}
.paper-uppercase-row > div:first-child {
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #4c4f4f;
  font-weight: 700;
}
.paper-uppercase-row > div:first-child::after {
  content: "（大写）";
}
.image-inspector {
  grid-template-columns: minmax(225px, 1.3fr) repeat(3, minmax(0, 1fr));
  gap: 10px;
  padding: 8px 18px;
}
.inspector-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.inspector-title > div:first-child {
  min-width: 0;
  flex: 1 1 auto;
}
.inspector-actions {
  flex: 0 0 auto;
  gap: 0;
}
.inspector-actions .el-button {
  width: 26px;
  height: 26px;
  margin: 0 !important;
}
.attachment-area {
  padding-bottom: 8%;
}
.attachment-object {
  overscroll-behavior: contain;
}
.ai-text,
.ocr-text {
  max-height: 220px;
  overflow: auto;
}
.ai-text {
  padding: 12px;
  margin: 0;
  border: 1px solid #e2e9e4;
  border-radius: 7px;
  color: #405148;
  background: #fffaf7;
  font-family: "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
}
.settings-grid {
  grid-template-rows: auto auto;
}
.settings-grid .drawer-section:nth-child(1) {
  grid-column: 1;
  grid-row: 2;
}
.settings-grid .drawer-section:nth-child(2) {
  grid-column: 1;
  grid-row: 1;
}
.settings-grid .drawer-section:nth-child(3) {
  grid-column: 2;
  grid-row: 1;
}
.settings-grid .drawer-section:nth-child(4) {
  grid-column: 2;
  grid-row: 2;
}
.settings-page {
  flex: 0 0 auto;
}
.profiles-page {
  flex: 0 0 auto;
  min-height: auto;
  padding: 8px 42px 32px;
  margin-top: -4px;
}
.profiles-page .profile-drawer-head {
  width: min(1180px, 100%);
  padding: 19px;
  margin: 0 auto;
  border: 1px solid #dce6df;
  border-radius: 12px 12px 0 0;
  background: #fbfcfa;
}
.profiles-page .profiles-list {
  width: min(1180px, 100%);
  padding: 0 19px 19px;
  margin: -1px auto 0;
  border: 1px solid #dce6df;
  border-top: 0;
  border-radius: 0 0 12px 12px;
  background: #fbfcfa;
}
.profile-editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-editor-head .el-input {
  min-width: 180px;
  flex: 1 1 auto;
}
.profile-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}
@media (max-width: 1220px) {
  .preview-toolbar-right {
    gap: 6px;
  }
  .preview-profile-card {
    width: 150px;
    flex-basis: 150px;
  }
  .image-inspector {
    grid-template-columns: minmax(205px, 1.25fr) repeat(3, minmax(0, 1fr));
    gap: 6px;
    padding-left: 12px;
    padding-right: 12px;
  }
  .profiles-page {
    padding-left: 24px;
    padding-right: 24px;
  }
}

/* 0.1.4 usability, history status and configuration transfer */
.topbar-actions .el-button > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.topbar {
  grid-template-columns: 190px auto minmax(0, 1fr);
  gap: 14px;
  padding-right: 18px;
  padding-left: 18px;
}
.topbar-actions {
  min-width: 0;
}
.save-state {
  min-width: 112px;
  width: auto;
  flex: 0 0 auto;
  overflow: visible;
  margin-right: 0;
  font-size: 12px;
}
.save-state svg {
  width: 14px;
  flex: 0 0 14px;
}
.preview-toolbar {
  padding: 0 18px;
  flex-wrap: wrap;
  height: auto;
  padding-top: 8px;
  padding-bottom: 8px;
}
.reimbursement-active .preview-toolbar {
  flex: 0 0 auto;
}
.preview-toolbar-right {
  flex: 1 1 690px;
  flex-wrap: wrap;
  gap: 8px;
}
.preview-context-selects {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview-context-selects label {
  display: grid;
  grid-template-columns: auto 122px;
  align-items: center;
  gap: 5px;
  color: #677870;
  font-size: 11px;
  white-space: nowrap;
}
.preview-context-selects .el-select {
  width: 122px;
}
.preview-context-selects .el-input {
  width: 320px;
}
.preview-context-selects .preview-label-input {
  grid-template-columns: auto 320px;
}
.preview-zoom-tools {
  width: 100px;
  display: grid;
  grid-template-columns: 28px 44px 28px;
  align-items: center;
}
.preview-zoom-tools .el-button {
  width: 28px;
  height: 28px;
  margin: 0 !important;
}
.preview-zoom-tools span {
  color: #53675e;
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.preview-pages {
  width: 794px;
  display: flex;
  flex-direction: column;
  gap: 28px;
  transform: scale(var(--paper-scale));
  transform-origin: top left;
}
.reimbursement-active .paper {
  transform: none;
}
.paper-meta {
  border-bottom: 0;
}
.paper-table th,
.paper-table td,
.paper-title,
.paper-meta,
.paper-payment,
.paper-approval,
.paper-total-block {
  border-color: #4c4f4f;
  border-width: 1px;
}
.amount-button,
.amount-input {
  text-align: center;
}
.paper-total-block {
  min-height: 62px;
  display: grid;
  grid-template-columns: 21% 79%;
  grid-template-rows: 31px 31px;
  border-right-style: solid;
  border-bottom-style: solid;
  border-left-style: solid;
}
.paper-total-block .total-label {
  grid-row: 1 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #4c4f4f;
  font-weight: 700;
}
.paper-total-block .total-value,
.paper-total-block .uppercase-value {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 10px;
  text-align: left;
}
.paper-total-block .total-value {
  border-bottom: 1px solid #4c4f4f;
}
.paper-total-block .total-number {
  text-align: left;
}
.paper-approval {
  min-height: 48px;
  align-items: center;
  padding: 0 13px;
}
.attachment-paper {
  padding: 30px 35px 27px;
}
.attachment-area {
  min-height: 0;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
}
.attachment-object {
  background: transparent;
}
.settings-page {
  min-height: auto !important;
  padding-bottom: 12px;
}
.settings-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: auto;
  align-items: start;
}
.settings-grid .drawer-section:nth-child(1) {
  grid-column: 1 / -1;
  grid-row: 3;
}
.settings-grid .drawer-section:nth-child(2) {
  grid-column: 1 / -1;
  grid-row: 2;
}
.settings-grid .drawer-section:nth-child(3) {
  grid-column: 1;
  grid-row: 1;
}
.settings-grid .drawer-section:nth-child(4) {
  grid-column: 2;
  grid-row: 1;
}
.settings-grid .drawer-section:nth-child(5) {
  grid-column: 1 / -1;
  grid-row: 4;
}
.settings-grid .drawer-section:nth-child(1) .el-form-item {
  margin-bottom: 0;
}
.dictionary-group + .dictionary-group {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #e7ece9;
}
.configuration-transfer-help {
  padding: 9px 10px;
  border-left: 3px solid #91aa9e;
  background: #f4f8f5;
}
.settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-actions .el-button {
  margin: 0;
}
.dictionary-group h4 {
  margin: 0 0 9px;
  color: #53665d;
  font-size: 12px;
}
.dictionary-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.dictionary-option {
  min-width: 0;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 4px 3px 10px;
  border: 1px solid #e1e8e3;
  border-radius: 7px;
  background: #fbfcfa;
}
.dictionary-drag-handle {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  color: #9eaaa4;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.dictionary-drag-handle:active {
  cursor: grabbing;
}
.dictionary-option.default {
  border-color: #9bc7b3;
  background: #f4faf7;
}
.dictionary-option.dragging {
  opacity: 0.72;
  border-color: #cf674d;
  box-shadow: 0 8px 18px rgba(42, 61, 53, 0.12);
}
.dictionary-option.drop-before {
  box-shadow: inset 3px 0 0 #cf674d;
}
.dictionary-option.drop-after {
  box-shadow: inset -3px 0 0 #cf674d;
}
.dictionary-option .el-radio {
  min-width: 0;
  flex: 1;
  margin-right: 0;
}
.dictionary-option .el-radio__label {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.profiles-page {
  padding-top: 0;
  margin-top: 0;
}
.history-toolbar .el-date-editor {
  width: 210px;
  flex: 0 0 210px;
}
.history-toolbar .el-select {
  width: 140px;
  flex: 0 0 140px;
}
.history-item-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-item-title > span:not(.el-tag) {
  color: #788880;
  font-size: 11px;
}
.history-pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
.paper-table tbody tr {
  height: 42px;
}
.paper-table tbody td,
.description-cell {
  height: auto;
}
.description-button,
.arranger-button {
  display: block;
  width: 100%;
  overflow: visible;
  line-height: 1.3;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  -webkit-line-clamp: unset;
  -webkit-box-orient: initial;
}
.description-input {
  min-height: 34px;
  overflow: hidden;
}
.expense-extra-section {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid #e4eae6;
}
.expense-extra-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.expense-extra-heading > span {
  color: #53675e;
  font-size: 12px;
  font-weight: 700;
}
.expense-extra-heading small {
  margin-left: 5px;
  color: #8b9991;
  font-size: 10px;
  font-weight: 400;
}
.expense-extra-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
  margin-top: 8px;
}
.expense-extra-item {
  min-width: 0;
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid #d8e1dc;
  border-radius: 6px;
  background: #eef2ef;
}
.expense-extra-item .el-image {
  width: 100%;
  height: 100%;
  display: block;
}
.expense-extra-actions {
  position: absolute;
  right: 2px;
  bottom: 2px;
  left: 2px;
  display: flex;
  justify-content: center;
  padding: 2px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.9);
}
.expense-extra-actions .el-button {
  width: 22px;
  height: 22px;
  margin: 0 !important;
}
.extra-upload-panel {
  margin: 0;
}
.upload-dropzone:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.extra-dialog-list {
  max-height: 300px;
  display: grid;
  gap: 7px;
  margin-top: 14px;
  overflow: auto;
}
.extra-dialog-item {
  min-width: 0;
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 7px;
  border: 1px solid #dce4df;
  border-radius: 7px;
}
.extra-dialog-item .el-image {
  width: 52px;
  height: 52px;
  border-radius: 5px;
}
.extra-dialog-item > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.extra-dialog-item > div {
  display: flex;
}
.extra-dialog-item .el-button {
  margin: 0 !important;
}
.service-switch {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 7px 10px;
  border: 1px solid #d8e1dc;
  border-radius: 6px;
  background: #fbfcfb;
}
.service-switch span,
.service-switch strong,
.service-switch small {
  display: block;
}
.service-switch strong {
  color: #465c52;
  font-size: 12px;
}
.service-switch small {
  margin-top: 2px;
  color: #8a9991;
  font-size: 10px;
}
.requests-page {
  padding-left: max(42px, calc((100% - 1100px) / 2));
  padding-right: max(42px, calc((100% - 1100px) / 2));
}
.request-page-actions,
.request-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.request-toolbar {
  padding: 14px;
  border: 1px solid #dce4df;
  border-radius: 8px;
  background: #fff;
}
.request-toolbar .el-input {
  flex: 1;
}
.request-toolbar .el-select {
  width: 150px;
  flex: 0 0 150px;
}
.request-list {
  display: grid;
  gap: 9px;
  margin-top: 14px;
}
.request-item {
  min-width: 0;
  display: grid;
  grid-template-columns: 126px minmax(0, 1fr) 170px 34px;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #dce4df;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.request-item:hover {
  border-color: #d39a89;
  box-shadow: 0 6px 14px rgba(81, 66, 60, 0.08);
}
.request-item-status {
  display: flex;
  gap: 6px;
}
.request-item-main,
.request-item-main strong,
.request-item-main span,
.request-item-main small {
  min-width: 0;
  display: block;
}
.request-item-main span,
.request-item-main small {
  margin-top: 3px;
  overflow: hidden;
  color: #7a8981;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.request-item-main span {
  font-size: 11px;
}
.request-item-main small {
  font-size: 10px;
}
.request-item-meta {
  display: grid;
  gap: 3px;
  color: #708078;
  text-align: right;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.request-detail {
  min-height: 180px;
}
.request-detail h4 {
  margin: 16px 0 7px;
}
.request-detail pre {
  max-height: 280px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid #dce4df;
  border-radius: 6px;
  color: #32453c;
  background: #f7f9f7;
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.request-detail-url {
  overflow-wrap: anywhere;
}
@media (max-width: 1080px) {
  .requests-page {
    padding-right: 24px;
    padding-left: 24px;
  }
  .request-item {
    grid-template-columns: 116px minmax(0, 1fr) 34px;
  }
  .request-item-meta {
    display: none;
  }
}
.exporting-document .attachment-object,
.exporting-document .attachment-object.selected,
.exporting-document .attachment-object:hover {
  border-color: transparent !important;
  box-shadow: none !important;
}
.exporting-document .attachment-label,
.exporting-document .resize-handle,
.exporting-document .paper-row-drag-handle {
  display: none !important;
}
.exporting-document .paper-table tr.selected-row td {
  background: #fff !important;
}
.exporting-document .paper-table td.paper-cell-selected {
  background: #fff !important;
  box-shadow: none !important;
}
.exporting-document .paper-empty-hint {
  display: none !important;
}
.storage-gate {
  position: fixed;
  z-index: 9999;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 28px;
  color: #26352f;
  background: #eef1ef;
}
.storage-gate-panel {
  width: min(620px, 100%);
  padding: 34px;
  border: 1px solid #d7e0db;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 18px 50px rgba(39, 56, 48, 0.13);
  text-align: center;
}
.storage-gate-panel > svg {
  margin-bottom: 12px;
  color: #c85f47;
}
.storage-gate-panel h1 {
  margin: 8px 0 10px;
  font-size: 24px;
}
.storage-gate-panel p {
  margin: 0 0 18px;
  color: #687a71;
  line-height: 1.7;
}
.storage-spinner {
  width: 34px;
  height: 34px;
  margin: 22px auto 0;
  border: 3px solid #dfe7e2;
  border-top-color: #4e7164;
  border-radius: 50%;
  animation: storage-spin 0.8s linear infinite;
}
@keyframes storage-spin {
  to {
    transform: rotate(360deg);
  }
}
.storage-gate-error {
  color: #a5433c !important;
  white-space: pre-line;
}
.storage-gate-path {
  padding: 9px 12px;
  border-radius: 6px;
  background: #f4f6f5;
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.storage-recovery-select {
  width: 100%;
  margin-bottom: 16px;
}
.storage-gate-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.storage-file-list {
  display: grid;
  gap: 6px;
  max-height: 180px;
  margin: 0 0 18px;
  padding: 10px;
  overflow: auto;
  border: 1px solid #eadbd6;
  border-radius: 6px;
  color: #8c4e42;
  background: #fff7f4;
  text-align: left;
  font-family: Consolas, "Courier New", monospace;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.settings-grid .backup-section {
  grid-column: 1 / -1;
}
.backup-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 12px 0;
}
.backup-summary > div {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #dce4df;
  border-radius: 6px;
  background: #f8faf8;
}
.backup-summary span,
.backup-summary strong {
  display: block;
}
.backup-summary span {
  margin-bottom: 4px;
  color: #7a8981;
  font-size: 10px;
}
.backup-summary strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.backup-list {
  display: grid;
  gap: 7px;
  max-height: 230px;
  margin-top: 14px;
  overflow: auto;
}
.backup-list > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #e2e8e4;
  border-radius: 6px;
}
.backup-list-main,
.backup-list-main strong,
.backup-list-main small {
  min-width: 0;
  display: block;
}
.backup-list-main small {
  margin-top: 2px;
  overflow: hidden;
  color: #809087;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.backup-list .el-tag {
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.legacy-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 9px 11px;
  color: #6f7e76;
  background: #f6f7f6;
  font-size: 11px;
}
.history-preview-image {
  position: relative;
  width: 126px;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 6px;
  background: #edf1ee;
}
.history-preview-image .el-image {
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: 100%;
  border: 1px solid #d7e1da;
  border-radius: 6px;
}
.history-preview-image-actions {
  position: absolute;
  z-index: 1;
  right: 4px;
  bottom: 4px;
  display: flex;
  padding: 2px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.9);
}
.history-preview-image .el-button {
  width: 26px;
  height: 26px;
  margin: 0;
  padding: 0;
}
@media print {
  .reimbursement-active .paper-scale,
  .reimbursement-active .paper-scale.double-page-scale {
    width: 794px !important;
    height: auto !important;
  }
  .preview-pages {
    gap: 0;
    transform: none !important;
  }
  .paper {
    break-after: page;
    page-break-after: always;
    box-shadow: none !important;
  }
  .paper:last-child {
    break-after: auto;
    page-break-after: auto;
  }
  .attachment-object,
  .attachment-object.selected,
  .attachment-object:hover {
    border-color: transparent !important;
    box-shadow: none !important;
  }
  .attachment-label,
  .resize-handle,
  .paper-row-drag-handle {
    display: none !important;
  }
  .paper-table tr.selected-row td {
    background: #fff !important;
  }
  .paper-table td.paper-cell-selected {
    background: #fff !important;
    box-shadow: none !important;
  }
  .paper-empty-hint {
    display: none !important;
  }
}
</style>
