import { nextTick, ref, type ComputedRef, type Ref } from "vue";
import { ElMessage } from "element-plus";
import ExcelJS from "exceljs";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { PAGE_HEIGHT, PAGE_WIDTH } from "../constants/app";
import { saveExportBytes } from "../services/exportService";
import { ChineseAmount, today } from "../utils/format";
import { expenseRowHeight } from "../utils/pagination";
import { getApprovalLine } from "../utils/approval";
import type {
  AppTab,
  Draft,
  FormPage,
  PreviewAttachment,
} from "../types/models";

export interface DocumentExportContext {
  draft: Draft;
  activeTab: Ref<AppTab>;
  formPages: ComputedRef<FormPage[]>;
  previewPageCount: ComputedRef<number>;
  sharedAttachmentPage: ComputedRef<PreviewAttachment[] | null>;
  calculatedTotal: ComputedRef<number>;
  effectiveTotal: ComputedRef<number>;
  commitActiveEdit: () => void;
  updateScale: () => void;
  persistDraft: (showMessage?: boolean) => Promise<boolean>;
  isAutoSaveSuppressed: () => boolean;
  withTemporaryDraft: <T>(
    source: Draft,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

async function waitForExportAssets(root: HTMLElement) {
  await document.fonts?.ready;
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
      }
      if (typeof image.decode === "function")
        await image.decode().catch(() => {});
    }),
  );
}

function synchronizeExportControls(source: HTMLElement, clone: HTMLElement) {
  const sourceControls = source.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input, textarea, select");
  const cloneControls = clone.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input, textarea, select");
  sourceControls.forEach((control, index) => {
    const clonedControl = cloneControls[index];
    if (clonedControl) clonedControl.value = control.value;
  });
}

