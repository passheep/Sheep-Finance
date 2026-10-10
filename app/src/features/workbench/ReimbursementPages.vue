<script setup lang="ts">
import { toRefs } from "vue";
import { useAppContext } from "../../composables/appContext";
import AttachmentSurface from "../../components/AttachmentSurface.vue";
import { money, ChineseAmount } from "../../utils/format";
import { Sort } from "@element-plus/icons-vue";

const {
  formPages,
  draft,
  editingKey,
  editValue,
  commitHeader,
  cancelEdit,
  beginEdit,
  selectedId,
  expenseDragState,
  selectExpense,
  isPaperCellSelected,
  startPaperCellSelection,
  extendPaperCellSelection,
  handlePaperCellClick,
  fieldKey,
  commitExpense,
  expenseReasons,
  arrangers,
  manualTotal,
  effectiveTotal,
  financeReviewer,
  showManagerApproval,
  enableManualTotal,
  commitManualTotal,
  restoreAutomaticTotal,
  sharedAttachmentPage,
  selectedAttachmentId,
  selectAttachment,
  pointerStart,
  separateAttachmentPages,
  editInput,
} = toRefs(useAppContext());
</script>

<template>
  <div class="preview-pages">
    <div
      v-for="(formPage, formPageIndex) in formPages"
      :key="'form-' + formPageIndex"
      class="paper form-paper"
      data-export-page="form"
    >
      <div class="paper-title">
        <div class="paper-title-text">
          {{ draft.companyName }}费用报销单{{
            formPage.isFirst ? "" : "（续）"
          }}
        </div>
      </div>
      <div v-if="formPage.isFirst" class="paper-meta">
        <div class="meta-cell">
          <span>报销日期：</span>
        </div>
        <div class="meta-cell">
          <span>申请人：</span
          ><template v-if="editingKey === 'applicant'"
            ><input
              ref="editInput"
              v-model="editValue"
              class="paper-edit-input"
              @blur="commitHeader('applicant')"
              @keydown.enter.prevent="commitHeader('applicant')"
              @keydown.esc="cancelEdit" /></template
          ><button
            v-else
            class="paper-editable"
            type="button"
            @click="beginEdit('applicant', draft.applicant)"
          >
            {{ draft.applicant || "xxx" }}
          </button>
        </div>
        <div class="meta-cell">
          <span>所属部门：</span
          ><template v-if="editingKey === 'department'"
            ><input
              ref="editInput"
              v-model="editValue"
              class="paper-edit-input"
              @blur="commitHeader('department')"
              @keydown.enter.prevent="commitHeader('department')"
              @keydown.esc="cancelEdit" /></template
          ><button
            v-else
            class="paper-editable"
            type="button"
            @click="beginEdit('department', draft.department)"
          >
            {{ draft.department || "xxxx" }}
          </button>
        </div>
        <div class="meta-cell ticket-cell">附票据（&nbsp;&nbsp;）张</div>
      </div>
      <div class="paper-table-wrap">
        <table class="paper-table">
          <thead>
            <tr>
              <th class="col-index">序号</th>
              <th class="col-date">发生日期</th>
              <th class="col-reason">事由</th>
              <th class="col-description">内容说明、参与人员等</th>
              <th class="col-arranger">安排人</th>
              <th class="col-amount">金额</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="formPage.rows.length"
              ><tr
                v-for="({ expense, index, height }, rowIndex) in formPage.rows"
                :key="expense.id"
                :data-expense-id="expense.id"
                :style="{ height: height + 'px' }"
                :class="{
                  'selected-row': expense.id === selectedId,
                  'dragging-row':
                    expenseDragState?.surface === 'paper' &&
                    expenseDragState.id === expense.id,
                }"
                @click="selectExpense(expense)"
              >
                <td
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      0,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 0)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 0)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 0)"
                >
                  <span class="paper-row-index">
                    <span
                      class="paper-row-drag-handle"
                      title="拖动调整费用顺序"
                      @click.stop
                      ><Sort :size="12"
                    /></span>
                    <span>{{ index + 1 }}</span>
                  </span>
                </td>
                <td
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      1,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 1)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 1)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 1)"
                >
                  <template
                    v-if="editingKey === fieldKey(expense, 'occurredDate')"
                    ><input
                      ref="editInput"
                      v-model="editValue"
                      class="paper-cell-input"
                      type="date"
                      @blur="commitExpense(expense, 'occurredDate')"
                      @keydown.esc="cancelEdit" /></template
                  ><button
                    v-else
                    class="paper-editable paper-select-button"
                    type="button"
                    @click.stop="handlePaperCellClick($event, expense, 1)"
                  >
                    {{ expense.occurredDate }}
                  </button>
                </td>
                <td
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      2,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 2)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 2)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 2)"
                >
                  <template v-if="editingKey === fieldKey(expense, 'reason')"
                    ><select
                      ref="editInput"
                      v-model="editValue"
                      class="paper-cell-input"
                      @blur="commitExpense(expense, 'reason')"
                    >
                      <option value="">请选择事由</option>
                      <option
                        v-for="reason in expenseReasons"
                        :key="reason"
                        :value="reason"
                      >
                        {{ reason }}
                      </option>
                    </select></template
                  ><button
                    v-else
                    class="paper-editable paper-select-button"
                    type="button"
                    @click.stop="handlePaperCellClick($event, expense, 2)"
                  >
                    <span v-if="expense.reason">{{ expense.reason }}</span
                    ><span v-else class="paper-empty-hint">点击选择</span>
                  </button>
                </td>
                <td
                  class="description-cell"
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      3,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 3)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 3)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 3)"
                >
                  <template
                    v-if="editingKey === fieldKey(expense, 'description')"
                  >
                    <textarea
                      ref="editInput"
                      v-model="editValue"
                      class="paper-cell-input description-input"
                      :style="{ height: height - 8 + 'px' }"
                      rows="2"
                      @blur="commitExpense(expense, 'description')"
                    /></template
                  ><button
                    v-else
                    class="paper-editable description-button"
                    type="button"
                    @click.stop="handlePaperCellClick($event, expense, 3)"
                  >
                    {{ expense.description || "xxxx" }}
                  </button>
                </td>
                <td
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      4,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 4)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 4)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 4)"
                >
                  <template v-if="editingKey === fieldKey(expense, 'arranger')"
                    ><select
                      ref="editInput"
                      v-model="editValue"
                      class="paper-cell-input"
                      @blur="commitExpense(expense, 'arranger')"
                    >
                      <option value="">请选择安排人</option>
                      <option
                        v-for="arranger in arrangers"
                        :key="arranger"
                        :value="arranger"
                      >
                        {{ arranger }}
                      </option>
                    </select></template
                  ><button
                    v-else
                    class="paper-editable paper-select-button arranger-button"
                    type="button"
                    @click.stop="handlePaperCellClick($event, expense, 4)"
                  >
                    <span v-if="expense.arranger">{{ expense.arranger }}</span
                    ><span v-else class="paper-empty-hint">点击选择</span>
                  </button>
                </td>
                <td
                  :class="{
                    'paper-cell-selected': isPaperCellSelected(
                      formPageIndex,
                      rowIndex,
                      5,
                    ),
                  }"
                  @pointerdown="
                    startPaperCellSelection($event, formPageIndex, rowIndex, 5)
                  "
                  @pointerenter="
                    extendPaperCellSelection($event, formPageIndex, rowIndex, 5)
                  "
                  @click.stop="handlePaperCellClick($event, expense, 5)"
                >
                  <template
                    v-if="editingKey === fieldKey(expense, 'amountCents')"
                    ><input
                      ref="editInput"
                      v-model="editValue"
                      class="paper-cell-input amount-input"
                      type="text"
                      inputmode="decimal"
                      autocomplete="off"
                      placeholder="=3+33*2"
                      @blur="commitExpense(expense, 'amountCents')"
                      @keydown.enter.prevent="
                        commitExpense(expense, 'amountCents')
                      " /></template
                  ><button
                    v-else
                    class="paper-editable amount-button"
                    type="button"
                    @click.stop="handlePaperCellClick($event, expense, 5)"
                  >
                    {{ money(expense.amountCents) }}
                  </button>
                </td>
              </tr></template
            >
            <tr v-else class="empty-row">
              <td>1</td>
              <td>xxxxx</td>
              <td>xxxxxx</td>
              <td>上传图片后生成费用行</td>
              <td>xxxx</td>
              <td>0.00</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template v-if="formPage.isLast">
        <div class="paper-total-block">
          <div class="total-label">合计金额</div>
          <div class="total-value">
            <button
              v-if="!manualTotal"
              class="paper-editable total-number"
              type="button"
              @click="enableManualTotal(effectiveTotal)"
            >
              ￥{{ money(effectiveTotal) }}</button
            ><input
              v-else
              class="paper-edit-input total-number"
              :value="(effectiveTotal / 100).toFixed(2)"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              @change="
                commitManualTotal(($event.target as HTMLInputElement).value)
              "
            />
          </div>
          <div class="uppercase-value">
            {{ ChineseAmount(effectiveTotal) }}
          </div>
        </div>
        <div v-if="manualTotal" class="manual-total-action">
          <el-button text size="small" @click="restoreAutomaticTotal"
            >恢复自动合计</el-button
          >
        </div>
        <div class="paper-payment">
          <span>收款信息：</span>
          <div class="payment-content">
            <div>
              <b>名称：</b
              ><button
                class="paper-editable"
                type="button"
                @click="beginEdit('payeeName', draft.payeeName)"
              >
                {{ draft.payeeName || "xxxx" }}
              </button>
            </div>
            <div>
              <b>账号：</b
              ><button
                class="paper-editable"
                type="button"
                @click="beginEdit('account', draft.account)"
              >
                {{ draft.account || "xxxxx" }}
              </button>
            </div>
            <div>
              <b>开户行：</b
              ><button
                class="paper-editable"
                type="button"
                @click="beginEdit('bank', draft.bank)"
              >
                {{ draft.bank || "xxxxx" }}
              </button>
            </div>
          </div>
        </div>
        <div class="paper-approval">
          <span>部门负责人：</span>
          <span class="approval-field">
            <span class="approval-export-text">{{ financeReviewer }}：</span>
            <select
              v-model="financeReviewer"
              class="approval-select"
              aria-label="审批部门"
              title="审批部门"
            >
              <option value="财务">财务：</option>
              <option value="秘书处">秘书处：</option>
            </select>
          </span>
          <span class="approval-field">
            <span class="approval-export-text">{{
              showManagerApproval ? "总经理审核：" : ""
            }}</span>
            <select
              v-model="showManagerApproval"
              class="approval-select"
              aria-label="总经理审核栏"
              title="总经理审核栏"
            >
              <option :value="true">总经理审核：</option>
              <option :value="false">隐藏</option>
            </select>
          </span>
        </div>
      </template>
      <AttachmentSurface
        v-if="formPage.isLast && sharedAttachmentPage"
        :attachments="sharedAttachmentPage"
        :page-index="0"
        :selected-id="selectedAttachmentId"
        @select="selectAttachment"
        @pointer-start="pointerStart"
      />
    </div>
    <div
      v-for="(attachments, attachmentPageIndex) in separateAttachmentPages"
      :key="'attachment-' + attachmentPageIndex"
      class="paper attachment-paper"
      data-export-page="attachments"
    >
      <AttachmentSurface
        :attachments="attachments"
        :page-index="(sharedAttachmentPage ? 1 : 0) + attachmentPageIndex"
        :selected-id="selectedAttachmentId"
        @select="selectAttachment"
        @pointer-start="pointerStart"
      />
    </div>
  </div>
</template>
