<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { REIMBURSEMENT_STATUSES } from "../../constants/app";
import {
  ArrowLeftBold,
  View,
  EditPen,
  Printer,
  Download,
  Delete,
  CopyDocument,
  Clock,
  Folder,
} from "@element-plus/icons-vue";
import {
  money,
  formatDateTime,
  reimbursementStatusType,
} from "../../utils/format";

const {
  activeTab,
  filteredHistory,
  historySearch,
  historyDate,
  historyStatus,
  historyViewMode,
  historyFolderKey,
  historyFolders,
  openHistoryFolder,
  leaveHistoryFolder,
  historyCurrentFolder,
  historyResultTotal,
  pagedHistory,
  openHistoryPreview,
  lastEditedHistoryId,
  cycleHistoryStatus,
  editHistory,
  printHistory,
  exportHistoryExcel,
  exportHistoryPdf,
  removeHistory,
  isHistoryQueryLoading,
  historyPage,
  historyPageSize,
  isHistoryPreviewOpen,
  historyPreviewItem,
  createFromHistoryTemplate,
  removeHistoryFromPreview,
  historyPreviewDraft,
  copyOriginalImage,
  saveOriginalImage,
  openOriginalImageFolder,
  isHistoryPreviewLoading,
} = toRefs(useAppContext());
</script>

