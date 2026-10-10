<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import {
  ZoomOut,
  ZoomIn,
  Refresh,
  CopyDocument,
  RefreshLeft,
  RefreshRight,
} from "@element-plus/icons-vue";

const {
  previewPageCount,
  draft,
  dirty,
  companyNames,
  currentProfileId,
  profiles,
  changePreviewZoom,
  previewZoom,
  selectedAttachment,
  resetImage,
  cellSelection,
  copySelectedPaperCells,
  editingKey,
  isExportingPdf,
  changePreviewCompany,
  canUndoPreview,
  canRedoPreview,
  undoPreviewLabel,
  redoPreviewLabel,
  undoPreviewEdit,
  redoPreviewEdit,
} = toRefs(useAppContext());
</script>

<template>
  <div class="preview-toolbar">
    <div>
      <span class="eyebrow">STEP 03</span>
      <h1>{{ previewPageCount }} 页 A4 预览</h1>
    </div>
    <div class="preview-toolbar-right">
      <div class="preview-context-selects">
        <label class="preview-label-input">
          <span>标签</span>
          <el-input
            v-model="draft.label"
            clearable
            maxlength="80"
            placeholder="便于查询"
            @input="dirty"
          />
        </label>
        <label>
          <span>公司名称</span>
          <el-select
            :model-value="draft.companyName"
            @update:model-value="changePreviewCompany"
          >
            <el-option
              v-for="company in companyNames"
              :key="company"
              :label="company"
              :value="company"
            />
          </el-select>
        </label>
        <label>
          <span>申请人</span>
          <el-select
            v-model="currentProfileId"
            placeholder="选择申请人"
            aria-label="申请人"
          >
            <el-option
              v-for="profile in profiles"
              :key="profile.id"
              :label="profile.name || profile.applicant || '未命名申请人'"
              :value="profile.id"
            />
          </el-select>
        </label>
      </div>
      <el-segmented
        v-model="draft.previewMode"
        :options="[
          { label: '附件同页', value: 'single' },
          { label: '附件分页', value: 'double' },
        ]"
        @change="dirty"
      />
      <div class="preview-zoom-tools">
        <el-button
          circle
          text
          :icon="ZoomOut"
          title="缩小预览"
          @click="changePreviewZoom(-0.1)"
        />
        <span>{{ Math.round(previewZoom * 100) }}%</span>
        <el-button
          circle
          text
          :icon="ZoomIn"
          title="放大预览"
          @click="changePreviewZoom(0.1)"
        />
      </div>
      <el-button
        circle
        text
        :icon="Refresh"
        title="重置当前图片排版"
        :disabled="!selectedAttachment"
        @click="resetImage"
      />
      <el-button
        circle
        text
        :icon="CopyDocument"
        title="复制选中的单元格"
        :disabled="!cellSelection"
        @click="copySelectedPaperCells"
      />
      <el-button
        circle
        text
        :icon="RefreshLeft"
        :title="
          undoPreviewLabel
            ? `撤销：${undoPreviewLabel}（Ctrl+Z）`
            : '撤销（Ctrl+Z）'
        "
        aria-label="撤销预览编辑"
        :disabled="isExportingPdf || (!canUndoPreview && !editingKey)"
        @click="undoPreviewEdit"
      />
      <el-button
        circle
        text
        :icon="RefreshRight"
        :title="
          redoPreviewLabel
            ? `重做：${redoPreviewLabel}（Ctrl+Shift+Z）`
            : '重做（Ctrl+Shift+Z）'
        "
        aria-label="重做预览编辑"
        :disabled="isExportingPdf || !canRedoPreview"
        @click="redoPreviewEdit"
      />
    </div>
  </div>
</template>
