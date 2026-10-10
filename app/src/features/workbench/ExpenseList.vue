<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import {
  Refresh,
  Document,
  Delete,
  Plus,
  ArrowLeftBold,
  ArrowRightBold,
  Picture,
  Sort,
} from "@element-plus/icons-vue";

const {
  draft,
  selectedId,
  expenseDragState,
  selectExpense,
  ocrStatusLabel,
  recognizeExpense,
  openOcrResult,
  removeExpense,
  dirty,
  expenseReasons,
  amountInputValue,
  beginAmountInput,
  updateAmountInput,
  commitAmountInput,
  arrangers,
  extraAttachmentSlots,
  openExtraUpload,
  moveExtraAttachment,
  removeExtraAttachment,
} = toRefs(useAppContext());
</script>

<template>
  <section class="expense-panel">
    <div class="section-heading">
      <div>
        <span class="eyebrow">STEP 02</span>
        <h2>费用列表</h2>
      </div>
      <span class="muted-count">{{ draft.expenses.length }} 笔</span>
    </div>
    <div v-if="!draft.expenses.length" class="empty-expenses">
      <Picture :size="24" /><strong>还没有费用截图</strong
      ><span>添加一张图片后，会自动生成一笔费用</span>
    </div>
    <div v-else class="expense-list">
      <article
        v-for="(expense, index) in draft.expenses"
        :key="expense.id"
        :data-expense-id="expense.id"
        class="expense-card"
        :class="{
          active: expense.id === selectedId,
          dragging:
            expenseDragState?.surface === 'list' &&
            expenseDragState.id === expense.id,
        }"
        @click="selectExpense(expense)"
      >
        <div class="expense-card-topline">
          <span class="drag-handle" title="拖动调整顺序" @click.stop
            ><Sort :size="15" /></span
          ><span class="expense-index">{{ index + 1 }}</span
          ><el-image
            class="expense-thumbnail"
            :src="expense.imageDataUrl"
            :alt="expense.fileName"
            fit="cover"
            :preview-src-list="[expense.imageDataUrl]"
            :initial-index="0"
            preview-teleported
            hide-on-click-modal
            @click.stop
          />
          <div class="expense-summary">
            <strong>{{ expense.reason || "未选择事由" }}</strong
            ><span>{{ expense.fileName }}</span
            ><span
              class="expense-status"
              :class="expense.ocrStatus"
              :title="expense.recognitionError || ocrStatusLabel(expense)"
              ><span class="status-dot" />{{ ocrStatusLabel(expense) }}</span
            >
          </div>
          <div class="expense-actions">
            <el-button
              circle
              text
              :icon="Refresh"
              :loading="expense.ocrStatus === 'recognizing'"
              title="重新识别"
              @click.stop="recognizeExpense(expense)"
            /><el-button
              v-if="
                expense.ocrText || expense.llmText || expense.recognitionError
              "
              circle
              text
              :icon="Document"
              title="查看识别结果"
              @click.stop="openOcrResult(expense)"
            /><el-button
              circle
              text
              type="danger"
              :icon="Delete"
              title="删除费用"
              @click.stop="removeExpense(expense)"
            />
          </div>
        </div>
        <div class="expense-mini-fields">
          <el-date-picker
            v-model="expense.occurredDate"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="发生日期"
            @change="
              expense.manualFields.occurredDate = true;
              expense.ocrStatus = 'manual';
              dirty();
            "
          /><el-select
            v-model="expense.reason"
            placeholder="事由"
            @change="
              expense.manualFields.reason = true;
              expense.ocrStatus = 'manual';
              dirty();
            "
            ><el-option
              v-for="reason in expenseReasons"
              :key="reason"
              :label="reason"
              :value="reason" /></el-select
          ><el-input
            class="expense-amount-field"
            :model-value="amountInputValue(expense)"
            inputmode="decimal"
            placeholder="金额或 =3+33*2"
            @focus="beginAmountInput(expense)"
            @update:model-value="
              (value: string) => updateAmountInput(expense, value)
            "
            @blur="commitAmountInput(expense)"
            @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
            ><template #prepend>￥</template></el-input
          ><el-select
            class="expense-arranger-field"
            v-model="expense.arranger"
            placeholder="安排人"
            @change="
              expense.manualFields.arranger = true;
              expense.ocrStatus = 'manual';
              dirty();
            "
            ><el-option
              v-for="arranger in arrangers"
              :key="arranger"
              :label="arranger"
              :value="arranger" /></el-select
          ><el-input
            v-model="expense.description"
            type="textarea"
            :rows="2"
            class="expense-description-field expense-description-input"
            placeholder="内容说明"
            @change="
              expense.manualFields.description = true;
              expense.ocrStatus = 'manual';
              dirty();
            "
          />
        </div>
        <div class="expense-extra-section" @click.stop>
          <div class="expense-extra-heading">
            <span
              >附加图片
              <small>{{ expense.extraAttachments.length }} 张</small></span
            >
            <el-button
              size="small"
              plain
              :icon="Plus"
              :disabled="!extraAttachmentSlots(expense)"
              @click="openExtraUpload(expense)"
              >添加附图</el-button
            >
          </div>
          <div
            v-if="expense.extraAttachments.length"
            class="expense-extra-list"
          >
            <div
              v-for="(attachment, attachmentIndex) in expense.extraAttachments"
              :key="attachment.id"
              class="expense-extra-item"
            >
              <el-image
                :src="attachment.imageDataUrl"
                :alt="attachment.fileName"
                fit="cover"
                :preview-src-list="
                  expense.extraAttachments.map((item) => item.imageDataUrl)
                "
                :initial-index="attachmentIndex"
                preview-teleported
                hide-on-click-modal
              />
              <div class="expense-extra-actions">
                <el-button
                  circle
                  text
                  :icon="ArrowLeftBold"
                  title="向前移动"
                  :disabled="attachmentIndex === 0"
                  @click="moveExtraAttachment(expense, attachment, -1)"
                />
                <el-button
                  circle
                  text
                  :icon="ArrowRightBold"
                  title="向后移动"
                  :disabled="
                    attachmentIndex === expense.extraAttachments.length - 1
                  "
                  @click="moveExtraAttachment(expense, attachment, 1)"
                />
                <el-button
                  circle
                  text
                  type="danger"
                  :icon="Delete"
                  title="删除附加图片"
                  @click="removeExtraAttachment(expense, attachment)"
                />
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
