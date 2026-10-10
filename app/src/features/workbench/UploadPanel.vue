<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { Iphone, Upload } from "@element-plus/icons-vue";
import { MAX_EXPENSES, MAX_TOTAL_ATTACHMENTS } from "../../constants/app";

const {
  uploadFocused,
  pasted,
  dropped,
  filesChanged,
  draft,
  previewAttachments,
  openLanUpload,
  openPicker,
  handwritingMode,
  uploadZone,
  fileInput,
} = toRefs(useAppContext());
</script>

<template>
  <section
    ref="uploadZone"
    class="upload-panel"
    tabindex="0"
    @focus="uploadFocused = true"
    @blur="uploadFocused = false"
    @paste="pasted"
    @dragover.prevent="uploadFocused = true"
    @drop.prevent="dropped"
  >
    <input
      ref="fileInput"
      class="hidden-file"
      type="file"
      accept="image/*"
      multiple
      @change="filesChanged"
    />
    <div class="upload-panel-header">
      <div>
        <span class="eyebrow">STEP 01</span>
        <h2>添加费用截图</h2>
      </div>
      <div class="upload-panel-actions">
        <el-button
          size="small"
          plain
          :icon="Iphone"
          :disabled="
            draft.expenses.length >= MAX_EXPENSES ||
            previewAttachments.length >= MAX_TOTAL_ATTACHMENTS
          "
          @click.stop="openLanUpload"
          >手机上传</el-button
        >
        <el-tag effect="plain" type="info"
          >{{ draft.expenses.length }}/{{ MAX_EXPENSES }}</el-tag
        >
      </div>
    </div>
    <button class="upload-dropzone" type="button" @click="openPicker">
      <span class="upload-icon"><Upload :size="22" /></span
      ><strong>点击选择或拖入图片</strong
      ><span>选中上传框后可直接 Ctrl+V 粘贴截图</span>
    </button>
    <div class="upload-options">
      <el-checkbox v-model="handwritingMode">使用通用手写体识别</el-checkbox
      ><span class="option-note">默认：全文识别高精版</span>
    </div>
  </section>
</template>
