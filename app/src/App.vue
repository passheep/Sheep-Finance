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
  Check,
  Clock,
  CopyDocument,
  Delete,
  Document,
  DocumentAdd,
  Download,
  EditPen,
  InfoFilled,
  Iphone,
  Picture,
  Plus,
  Printer,
  Refresh,
  Setting,
  Sort,
  Upload,
  WarningFilled,
  ZoomIn,
  ZoomOut,
} from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ExcelJS from "exceljs";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { save as tauriSave } from "@tauri-apps/plugin-dialog";
import { writeFile as tauriWriteFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as QRCode from "qrcode";

type OcrMode = "advanced" | "handwriting";
type OcrStatus =
  "queued" | "recognizing" | "success" | "partial" | "error" | "manual";
type AppTab = "reimbursement" | "history" | "settings" | "about";
type PreviewMode = "single" | "double";
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
interface Expense {
  id: string;
  fileName: string;
  imageDataUrl: string;
  recognitionImageDataUrl?: string;
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
  manualFields: Record<string, boolean>;
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
  updatedAt: string;
  draft?: Draft;
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
  isDefault: boolean;
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
  label: string;
  expiresAt: number;
  remainingSlots: number;
  localAddress: string;
}
interface LanUploadReceivedEvent {
  recordId: string;
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
const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const MAX_EXPENSES = 10;
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
    companyName: defaultCompany.value || companyNames.value[0] || "",
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
const uploadZone = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const configImportInput = ref<HTMLInputElement | null>(null);
const previewViewport = ref<HTMLElement | null>(null);
const editInput = ref<
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
>(null);
const isOcrResultOpen = ref(false);
const isLanUploadOpen = ref(false);
const isLanUploadLoading = ref(false);
const lanUploadSession = ref<LanUploadSessionInfo | null>(null);
const lanUploadQrCode = ref("");
const lanUploadError = ref("");
const lanUploadNow = ref(Date.now());
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
const dataDirectory = ref("");
const activeTab = ref<AppTab>("reimbursement");
const historySearch = ref("");
const historyDate = ref("");
const historyStatus = ref<ReimbursementStatus | "">("");
const historyPage = ref(1);
const historyPageSize = ref(8);
const newCompany = ref("");
const newReason = ref("");
const newArranger = ref("");
const saveTimer = ref<number | null>(null);
const lanReceivedCount = ref(0);
let autoSaveRevision = 0;
let lanUploadClockTimer: number | null = null;
let lanUploadNoticeTimer: number | null = null;
let lanUploadUnlisten: UnlistenFn | null = null;
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
} | null>(null);
const expenseDragState = ref<{
  id: string;
  surface: "list" | "paper";
} | null>(null);

const selectedExpense = computed(
  () => draft.expenses.find((item) => item.id === selectedId.value) ?? null,
);
const lanUploadLabel = computed(
  () => draft.label.trim() || draft.companyName.trim() || "未命名报销单",
);
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
      !historyDate.value || item.updatedAt.slice(0, 10) === historyDate.value;
    const matchesStatus =
      !historyStatus.value || item.status === historyStatus.value;
    return matchesKeyword && matchesDate && matchesStatus;
  });
});
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
  filteredHistory.value.slice(
    (historyPage.value - 1) * historyPageSize.value,
    historyPage.value * historyPageSize.value,
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

function money(cents: number) {
  return (cents / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function normalizeReimbursementStatus(value: unknown): ReimbursementStatus {
  return REIMBURSEMENT_STATUSES.includes(value as ReimbursementStatus)
    ? (value as ReimbursementStatus)
    : "未报销";
}
function reimbursementStatusType(status: ReimbursementStatus) {
  if (status === "已报销") return "success";
  if (status === "报销中") return "warning";
  return "info";
}
async function cycleHistoryStatus(item: HistoryRecord) {
  const index = REIMBURSEMENT_STATUSES.indexOf(item.status);
  item.status =
    REIMBURSEMENT_STATUSES[(index + 1) % REIMBURSEMENT_STATUSES.length];
  item.updatedAt = new Date().toISOString();
  if (item.id === draft.id) {
    draft.status = item.status;
    dirty();
    return;
  }
  await persistDraft(false);
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
  const value = Math.max(0, Math.round(cents));
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
  return text;
}
function fieldKey(expense: Expense, field: string) {
  return `expense:${expense.id}:${field}`;
}
function dirty() {
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
    const amount = Number(editValue.value);
    expense.amountCents = Number.isFinite(amount)
      ? Math.max(0, Math.round(amount * 100))
      : 0;
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
  const amount = Number(rawValue.trim().replace(/,/g, ""));
  expense.amountCents = Number.isFinite(amount)
    ? Math.max(0, Math.round(amount * 100))
    : 0;
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
async function recognizeExpense(expense: Expense, notify = true) {
  if (expense.ocrStatus === "recognizing") return;
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
    const result = await invoke<RecognitionResponse>("recognize_expense", {
      request: {
        imageDataUrl: expense.recognitionImageDataUrl ?? expense.imageDataUrl,
        ocrMode: expense.ocrMode,
        ocrProfile: {
          name: ocrProfile.name,
          endpoint: ocrProfile.endpoint,
          region: ocrProfile.region,
          accessKeyId: ocrProfile.accessKeyId,
          accessKeySecret: ocrProfile.accessKeySecret,
          timeoutSeconds: Number(ocrProfile.timeoutSeconds) || 30,
        },
        llmProfile: {
          name: llmProfile.name,
          baseUrl: llmProfile.baseUrl,
          apiKey: llmProfile.apiKey,
          model: llmProfile.model,
          timeoutSeconds: Number(llmProfile.timeoutSeconds) || 30,
        },
        reasonDictionary: expenseReasons.value,
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
    }
    current.recognitionError = result.llmError ?? "";
    current.ocrStatus = result.llmError ? "partial" : "success";
    dirty();
    if (notify)
      ElMessage.success(
        result.llmError
          ? "OCR 已完成，大模型提取失败，可查看原文后手工填写"
          : "识别完成，已填入未被人工修改的字段",
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
}
function reflowExpenses() {
  draft.expenses.forEach((item, index) => {
    const slot = transform(index, draft.expenses.length);
    item.transform = {
      ...item.transform,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
    };
  });
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
  if (draft.expenses.length >= MAX_EXPENSES) {
    if (notify) ElMessage.warning(`一张报销单最多上传${MAX_EXPENSES}张图片`);
    return false;
  }
  try {
    const image = await readImage(file);
    const recognitionImageDataUrl = await compressForRecognition(
      image.dataUrl,
      image.width,
      image.height,
    );
    if (draft.id !== targetRecordId) return false;
    if (draft.expenses.length >= MAX_EXPENSES) {
      if (notify) ElMessage.warning(`一张报销单最多上传${MAX_EXPENSES}张图片`);
      return false;
    }
    const expense: Expense = {
      id: id("expense"),
      fileName:
        file.name || "剪贴板图片-" + (draft.expenses.length + 1) + ".png",
      imageDataUrl: image.dataUrl,
      recognitionImageDataUrl,
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
      manualFields: {},
    };
    draft.expenses.push(expense);
    reflowExpenses();
    selectedId.value = expense.id;
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
    if (draft.expenses.length >= MAX_EXPENSES) {
      await synchronizeLanUploadSession();
      return;
    }
    if (lanUploadSession.value)
      lanUploadSession.value.remainingSlots = payload.remainingSlots;
    const added = await addFile(
      lanUploadFile(payload.file),
      false,
      payload.recordId,
    );
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
  if (draft.expenses.length >= MAX_EXPENSES) {
    lanUploadError.value = "当前报销单已达到 10 张图片上限";
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
          label: lanUploadLabel.value,
          remainingSlots: MAX_EXPENSES - draft.expenses.length,
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
async function openLanUpload() {
  if (!isTauriRuntime())
    return ElMessage.warning("手机上传仅支持在桌面应用中使用");
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
  session.remainingSlots = Math.max(0, MAX_EXPENSES - draft.expenses.length);
  await invoke("update_lan_upload_session", {
    request: {
      recordId: draft.id,
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
    draft.expenses.splice(index, 1);
    reflowExpenses();
    selectedId.value = draft.expenses[Math.max(0, index - 1)]?.id ?? null;
    dirty();
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
function updateScale() {
  const viewport = previewViewport.value;
  if (!viewport) return;
  paperScale.value = Math.min(
    1,
    Math.max(0.56, (viewport.clientWidth - 52) / PAGE_WIDTH),
  );
}
function pointerStart(
  event: PointerEvent,
  expense: Expense,
  type: "move" | "resize",
) {
  event.preventDefault();
  event.stopPropagation();
  selectedId.value = expense.id;
  const t = expense.transform;
  pointerState.value = {
    type,
    id: expense.id,
    startX: event.clientX,
    startY: event.clientY,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
  };
}
function pointerMove(event: PointerEvent) {
  const state = pointerState.value;
  const expense = draft.expenses.find((item) => item.id === state?.id);
  const area = document.querySelector(
    ".attachment-area.active-attachment-area",
  ) as HTMLElement | null;
  if (!state || !expense || !area) return;
  const rect = area.getBoundingClientRect();
  const dx = ((event.clientX - state.startX) / rect.width) * 100;
  const dy = ((event.clientY - state.startY) / rect.height) * 100;
  if (state.type === "move") {
    expense.transform.x = Math.min(
      100 - expense.transform.width,
      Math.max(0, state.x + dx),
    );
    expense.transform.y = Math.min(
      100 - expense.transform.height,
      Math.max(0, state.y + dy),
    );
  } else {
    expense.transform.width = Math.min(
      100 - expense.transform.x,
      Math.max(12, state.width + dx),
    );
    expense.transform.height = Math.min(
      100 - expense.transform.y,
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
  const index = Array.from(
    document.querySelectorAll(".attachment-object"),
  ).indexOf(target);
  const expense = draft.expenses[index];
  const delta = event.deltaY || event.deltaX;
  if (!expense || !delta) return;
  event.preventDefault();
  event.stopPropagation();
  selectedId.value = expense.id;
  const change =
    Math.sign(delta) * Math.max(1, Math.min(5, Math.abs(delta) / 20));
  if (event.shiftKey)
    expense.transform.cropX = Math.min(
      100,
      Math.max(0, expense.transform.cropX + change),
    );
  else
    expense.transform.cropY = Math.min(
      100,
      Math.max(0, expense.transform.cropY + change),
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
  if (selectedExpense.value) {
    selectedExpense.value.transform.rotation =
      (selectedExpense.value.transform.rotation + 90) % 360;
    dirty();
  }
}
function resetImage() {
  if (selectedExpense.value) {
    const index = draft.expenses.findIndex(
      (item) => item.id === selectedExpense.value?.id,
    );
    selectedExpense.value.transform = transform(index, draft.expenses.length);
    dirty();
  }
}
function printCurrentPage() {
  window.print();
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
    updatedAt: value.updatedAt ?? new Date().toISOString(),
    draft: value.draft,
  };
}
async function persistDraft(showMessage = false) {
  if (isLoadingWorkspace.value) return;
  const revision = autoSaveRevision;
  saveText.value = showMessage ? "正在保存" : "正在自动保存";
  const snapshot = cloneDraft();
  const nextHistory = [
    historyItem(snapshot),
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
          history: nextHistory.map(({ draft: _draft, ...summary }) => summary),
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
    }
    isSaved.value = revision === autoSaveRevision;
    saveText.value = isSaved.value
      ? `已保存 ${formatSaveTime(new Date())}`
      : "尚未保存";
    if (showMessage) ElMessage.success("草稿已保存到本机");
  } catch (error) {
    isSaved.value = false;
    saveText.value = "自动保存失败";
    if (showMessage) ElMessage.error(errorMessage(error));
  }
}
function saveDraft() {
  commitActiveEdit();
  void persistDraft(true);
}
function applyDraft(value: Draft) {
  Object.assign(draft, value, {
    label: value.label ?? "",
    status: normalizeReimbursementStatus(value.status),
    reimbursementDate: "",
    previewMode: value.previewMode === "double" ? "double" : "single",
  });
  const expenses = (value.expenses ?? []).slice(0, MAX_EXPENSES);
  draft.expenses = expenses.map((item, index) =>
    normalizeExpense(item, index, expenses.length),
  );
  selectedId.value = draft.expenses[0]?.id ?? null;
}
function applyWorkspace(value: LoadedWorkspace) {
  if (value.draft?.id) applyDraft(value.draft);
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
  let migrateBrowserData = false;
  try {
    if (isTauriRuntime()) {
      const workspace = await invoke<LoadedWorkspace | null>("load_workspace");
      if (workspace) applyWorkspace(workspace);
      else migrateBrowserData = loadBrowserWorkspace();
    } else loadBrowserWorkspace();
    isSaved.value = true;
    saveText.value = `已保存 ${formatSaveTime(draft.updatedAt)}`;
  } catch (error) {
    ElMessage.warning(
      `本地草稿读取失败，已创建空白报销单：${errorMessage(error)}`,
    );
  } finally {
    isLoadingWorkspace.value = false;
  }
  if (migrateBrowserData) await persistDraft(false);
}
async function restoreHistory(item: HistoryRecord) {
  try {
    const restored = item.draft
      ? cloneDraft(item.draft)
      : await invoke<Draft>("load_record", { recordId: item.id });
    restored.label = item.label;
    restored.status = item.status;
    restored.updatedAt = item.updatedAt;
    applyDraft(restored);
    switchTab("reimbursement");
    isSaved.value = true;
    saveText.value = `已保存 ${formatSaveTime(restored.updatedAt)}`;
    ElMessage.success("已恢复历史报销单");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}
async function removeHistory(item: HistoryRecord) {
  if (item.id === draft.id)
    return ElMessage.warning(
      "当前打开的报销单不能删除，请先新建或恢复其他记录",
    );
  try {
    await ElMessageBox.confirm(
      "将删除这条本地报销记录，不影响已经导出的文件。",
      "删除历史记录",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
    if (isTauriRuntime()) await invoke("delete_record", { recordId: item.id });
    historyRecords.value = historyRecords.value.filter(
      (entry) => entry.id !== item.id,
    );
    await persistDraft(false);
    ElMessage.success("历史记录已删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close")
      ElMessage.error(errorMessage(error));
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
  nextTick(() => {
    if (tab === "reimbursement") updateScale();
  });
}
function newRecord() {
  commitActiveEdit();
  switchTab("reimbursement");
  if (!isSaved.value || draft.expenses.length) void persistDraft(false);
  Object.assign(draft, createDraft());
  selectedId.value = null;
  dirty();
  ElMessage.success("已创建新的空白报销单");
}
function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
    manualFields: value.manualFields ?? {},
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
async function openExternalUrl(url: string) {
  try {
    if (isTauriRuntime()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    ElMessage.error(`链接打开失败：${errorMessage(error)}`);
  }
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
async function captureAttachmentForExport() {
  const source = document.querySelector<HTMLElement>(
    ".attachment-area.active-attachment-area",
  );
  if (!source) throw new Error("附件预览尚未准备完成，请稍后重试");
  const width = Math.round(source.clientWidth);
  const height = Math.round(source.clientHeight);
  if (width <= 0 || height <= 0)
    throw new Error("附件预览尺寸异常，请稍后重试");
  const canvas = await captureElementForExport(source, width, height);
  return { dataUrl: canvas.toDataURL("image/png"), width, height };
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
async function exportExcel() {
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

    const attachment = await captureAttachmentForExport();
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
    draft.expenses.forEach((_expense, index) => {
      sheet.getRow(expenseStartRow + index).height = 31.5;
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
          shrinkToFit: column !== 4,
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

    const attachmentStartRow = approvalRow + 1;
    const attachmentHeightPoints = attachment.height * 0.75;
    const attachmentRowCount = Math.max(
      1,
      Math.ceil(attachmentHeightPoints / 300),
    );
    const attachmentEndRow = attachmentStartRow + attachmentRowCount - 1;
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

    if (draft.previewMode === "double")
      sheet.getRow(approvalRow).addPageBreak();
    sheet.pageSetup.orientation = "portrait";
    sheet.pageSetup.paperSize = 9;
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    sheet.pageSetup.fitToHeight = draft.previewMode === "double" ? 2 : 1;
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
    void persistDraft(false);
    ElMessage.success(path ? "Excel 已导出到：" + path : "Excel 已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Excel 导出失败");
  } finally {
    if (activeTab.value !== previousTab) activeTab.value = previousTab;
  }
}
async function exportPdf() {
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
    const expectedPages = draft.previewMode === "double" ? 2 : 1;
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
    void persistDraft(false);
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
  if (isLoadingWorkspace.value) return;
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
watch([historySearch, historyDate, historyStatus], () => {
  historyPage.value = 1;
});
watch([() => draft.label, () => draft.expenses.length], () => {
  void synchronizeLanUploadSession();
});
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
  },
);
function preventContextMenu(event: MouseEvent) {
  event.preventDefault();
}
onMounted(() => {
  void loadDraft();
  lanUploadClockTimer = window.setInterval(() => {
    lanUploadNow.value = Date.now();
  }, 1000);
  updateScale();
  window.addEventListener("resize", updateScale);
  window.addEventListener("pointerdown", expenseDragStart);
  window.addEventListener("pointermove", pointerMove);
  window.addEventListener("pointermove", expenseDragMove);
  window.addEventListener("pointerup", pointerStop);
  window.addEventListener("pointerup", expenseDragStop);
  window.addEventListener("wheel", adjustImageByWheel, { passive: false });
  window.addEventListener("wheel", adjustPreviewZoom, { passive: false });
  window.addEventListener("contextmenu", preventContextMenu);
});
onUnmounted(() => {
  if (saveTimer.value !== null) window.clearTimeout(saveTimer.value);
  if (lanUploadClockTimer !== null) window.clearInterval(lanUploadClockTimer);
  if (lanUploadNoticeTimer !== null) window.clearTimeout(lanUploadNoticeTimer);
  lanUploadUnlisten?.();
  lanUploadUnlisten = null;
  lanUploadListenerReady = null;
  void stopLanUploadSession();
  window.removeEventListener("resize", updateScale);
  window.removeEventListener("pointerdown", expenseDragStart);
  window.removeEventListener("pointermove", pointerMove);
  window.removeEventListener("pointermove", expenseDragMove);
  window.removeEventListener("pointerup", pointerStop);
  window.removeEventListener("pointerup", expenseDragStop);
  window.removeEventListener("wheel", adjustImageByWheel);
  window.removeEventListener("wheel", adjustPreviewZoom);
  window.removeEventListener("contextmenu", preventContextMenu);
});
</script>

<template>
  <div
    class="app-shell"
    :class="{ 'reimbursement-active': activeTab === 'reimbursement' }"
    @contextmenu.prevent
  >
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
    <main v-if="activeTab === 'reimbursement'" class="workspace">
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
                :disabled="draft.expenses.length >= MAX_EXPENSES"
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
                  :model-value="amountInputValue(expense)"
                  inputmode="decimal"
                  placeholder="金额"
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
                  class="expense-description-input"
                  placeholder="内容说明"
                  @change="
                    expense.manualFields.description = true;
                    expense.ocrStatus = 'manual';
                    dirty();
                  "
                />
              </div>
            </article>
          </div>
        </section>
      </aside>
      <section ref="previewViewport" class="preview-panel">
        <div class="preview-toolbar">
          <div>
            <span class="eyebrow">STEP 03</span>
            <h1>
              {{ draft.previewMode === "double" ? "两页" : "一页" }} A4 预览
            </h1>
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
                { label: '一页', value: 'single' },
                { label: '两页', value: 'double' },
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
              :disabled="!selectedExpense"
              @click="resetImage"
            />
          </div>
        </div>
        <div class="paper-stage" :style="paperSize">
          <div
            class="paper-scale"
            :class="{ 'double-page-scale': draft.previewMode === 'double' }"
          >
            <div
              class="preview-pages"
              :class="{ 'double-page': draft.previewMode === 'double' }"
            >
              <div class="paper form-paper" data-export-page="form">
                <div class="paper-title">
                  <div class="paper-title-text">
                    {{ draft.companyName }}费用报销单
                  </div>
                </div>
                <div class="paper-meta">
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
                      <template v-if="draft.expenses.length"
                        ><tr
                          v-for="(expense, index) in draft.expenses"
                          :key="expense.id"
                          :data-expense-id="expense.id"
                          :class="{
                            'selected-row': expense.id === selectedId,
                            'dragging-row':
                              expenseDragState?.surface === 'paper' &&
                              expenseDragState.id === expense.id,
                          }"
                          @click="selectExpense(expense)"
                        >
                          <td>
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
                          <td>
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
                              class="paper-editable"
                              type="button"
                              @click.stop="
                                beginEdit(
                                  fieldKey(expense, 'occurredDate'),
                                  expense.occurredDate,
                                )
                              "
                            >
                              {{ expense.occurredDate }}
                            </button>
                          </td>
                          <td>
                            <template
                              v-if="editingKey === fieldKey(expense, 'reason')"
                              ><select
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input"
                                @blur="commitExpense(expense, 'reason')"
                              >
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
                              class="paper-editable"
                              type="button"
                              @click.stop="
                                beginEdit(
                                  fieldKey(expense, 'reason'),
                                  expense.reason,
                                )
                              "
                            >
                              {{ expense.reason }}
                            </button>
                          </td>
                          <td class="description-cell">
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'description')
                              "
                            >
                              <textarea
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input description-input"
                                rows="2"
                                @blur="commitExpense(expense, 'description')"
                              /></template
                            ><button
                              v-else
                              class="paper-editable description-button"
                              type="button"
                              @click.stop="
                                beginEdit(
                                  fieldKey(expense, 'description'),
                                  expense.description,
                                )
                              "
                            >
                              {{ expense.description || "xxxx" }}
                            </button>
                          </td>
                          <td>
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
                              class="paper-editable"
                              type="button"
                              @click.stop="
                                beginEdit(
                                  fieldKey(expense, 'arranger'),
                                  expense.arranger,
                                )
                              "
                            >
                              {{ expense.arranger }}
                            </button>
                          </td>
                          <td>
                            <template
                              v-if="
                                editingKey === fieldKey(expense, 'amountCents')
                              "
                              ><input
                                ref="editInput"
                                v-model="editValue"
                                class="paper-cell-input amount-input"
                                type="number"
                                min="0"
                                step="0.01"
                                @blur="commitExpense(expense, 'amountCents')"
                                @keydown.enter.prevent="
                                  commitExpense(expense, 'amountCents')
                                " /></template
                            ><button
                              v-else
                              class="paper-editable amount-button"
                              type="button"
                              @click.stop="
                                beginEdit(
                                  fieldKey(expense, 'amountCents'),
                                  (expense.amountCents / 100).toFixed(2),
                                )
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
                      type="number"
                      min="0"
                      step="0.01"
                      @change="
                        (event) => {
                          const amount = Number(
                            (event.target as HTMLInputElement).value,
                          );
                          draft.totalOverrideCents = Number.isFinite(amount)
                            ? Math.max(0, Math.round(amount * 100))
                            : 0;
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
                <div
                  v-if="draft.previewMode === 'single'"
                  class="attachment-area active-attachment-area"
                >
                  <div v-if="!draft.expenses.length" class="attachment-empty">
                    图片会按费用顺序排列在这里
                  </div>
                  <div
                    v-for="expense in draft.expenses"
                    :key="expense.id"
                    class="attachment-object"
                    :class="{ selected: expense.id === selectedId }"
                    :style="{
                      left: `${expense.transform.x}%`,
                      top: `${expense.transform.y}%`,
                      width: `${expense.transform.width}%`,
                      height: `${expense.transform.height}%`,
                      transform: `rotate(${expense.transform.rotation}deg)`,
                    }"
                    @pointerdown="pointerStart($event, expense, 'move')"
                    @click.stop="selectExpense(expense)"
                  >
                    <img
                      :src="expense.imageDataUrl"
                      :alt="expense.fileName"
                      :style="{
                        transform: `scale(${expense.transform.cropZoom})`,
                        objectPosition: `${expense.transform.cropX}% ${expense.transform.cropY}%`,
                      }"
                    /><span class="attachment-label">{{
                      draft.expenses.indexOf(expense) + 1
                    }}</span
                    ><span
                      v-if="expense.id === selectedId"
                      class="resize-handle"
                      @pointerdown="pointerStart($event, expense, 'resize')"
                    />
                  </div>
                </div>
              </div>
              <div
                v-if="draft.previewMode === 'double'"
                class="paper attachment-paper"
                data-export-page="attachments"
              >
                <div class="attachment-area active-attachment-area">
                  <div v-if="!draft.expenses.length" class="attachment-empty">
                    图片会按费用顺序排列在这里
                  </div>
                  <div
                    v-for="expense in draft.expenses"
                    :key="expense.id"
                    class="attachment-object"
                    :class="{ selected: expense.id === selectedId }"
                    :style="{
                      left: `${expense.transform.x}%`,
                      top: `${expense.transform.y}%`,
                      width: `${expense.transform.width}%`,
                      height: `${expense.transform.height}%`,
                      transform: `rotate(${expense.transform.rotation}deg)`,
                    }"
                    @pointerdown="pointerStart($event, expense, 'move')"
                    @click.stop="selectExpense(expense)"
                  >
                    <img
                      :src="expense.imageDataUrl"
                      :alt="expense.fileName"
                      :style="{
                        transform: `scale(${expense.transform.cropZoom})`,
                        objectPosition: `${expense.transform.cropX}% ${expense.transform.cropY}%`,
                      }"
                    />
                    <span class="attachment-label">{{
                      draft.expenses.indexOf(expense) + 1
                    }}</span>
                    <span
                      v-if="expense.id === selectedId"
                      class="resize-handle"
                      @pointerdown="pointerStart($event, expense, 'resize')"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="selectedExpense" class="image-inspector">
          <div class="inspector-title">
            <div>
              <span class="eyebrow">SELECTED IMAGE</span
              ><strong>{{ selectedExpense.fileName }}</strong>
            </div>
            <div class="inspector-actions">
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
                title="删除这笔费用"
                @click="removeExpense(selectedExpense)"
              />
            </div>
          </div>
          <label
            >裁剪缩放<input
              v-model.number="selectedExpense.transform.cropZoom"
              type="range"
              min="1"
              max="2.4"
              step="0.05"
              @input="dirty"
            /><output
              >{{ selectedExpense.transform.cropZoom.toFixed(2) }}x</output
            ></label
          ><label
            >横向取景<input
              v-model.number="selectedExpense.transform.cropX"
              type="range"
              min="0"
              max="100"
              step="1"
              @input="dirty"
            /><output>{{ selectedExpense.transform.cropX }}%</output></label
          ><label
            >纵向取景<input
              v-model.number="selectedExpense.transform.cropY"
              type="range"
              min="0"
              max="100"
              step="1"
              @input="dirty"
            /><output>{{ selectedExpense.transform.cropY }}%</output></label
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
          :disabled="draft.expenses.length >= MAX_EXPENSES"
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
            选中的默认值会自动带入新建报销单或新上传的费用。
          </p>
          <p class="drawer-help configuration-transfer-help">
            导出的 TXT 会进行轻量加密，可在另一台 SheepFinance
            电脑上一键导入；请仍将其作为含密钥文件妥善保管。
          </p>
          <div class="dictionary-group">
            <h4>公司名称字典</h4>
            <div class="dictionary-options">
              <div
                v-for="company in companyNames"
                :key="company"
                class="dictionary-option"
                :class="{ default: company === defaultCompany }"
              >
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
            <div class="dictionary-options">
              <div
                v-for="reason in expenseReasons"
                :key="reason"
                class="dictionary-option"
                :class="{ default: reason === defaultReason }"
              >
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
            <div class="dictionary-options">
              <div
                v-for="arranger in arrangers"
                :key="arranger"
                class="dictionary-option"
                :class="{ default: arranger === defaultArranger }"
              >
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
          placeholder="按编辑日期筛选"
        />
        <el-select v-model="historyStatus" clearable placeholder="全部状态">
          <el-option
            v-for="status in REIMBURSEMENT_STATUSES"
            :key="status"
            :label="status"
            :value="status"
          />
        </el-select>
        <span>{{ filteredHistory.length }} 条</span>
      </div>
      <div v-if="!filteredHistory.length" class="history-empty">
        <Clock :size="25" /><strong>还没有已保存的历史记录</strong
        ><span>点击“保存草稿”后，记录会保存在本机。</span>
      </div>
      <div v-else class="history-list">
        <article
          v-for="item in pagedHistory"
          :key="item.id"
          class="history-item"
          @click="restoreHistory(item)"
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
              type="danger"
              :icon="Delete"
              title="删除历史记录"
              @click.stop="removeHistory(item)"
            />
          </div>
        </article>
      </div>
      <div v-if="filteredHistory.length" class="history-pagination">
        <el-pagination
          v-model:current-page="historyPage"
          v-model:page-size="historyPageSize"
          background
          layout="total, prev, pager, next"
          :total="filteredHistory.length"
        />
      </div>
    </section>
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
          <span>版本 0.1.6</span><span>Windows 10 x64</span>
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
  grid-template-columns: 404px minmax(0, 1fr);
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
}
.paper-editable:hover {
  color: #b9533e;
  background: #fff0ea;
  outline: 1px dashed #d99a89;
}
.description-button {
  display: -webkit-box;
  width: 100%;
  overflow: hidden;
  text-align: left;
  line-height: 1.3;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
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
  object-fit: contain;
  transition: transform 0.12s;
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
  height: var(--scaled-paper-height);
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
.expense-mini-fields > :nth-child(5) {
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
.reimbursement-active .paper-scale.double-page-scale {
  height: calc(var(--scaled-paper-height) * 2 + 28px * var(--paper-scale));
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
  grid-column: 1 / -1;
  grid-row: 3;
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
.dictionary-option.default {
  border-color: #9bc7b3;
  background: #f4faf7;
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
}
</style>
