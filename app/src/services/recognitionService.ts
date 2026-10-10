import { invoke } from "@tauri-apps/api/core";
import type { RecognitionResponse } from "../types/models";

export interface RecognizeExpenseRequest {
  recordId: string;
  expenseId: string;
  attachmentId: string;
  ocrMode: "advanced" | "handwriting";
  ocrProfileId: string;
  llmProfileId: string;
}

export function recognizeExpense(request: RecognizeExpenseRequest) {
  return invoke<RecognitionResponse>("recognize_expense", { request });
}
