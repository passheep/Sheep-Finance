import { computed, nextTick, reactive, ref, type ComputedRef } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { amountExpressionToCents } from "../utils/format";
import type {
  CellSelection,
  Draft,
  Expense,
  ExpenseEditableField,
  FormPage,
  HeaderEditableField,
  PreviewAttachment,
  Profile,
} from "../types/models";
import { cleanupOrphanImages } from "../services/attachmentService";
import { isTauriRuntime } from "../services/runtimeService";
import { usePreviewHistory } from "./usePreviewHistory";
import { getFinanceReviewer } from "../utils/approval";

type PreviewDraftField =
  | HeaderEditableField
  | "totalOverrideCents"
  | "financeReviewer"
  | "showManagerApproval";

export interface ExpenseEditingContext {
  draft: Draft;
  formPages: ComputedRef<FormPage[]>;
  getPreviewAttachments: () => PreviewAttachment[];
  dirty: () => void;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
  reflowExpenses: () => void;
  revokeManagedImageUrl: (url?: string) => void;
  setSelectedIds: (
    expenseId: string | null,
    attachmentId?: string | null,
  ) => void;
  isPreviewActive?: () => boolean;
}

export function useExpenseEditing(context: ExpenseEditingContext) {
  const {
    draft,
    formPages,
    dirty,
    persistDraft,
    reflowExpenses,
    revokeManagedImageUrl,
    setSelectedIds,
  } = context;
  const editingKey = ref<string | null>(null);
  const editValue = ref("");
  const editInput = ref<HTMLElement | HTMLElement[] | null>(null);
  const amountInputValues = reactive<Record<string, string>>({});
  const cellSelection = ref<CellSelection | null>(null);
  const paperCellPointerState = ref<{
    pointerId: number;
    startX: number;
    startY: number;
    startRow: number;
    startColumn: number;
    dragged: boolean;
  } | null>(null);
  const expenseDragState = ref<{
    id: string;
    surface: "list" | "paper";
  } | null>(null);
  let suppressPaperCellClick = false;
  const selectedId = ref<string | null>(draft.expenses[0]?.id ?? null);
  const selectedAttachmentId = ref<string | null>(selectedId.value);
  const selectedExpense = computed(
    () => draft.expenses.find((item) => item.id === selectedId.value) ?? null,
  );
  const selectedAttachment = computed(
    () =>
      context
        .getPreviewAttachments()
        .find((item) => item.id === selectedAttachmentId.value) ?? null,
  );
  const previewAttachments = computed(() => context.getPreviewAttachments());
  const findAttachment = (attachmentId: string | null) => {
    if (!attachmentId) return null;
    return (
      previewAttachments.value.find((item) => item.id === attachmentId) ?? null
    );
  };
  const clearSelection = () => {
    cellSelection.value = null;
  };
  const previewHistory = usePreviewHistory({
    getRecordId: () => draft.id,
    onApply: dirty,
  });
  const financeReviewer = computed({
    get: () => getFinanceReviewer(draft),
    set: (value: "财务" | "秘书处") =>
      changeDraftField("financeReviewer", value, "审批部门"),
  });
  const showManagerApproval = computed({
    get: () => draft.showManagerApproval !== false,
    set: (value: boolean) =>
      changeDraftField("showManagerApproval", value, "总经理审核栏"),
  });

  function changeDraftField<K extends PreviewDraftField>(
    field: K,
    value: Draft[K],
    label: string,
  ) {
    const before = draft[field];
    if (Object.is(before, value)) return;
    draft[field] = value;
    const apply = (expected: Draft[K], next: Draft[K]) => {
      if (!Object.is(draft[field], expected)) return false;
      draft[field] = next;
      return true;
    };
    previewHistory.record({
      label,
      undo: () => apply(value, before),
      redo: () => apply(before, value),
    });
    dirty();
  }

  function changePreviewProfile(profile: Profile) {
    const fields = [
      "applicant",
      "department",
      "payeeName",
      "account",
      "bank",
    ] as const;
    const before = fields.map((field) => draft[field]);
    const after = fields.map((field) => profile[field]);
    if (before.every((value, index) => value === after[index])) return;
    fields.forEach((field, index) => {
      draft[field] = after[index]!;
    });
    const apply = (expected: string[], next: string[]) => {
      if (fields.some((field, index) => draft[field] !== expected[index]))
        return false;
      fields.forEach((field, index) => {
        draft[field] = next[index]!;
      });
      return true;
    };
    previewHistory.record({
      label: "切换申请人",
      undo: () => apply(after, before),
      redo: () => apply(before, after),
    });
    dirty();
  }

  function enableManualTotal(totalCents: number) {
    changeDraftField("totalOverrideCents", totalCents, "人工合计");
  }

  function commitManualTotal(value: string) {
    const amount = amountExpressionToCents(value);
    if (amount === null) {
      ElMessage.warning("金额表达式无法计算，请检查数字和运算符");
      return false;
    }
    changeDraftField("totalOverrideCents", amount, "人工合计");
    return true;
  }

  function restoreAutomaticTotal() {
    changeDraftField("totalOverrideCents", null, "恢复自动合计");
  }

  function undoPreviewEdit() {
    if (context.isPreviewActive && !context.isPreviewActive()) return false;
    commitActiveEdit();
    cancelEdit();
    return previewHistory.undo();
  }

  function redoPreviewEdit() {
    if (context.isPreviewActive && !context.isPreviewActive()) return false;
    commitActiveEdit();
    cancelEdit();
    return previewHistory.redo();
  }

  function resetPreviewHistory() {
    cancelEdit();
    previewHistory.clear();
  }

  function fieldKey(expense: Expense, field: string) {
    return `expense:${expense.id}:${field}`;
  }

  // 纸页和费用行使用 v-for，模板 ref 会返回数组；只聚焦仍挂在页面上的编辑框。
  function getActiveEditInput() {
    const value = editInput.value;
    return Array.isArray(value)
      ? (value.find((element) => element.isConnected) ?? null)
      : value;
  }

  function beginEdit(key: string, value: string) {
    if (editingKey.value && editingKey.value !== key) commitActiveEdit();
    editingKey.value = key;
    editValue.value = value;
    nextTick(() => getActiveEditInput()?.focus());
  }

  function cancelEdit() {
    editingKey.value = null;
    editValue.value = "";
  }

  function commitHeader(field: HeaderEditableField) {
    if (editingKey.value !== field) return;
    const value = editValue.value;
    cancelEdit();
    changeDraftField(field, value, "表头或收款信息");
  }

  function commitExpense(expense: Expense, field: ExpenseEditableField) {
    if (editingKey.value !== fieldKey(expense, field)) return;
    let value: string | number = editValue.value;
    if (field === "amountCents") {
      const amount = amountExpressionToCents(editValue.value);
      if (amount === null) {
        ElMessage.warning("金额表达式无法计算，请检查数字和运算符");
        cancelEdit();
        return;
      }
      value = amount;
    }
    const expenseId = expense.id;
    const before = expense[field];
    const previousManual = expense.manualFields[field];
    expense[field] = value as never;
    expense.manualFields[field] = true;
    expense.ocrStatus = "manual";
    cancelEdit();
    if (!Object.is(before, value) || previousManual !== true) {
      const apply = (
        expected: string | number,
        expectedManual: boolean | undefined,
        next: string | number,
        nextManual: boolean | undefined,
      ) => {
        const current = draft.expenses.find((item) => item.id === expenseId);
        if (
          !current ||
          !Object.is(current[field], expected) ||
          current.manualFields[field] !== expectedManual
        )
          return false;
        current[field] = next as never;
        if (nextManual === undefined) delete current.manualFields[field];
        else current.manualFields[field] = nextManual;
        return true;
      };
      // 手工确认标记随值撤销，识别版本/请求状态保持实时值，不恢复旧网络状态。
      previewHistory.record({
        label: "费用单元格",
        undo: () => apply(value, true, before, previousManual),
        redo: () => apply(before, previousManual, value, true),
      });
      dirty();
    }
  }

  function commitActiveEdit() {
    const key = editingKey.value;
    if (!key) return;
    const expenseMatch =
      /^expense:(.+):(occurredDate|reason|description|arranger|amountCents)$/.exec(
        key,
      );
    if (expenseMatch) {
      const expense = draft.expenses.find(
        (item) => item.id === expenseMatch[1],
      );
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

  function selectExpense(expense: Expense) {
    setSelectedIds(expense.id);
  }

  function selectAttachment(
    attachment: Pick<PreviewAttachment, "id" | "expenseId">,
  ) {
    setSelectedIds(attachment.expenseId, attachment.id);
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
      const select = getActiveEditInput();
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
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing)
      return;
    const target = event.target as HTMLElement | null;
    // 输入控件内保留原生逐字撤销；预览区域外的表单和弹窗也不接管快捷键。
    if (
      target?.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false']), .el-dialog, [role='dialog']",
      )
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      if (context.isPreviewActive && !context.isPreviewActive()) return;
      const available = event.shiftKey
        ? previewHistory.canRedo.value
        : previewHistory.canUndo.value;
      if (!available && !editingKey.value) return;
      event.preventDefault();
      if (event.shiftKey) redoPreviewEdit();
      else undoPreviewEdit();
      return;
    }
    if (key !== "c" || !cellSelection.value) return;
    event.preventDefault();
    void copySelectedPaperCells();
  }

  async function removeExpense(expense: Expense) {
    try {
      await ElMessageBox.confirm(
        `确定删除“${expense.fileName}”对应的费用吗？`,
        "删除费用",
        {
          confirmButtonText: "删除",
          cancelButtonText: "取消",
          type: "warning",
        },
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
      setSelectedIds(draft.expenses[Math.max(0, index - 1)]?.id ?? null);
      dirty();
      if (isTauriRuntime() && (await persistDraft(false)))
        void cleanupOrphanImages();
      ElMessage.success("费用已删除");
    } catch {
      /* 用户取消 */
    }
  }

  function reorderExpense(sourceId: string, targetIndex: number) {
    const sourceIndex = draft.expenses.findIndex(
      (item) => item.id === sourceId,
    );
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

  return {
    editingKey,
    editValue,
    editInput,
    amountInputValues,
    cellSelection,
    paperCellPointerState,
    expenseDragState,
    selectedId,
    selectedAttachmentId,
    selectedExpense,
    selectedAttachment,
    previewAttachments,
    findAttachment,
    clearSelection,
    fieldKey,
    beginEdit,
    cancelEdit,
    commitHeader,
    commitExpense,
    commitActiveEdit,
    amountInputValue,
    beginAmountInput,
    updateAmountInput,
    commitAmountInput,
    selectExpense,
    selectAttachment,
    paperCellValue,
    paperCellField,
    openPaperCellEditor,
    handlePaperCellClick,
    isPaperCellSelected,
    startPaperCellSelection,
    trackPaperCellSelection,
    extendPaperCellSelection,
    finishPaperCellSelection,
    endPaperCellSelection,
    cancelPaperCellSelection,
    clipboardCellValue,
    selectedPaperCellText,
    copySelectedPaperCells,
    handleGlobalKeydown,
    canUndoPreview: previewHistory.canUndo,
    canRedoPreview: previewHistory.canRedo,
    undoPreviewLabel: previewHistory.undoLabel,
    redoPreviewLabel: previewHistory.redoLabel,
    undoPreviewEdit,
    redoPreviewEdit,
    resetPreviewHistory,
    financeReviewer,
    showManagerApproval,
    changePreviewCompany: (value: string) =>
      changeDraftField("companyName", value, "公司名称"),
    changePreviewProfile,
    enableManualTotal,
    commitManualTotal,
    restoreAutomaticTotal,
    removeExpense,
    reorderExpense,
    expenseDragStart,
    expenseDragMove,
    expenseDragStop,
  };
}
