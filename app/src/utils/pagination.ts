import {
  ATTACHMENTS_PER_PAGE,
  CONTINUATION_FORM_ROW_BUDGET,
  FIRST_FORM_ROW_BUDGET,
  MIN_SHARED_ATTACHMENT_HEIGHT,
  PAGE_HEIGHT,
} from "../constants/app";
import type {
  Draft,
  Expense,
  FormExpenseRow,
  FormPage,
  PreviewAttachment,
} from "../types/models";
import { wrappedLineCount } from "./format";

export function expenseRowHeight(expense: Expense) {
  const lines = Math.max(
    2,
    wrappedLineCount(expense.description || "", 18),
    wrappedLineCount(expense.arranger || "", 8),
  );
  return Math.max(42, Math.ceil(10 + lines * 15.6));
}

export function buildPreviewAttachments(expenses: Expense[]) {
  return expenses.flatMap<PreviewAttachment>((expense, expenseIndex) => [
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
  ]);
}

export function paginateFormRows(expenses: Expense[]): FormPage[] {
  const rows = expenses.map((expense, index) => ({
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
}

export function paginateAttachments(attachments: PreviewAttachment[]) {
  const pages: PreviewAttachment[][] = [];
  for (let index = 0; index < attachments.length; index += ATTACHMENTS_PER_PAGE) {
    pages.push(attachments.slice(index, index + ATTACHMENTS_PER_PAGE));
  }
  return pages;
}

export function lastFormPageRemainingHeight(formPages: FormPage[]) {
  const page = formPages[formPages.length - 1];
  const rowHeight = page.rows.reduce((sum, row) => sum + row.height, 0);
  const fixedHeight = page.isFirst ? 281 : 250;
  return PAGE_HEIGHT - 57 - fixedHeight - rowHeight;
}

export function getSharedAttachmentPage(
  draft: Pick<Draft, "previewMode">,
  formPages: FormPage[],
  attachmentPages: PreviewAttachment[][],
) {
  return draft.previewMode === "single" &&
    formPages.length === 1 &&
    attachmentPages.length > 0 &&
    lastFormPageRemainingHeight(formPages) >= MIN_SHARED_ATTACHMENT_HEIGHT
    ? attachmentPages[0]
    : null;
}

export function getSeparateAttachmentPages(
  sharedPage: PreviewAttachment[] | null,
  attachmentPages: PreviewAttachment[][],
) {
  return sharedPage ? attachmentPages.slice(1) : attachmentPages;
}

export function getPreviewPageCount(
  formPages: FormPage[],
  separateAttachmentPages: PreviewAttachment[][],
) {
  return formPages.length + separateAttachmentPages.length;
}
