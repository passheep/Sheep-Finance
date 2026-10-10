import { ref, type ComputedRef } from "vue";
import { ElMessage } from "element-plus";
import type {
  Draft,
  Expense,
  LlmProfile,
  OcrProfile,
  OcrStatus,
} from "../types/models";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";
import { recognizeExpense as recognizeExpenseService } from "../services/recognitionService";

export interface RecognitionContext {
  draft: Draft;
  defaultOcrProfile: ComputedRef<OcrProfile | undefined>;
  defaultLlmProfile: ComputedRef<LlmProfile | undefined>;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
  dirty: () => void;
  switchTab: (
    tab: "reimbursement" | "history" | "requests" | "settings" | "about",
  ) => void;
}

export function useRecognition(context: RecognitionContext) {
  const { draft, defaultOcrProfile, defaultLlmProfile } = context;
  const { dirty, switchTab, persistDraft } = context;
  const isOcrResultOpen = ref(false);
  const ocrResultExpense = ref<Expense | null>(null);
  const handwritingMode = ref(false);

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
      const result = await recognizeExpenseService({
        recordId: draft.id,
        expenseId: expense.id,
        attachmentId: expense.id,
        ocrMode: expense.ocrMode,
        ocrProfileId: ocrProfile.id,
        llmProfileId: llmProfile.id,
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

  return {
    isOcrResultOpen,
    ocrResultExpense,
    handwritingMode,
    ocrStatusLabel,
    recognitionConfigured,
    openOcrResult,
    applyRecognizedField,
    clearUnconfirmedExpenseFields,
    recognizeExpense,
  };
}
