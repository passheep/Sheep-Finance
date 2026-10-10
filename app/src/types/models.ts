export type OcrMode = "advanced" | "handwriting";
export type OcrStatus =
  | "queued"
  | "recognizing"
  | "success"
  | "partial"
  | "error"
  | "manual";
export type AppTab = "reimbursement" | "history" | "requests" | "settings" | "about";
export type PreviewMode = "single" | "double";
export type HistoryViewMode = "company" | "status" | "list";
export type DictionaryType = "company" | "reason" | "arranger";
export type ReimbursementStatus = "未报销" | "报销中" | "已报销";
export type ExpenseEditableField =
  | "occurredDate"
  | "reason"
  | "description"
  | "arranger"
  | "amountCents";
export type HeaderEditableField =
  | "companyName"
  | "reimbursementDate"
  | "applicant"
  | "department"
  | "payeeName"
  | "account"
  | "bank";

export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  cropZoom: number;
  cropX: number;
  cropY: number;
}
export interface RecognizedFields {
  occurredDate?: string;
  reason?: string;
  description?: string;
  amountCents?: number;
  confidence?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}
export interface ExtraAttachment {
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
export interface Expense {
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
export interface PreviewAttachment extends ExtraAttachment {
  expenseId: string;
  isPrimary: boolean;
  label: string;
}
export interface Profile {
  id: string;
  name: string;
  applicant: string;
  department: string;
  payeeName: string;
  account: string;
  bank: string;
  isDefault: boolean;
}
export interface Draft {
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
  financeReviewer?: "财务" | "秘书处";
  showManagerApproval?: boolean;
  expenses: Expense[];
  updatedAt: string;
}
export interface HistoryRecord {
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
export interface HistoryFolder {
  key: string;
  label: string;
  count: number;
  deleted?: boolean;
}
export interface HistoryQueryResult {
  items: HistoryRecord[];
  total: number;
}
export interface CellSelection {
  recordId: string;
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}
export interface OcrProfile {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  timeoutSeconds: number;
  isDefault: boolean;
}
export interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  multimodal: boolean;
  isDefault: boolean;
}
export interface FormExpenseRow {
  expense: Expense;
  index: number;
  height: number;
}
export interface FormPage {
  rows: FormExpenseRow[];
  isFirst: boolean;
  isLast: boolean;
}
export interface RequestLogSummary {
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
export interface RequestLogRecord extends RequestLogSummary {
  requestContent: string;
  responseContent?: string;
}
export interface RecognitionResponse {
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
export interface LoadedWorkspace {
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
export interface StorageBootstrapResult {
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
export interface MigrationProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}
export interface StoredAttachment {
  blobHash: string;
  mimeType: string;
  blobExtension: string;
  sizeBytes: number;
  recognitionBlobHash?: string;
  recognitionMimeType?: string;
  recognitionBlobExtension?: string;
  recognitionSizeBytes?: number;
}
export interface AttachmentBytes {
  bytes: number[];
  mimeType: string;
  extension: string;
}
export interface DatabaseBackupItem {
  fileName: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  valid: boolean;
  imagesComplete: boolean;
  error?: string;
}
export interface LegacyArchiveItem {
  directoryName: string;
  path: string;
  sizeBytes: number;
}
export interface BackupStatus {
  lastBackupAt?: string;
  validBackupCount: number;
  backupDue: boolean;
  backups: DatabaseBackupItem[];
  legacyArchives: LegacyArchiveItem[];
  dataDirectory: string;
}
export interface ConfigurationTransferPayload {
  format: "sheepfinance-configuration";
  version: 1;
  exportedAt: string;
  profiles: Profile[];
  dictionaries: LoadedWorkspace["dictionaries"];
  services: { ocrProfiles: OcrProfile[]; llmProfiles: LlmProfile[] };
}
export interface EncryptedConfigurationEnvelope {
  format: "sheepfinance-encrypted-configuration";
  version: 1;
  algorithm: "AES-256-GCM";
  keyDerivation: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}
export interface LanUploadSessionInfo {
  url: string;
  recordId: string;
  targetExpenseId?: string;
  label: string;
  expiresAt: number;
  remainingSlots: number;
  localAddress: string;
}
export interface LanUploadReceivedEvent {
  recordId: string;
  targetExpenseId?: string;
  remainingSlots: number;
  file: {
    fileName: string;
    mimeType: string;
    dataUrl: string;
  };
}
