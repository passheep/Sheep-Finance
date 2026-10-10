<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../composables/appContext";
import { Refresh, Delete, View, Connection } from "@element-plus/icons-vue";

const {
  activeTab,
  isRequestLoading,
  loadRequestLogs,
  requestRecords,
  clearRequestLogs,
  requestSearch,
  requestService,
  requestStatus,
  filteredRequests,
  pagedRequests,
  openRequestDetail,
  requestPage,
  requestPageSize,
  isRequestDetailOpen,
  requestDetail,
  isRequestDetailLoading,
} = toRefs(useAppContext());

function requestServiceLabel(service: "ocr" | "llm") {
  return service === "ocr" ? "OCR" : "大模型";
}

function formatRequestTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section v-if="activeTab === 'requests'" class="page-shell requests-page">
    <div class="page-heading">
      <div>
        <span class="eyebrow">DIAGNOSTICS</span>
        <h1>请求记录</h1>
      </div>
      <div class="request-page-actions">
        <el-button
          plain
          :icon="Refresh"
          :loading="isRequestLoading"
          @click="loadRequestLogs"
          >刷新</el-button
        >
        <el-button
          plain
          type="danger"
          :icon="Delete"
          :disabled="!requestRecords.length"
          @click="clearRequestLogs"
          >清空记录</el-button
        >
      </div>
    </div>
    <div class="request-toolbar">
      <el-input
        v-model="requestSearch"
        clearable
        placeholder="搜索文件、配置、模型、地址或错误"
      />
      <el-select v-model="requestService" clearable placeholder="全部服务">
        <el-option label="OCR" value="ocr" />
        <el-option label="大模型" value="llm" />
      </el-select>
      <el-select v-model="requestStatus" clearable placeholder="全部状态">
        <el-option label="成功" value="success" />
        <el-option label="失败" value="error" />
      </el-select>
    </div>
    <div v-loading="isRequestLoading">
      <div v-if="!filteredRequests.length" class="history-empty">
        <Connection :size="25" />
        <strong>还没有请求记录</strong>
        <span>执行 OCR 或大模型识别后，会在本机保存脱敏记录</span>
      </div>
      <div v-else class="request-list">
        <article
          v-for="item in pagedRequests"
          :key="item.id"
          class="request-item"
          @click="openRequestDetail(item)"
        >
          <div class="request-item-status">
            <el-tag
              effect="plain"
              :type="item.service === 'ocr' ? 'warning' : 'primary'"
              >{{ requestServiceLabel(item.service) }}</el-tag
            >
            <el-tag effect="dark" :type="item.success ? 'success' : 'danger'">{{
              item.success ? "成功" : "失败"
            }}</el-tag>
          </div>
          <div class="request-item-main">
            <strong>{{ item.fileName || "未命名费用图片" }}</strong>
            <span :title="item.requestUrl">{{ item.requestUrl }}</span>
            <small>
              {{ item.profileName }}
              <template v-if="item.model"> · {{ item.model }}</template>
              <template v-if="item.action"> · {{ item.action }}</template>
            </small>
          </div>
          <div class="request-item-meta">
            <span>{{ formatRequestTime(item.requestedAt) }}</span>
            <span>{{ item.durationMs }} ms</span>
            <span v-if="item.httpStatus">HTTP {{ item.httpStatus }}</span>
          </div>
          <el-button
            circle
            text
            :icon="View"
            title="查看请求详情"
            @click.stop="openRequestDetail(item)"
          />
        </article>
      </div>
    </div>
    <div v-if="filteredRequests.length" class="history-pagination">
      <el-pagination
        v-model:current-page="requestPage"
        v-model:page-size="requestPageSize"
        background
        layout="total, prev, pager, next"
        :total="filteredRequests.length"
      />
    </div>
  </section>
  <el-dialog
    v-model="isRequestDetailOpen"
    title="请求详情"
    width="900px"
    destroy-on-close
  >
    <div v-loading="isRequestDetailLoading" class="request-detail">
      <template v-if="requestDetail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="服务">
            {{ requestServiceLabel(requestDetail.service) }}
          </el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="requestDetail.success ? 'success' : 'danger'">
              {{ requestDetail.success ? "成功" : "失败" }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="请求时间">
            {{ formatRequestTime(requestDetail.requestedAt) }}
          </el-descriptions-item>
          <el-descriptions-item label="耗时">
            {{ requestDetail.durationMs }} ms
          </el-descriptions-item>
          <el-descriptions-item label="配置">
            {{ requestDetail.profileName }}
          </el-descriptions-item>
          <el-descriptions-item label="模型 / Action">
            {{ requestDetail.model || requestDetail.action || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="关联图片">
            {{ requestDetail.fileName || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="HTTP 状态">
            {{ requestDetail.httpStatus || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="请求地址" :span="2">
            <span class="request-detail-url">{{
              requestDetail.requestUrl
            }}</span>
          </el-descriptions-item>
          <el-descriptions-item
            v-if="requestDetail.error"
            label="错误信息"
            :span="2"
          >
            {{ requestDetail.error }}
          </el-descriptions-item>
        </el-descriptions>
        <h4>请求内容（密钥与图片数据已脱敏）</h4>
        <pre>{{ requestDetail.requestContent }}</pre>
        <h4>响应内容</h4>
        <pre>{{ requestDetail.responseContent || "未取得响应内容" }}</pre>
      </template>
    </div>
    <template #footer>
      <el-button @click="isRequestDetailOpen = false">关闭</el-button>
    </template>
  </el-dialog>
</template>
