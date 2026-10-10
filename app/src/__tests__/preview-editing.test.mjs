import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as vue from "vue";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const allowed = new Set(
  [
    "composables/useExpenseEditing.ts",
    "composables/usePreviewHistory.ts",
    "composables/useWorkspace.ts",
    "utils/approval.ts",
    "utils/format.ts",
    "constants/app.ts",
  ].map((file) => path.resolve(sourceRoot, file)),
);

function loader(messages = [], storage = new Map()) {
  const cache = new Map();
  const mocks = new Map([
    [
      path.resolve(sourceRoot, "services/runtimeService.ts"),
      { isTauriRuntime: () => false, errorMessage: (error) => String(error) },
    ],
    [path.resolve(sourceRoot, "services/storageService.ts"), {}],
    [path.resolve(sourceRoot, "services/attachmentService.ts"), {}],
  ]);
  function load(file) {
    if (mocks.has(file)) return mocks.get(file);
    assert.ok(allowed.has(file), `禁止加载非白名单模块：${file}`);
    if (cache.has(file)) return cache.get(file);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    });
    const module = { exports: {} };
    const require = (name) => {
      if (name === "vue") return vue;
      if (name === "element-plus")
        return {
          ElMessage: Object.fromEntries(
            ["warning", "info", "success", "error"].map((level) => [
              level,
              (text) => messages.push({ level, text }),
            ]),
          ),
          ElMessageBox: {},
        };
      assert.ok(name.startsWith("."), `禁止外部 IO 或依赖：${name}`);
      return load(path.resolve(path.dirname(file), `${name}.ts`));
    };
    new vm.Script(outputText, { filename: file }).runInNewContext(
      {
        module,
        exports: module.exports,
        require,
        Date,
        localStorage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        },
        window: {
          setTimeout: () => {
            throw new Error("本用例不能启动真实计时器");
          },
          clearTimeout() {},
        },
      },
      { timeout: 1000 },
    );
    cache.set(file, module.exports);
    return module.exports;
  }
  return (name) => load(path.resolve(sourceRoot, name));
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function draftFixture() {
  return {
    id: "record-a",
    label: "历史栈测试",
    status: "未报销",
    companyName: "测试公司",
    reimbursementDate: "",
    applicant: "原申请人",
    department: "原部门",
    payeeName: "原收款人",
    account: "原账号",
    bank: "原银行",
    totalOverrideCents: null,
    previewMode: "single",
    updatedAt: "2026-01-01T00:00:00Z",
    expenses: [
      {
        id: "expense-a",
        fileName: "fixture.png",
        imageDataUrl: "blob:unchanged",
        recognitionImageDataUrl: "blob:recognition",
        occurredDate: "2026-01-01",
        reason: "办公费",
        description: "原说明",
        arranger: "原安排人",
        amountCents: 1234,
        manualFields: {},
        ocrStatus: "success",
        ocrMode: "advanced",
        recognitionVersion: 9,
        ocrText: "识别原文",
        extraAttachments: [],
        transform: {
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          rotation: 0,
          cropZoom: 1,
          cropX: 50,
          cropY: 50,
        },
        naturalWidth: 512,
        naturalHeight: 512,
      },
    ],
  };
}
function harness() {
  const messages = [];
  const load = loader(messages);
  const draft = vue.reactive(draftFixture());
  let dirties = 0;
  let active = true;
  const { useExpenseEditing } = load("composables/useExpenseEditing.ts");
  const editing = useExpenseEditing({
    draft,
    formPages: vue.computed(() => []),
    getPreviewAttachments: () => [],
    dirty: () => {
      dirties += 1;
    },
    persistDraft: () => {
      throw new Error("编辑历史不得调用 IO");
    },
    reflowExpenses() {},
    revokeManagedImageUrl: () => {
      throw new Error("撤销不得回收图片");
    },
    setSelectedIds() {},
    isPreviewActive: () => active,
  });
  function header(field, value) {
    editing.beginEdit(field, draft[field]);
    editing.editValue.value = value;
    editing.commitHeader(field);
  }
  function expense(field, value) {
    const item = draft.expenses[0];
    editing.beginEdit(editing.fieldKey(item, field), String(item[field]));
    editing.editValue.value = value;
    editing.commitExpense(item, field);
  }
  return {
    draft,
    editing,
    messages,
    header,
    expense,
    load,
    get dirties() {
      return dirties;
    },
    set active(value) {
      active = value;
    },
  };
}

