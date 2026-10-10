import { type ComputedRef, type Ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  MAX_ATTACHMENTS_PER_EXPENSE,
  MAX_EXPENSES,
  MAX_TOTAL_ATTACHMENTS,
} from "../constants/app";
import { id, today, transform } from "../utils/format";
import type {
  Draft,
  Expense,
  ExtraAttachment,
  PreviewAttachment,
  StoredAttachment,
} from "../types/models";
import {
  cleanupOrphanImages,
  openAttachmentFolder,
  readAttachment,
  saveAttachmentAs,
  storeAttachment,
} from "../services/attachmentService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";

export interface AttachmentsContext {
  draft: Draft;
  previewAttachments: ComputedRef<PreviewAttachment[]>;
  selectedAttachment: ComputedRef<PreviewAttachment | null>;
  defaultReason: Ref<string>;
  expenseReasons: Ref<string[]>;
  defaultArranger: Ref<string>;
  arrangers: Ref<string[]>;
  handwritingMode: Ref<boolean>;
  recognitionConfigured: () => boolean;
  recognizeExpense: (expense: Expense, notify?: boolean) => Promise<void>;
  dirty: () => void;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
  reflowExpenses: () => void;
  reflowAttachments: () => void;
  scrollExpenseIntoView: (expenseId: string) => void;
  setSelectedIds: (
    expenseId: string | null,
    attachmentId?: string | null,
  ) => void;
  saveAttachmentFile: (options: {
    defaultPath: string;
    filters: { name: string; extensions: string[] }[];
  }) => Promise<string | null>;
}