export function useDocumentExport(context: DocumentExportContext) {
  const {
    draft,
    activeTab,
    formPages,
    previewPageCount,
    sharedAttachmentPage,
    calculatedTotal,
    effectiveTotal,
    commitActiveEdit,
    updateScale,
    persistDraft,
    isAutoSaveSuppressed,
    withTemporaryDraft,
  } = context;

  const isExportingPdf = ref(false);

  async function captureElementForExport(
    source: HTMLElement,
    width: number,
    height: number,
  ) {
    const host = document.createElement("div");
    host.className = "export-capture-host exporting-document";
    Object.assign(host.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${width}px`,
      height: `${height}px`,
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "-2147483647",
      background: "#ffffff",
    });
    const clone = source.cloneNode(true) as HTMLElement;
    synchronizeExportControls(source, clone);
    Object.assign(clone.style, {
      width: `${width}px`,
      height: `${height}px`,
      minWidth: `${width}px`,
      minHeight: `${height}px`,
      maxWidth: `${width}px`,
      maxHeight: `${height}px`,
      flex: "none",
      transform: "none",
      boxShadow: "none",
      letterSpacing: "0",
    });
    clone.querySelectorAll<HTMLElement>("*").forEach((element) => {
      element.style.letterSpacing = "0";
      element.style.fontKerning = "none";
    });
    host.appendChild(clone);
    document.body.appendChild(host);
    try {
      await waitForExportAssets(clone);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return await html2canvas(clone, {
        backgroundColor: "#ffffff",
        scale: 2,
        width,
        height,
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: Math.max(PAGE_WIDTH, document.documentElement.clientWidth),
        windowHeight: Math.max(
          PAGE_HEIGHT,
          document.documentElement.clientHeight,
        ),
      });
    } finally {
      host.remove();
    }
  }

  async function captureAttachmentPagesForExport() {
    const sources = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".attachment-area[data-export-attachment-page]",
      ),
    );
    if (!sources.length) throw new Error("附件预览尚未准备完成，请稍后重试");
    const pages: { dataUrl: string; width: number; height: number }[] = [];
    for (const source of sources) {
      const width = Math.round(source.clientWidth);
      const height = Math.round(source.clientHeight);
      if (width <= 0 || height <= 0)
        throw new Error("附件预览尺寸异常，请稍后重试");
      const canvas = await captureElementForExport(source, width, height);
      pages.push({ dataUrl: canvas.toDataURL("image/png"), width, height });
    }
    return pages;
  }

  async function exportExcel(sourceDraft?: Draft) {
    if (sourceDraft) {
      await withTemporaryDraft(sourceDraft, () => exportExcel());
      return;
    }
    commitActiveEdit();
    if (!draft.expenses.length)
      return ElMessage.warning("请先上传至少一张费用截图");

    const previousTab = activeTab.value;
    try {
      if (previousTab !== "reimbursement") {
        activeTab.value = "reimbursement";
        await nextTick();
        updateScale();
        await nextTick();
      }

      const attachmentPagesForExport = await captureAttachmentPagesForExport();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "报销单助手";
      workbook.created = new Date();
      workbook.modified = new Date();
      workbook.calcProperties.fullCalcOnLoad = true;

      const sheet = workbook.addWorksheet("报销单", {
        properties: { defaultRowHeight: 15 },
        views: [{ showGridLines: false, zoomScale: 90 }],
      });
      const columnWidths = [8, 13, 14, 32, 16, 17];
      columnWidths.forEach((width, index) => {
        sheet.getColumn(index + 1).width = width;
      });

      const expenseStartRow = 4;
      const expenseEndRow = expenseStartRow + draft.expenses.length - 1;
      const totalRow = expenseEndRow + 1;
      const uppercaseRow = totalRow + 1;
      const paymentRow = uppercaseRow + 1;
      const approvalRow = paymentRow + 1;
      const bodyFont: Partial<ExcelJS.Font> = {
        name: "宋体",
        size: 9,
        color: { argb: "FF2F3334" },
      };
      const thinBorder: Partial<ExcelJS.Borders> = {
        top: { style: "thin", color: { argb: "FF4C4F4F" } },
        bottom: { style: "thin", color: { argb: "FF4C4F4F" } },
        left: { style: "thin", color: { argb: "FF4C4F4F" } },
        right: { style: "thin", color: { argb: "FF4C4F4F" } },
      };

      for (let rowNumber = 1; rowNumber <= approvalRow; rowNumber += 1) {
        for (let column = 1; column <= 6; column += 1) {
          const cell = sheet.getRow(rowNumber).getCell(column);
          cell.font = { ...bodyFont };
          cell.border = thinBorder;
          cell.alignment = {
            horizontal: "center",
            vertical: "middle",
            wrapText: true,
          };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFFFFF" },
          };
        }
      }

      sheet.getRow(1).height = 32.25;
      sheet.getRow(2).height = 23.25;
      sheet.getRow(3).height = 25.5;
      draft.expenses.forEach((expense, index) => {
        sheet.getRow(expenseStartRow + index).height =
          expenseRowHeight(expense) * 0.75;
      });
      sheet.getRow(totalRow).height = 23.25;
      sheet.getRow(uppercaseRow).height = 23.25;
      sheet.getRow(paymentRow).height = 47.25;
      sheet.getRow(approvalRow).height = 36;

      sheet.mergeCells("A1:F1");
      sheet.mergeCells("A2:C2");
      sheet.mergeCells(`A${totalRow}:B${uppercaseRow}`);
      sheet.mergeCells(`C${totalRow}:F${totalRow}`);
      sheet.mergeCells(`C${uppercaseRow}:F${uppercaseRow}`);
      sheet.mergeCells(`A${paymentRow}:F${paymentRow}`);
      sheet.mergeCells(`A${approvalRow}:F${approvalRow}`);

      const titleCell = sheet.getCell("A1");
      titleCell.value = (draft.companyName || "") + "费用报销单";
      titleCell.font = {
        name: "宋体",
        size: 14.25,
        bold: true,
        color: { argb: "FF2F3334" },
      };
      titleCell.alignment = { horizontal: "center", vertical: "middle" };

      sheet.getCell("A2").value = "报销日期：";
      sheet.getCell("D2").value = "申请人：" + (draft.applicant || "");
      sheet.getCell("E2").value = "所属部门：" + (draft.department || "");
      sheet.getCell("F2").value = "附票据（  ）张";
      sheet.getCell("A2").alignment = {
        horizontal: "left",
        vertical: "middle",
      };
      sheet.getCell("D2").alignment = {
        horizontal: "left",
        vertical: "middle",
        shrinkToFit: true,
      };
      sheet.getCell("E2").alignment = {
        horizontal: "left",
        vertical: "middle",
        shrinkToFit: true,
      };
      sheet.getCell("F2").alignment = {
        horizontal: "center",
        vertical: "middle",
        shrinkToFit: true,
      };

      const headers = [
        "序号",
        "发生日期",
        "事由",
        "内容说明、参与人员等",
        "安排人",
        "金额",
      ];
      headers.forEach((header, index) => {
        const cell = sheet.getRow(3).getCell(index + 1);
        cell.value = header;
        cell.font = { ...bodyFont, bold: true };
      });

      draft.expenses.forEach((expense, index) => {
        const row = sheet.getRow(expenseStartRow + index);
        row.getCell(1).value = index + 1;
        row.getCell(2).value = expense.occurredDate;
        row.getCell(3).value = expense.reason;
        row.getCell(4).value = expense.description || "";
        row.getCell(5).value = expense.arranger;
        row.getCell(6).value = expense.amountCents / 100;
        row.getCell(6).numFmt = "#,##0.00";
        for (let column = 1; column <= 6; column += 1) {
          row.getCell(column).alignment = {
            horizontal: "center",
            vertical: "middle",
            wrapText: true,
            shrinkToFit: column !== 4 && column !== 5,
          };
        }
      });

      sheet.getCell(`A${totalRow}`).value = "合计金额";
      sheet.getCell(`A${totalRow}`).font = { ...bodyFont, bold: true };
      sheet.getCell(`A${totalRow}`).alignment = {
        horizontal: "center",
        vertical: "middle",
      };
      const totalCell = sheet.getCell(`C${totalRow}`);
      totalCell.value =
        draft.totalOverrideCents === null
          ? {
              formula: `SUM(F${expenseStartRow}:F${expenseEndRow})`,
              result: calculatedTotal.value / 100,
            }
          : effectiveTotal.value / 100;
      totalCell.numFmt = '"￥"#,##0.00';
      totalCell.alignment = {
        horizontal: "left",
        vertical: "middle",
        indent: 1,
      };
      const uppercaseCell = sheet.getCell(`C${uppercaseRow}`);
      uppercaseCell.value = ChineseAmount(effectiveTotal.value);
      uppercaseCell.alignment = {
        horizontal: "left",
        vertical: "middle",
        indent: 1,
        shrinkToFit: true,
      };

      sheet.getCell(`A${paymentRow}`).value = {
        richText: [
          { font: { name: "宋体", size: 9 }, text: "收款信息：" },
          { font: { name: "宋体", size: 9, bold: true }, text: "名称：" },
          { font: { name: "宋体", size: 9 }, text: draft.payeeName || "" },
          {
            font: { name: "宋体", size: 9, bold: true },
            text: "\n　　　　　账号：",
          },
          { font: { name: "宋体", size: 9 }, text: draft.account || "" },
          {
            font: { name: "宋体", size: 9, bold: true },
            text: "\n　　　　　开户行：",
          },
          { font: { name: "宋体", size: 9 }, text: draft.bank || "" },
        ],
      };
      sheet.getCell(`A${paymentRow}`).alignment = {
        horizontal: "left",
        vertical: "middle",
        wrapText: true,
        indent: 1,
      };
      sheet.getCell(`A${approvalRow}`).value = getApprovalLine(draft);
      sheet.getCell(`A${approvalRow}`).alignment = {
        horizontal: "left",
        vertical: "middle",
        shrinkToFit: true,
        indent: 1,
      };

      // A:F is the complete printable table; columns G:M intentionally remain unstyled.
      for (let column = 7; column <= 13; column += 1)
        sheet.getRow(5).getCell(column).border = {};

      formPages.value.slice(0, -1).forEach((page) => {
        const lastRow = page.rows[page.rows.length - 1];
        if (lastRow)
          sheet.getRow(expenseStartRow + lastRow.index).addPageBreak();
      });

      let nextAttachmentRow = approvalRow + 1;
      let attachmentEndRow = approvalRow;
      if (!sharedAttachmentPage.value) sheet.getRow(approvalRow).addPageBreak();
      attachmentPagesForExport.forEach((attachment, index) => {
        const attachmentStartRow = nextAttachmentRow;
        const attachmentHeightPoints = attachment.height * 0.75;
        const attachmentRowCount = Math.max(
          1,
          Math.ceil(attachmentHeightPoints / 300),
        );
        attachmentEndRow = attachmentStartRow + attachmentRowCount - 1;
        for (
          let rowNumber = attachmentStartRow;
          rowNumber <= attachmentEndRow;
          rowNumber += 1
        ) {
          sheet.getRow(rowNumber).height =
            attachmentHeightPoints / attachmentRowCount;
        }

        const attachmentImageId = workbook.addImage({
          base64: attachment.dataUrl,
          extension: "png",
        });
        sheet.addImage(attachmentImageId, {
          tl: { col: 0, row: attachmentStartRow - 1 },
          br: { col: 6, row: attachmentEndRow },
          editAs: "oneCell",
        } as any);
        if (index < attachmentPagesForExport.length - 1)
          sheet.getRow(attachmentEndRow).addPageBreak();
        nextAttachmentRow = attachmentEndRow + 1;
      });

      sheet.pageSetup.orientation = "portrait";
      sheet.pageSetup.paperSize = 9;
      sheet.pageSetup.fitToPage = true;
      sheet.pageSetup.fitToWidth = 1;
      sheet.pageSetup.fitToHeight = previewPageCount.value;
      sheet.pageSetup.printTitlesRow = "1:3";
      sheet.pageSetup.margins = {
        left: 0.38,
        right: 0.38,
        top: 0.31,
        bottom: 0.28,
        header: 0,
        footer: 0,
      };
      sheet.pageSetup.horizontalCentered = true;
      sheet.pageSetup.verticalCentered = false;
      sheet.pageSetup.printArea = `A1:F${attachmentEndRow}`;

      const buffer = await workbook.xlsx.writeBuffer();
      const filename =
        today() + "_" + (draft.applicant || "未命名") + "_报销单.xlsx";
      const path = await saveExportBytes(
        new Uint8Array(buffer as ArrayBuffer),
        filename,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
      );
      if (!isAutoSaveSuppressed()) void persistDraft(false);
      ElMessage.success(path ? "Excel 已导出到：" + path : "Excel 已下载");
    } catch (error) {
      ElMessage.error(
        error instanceof Error ? error.message : "Excel 导出失败",
      );
    } finally {
      if (activeTab.value !== previousTab) activeTab.value = previousTab;
    }
  }

  async function exportPdf(sourceDraft?: Draft) {
    if (sourceDraft) {
      await withTemporaryDraft(sourceDraft, () => exportPdf());
      return;
    }
    commitActiveEdit();
    if (!draft.expenses.length)
      return ElMessage.warning("请先上传至少一张费用截图");
    if (isExportingPdf.value) return;

    isExportingPdf.value = true;
    const previousTab = activeTab.value;
    try {
      if (previousTab !== "reimbursement") {
        activeTab.value = "reimbursement";
        await nextTick();
        updateScale();
        await nextTick();
      }
      const pages = Array.from(
        document.querySelectorAll<HTMLElement>(".preview-pages .paper"),
      );
      const expectedPages = previewPageCount.value;
      if (pages.length !== expectedPages)
        throw new Error("PDF 页面尚未准备完成，请稍后重试");

      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      for (let index = 0; index < pages.length; index += 1) {
        const canvas = await captureElementForExport(
          pages[index],
          PAGE_WIDTH,
          PAGE_HEIGHT,
        );
        if (index > 0) pdf.addPage("a4", "portrait");
        pdf.addImage(
          canvas.toDataURL("image/jpeg", 0.96),
          "JPEG",
          0,
          0,
          210,
          297,
          undefined,
          "FAST",
        );
      }

      const bytes = new Uint8Array(pdf.output("arraybuffer"));
      const filename =
        today() + "_" + (draft.applicant || "未命名") + "_报销单.pdf";
      const path = await saveExportBytes(
        bytes,
        filename,
        "application/pdf",
        "pdf",
      );
      if (!isAutoSaveSuppressed()) void persistDraft(false);
      ElMessage.success(path ? "PDF 已导出到：" + path : "PDF 已下载");
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "PDF 导出失败");
    } finally {
      if (activeTab.value !== previousTab) activeTab.value = previousTab;
      isExportingPdf.value = false;
    }
  }

  function printCurrentPage() {
    window.print();
  }

  return {
    isExportingPdf,
    captureElementForExport,
    captureAttachmentPagesForExport,
    exportExcel,
    exportPdf,
    printCurrentPage,
  };
}