test("审批旧数据默认兼容，秘书处和隐藏在完整审批行中正确输出", () => {
  const { getFinanceReviewer, getApprovalLine } = loader()("utils/approval.ts");
  const defaultLine =
    "部门负责人：                         财务：                         总经理审核：";
  assert.equal(getFinanceReviewer({}), "财务");
  assert.equal(getApprovalLine({}), defaultLine);
  assert.equal(
    getApprovalLine({ financeReviewer: "秘书处", showManagerApproval: false }),
    "部门负责人：                         秘书处：",
  );
  assert.equal(
    getApprovalLine({ financeReviewer: "非法值", showManagerApproval: null }),
    defaultLine,
  );
});

test("完整编辑提交只记录一步，不记录无变化、取消和重复 blur", () => {
  const h = harness();
  h.header("applicant", "新申请人");
  h.editing.commitHeader("applicant");
  assert.equal(h.dirties, 1);
  assert.equal(h.editing.undoPreviewEdit(), true);
  assert.equal(h.draft.applicant, "原申请人");
  assert.equal(h.editing.canUndoPreview.value, false);
  assert.equal(h.editing.redoPreviewEdit(), true);
  assert.equal(h.draft.applicant, "新申请人");
  h.editing.resetPreviewHistory();
  h.header("applicant", "新申请人");
  assert.equal(h.editing.canUndoPreview.value, false);
  h.editing.beginEdit("applicant", "新申请人");
  h.editing.editValue.value = "未提交";
  h.editing.cancelEdit();
  assert.equal(h.draft.applicant, "新申请人");
  assert.equal(h.editing.canUndoPreview.value, false);
});

test("预览编辑框支持 v-for 的数组 ref，只聚焦仍挂载的元素", async () => {
  const h = harness();
  let focused = 0;
  const activeInput = {
    isConnected: true,
    focus: () => {
      focused += 1;
    },
  };
  h.editing.editInput.value = [
    {
      isConnected: false,
      focus: () => {
        throw new Error("不能聚焦已移除的编辑框");
      },
    },
    activeInput,
  ];
  h.editing.beginEdit("applicant", h.draft.applicant);
  await vue.nextTick();
  assert.equal(focused, 1);
  h.editing.editInput.value = activeInput;
  h.editing.beginEdit("applicant", h.draft.applicant);
  await vue.nextTick();
  assert.equal(focused, 2);
  h.editing.editInput.value = [];
  h.editing.beginEdit("applicant", h.draft.applicant);
  await vue.nextTick();
  assert.equal(focused, 2);
});

test("五类费用单元格撤销同步手工标记，不回退识别版本、响应和图片，也不替换对象", () => {
  for (const [field, input, expected] of [
    ["occurredDate", "2026-02-02", "2026-02-02"],
    ["reason", "差旅费", "差旅费"],
    ["description", "新说明", "新说明"],
    ["arranger", "新安排人", "新安排人"],
    ["amountCents", "=3+33*2", 6900],
  ]) {
    const h = harness();
    const item = h.draft.expenses[0];
    const before = item[field];
    const transform = item.transform;
    const flags = item.manualFields;
    h.expense(field, input);
    assert.equal(item[field], expected);
    assert.equal(item.manualFields[field], true);
    item.recognitionVersion = 10;
    item.ocrText = "晚到的新原文";
    assert.equal(h.editing.undoPreviewEdit(), true);
    assert.equal(item[field], before);
    assert.equal(Object.hasOwn(item.manualFields, field), false);
    assert.strictEqual(h.draft.expenses[0], item);
    assert.strictEqual(item.transform, transform);
    assert.strictEqual(item.manualFields, flags);
    assert.equal(item.recognitionVersion, 10);
    assert.equal(item.ocrText, "晚到的新原文");
    assert.equal(item.imageDataUrl, "blob:unchanged");
    assert.equal(item.ocrStatus, "manual");
    assert.equal(h.editing.redoPreviewEdit(), true);
    assert.equal(item[field], expected);
    assert.equal(item.manualFields[field], true);
  }
  const h = harness();
  h.draft.expenses[0].manualFields.reason = false;
  h.expense("reason", "招待费");
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.expenses[0].manualFields.reason, false);
});

