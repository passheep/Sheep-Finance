<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import { money } from "../../utils/format";
import {
  Iphone,
  ArrowLeftBold,
  ArrowRightBold,
  Delete,
  Refresh,
  CopyDocument,
  Upload,
} from "@element-plus/icons-vue";
import { MAX_ATTACHMENTS_PER_EXPENSE } from "../../constants/app";

const {
  isOcrResultOpen,
  ocrResultExpense,
  recognizeExpense,
  isExtraUploadOpen,
  extraUploadExpense,
  draft,
  extraUploadExpenseId,
  extraUploadFocused,
  extraPasted,
  extraDropped,
  extraFilesChanged,
  extraAttachmentSlots,
  openLanUpload,
  openExtraPicker,
  moveExtraAttachment,
  removeExtraAttachment,
  isLanUploadOpen,
  stopLanUploadSession,
  isLanUploadLoading,
  lanUploadRemainingSlots,
  refreshLanUploadSession,
  lanUploadError,
  lanUploadSession,
  lanUploadQrCode,
  lanUploadLabel,
  lanUploadSecondsRemaining,
  lanUploadExpiryText,
  copyLanUploadUrl,
  extraUploadZone,
  extraFileInput,
} = toRefs(useAppContext());
</script>

<template>
  <el-dialog v-model="isOcrResultOpen" title="识别结果" width="680px">
    <template v-if="ocrResultExpense">
      <el-alert
        v-if="ocrResultExpense.recognitionError"
        :title="ocrResultExpense.recognitionError"
        type="warning"
        :closable="false"
        show-icon
      />
      <div class="recognition-meta">
        <span>{{
          ocrResultExpense.ocrMode === "handwriting"
            ? "通用手写体识别"
            : "全文识别高精版"
        }}</span
        ><span v-if="ocrResultExpense.lastOcrProfile"
          >{{ ocrResultExpense.lastOcrProfile }} +
          {{ ocrResultExpense.lastLlmProfile }}</span
        ><span v-if="ocrResultExpense.lastRecognitionMs"
          >{{ ocrResultExpense.lastRecognitionMs }} ms</span
        >
      </div>
      <div v-if="ocrResultExpense.recognizedFields" class="recognition-fields">
        <div>
          <span>发生日期</span
          ><strong>{{
            ocrResultExpense.recognizedFields.occurredDate || "未提取"
          }}</strong>
        </div>
        <div>
          <span>事由</span
          ><strong>{{
            ocrResultExpense.recognizedFields.reason || "未提取"
          }}</strong>
        </div>
        <div>
          <span>金额</span
          ><strong>{{
            ocrResultExpense.recognizedFields.amountCents === undefined
              ? "未提取"
              : `￥${money(ocrResultExpense.recognizedFields.amountCents)}`
          }}</strong>
        </div>
        <div class="recognition-description">
          <span>内容说明</span
          ><strong>{{
            ocrResultExpense.recognizedFields.description || "未提取"
          }}</strong>
        </div>
      </div>
      <h4>AI 返回记录</h4>
      <pre class="ai-text">{{
        ocrResultExpense.llmText ||
        (ocrResultExpense.recognitionError
          ? "本次未取得 AI 返回内容"
          : "尚无 AI 返回记录")
      }}</pre>
      <h4>OCR 原文</h4>
      <pre class="ocr-text">{{
        ocrResultExpense.ocrText || "尚无 OCR 原文"
      }}</pre>
    </template>
    <template #footer
      ><el-button @click="isOcrResultOpen = false">关闭</el-button
      ><el-button
        v-if="ocrResultExpense"
        type="primary"
        :loading="ocrResultExpense.ocrStatus === 'recognizing'"
        @click="recognizeExpense(ocrResultExpense)"
        >重新识别</el-button
      ></template
    >
  </el-dialog>
  <el-dialog
    v-model="isExtraUploadOpen"
    :title="
      extraUploadExpense
        ? '添加附图 · 费用 ' + (draft.expenses.indexOf(extraUploadExpense) + 1)
        : '添加附图'
    "
    width="680px"
    destroy-on-close
    @closed="extraUploadExpenseId = null"
  >
    <template v-if="extraUploadExpense">
      <section
        ref="extraUploadZone"
        class="upload-panel extra-upload-panel"
        tabindex="0"
        @focus="extraUploadFocused = true"
        @blur="extraUploadFocused = false"
        @paste="extraPasted"
        @dragover.prevent="extraUploadFocused = true"
        @drop.prevent="extraDropped"
      >
        <input
          ref="extraFileInput"
          class="hidden-file"
          type="file"
          accept="image/*"
          multiple
          @change="extraFilesChanged"
        />
        <div class="upload-panel-header">
          <div>
            <span class="eyebrow">EXTRA ATTACHMENTS</span>
            <h2>添加附加图片</h2>
          </div>
          <div class="upload-panel-actions">
            <el-button
              size="small"
              plain
              :icon="Iphone"
              :disabled="!extraAttachmentSlots(extraUploadExpense)"
              @click.stop="openLanUpload(extraUploadExpense)"
              >手机上传</el-button
            >
            <el-tag effect="plain" type="info"
              >本笔 {{ extraUploadExpense.extraAttachments.length + 1 }}/{{
                MAX_ATTACHMENTS_PER_EXPENSE
              }}</el-tag
            >
          </div>
        </div>
        <button
          class="upload-dropzone"
          type="button"
          :disabled="!extraAttachmentSlots(extraUploadExpense)"
          @click="openExtraPicker"
        >
          <span class="upload-icon"><Upload :size="22" /></span
          ><strong>点击选择或拖入附加图片</strong
          ><span>选中上传框后可直接 Ctrl+V 粘贴截图，不执行智能识别</span>
        </button>
      </section>
      <div
        v-if="extraUploadExpense.extraAttachments.length"
        class="extra-dialog-list"
      >
        <div
          v-for="(
            attachment, attachmentIndex
          ) in extraUploadExpense.extraAttachments"
          :key="attachment.id"
          class="extra-dialog-item"
        >
          <el-image
            :src="attachment.imageDataUrl"
            :alt="attachment.fileName"
            fit="cover"
            :preview-src-list="
              extraUploadExpense.extraAttachments.map(
                (item) => item.imageDataUrl,
              )
            "
            :initial-index="attachmentIndex"
            preview-teleported
            hide-on-click-modal
          />
          <span :title="attachment.fileName">{{ attachment.fileName }}</span>
          <div>
            <el-button
              circle
              text
              :icon="ArrowLeftBold"
              title="向前移动"
              :disabled="attachmentIndex === 0"
              @click="moveExtraAttachment(extraUploadExpense, attachment, -1)"
            />
            <el-button
              circle
              text
              :icon="ArrowRightBold"
              title="向后移动"
              :disabled="
                attachmentIndex ===
                extraUploadExpense.extraAttachments.length - 1
              "
              @click="moveExtraAttachment(extraUploadExpense, attachment, 1)"
            />
            <el-button
              circle
              text
              type="danger"
              :icon="Delete"
              title="删除附加图片"
              @click="removeExtraAttachment(extraUploadExpense, attachment)"
            />
          </div>
        </div>
      </div>
    </template>
    <template #footer>
      <el-button @click="isExtraUploadOpen = false">完成</el-button>
    </template>
  </el-dialog>
  <el-dialog
    v-model="isLanUploadOpen"
    title="手机扫码上传"
    width="520px"
    destroy-on-close
    @closed="stopLanUploadSession"
  >
    <div v-loading="isLanUploadLoading" class="lan-upload-dialog">
      <el-alert
        v-if="lanUploadError"
        :title="lanUploadError"
        type="error"
        :closable="false"
        show-icon
      />
      <template v-if="lanUploadSession && lanUploadQrCode">
        <div class="lan-upload-main">
          <img
            class="lan-upload-qr"
            :src="lanUploadQrCode"
            alt="手机上传二维码"
          />
          <div class="lan-upload-summary">
            <span class="eyebrow">CURRENT RECORD</span>
            <strong>{{ lanUploadLabel }}</strong>
            <span>编号 {{ draft.id.slice(-12) }}</span>
            <div class="lan-upload-metrics">
              <span
                ><b>{{ lanUploadSession.remainingSlots }}</b> 个位置</span
              >
              <span :class="{ expired: !lanUploadSecondsRemaining }"
                ><b>{{ lanUploadExpiryText }}</b> 有效期</span
              >
            </div>
          </div>
        </div>
        <el-input
          :model-value="lanUploadSession.url"
          readonly
          aria-label="手机上传地址"
        >
          <template #append>
            <el-button
              :icon="CopyDocument"
              title="复制上传地址"
              @click="copyLanUploadUrl"
            />
          </template>
        </el-input>
        <div class="lan-upload-network">
          <span>监听地址 {{ lanUploadSession.localAddress }}</span>
          <span>手机与电脑需连接同一局域网</span>
        </div>
        <el-alert
          title="手机无法打开时，请允许报销单助手通过 Windows 防火墙，并确认 Wi-Fi 未开启设备隔离。"
          type="info"
          :closable="false"
          show-icon
        />
      </template>
      <div
        v-else-if="!isLanUploadLoading && !lanUploadError"
        class="lan-upload-empty"
      >
        正在准备局域网上传地址
      </div>
    </div>
    <template #footer>
      <el-button @click="isLanUploadOpen = false">关闭</el-button>
      <el-button
        type="primary"
        :icon="Refresh"
        :loading="isLanUploadLoading"
        :disabled="!lanUploadRemainingSlots()"
        @click="refreshLanUploadSession"
        >刷新二维码</el-button
      >
    </template>
  </el-dialog>
</template>
