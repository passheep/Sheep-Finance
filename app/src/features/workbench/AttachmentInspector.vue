<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import {
  CopyDocument,
  Download,
  Folder,
  Refresh,
  EditPen,
  Delete,
} from "@element-plus/icons-vue";

const {
  selectedAttachment,
  copyOriginalImage,
  saveOriginalImage,
  openOriginalImageFolder,
  resetImage,
  rotate,
  removeSelectedAttachment,
  dirty,
} = toRefs(useAppContext());
</script>

<template>
  <div v-if="selectedAttachment" class="image-inspector">
    <div class="inspector-title">
      <div>
        <span class="eyebrow">SELECTED IMAGE</span
        ><strong>{{ selectedAttachment.fileName }}</strong>
      </div>
      <div class="inspector-actions">
        <el-button
          circle
          text
          :icon="CopyDocument"
          title="复制原图"
          @click="copyOriginalImage()"
        /><el-button
          circle
          text
          :icon="Download"
          title="另存原图"
          @click="saveOriginalImage()"
        /><el-button
          circle
          text
          :icon="Folder"
          title="打开所在目录"
          @click="openOriginalImageFolder()"
        />
        <el-button
          circle
          text
          :icon="Refresh"
          title="恢复默认位置"
          @click="resetImage"
        /><el-button
          circle
          text
          :icon="EditPen"
          title="旋转90度"
          @click="rotate"
        /><el-button
          circle
          text
          type="danger"
          :icon="Delete"
          :title="
            selectedAttachment.isPrimary ? '删除这笔费用' : '删除附加图片'
          "
          @click="removeSelectedAttachment"
        />
      </div>
    </div>
    <label
      >裁剪缩放<input
        v-model.number="selectedAttachment.transform.cropZoom"
        type="range"
        min="1"
        max="2.4"
        step="0.05"
        @input="dirty"
      /><output
        >{{ selectedAttachment.transform.cropZoom.toFixed(2) }}x</output
      ></label
    ><label
      >横向取景<input
        v-model.number="selectedAttachment.transform.cropX"
        type="range"
        min="0"
        max="100"
        step="1"
        @input="dirty"
      /><output>{{ selectedAttachment.transform.cropX }}%</output></label
    ><label
      >纵向取景<input
        v-model.number="selectedAttachment.transform.cropY"
        type="range"
        min="0"
        max="100"
        step="1"
        @input="dirty"
      /><output>{{ selectedAttachment.transform.cropY }}%</output></label
    >
  </div>
</template>