test("连续历史按逆序撤销和顺序重做，新操作截断重做分支，默认上限一百步", () => {
  const h = harness();
  h.header("applicant", "第一步");
  h.header("department", "第二步");
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.department, "原部门");
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.applicant, "原申请人");
  h.editing.redoPreviewEdit();
  assert.equal(h.draft.applicant, "第一步");
  h.header("bank", "新分支");
  assert.equal(h.editing.canRedoPreview.value, false);
  assert.equal(h.editing.redoPreviewEdit(), false);
  h.editing.resetPreviewHistory();
  for (let index = 0; index < 105; index += 1)
    h.header("applicant", `操作${index}`);
  let count = 0;
  while (h.editing.undoPreviewEdit()) count += 1;
  assert.equal(count, 100);
  assert.equal(h.draft.applicant, "操作4");
  count = 0;
  while (h.editing.redoPreviewEdit()) count += 1;
  assert.equal(count, 100);
  assert.equal(h.draft.applicant, "操作104");
});

test("审批、人工合计和切换申请人的字段组均可撤销并重做", () => {
  const h = harness();
  h.editing.financeReviewer.value = "秘书处";
  h.editing.showManagerApproval.value = false;
  assert.equal(h.draft.financeReviewer, "秘书处");
  assert.equal(h.draft.showManagerApproval, false);
  h.editing.undoPreviewEdit();
  assert.equal(h.editing.showManagerApproval.value, true);
  h.editing.undoPreviewEdit();
  assert.equal(h.editing.financeReviewer.value, "财务");
  h.editing.redoPreviewEdit();
  h.editing.redoPreviewEdit();
  h.editing.enableManualTotal(1234);
  h.editing.commitManualTotal("(1+2)*3");
  assert.equal(h.draft.totalOverrideCents, 900);
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.totalOverrideCents, 1234);
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.totalOverrideCents, null);
  h.editing.redoPreviewEdit();
  h.editing.restoreAutomaticTotal();
  assert.equal(h.draft.totalOverrideCents, null);
  h.editing.undoPreviewEdit();
  assert.equal(h.draft.totalOverrideCents, 1234);
  const before = plain(h.draft);
  h.editing.changePreviewProfile({
    applicant: "甲",
    department: "乙",
    payeeName: "丙",
    account: "丁",
    bank: "戊",
  });
  h.editing.undoPreviewEdit();
  for (const field of [
    "applicant",
    "department",
    "payeeName",
    "account",
    "bank",
  ])
    assert.equal(h.draft[field], before[field]);
  h.editing.redoPreviewEdit();
  assert.equal(h.draft.account, "丁");
});

test("无效金额不进入历史；活动编辑点撤销先提交再撤销，不丢失重做值", () => {
  const h = harness();
  h.expense("amountCents", "1/0");
  assert.equal(h.draft.expenses[0].amountCents, 1234);
  assert.equal(h.editing.canUndoPreview.value, false);
  assert.equal(h.editing.commitManualTotal("(1+"), false);
  assert.equal(h.dirties, 0);
  assert.equal(h.messages.length, 2);
  h.editing.beginEdit("applicant", h.draft.applicant);
  h.editing.editValue.value = "进行中的编辑";
  assert.equal(h.editing.undoPreviewEdit(), true);
  assert.equal(h.draft.applicant, "原申请人");
  assert.equal(h.editing.editingKey.value, null);
  h.editing.redoPreviewEdit();
  assert.equal(h.draft.applicant, "进行中的编辑");
});

