import { computed, ref, type ComputedRef } from "vue";
import {
  ATTACHMENTS_PER_PAGE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
} from "../constants/app";
import {
  getPreviewPageCount,
  getSeparateAttachmentPages,
  getSharedAttachmentPage,
  paginateAttachments,
  paginateFormRows,
} from "../utils/pagination";
import { transform } from "../utils/format";
import type { Draft, FormPage, PreviewAttachment } from "../types/models";

export interface PreviewContext {
  draft: Draft;
  previewAttachments: ComputedRef<PreviewAttachment[]>;
  selectedAttachment: ComputedRef<PreviewAttachment | null>;
  findAttachment: (attachmentId: string | null) => PreviewAttachment | null;
  selectAttachment: (
    attachment: Pick<PreviewAttachment, "id" | "expenseId">,
  ) => void;
  dirty: () => void;
  scheduleAutoSave: () => void;
}

export function usePreview(context: PreviewContext) {
  const { draft, previewAttachments, selectedAttachment } = context;
  const previewViewport = ref<HTMLElement | null>(null);
  const paperScale = ref(0.78);
  const previewZoom = ref(1);
  const leftPanelWidth = ref(404);
  const leftPanelResizeState = ref<{
    startX: number;
    startWidth: number;
  } | null>(null);
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

  const formPages = computed<FormPage[]>(() =>
    paginateFormRows(draft.expenses),
  );
  const attachmentPages = computed(() =>
    paginateAttachments(previewAttachments.value),
  );
  const sharedAttachmentPage = computed(() =>
    getSharedAttachmentPage(draft, formPages.value, attachmentPages.value),
  );
  const separateAttachmentPages = computed(() =>
    getSeparateAttachmentPages(
      sharedAttachmentPage.value,
      attachmentPages.value,
    ),
  );
  const previewPageCount = computed(() =>
    getPreviewPageCount(formPages.value, separateAttachmentPages.value),
  );
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

  const { findAttachment, selectAttachment, dirty, scheduleAutoSave } = context;

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

  return {
    previewViewport,
    paperScale,
    previewZoom,
    leftPanelWidth,
    leftPanelResizeState,
    pointerState,
    formPages,
    attachmentPages,
    sharedAttachmentPage,
    separateAttachmentPages,
    previewPageCount,
    displayScale,
    paperSize,
    updateScale,
    clampLeftPanelWidth,
    startLeftPanelResize,
    moveLeftPanelResize,
    stopLeftPanelResize,
    pointerStart,
    pointerMove,
    pointerStop,
    adjustImageByWheel,
    changePreviewZoom,
    adjustPreviewZoom,
    rotate,
    resetImage,
  };
}
