import { computed, ref, type ComputedRef, type Ref } from "vue";
import { ElMessage } from "element-plus";
import * as QRCode from "qrcode";
import {
  MAX_ATTACHMENTS_PER_EXPENSE,
  MAX_EXPENSES,
  MAX_TOTAL_ATTACHMENTS,
} from "../constants/app";
import type {
  Draft,
  Expense,
  LanUploadReceivedEvent,
  LanUploadSessionInfo,
  PreviewAttachment,
} from "../types/models";
import {
  listenLanUploadReceived,
  startLanUploadSession,
  stopLanUploadSession as stopLanUploadSessionService,
  updateLanUploadSession,
} from "../services/lanUploadService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";

export interface LanUploadContext {
  draft: Draft;
  previewAttachments: ComputedRef<PreviewAttachment[]>;
  isLanUploadOpen: Ref<boolean>;
  isLanUploadLoading: Ref<boolean>;
  lanUploadSession: Ref<LanUploadSessionInfo | null>;
  lanUploadQrCode: Ref<string>;
  lanUploadError: Ref<string>;
  lanUploadNow: Ref<number>;
  lanUploadTargetExpenseId: Ref<string | null>;
  addFile: (
    file: File,
    notify?: boolean,
    targetRecordId?: string,
  ) => Promise<boolean>;
  addExtraAttachmentFile: (
    file: File,
    expenseId: string,
    notify?: boolean,
    targetRecordId?: string,
  ) => Promise<boolean>;
  extraAttachmentSlots: (expense: Expense) => number;
}

export function useLanUpload(context: LanUploadContext) {
  const {
    draft,
    previewAttachments,
    isLanUploadOpen,
    isLanUploadLoading,
    lanUploadSession,
    lanUploadQrCode,
    lanUploadError,
    lanUploadNow,
    lanUploadTargetExpenseId,
    addFile,
    addExtraAttachmentFile,
    extraAttachmentSlots,
  } = context;
  const lanUploadLabel = computed(() => {
    const base =
      draft.label.trim() || draft.companyName.trim() || "未命名报销单";
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
  const lanReceivedCount = ref(0);
  let lanUploadNoticeTimer: number | null = null;
  let lanUploadUnlisten: (() => void) | null = null;
  let lanUploadListenerReady: Promise<void> | null = null;
  let lanUploadQueue = Promise.resolve();
  let lanUploadPendingEvents = 0;
  let lanUploadRequestVersion = 0;

  function lanUploadRemainingSlots(
    targetExpenseId: string | null = lanUploadTargetExpenseId.value,
  ) {
    if (targetExpenseId) {
      const expense = draft.expenses.find(
        (item) => item.id === targetExpenseId,
      );
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
    if (lanUploadNoticeTimer !== null)
      window.clearTimeout(lanUploadNoticeTimer);
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
      lanUploadListenerReady = listenLanUploadReceived((payload) => {
        lanUploadPendingEvents += 1;
        lanUploadQueue = lanUploadQueue
          .then(() => receiveLanUpload(payload))
          .catch((error) => {
            ElMessage.error(`手机图片接收失败：${errorMessage(error)}`);
          });
      }).then((unlisten) => {
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
      const session = await startLanUploadSession({
        recordId: draft.id,
        targetExpenseId: lanUploadTargetExpenseId.value,
        label: lanUploadLabel.value,
        remainingSlots,
        ttlSeconds: 15 * 60,
      });
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
    await stopLanUploadSessionService().catch(() => {});
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
    await updateLanUploadSession({
      recordId: draft.id,
      targetExpenseId: lanUploadTargetExpenseId.value,
      label: session.label,
      remainingSlots: session.remainingSlots,
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

  function getLanUploadNoticeTimer() {
    return lanUploadNoticeTimer;
  }

  function clearLanUploadNoticeTimer() {
    if (lanUploadNoticeTimer === null) return;
    window.clearTimeout(lanUploadNoticeTimer);
    lanUploadNoticeTimer = null;
  }

  function cleanupLanUploadListener() {
    lanUploadUnlisten?.();
    lanUploadUnlisten = null;
    lanUploadListenerReady = null;
  }

  return {
    lanUploadLabel,
    lanUploadSecondsRemaining,
    lanUploadExpiryText,
    lanReceivedCount,
    lanUploadRemainingSlots,
    lanUploadFile,
    showLanUploadReceived,
    receiveLanUpload,
    ensureLanUploadListener,
    refreshLanUploadSession,
    openLanUpload,
    stopLanUploadSession,
    synchronizeLanUploadSession,
    copyLanUploadUrl,
    getLanUploadNoticeTimer,
    clearLanUploadNoticeTimer,
    cleanupLanUploadListener,
  };
}