<template>
  <section v-if="activeTab === 'history'" class="page-shell history-page">
    <div class="page-heading">
      <div>
        <span class="eyebrow">ARCHIVE</span>
        <h1>历史记录</h1>
      </div>
      <span class="page-count">{{ filteredHistory.length }} 条记录</span>
    </div>
    <div class="history-toolbar">
      <el-input
        v-model="historySearch"
        clearable
        placeholder="按标签、公司、申请人或记录编号搜索"
      />
      <el-date-picker
        v-model="historyDate"
        type="date"
        value-format="YYYY-MM-DD"
        clearable
        placeholder="按发生日期筛选"
      />
      <el-select v-model="historyStatus" clearable placeholder="全部状态">
        <el-option
          v-for="status in REIMBURSEMENT_STATUSES"
          :key="status"
          :label="status"
          :value="status"
        />
      </el-select>
      <el-radio-group v-model="historyViewMode" size="small">
        <el-radio-button label="company">公司文件夹</el-radio-button>
        <el-radio-button label="status">状态文件夹</el-radio-button>
        <el-radio-button label="list">列表</el-radio-button>
      </el-radio-group>
    </div>
    <div v-if="!filteredHistory.length" class="history-empty">
      <Clock :size="25" /><strong>还没有已保存的历史记录</strong
      ><span>点击“保存草稿”后，记录会保存在本机。</span>
    </div>
    <template v-else>
      <div
        v-if="historyViewMode !== 'list' && !historyFolderKey"
        class="history-folder-grid"
      >
        <button
          v-for="folder in historyFolders"
          :key="folder.key"
          type="button"
          class="history-folder-card"
          @click="openHistoryFolder(folder)"
        >
          <Folder :size="28" />
          <strong>{{ folder.label }}</strong>
          <span>{{ folder.count }} 条单据</span>
          <small v-if="folder.deleted">设置中已删除</small>
        </button>
      </div>
      <template v-else>
        <div v-if="historyViewMode !== 'list'" class="history-breadcrumb">
          <el-button text :icon="ArrowLeftBold" @click="leaveHistoryFolder"
            >全部文件夹</el-button
          ><span>/</span><strong>{{ historyCurrentFolder?.label }}</strong>
        </div>
        <div v-if="!historyResultTotal" class="history-empty">
          <Clock :size="25" /><strong>当前筛选下没有单据</strong>
        </div>
        <div v-else v-loading="isHistoryQueryLoading" class="history-list">
          <article
            v-for="item in pagedHistory"
            :key="item.id"
            class="history-item"
            @click="openHistoryPreview(item)"
          >
            <div class="history-item-main">
              <div class="history-item-title">
                <strong>{{ item.companyName || "未填写公司" }}</strong>
                <span>{{ item.applicant || "未填写申请人" }}</span>
                <el-tag v-if="item.label" size="small" effect="plain">{{
                  item.label
                }}</el-tag>
                <el-tag
                  v-if="item.id === lastEditedHistoryId"
                  size="small"
                  effect="plain"
                  type="primary"
                  >上次编辑</el-tag
                >
              </div>
              <strong class="history-occurred-date">{{
                item.firstOccurredDate || "未填写发生日期"
              }}</strong>
              <span
                >{{ item.expenseCount }} 笔 · ￥{{ money(item.totalCents) }} ·
                编辑于 {{ formatDateTime(item.updatedAt) }}</span
              >
              <small>{{ item.id }}</small>
            </div>
            <div class="history-item-actions">
              <el-tag
                class="history-status"
                :type="reimbursementStatusType(item.status)"
                effect="light"
                title="点击切换报销状态"
                @click.stop="cycleHistoryStatus(item)"
                >{{ item.status }}</el-tag
              >
              <el-button
                circle
                text
                :icon="View"
                title="查看详情"
                @click.stop="openHistoryPreview(item)"
              /><el-button
                circle
                text
                :icon="EditPen"
                title="修改"
                @click.stop="editHistory(item)"
              /><el-button
                circle
                text
                :icon="Printer"
                title="打印"
                @click.stop="printHistory(item)"
              /><el-dropdown trigger="click" @click.stop>
                <el-button circle text :icon="Download" title="导出" />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="exportHistoryExcel(item)">
                      导出 Excel
                    </el-dropdown-item>
                    <el-dropdown-item @click="exportHistoryPdf(item)">
                      导出 PDF
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template> </el-dropdown
              ><el-button
                circle
                text
                type="danger"
                :icon="Delete"
                title="删除历史记录"
                @click.stop="removeHistory(item)"
              />
            </div>
          </article>
        </div>
        <div v-if="historyResultTotal" class="history-pagination">
          <el-pagination
            v-model:current-page="historyPage"
            v-model:page-size="historyPageSize"
            background
            layout="total, prev, pager, next"
            :total="historyResultTotal"
          />
        </div>
      </template>
    </template>
  </section>
  <el-dialog
    v-model="isHistoryPreviewOpen"
    title="历史报销单详情"
    width="980px"
    destroy-on-close
  >
    <div v-loading="isHistoryPreviewLoading" class="history-preview-dialog">
      <template v-if="historyPreviewDraft && historyPreviewItem">
        <div class="history-preview-summary">
          <div>
            <span class="eyebrow">READ ONLY PREVIEW</span>
            <h2>
              {{ historyPreviewDraft.companyName || "未填写公司" }}费用报销单
            </h2>
            <p>
              {{ historyPreviewItem.firstOccurredDate || "未填写发生日期" }} ·
              {{ historyPreviewDraft.expenses.length }} 笔 · ￥{{
                money(historyPreviewItem.totalCents)
              }}
            </p>
            <small class="history-preview-meta">
              申请人：{{ historyPreviewDraft.applicant || "未填写" }} ·
              所属部门：{{ historyPreviewDraft.department || "未填写" }}
              <template v-if="historyPreviewDraft.reimbursementDate">
                · 报销日期：{{ historyPreviewDraft.reimbursementDate }}
              </template>
              <br />
              报销单编号：{{ historyPreviewDraft.id }}
            </small>
          </div>
          <el-tag :type="reimbursementStatusType(historyPreviewItem.status)">
            {{ historyPreviewItem.status }}
          </el-tag>
        </div>
        <div class="history-preview-table-wrap">
          <table class="history-preview-table">
            <thead>
              <tr>
                <th>序号</th>
                <th>发生日期</th>
                <th>事由</th>
                <th>内容说明、参与人员等</th>
                <th>安排人</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(expense, index) in historyPreviewDraft.expenses"
                :key="expense.id"
              >
                <td>{{ index + 1 }}</td>
                <td>{{ expense.occurredDate }}</td>
                <td>{{ expense.reason }}</td>
                <td class="preview-description">
                  {{ expense.description || "" }}
                </td>
                <td class="preview-description">{{ expense.arranger }}</td>
                <td>{{ money(expense.amountCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="history-preview-attachments">
          <template
            v-for="expense in historyPreviewDraft.expenses"
            :key="expense.id"
          >
            <div class="history-preview-image">
              <el-image
                :src="expense.imageDataUrl"
                fit="cover"
                :preview-src-list="[expense.imageDataUrl]"
              />
              <div class="history-preview-image-actions">
                <el-button
                  text
                  title="复制原图"
                  @click="copyOriginalImage(expense)"
                  ><CopyDocument :size="14"
                /></el-button>
                <el-button
                  text
                  title="另存原图"
                  @click="saveOriginalImage(expense)"
                  ><Download :size="14"
                /></el-button>
                <el-button
                  text
                  title="打开所在目录"
                  @click="
                    openOriginalImageFolder(expense, historyPreviewDraft.id)
                  "
                  ><Folder :size="14"
                /></el-button>
              </div>
            </div>
            <div
              v-for="attachment in expense.extraAttachments"
              :key="attachment.id"
              class="history-preview-image"
            >
              <el-image
                :src="attachment.imageDataUrl"
                fit="cover"
                :preview-src-list="[attachment.imageDataUrl]"
              />
              <div class="history-preview-image-actions">
                <el-button
                  text
                  title="复制原图"
                  @click="copyOriginalImage(attachment)"
                  ><CopyDocument :size="14"
                /></el-button>
                <el-button
                  text
                  title="另存原图"
                  @click="saveOriginalImage(attachment)"
                  ><Download :size="14"
                /></el-button>
                <el-button
                  text
                  title="打开所在目录"
                  @click="
                    openOriginalImageFolder(attachment, historyPreviewDraft.id)
                  "
                  ><Folder :size="14"
                /></el-button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
    <template #footer>
      <el-button @click="isHistoryPreviewOpen = false">关闭</el-button>
      <el-button
        v-if="historyPreviewItem"
        :type="reimbursementStatusType(historyPreviewItem.status)"
        @click="cycleHistoryStatus(historyPreviewItem)"
        >切换状态</el-button
      >
      <el-button
        v-if="historyPreviewItem"
        :icon="Download"
        @click="exportHistoryExcel(historyPreviewItem)"
        >导出 Excel</el-button
      >
      <el-button
        v-if="historyPreviewItem"
        :icon="Printer"
        @click="printHistory(historyPreviewItem)"
        >打印</el-button
      >
      <el-button
        v-if="historyPreviewItem"
        :icon="CopyDocument"
        @click="createFromHistoryTemplate(historyPreviewItem)"
        >以此为模板新建</el-button
      >
      <el-button
        v-if="historyPreviewItem"
        type="danger"
        :icon="Delete"
        @click="removeHistoryFromPreview(historyPreviewItem)"
        >删除</el-button
      >
      <el-button
        v-if="historyPreviewItem"
        type="primary"
        :icon="EditPen"
        @click="editHistory(historyPreviewItem)"
        >修改</el-button
      >
    </template>
  </el-dialog>
</template>