export function useAttachments(context: AttachmentsContext) {
  const {
    draft,
    previewAttachments,
    selectedAttachment,
    defaultReason,
    expenseReasons,
    defaultArranger,
    arrangers,
    handwritingMode,
    recognitionConfigured,
    recognizeExpense,
    dirty,
    persistDraft,
    reflowExpenses,
    reflowAttachments,
    scrollExpenseIntoView,
    setSelectedIds,
  } = context;
  const managedImageUrls = new Set<string>();

  const saveAttachmentFile = context.saveAttachmentFile;

  function dataUrlSize(dataUrl: string) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return 0;
    return Math.ceil(((dataUrl.length - comma - 1) * 3) / 4);
  }

  function createManagedImageUrl(value: Blob) {
    const url = URL.createObjectURL(value);
    managedImageUrls.add(url);
    return url;
  }

  function revokeManagedImageUrl(url?: string) {
    if (!url?.startsWith("blob:") || !managedImageUrls.has(url)) return;
    URL.revokeObjectURL(url);
    managedImageUrls.delete(url);
  }

  function revokeDraftImageUrls(value: Draft | null | undefined) {
    value?.expenses.forEach((expense) => {
      revokeManagedImageUrl(expense.imageDataUrl);
      revokeManagedImageUrl(expense.recognitionImageDataUrl);
      expense.extraAttachments.forEach((attachment) =>
        revokeManagedImageUrl(attachment.imageDataUrl),
      );
    });
  }

  async function loadStoredImageUrl(blobHash?: string) {
    if (!blobHash || !isTauriRuntime()) return "";
    const stored = await readAttachment(blobHash);
    return createManagedImageUrl(
      new Blob([new Uint8Array(stored.bytes)], { type: stored.mimeType }),
    );
  }

  async function hydrateDraftImages(value: Draft) {
    if (!isTauriRuntime()) return value;
    const jobs: Promise<void>[] = [];
    value.expenses.forEach((expense) => {
      if (expense.blobHash && !expense.imageDataUrl) {
        jobs.push(
          loadStoredImageUrl(expense.blobHash).then((url) => {
            expense.imageDataUrl = url;
          }),
        );
      }
      expense.extraAttachments.forEach((attachment) => {
        if (!attachment.blobHash || attachment.imageDataUrl) return;
        jobs.push(
          loadStoredImageUrl(attachment.blobHash).then((url) => {
            attachment.imageDataUrl = url;
          }),
        );
      });
    });
    try {
      await Promise.all(jobs);
      return value;
    } catch (error) {
      revokeDraftImageUrls(value);
      throw error;
    }
  }

  function applyStoredAttachment(
    target: Expense | ExtraAttachment,
    stored: StoredAttachment,
  ) {
    target.blobHash = stored.blobHash;
    target.mimeType = stored.mimeType;
    target.blobExtension = stored.blobExtension;
    target.sizeBytes = stored.sizeBytes;
    if ("ocrMode" in target) {
      target.recognitionBlobHash = stored.recognitionBlobHash;
      target.recognitionMimeType = stored.recognitionMimeType;
      target.recognitionBlobExtension = stored.recognitionBlobExtension;
      target.recognitionSizeBytes = stored.recognitionSizeBytes;
    }
  }

  async function persistImage(
    recordId: string,
    imageDataUrl: string,
    recognitionDataUrl: string | undefined,
    width: number,
    height: number,
  ) {
    return storeAttachment({
      recordId,
      dataUrl: imageDataUrl,
      recognitionDataUrl,
      naturalWidth: width,
      naturalHeight: height,
    });
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
        reader.onerror = () =>
          reject(reader.error ?? new Error("文件读取失败"));
        reader.readAsDataURL(file);
      },
    );
  }

  function extraAttachmentSlots(expense: Expense) {
    return Math.max(
      0,
      Math.min(
        MAX_ATTACHMENTS_PER_EXPENSE - expense.extraAttachments.length - 1,
        MAX_TOTAL_ATTACHMENTS - previewAttachments.value.length,
      ),
    );
  }

  async function addFile(file: File, notify = true, targetRecordId = draft.id) {
    if (draft.id !== targetRecordId) return false;
    if (!file.type.startsWith("image/")) {
      if (notify) ElMessage.warning("请选择图片文件");
      return false;
    }
    if (
      draft.expenses.length >= MAX_EXPENSES ||
      previewAttachments.value.length >= MAX_TOTAL_ATTACHMENTS
    ) {
      if (notify)
        ElMessage.warning(
          `一张报销单最多 ${MAX_EXPENSES} 笔费用、${MAX_TOTAL_ATTACHMENTS} 张图片`,
        );
      return false;
    }
    try {
      const image = await readImage(file);
      const recognitionImageDataUrl = await compressForRecognition(
        image.dataUrl,
        image.width,
        image.height,
      );
      const stored = isTauriRuntime()
        ? await persistImage(
            targetRecordId,
            image.dataUrl,
            recognitionImageDataUrl,
            image.width,
            image.height,
          )
        : null;
      if (draft.id !== targetRecordId) return false;
      if (
        draft.expenses.length >= MAX_EXPENSES ||
        previewAttachments.value.length >= MAX_TOTAL_ATTACHMENTS
      ) {
        if (notify)
          ElMessage.warning(
            `一张报销单最多 ${MAX_EXPENSES} 笔费用、${MAX_TOTAL_ATTACHMENTS} 张图片`,
          );
        return false;
      }
      const expense: Expense = {
        id: id("expense"),
        fileName:
          file.name || "剪贴板图片-" + (draft.expenses.length + 1) + ".png",
        imageDataUrl: isTauriRuntime()
          ? createManagedImageUrl(file)
          : image.dataUrl,
        recognitionImageDataUrl: isTauriRuntime()
          ? undefined
          : recognitionImageDataUrl,
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
        extraAttachments: [],
        manualFields: {},
      };
      if (stored) applyStoredAttachment(expense, stored);
      draft.expenses.push(expense);
      reflowExpenses();
      setSelectedIds(expense.id);
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
        ElMessage.error(
          error instanceof Error ? error.message : "图片读取失败",
        );
      return false;
    }
  }

  async function addExtraAttachmentFile(
    file: File,
    expenseId: string,
    notify = true,
    targetRecordId = draft.id,
  ) {
    if (draft.id !== targetRecordId) return false;
    const expense = draft.expenses.find((item) => item.id === expenseId);
    if (!expense) return false;
    if (!file.type.startsWith("image/")) {
      if (notify) ElMessage.warning("请选择图片文件");
      return false;
    }
    if (!extraAttachmentSlots(expense)) {
      if (notify)
        ElMessage.warning(
          `每笔费用最多 ${MAX_ATTACHMENTS_PER_EXPENSE} 张图片，整张报销单最多 ${MAX_TOTAL_ATTACHMENTS} 张`,
        );
      return false;
    }
    try {
      const image = await readImage(file);
      const stored = isTauriRuntime()
        ? await persistImage(
            targetRecordId,
            image.dataUrl,
            undefined,
            image.width,
            image.height,
          )
        : null;
      const current = draft.expenses.find((item) => item.id === expenseId);
      if (
        !current ||
        draft.id !== targetRecordId ||
        !extraAttachmentSlots(current)
      )
        return false;
      const attachment: ExtraAttachment = {
        id: id("attachment"),
        fileName:
          file.name ||
          `附加图片-${current.extraAttachments.length + 1}-${Date.now()}.png`,
        imageDataUrl: isTauriRuntime()
          ? createManagedImageUrl(file)
          : image.dataUrl,
        naturalWidth: image.width,
        naturalHeight: image.height,
        transform: transform(0, 1),
      };
      if (stored) applyStoredAttachment(attachment, stored);
      current.extraAttachments.push(attachment);
      reflowAttachments();
      setSelectedIds(current.id, attachment.id);
      dirty();
      if (notify)
        ElMessage.success("附加图片已加入，不会执行 OCR 或大模型识别");
      return true;
    } catch (error) {
      if (notify)
        ElMessage.error(
          error instanceof Error ? error.message : "图片读取失败",
        );
      return false;
    }
  }

  async function removeExtraAttachment(
    expense: Expense,
    attachment: ExtraAttachment,
  ) {
    try {
      await ElMessageBox.confirm(
        `确定删除附加图片“${attachment.fileName}”吗？`,
        "删除附加图片",
        {
          confirmButtonText: "删除",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
      const index = expense.extraAttachments.findIndex(
        (item) => item.id === attachment.id,
      );
      if (index < 0) return;
      revokeManagedImageUrl(attachment.imageDataUrl);
      expense.extraAttachments.splice(index, 1);
      reflowAttachments();
      setSelectedIds(expense.id);
      dirty();
      if (isTauriRuntime() && (await persistDraft(false)))
        void cleanupOrphanImages();
      ElMessage.success("附加图片已删除");
    } catch {
      /* 用户取消 */
    }
  }

  function moveExtraAttachment(
    expense: Expense,
    attachment: ExtraAttachment,
    offset: number,
  ) {
    const index = expense.extraAttachments.findIndex(
      (item) => item.id === attachment.id,
    );
    const nextIndex = index + offset;
    if (
      index < 0 ||
      nextIndex < 0 ||
      nextIndex >= expense.extraAttachments.length
    )
      return;
    const [current] = expense.extraAttachments.splice(index, 1);
    expense.extraAttachments.splice(nextIndex, 0, current);
    reflowAttachments();
    dirty();
  }

  async function attachmentBlob(
    attachment: PreviewAttachment | ExtraAttachment | Expense,
  ) {
    if (!attachment.blobHash) throw new Error("该图片尚未存入本地图片池");
    const value = await readAttachment(attachment.blobHash);
    return {
      blob: new Blob([new Uint8Array(value.bytes)], { type: value.mimeType }),
      extension: value.extension,
    };
  }

  async function copyOriginalImage(
    attachment:
      | PreviewAttachment
      | ExtraAttachment
      | Expense
      | null = selectedAttachment.value,
  ) {
    if (!attachment) return;
    try {
      const { blob } = await attachmentBlob(attachment);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
        throw new Error("当前系统不支持图片剪贴板");
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
      } catch {
        const sourceUrl = URL.createObjectURL(blob);
        try {
          const image = await loadImage(sourceUrl);
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("无法读取图片画布");
          context.drawImage(image, 0, 0);
          const png = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) =>
                value ? resolve(value) : reject(new Error("图片转换失败")),
              "image/png",
            ),
          );
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": png }),
          ]);
        } finally {
          URL.revokeObjectURL(sourceUrl);
        }
      }
      ElMessage.success("原图已写入剪贴板");
    } catch (error) {
      ElMessage.error(`复制原图失败：${errorMessage(error)}`);
    }
  }

  async function saveOriginalImage(
    attachment:
      | PreviewAttachment
      | ExtraAttachment
      | Expense
      | null = selectedAttachment.value,
  ) {
    if (!attachment?.blobHash) return;
    try {
      const stored = await attachmentBlob(attachment);
      const baseName = attachment.fileName.replace(/[\\/:*?"<>|]/g, "_");
      const suggested = baseName.includes(".")
        ? baseName
        : `${baseName || "票据原图"}.${stored.extension}`;
      const destination = await saveAttachmentFile({
        defaultPath: suggested,
        filters: [{ name: "图片", extensions: [stored.extension] }],
      });
      if (!destination) return;
      await saveAttachmentAs(attachment.blobHash, destination);
      ElMessage.success("原图已保存");
    } catch (error) {
      ElMessage.error(`另存原图失败：${errorMessage(error)}`);
    }
  }

  async function openOriginalImageFolder(
    attachment:
      | PreviewAttachment
      | ExtraAttachment
      | Expense
      | null = selectedAttachment.value,
    recordId = draft.id,
  ) {
    if (!attachment?.blobHash) return;
    try {
      await openAttachmentFolder(attachment.blobHash, recordId);
    } catch (error) {
      ElMessage.error(errorMessage(error));
    }
  }

  return {
    dataUrlSize,
    createManagedImageUrl,
    revokeManagedImageUrl,
    revokeDraftImageUrls,
    loadStoredImageUrl,
    hydrateDraftImages,
    applyStoredAttachment,
    persistImage,
    loadImage,
    compressForRecognition,
    readImage,
    extraAttachmentSlots,
    addFile,
    addExtraAttachmentFile,
    removeExtraAttachment,
    moveExtraAttachment,
    attachmentBlob,
    copyOriginalImage,
    saveOriginalImage,
    openOriginalImageFolder,
  };
}