test("切单和显式恢复同 ID 单据清空历史，外部改写或删除不会被旧历史覆盖", () => {
  const h = harness();
  h.header("applicant", "新申请人");
  h.draft.id = "record-b";
  assert.equal(h.editing.undoPreviewEdit(), false);
  assert.equal(h.draft.applicant, "新申请人");
  h.header("bank", "新银行");
  h.editing.resetPreviewHistory();
  assert.equal(h.editing.canUndoPreview.value, false);
  h.expense("description", "手工值");
  h.draft.expenses[0].description = "其他入口的新值";
  assert.equal(h.editing.undoPreviewEdit(), false);
  assert.equal(h.draft.expenses[0].description, "其他入口的新值");
  assert.equal(h.editing.canRedoPreview.value, false);
  h.expense("description", "删除前");
  h.draft.expenses = [];
  assert.equal(h.editing.undoPreviewEdit(), false);
  assert.equal(h.draft.expenses.length, 0);
});

test("Ctrl+Z/Shift+Z 与 Meta 同效，输入控件、弹窗、IME 和设置页面不抢快捷键", () => {
  const h = harness();
  h.header("applicant", "已提交");
  function keyboard(overrides = {}) {
    let prevented = false;
    const event = {
      key: "z",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      target: { closest: () => null },
      preventDefault: () => {
        prevented = true;
      },
      ...overrides,
    };
    h.editing.handleGlobalKeydown(event);
    return prevented;
  }
  assert.equal(keyboard({ target: { closest: () => ({}) } }), false);
  assert.equal(keyboard({ isComposing: true }), false);
  assert.equal(keyboard({ altKey: true }), false);
  h.active = false;
  assert.equal(keyboard(), false);
  assert.equal(h.draft.applicant, "已提交");
  h.active = true;
  assert.equal(keyboard(), true);
  assert.equal(h.draft.applicant, "原申请人");
  assert.equal(keyboard({ key: "Z", shiftKey: true }), true);
  assert.equal(h.draft.applicant, "已提交");
  assert.equal(keyboard({ ctrlKey: false, metaKey: true }), true);
  assert.equal(h.draft.applicant, "原申请人");
});

test("真实 workspace 默认字段、切换旧数据、保存与重载都保留审批选项，历史栈不持久化", async () => {
  const storage = new Map();
  const { useWorkspace } = loader([], storage)("composables/useWorkspace.ts");
  let resets = 0;
  const emptyRef = () => vue.ref([]);
  const workspace = useWorkspace({
    profiles: emptyRef(),
    companyNames: emptyRef(),
    expenseReasons: emptyRef(),
    arrangers: emptyRef(),
    defaultCompany: vue.ref(""),
    defaultReason: vue.ref(""),
    defaultArranger: vue.ref(""),
    ocrProfiles: emptyRef(),
    llmProfiles: emptyRef(),
    historyRecords: emptyRef(),
    normalizeHistory: (value) => value,
    normalizeOcrProfile: (value) => value,
    normalizeLlmProfile: (value) => value,
    hydrateDraftImages: async (value) => value,
    revokeDraftImageUrls() {},
    setSelectedIds() {},
    clearSelection() {},
    getUiPreferences: () => ({
      leftPanelWidth: 404,
      historyViewMode: "company",
    }),
    setUiPreferences() {},
    clampLeftPanelWidth: (value) => value,
    loadBackupStatus: async () => {},
    refreshHistoryQuery: async () => {},
    getActiveTab: () => "reimbursement",
    commitActiveEdit() {},
    onDraftReplaced: () => {
      resets += 1;
    },
  });
  assert.equal(workspace.draft.financeReviewer, "财务");
  assert.equal(workspace.draft.showManagerApproval, true);
  workspace.applyDraft({
    ...draftFixture(),
    financeReviewer: "秘书处",
    showManagerApproval: false,
  });
  workspace.isLoadingWorkspace.value = false;
  assert.equal(await workspace.persistDraft(false), true);
  const saved = JSON.parse(storage.get("sheepfinance:workbench:v1"));
  assert.equal(saved.financeReviewer, "秘书处");
  assert.equal(saved.showManagerApproval, false);
  assert.equal(
    Object.keys(saved).some((key) => /history|undo|redo/i.test(key)),
    false,
  );
  workspace.applyDraft(draftFixture());
  assert.equal(workspace.draft.financeReviewer, "财务");
  assert.equal(workspace.draft.showManagerApproval, true);
  workspace.loadBrowserWorkspace();
  assert.equal(workspace.draft.financeReviewer, "秘书处");
  assert.equal(workspace.draft.showManagerApproval, false);
  assert.equal(resets, 3);
});
