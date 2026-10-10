import type { ReimbursementStatus } from "../types/models";

export const STORAGE_KEY = "sheepfinance:workbench:v1";
export const PROFILE_KEY = "sheepfinance:profiles:v1";
export const DICTIONARY_KEY = "sheepfinance:dictionaries:v1";
export const HISTORY_KEY = "sheepfinance:history:v1";
export const SERVICE_KEY = "sheepfinance:services:v1";
export const UI_PREFERENCES_KEY = "sheepfinance:ui-preferences:v1";

export const PAGE_WIDTH = 794;
export const PAGE_HEIGHT = 1123;
export const MAX_EXPENSES = 10;
export const ATTACHMENTS_PER_PAGE = 6;
export const MAX_TOTAL_ATTACHMENTS = 30;
export const MAX_ATTACHMENTS_PER_EXPENSE = 10;
export const FIRST_FORM_ROW_BUDGET = 785;
export const CONTINUATION_FORM_ROW_BUDGET = 816;
export const MIN_SHARED_ATTACHMENT_HEIGHT = 126;
export const DEFAULT_LLM_MODEL = "deepseek-v4-flash";
export const REIMBURSEMENT_STATUSES: ReimbursementStatus[] = [
  "未报销",
  "报销中",
  "已报销",
];
export const CONFIG_TRANSFER_ITERATIONS = 180_000;
export const CONFIG_TRANSFER_SECRET =
  "SheepFinance::local-configuration-transfer::v1";
