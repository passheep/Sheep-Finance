import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { RequestLogRecord, RequestLogSummary } from "../types/models";
import {
  getRequestLog,
  listRequestLogs,
  clearRequestLogs as clearRequestLogsService,
} from "../services/requestLogService";
import { errorMessage, isTauriRuntime } from "../services/runtimeService";

export interface RequestLogsContext {
  requestRecords: ReturnType<typeof ref<RequestLogSummary[]>>;
}

export function useRequestLogs() {
  const requestRecords = ref<RequestLogSummary[]>([]);
  const requestSearch = ref("");
  const requestService = ref<"ocr" | "llm" | "">("");
  const requestStatus = ref<"success" | "error" | "">("");
  const requestPage = ref(1);
  const requestPageSize = ref(10);
  const isRequestLoading = ref(false);
  const isRequestDetailOpen = ref(false);
  const isRequestDetailLoading = ref(false);
  const requestDetail = ref<RequestLogRecord | null>(null);
  const filteredRequests = computed(() => {
    const keyword = requestSearch.value.trim().toLowerCase();
    return requestRecords.value.filter((item) => {
      const matchesKeyword =
        !keyword ||
        `${item.fileName} ${item.profileName} ${item.model ?? ""} ${item.action ?? ""} ${item.requestUrl} ${item.error ?? ""}`
          .toLowerCase()
          .includes(keyword);
      const matchesService =
        !requestService.value || item.service === requestService.value;
      const matchesStatus =
        !requestStatus.value ||
        (requestStatus.value === "success" ? item.success : !item.success);
      return matchesKeyword && matchesService && matchesStatus;
    });
  });
  const pagedRequests = computed(() =>
    filteredRequests.value.slice(
      (requestPage.value - 1) * requestPageSize.value,
      requestPage.value * requestPageSize.value,
    ),
  );

  async function loadRequestLogs() {
    if (!isTauriRuntime()) {
      requestRecords.value = [];
      return;
    }
    isRequestLoading.value = true;
    try {
      requestRecords.value = await listRequestLogs();
    } catch (error) {
      ElMessage.error(`请求记录读取失败：${errorMessage(error)}`);
    } finally {
      isRequestLoading.value = false;
    }
  }

  async function openRequestDetail(item: RequestLogSummary) {
    if (!isTauriRuntime()) return;
    isRequestDetailOpen.value = true;
    isRequestDetailLoading.value = true;
    requestDetail.value = null;
    try {
      requestDetail.value = await getRequestLog(item.id);
    } catch (error) {
      ElMessage.error(`请求详情读取失败：${errorMessage(error)}`);
      isRequestDetailOpen.value = false;
    } finally {
      isRequestDetailLoading.value = false;
    }
  }

  async function clearRequestLogs() {
    if (!requestRecords.value.length || !isTauriRuntime()) return;
    try {
      await ElMessageBox.confirm(
        "确定清空本机保存的全部 OCR 和大模型请求记录吗？",
        "清空请求记录",
        {
          confirmButtonText: "清空",
          cancelButtonText: "取消",
          type: "warning",
        },
      );
    } catch {
      return;
    }
    try {
      await clearRequestLogsService();
      requestRecords.value = [];
      requestDetail.value = null;
      ElMessage.success("请求记录已清空");
    } catch (error) {
      ElMessage.error(`请求记录清空失败：${errorMessage(error)}`);
    }
  }

  return {
    requestRecords,
    requestSearch,
    requestService,
    requestStatus,
    requestPage,
    requestPageSize,
    isRequestLoading,
    isRequestDetailOpen,
    isRequestDetailLoading,
    requestDetail,
    filteredRequests,
    pagedRequests,
    loadRequestLogs,
    openRequestDetail,
    clearRequestLogs,
  };
}
