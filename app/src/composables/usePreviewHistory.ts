import { computed, shallowRef } from "vue";

interface PreviewHistoryEntry {
  label: string;
  undo: () => boolean;
  redo: () => boolean;
}

interface PreviewHistoryContext {
  getRecordId: () => string;
  onApply: () => void;
}

// 只保存字段变更命令，不复制图片、识别响应或整份草稿；新操作截断重做分支。
export function usePreviewHistory(context: PreviewHistoryContext, limit = 100) {
  const past = shallowRef<PreviewHistoryEntry[]>([]);
  const future = shallowRef<PreviewHistoryEntry[]>([]);
  let recordId = context.getRecordId();
  let replaying = false;
  const canUndo = computed(() => past.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const undoLabel = computed(
    () => past.value[past.value.length - 1]?.label ?? "",
  );
  const redoLabel = computed(
    () => future.value[future.value.length - 1]?.label ?? "",
  );

  function clear() {
    past.value = [];
    future.value = [];
    recordId = context.getRecordId();
  }

  function record(entry: PreviewHistoryEntry) {
    if (replaying) return;
    if (recordId !== context.getRecordId()) clear();
    past.value = [...past.value, entry].slice(-limit);
    future.value = [];
  }

  function apply(direction: "undo" | "redo") {
    if (recordId !== context.getRecordId()) {
      clear();
      return false;
    }
    const source = direction === "undo" ? past : future;
    const target = direction === "undo" ? future : past;
    const entry = source.value[source.value.length - 1];
    if (!entry) return false;
    replaying = true;
    try {
      // 字段被识别或其他入口改写后不强行覆盖；这一条及依赖它的历史一起失效。
      if (!entry[direction]()) {
        clear();
        return false;
      }
      source.value = source.value.slice(0, -1);
      target.value = [...target.value, entry];
      context.onApply();
      return true;
    } finally {
      replaying = false;
    }
  }

  return {
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    record,
    clear,
    undo: () => apply("undo"),
    redo: () => apply("redo"),
  };
}
