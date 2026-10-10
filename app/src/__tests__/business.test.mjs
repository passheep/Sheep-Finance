import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as vue from "vue";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = path.join(appRoot, "src");
const baselineCommit = "4aaa9e55ac2f0d8b33c38180facc3340e792e057";
const allowedSources = new Set([
  "composables/useWorkspace.ts", "composables/useRecognition.ts",
  "composables/useAttachments.ts", "composables/useLanUpload.ts",
  "constants/app.ts", "utils/format.ts", "utils/pagination.ts", "types/models.ts",
].map(fileName => path.resolve(sourceRoot, fileName)));
const allowedServiceMocks = new Set([
  "services/storageService.ts", "services/recognitionService.ts", "services/runtimeService.ts",
  "services/attachmentService.ts", "services/lanUploadService.ts",
].map(fileName => path.resolve(sourceRoot, fileName)));

// VM 对象只在比较值时归一化；引用和 Vue 代理身份必须另用 strictEqual 断言。
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
function parseSource(fileName, source) {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, `${fileName} 应能解析为 TypeScript`);
  return ast;
}
function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.deepEqual(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")), []);
  return result.outputText;
}

const fixedNow = new Date(2026, 5, 1, 12, 0, 0).getTime();
class FixtureDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]));
  }
  static now() { return fixedNow; }
}
function runCommonJs(source, fileName, require, globals) {
  const module = { exports: {} };
  const context = vm.createContext({
    ...globals, module, exports: module.exports, require,
    Date: FixtureDate, Error, TypeError,
  });
  new vm.Script(transpile(source, fileName), { filename: fileName })
    .runInContext(context, { timeout: 1000 });
  return module.exports;
}

// 所有计时器均手动推进，不调用宿主定时器，也不依赖 wall-clock sleep。
function createTimers(trace) {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay, ...args) {
      const id = nextId++;
      pending.set(id, { callback, args, delay, due: now + delay });
      trace.push({ kind: "timer:set", id, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
      trace.push({ kind: "timer:clear", id });
    },
    advanceBy(duration) {
      const target = now + duration;
      let fired = 0;
      while (true) {
        const entry = [...pending.entries()]
          .filter(([, timer]) => timer.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!entry) break;
        assert.ok(++fired <= 100, "假计时器不应无限重入");
        const [id, timer] = entry;
        pending.delete(id);
        now = timer.due;
        trace.push({ kind: "timer:fire", id });
        timer.callback(...timer.args);
      }
      now = target;
    },
    get pending() {
      return [...pending.entries()].map(([id, timer]) => ({ id, delay: timer.delay, due: timer.due }));
    },
  };
}
function createMessages(trace) {
  return Object.fromEntries(["success", "error", "warning", "info"].map(level => [
    level, text => { trace.push({ kind: "message", level, text }); },
  ]));
}
function createIo(trace) {
  const calls = [];
  const handlers = new Map();
  const observers = [];
  function invoke(command, payload) {
    const call = { command, payload };
    calls.push(call);
    trace.push({ kind: "invoke", command, payload: plain(payload) });
    const observerIndex = observers.findIndex(observer => observer.command === command);
    if (observerIndex >= 0) observers.splice(observerIndex, 1)[0].gate.resolve(call);
    assert.ok(handlers.has(command), `未注册的服务调用禁止 IO：${command}`);
    return handlers.get(command)(payload);
  }
  return {
    calls, handlers, invoke,
    nextCall(command) {
      const gate = deferred();
      observers.push({ command, gate });
      return gate.promise;
    },
    storage: {
      saveWorkspace: request => invoke("save_workspace", { request }),
      bootstrapStorage: allowDefaultSettings => invoke("bootstrap_storage", { allowDefaultSettings }),
      loadWorkspace: () => invoke("load_workspace"),
      scheduleStorageBackup: () => invoke("schedule_storage_backup"),
    },
    recognition: { recognizeExpense: request => invoke("recognize_expense", { request }) },
    attachments: {
      storeAttachment: request => invoke("store_attachment", { request }),
      readAttachment: blobHash => invoke("read_attachment", { blobHash }),
      saveAttachmentAs: (blobHash, destination) => invoke("save_attachment_as", { blobHash, destination }),
      openAttachmentFolder: (blobHash, recordId) => invoke("open_attachment_folder", { blobHash, recordId }),
      cleanupOrphanImages: () => invoke("cleanup_orphan_images"),
    },
    lanUpload: {
      listenLanUploadReceived: callback => invoke("listen_lan_upload_received", { callback }),
      startLanUploadSession: request => invoke("start_lan_upload_session", { request }),
      updateLanUploadSession: request => invoke("update_lan_upload_session", { request }),
      stopLanUploadSession: () => invoke("stop_lan_upload_session"),
    },
  };
}
function createEnvironment(desktop = true) {
  const trace = [];
  const timers = createTimers(trace);
  const io = createIo(trace);
  const messages = createMessages(trace);
  const values = new Map();
  const window = {
    ...(desktop ? { __TAURI_INTERNALS__: {} } : {}),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  };
  const localStorage = {
    getItem(key) {
      trace.push({ kind: "storage:get", key });
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      trace.push({ kind: "storage:set", key, value });
      values.set(key, String(value));
    },
  };
  return {
    trace, timers, io, messages, values,
    globals: { window, localStorage, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  };
}

// 服务只返回显式 mock；生产服务与桌面 SDK 永远不从磁盘加载或执行。
function createModuleLoader(environment) {
  const cache = new Map();
  const mocks = new Map([
    [path.resolve(sourceRoot, "services/storageService.ts"), environment.io.storage],
    [path.resolve(sourceRoot, "services/recognitionService.ts"), environment.io.recognition],
    [path.resolve(sourceRoot, "services/attachmentService.ts"), environment.io.attachments],
    [path.resolve(sourceRoot, "services/lanUploadService.ts"), environment.io.lanUpload],
    [path.resolve(sourceRoot, "services/runtimeService.ts"), {
      isTauriRuntime: () => "__TAURI_INTERNALS__" in environment.globals.window,
      errorMessage: error => typeof error === "string" ? error : error instanceof Error ? error.message : "识别请求失败",
    }],
  ]);
  function load(fileName) {
    const absolute = path.resolve(sourceRoot, fileName);
    assert.ok(allowedSources.has(absolute), `禁止加载白名单之外的生产代码：${absolute}`);
    if (!cache.has(absolute)) {
      const source = readFileSync(absolute, "utf8");
      const exports = runCommonJs(source, absolute, specifier => {
        if (specifier === "vue") return vue;
        if (specifier === "element-plus") return { ElMessage: environment.messages };
        if (specifier === "qrcode") {
          assert.ok(environment.qrCode, "QRCode 必须提供可控 mock");
          return environment.qrCode;
        }
        assert.ok(specifier.startsWith("."), `禁止加载外部运行时：${specifier}`);
        const dependency = path.resolve(path.dirname(absolute), specifier);
        const resolved = path.extname(dependency) ? dependency : `${dependency}.ts`;
        if (mocks.has(resolved)) {
          assert.ok(allowedServiceMocks.has(resolved));
          return mocks.get(resolved);
        }
        return load(resolved);
      }, environment.globals);
      cache.set(absolute, { source, exports });
    }
    return cache.get(absolute).exports;
  }
  return { load, cache, mocks };
}

let baselineAst;
function getBaselineAst() {
  if (!baselineAst) {
    const oldVue = execFileSync("git", ["show", `${baselineCommit}:app/src/App.vue`], {
      cwd: appRoot, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    });
    const start = oldVue.indexOf("<script setup");
    const end = oldVue.indexOf("</script>", start);
    assert.ok(start >= 0 && end > start, "固定基线应包含 script setup");
    baselineAst = parseSource("baseline-App.ts", oldVue.slice(oldVue.indexOf(">", start) + 1, end));
  }
  return baselineAst;
}

// 保留原声明的 const/let；let 用闭包 getter/setter 访问，避免复制数值后丢失 revision/suppress 语义。
function loadReference(functionNames, variableNames, bindings, globals) {
  const ast = getBaselineAst();
  const functions = new Map();
  const variables = new Map();
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement)) functions.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) variables.set(declaration.name.text, declaration);
      }
    }
  }
  const source = [];
  const exported = [];
  for (const name of variableNames) {
    const node = variables.get(name);
    assert.ok(node, `固定基线缺少变量：${name}`);
    const isConst = Boolean(node.parent.flags & ts.NodeFlags.Const);
    const declaration = Object.hasOwn(bindings, name) ? `${name} = __bindings[${JSON.stringify(name)}]` : node.getText(ast);
    source.push(`${isConst ? "const" : "let"} ${declaration};`);
    exported.push(isConst ? name : `get ${name}() { return ${name}; }, set ${name}(value) { ${name} = value; }`);
  }
  for (const name of functionNames) {
    assert.ok(functions.has(name), `固定基线缺少函数：${name}`);
    source.push(functions.get(name).getText(ast));
    exported.push(name);
  }
  source.push(`module.exports = { ${exported.join(", ")} };`);
  return runCommonJs(source.join("\n"), "baseline-business.ts", specifier => {
    throw new Error(`旧业务 AST 不应 require：${specifier}`);
  }, { ...vue, ...globals, __bindings: bindings });
}

function makeExpense(overrides = {}) {
  return {
    id: "expense-a", fileName: "普通发票.png", imageDataUrl: "data:image/png;base64,AA==",
    blobHash: "fixture-blob", mimeType: "image/png", blobExtension: "png", sizeBytes: 2,
    naturalWidth: 1200, naturalHeight: 800,
    transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, cropZoom: 1, cropX: 50, cropY: 50 },
    occurredDate: "2026-06-01", reason: "字典事由", description: "待识别说明", arranger: "字典安排人",
    amountCents: 0, ocrMode: "advanced", ocrStatus: "queued", recognitionVersion: 0,
    extraAttachments: [], manualFields: {}, ...overrides,
  };
}
function makeDraft(expenses = [makeExpense()], overrides = {}) {
  return {
    id: "record-a", label: "业务测试草稿", status: "未报销", companyName: "测试公司",
    reimbursementDate: "2026-06-01", applicant: "申请人", department: "测试部门", payeeName: "收款人",
    account: "fixture-account", bank: "测试银行", totalOverrideCents: null, previewMode: "single",
    financeReviewer: "财务", showManagerApproval: true,
    expenses, updatedAt: "2026-06-01T04:00:00.000Z", ...overrides,
  };
}
function makeRecognized(overrides = {}) {
  return {
    ocrText: "OCR 原文：2026-06-02，45.67 元", llmText: "模型结构化原文",
    extracted: {
      occurredDate: "2026-06-02", reasonName: "识别事由", description: "识别说明", amountCents: 4567,
      confidence: { amount: 0.8 }, evidence: { amount: "45.67 元" },
    },
    ocrProfileName: "普通 OCR", llmProfileName: "测试模型", ocrElapsedMs: 17, llmElapsedMs: 23,
    ...overrides,
  };
}
function createLegacyState(draft = makeDraft()) {
  const { ref, reactive, computed } = vue;
  const state = {
    draft: reactive(draft), cellSelection: ref(null), isSaved: ref(false), saveText: ref("尚未保存"),
    isLoadingWorkspace: ref(false), storageReady: ref(true), activeTab: ref("reimbursement"),
    historyRecords: ref([]), profiles: ref([]), companyNames: ref(["测试公司"]), expenseReasons: ref(["字典事由"]),
    arrangers: ref(["字典安排人"]), defaultCompany: ref("测试公司"), defaultReason: ref("字典事由"),
    defaultArranger: ref("字典安排人"), leftPanelWidth: ref(404), historyViewMode: ref("company"),
    selectedId: ref("expense-a"), selectedAttachmentId: ref("expense-a"),
    ocrProfiles: ref([{ id: "ocr-main", name: "普通 OCR", accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", isDefault: true }]),
    llmProfiles: ref([{ id: "llm-main", name: "测试模型", apiKey: "fixture-key", model: "fixture-model", isDefault: true }]),
  };
  state.defaultOcrProfile = computed(() => state.ocrProfiles.value.find(item => item.isDefault) ?? state.ocrProfiles.value[0]);
  state.defaultLlmProfile = computed(() => state.llmProfiles.value.find(item => item.isDefault) ?? state.llmProfiles.value[0]);
  return state;
}
function createLegacyRecognition(state, environment, persistDraft) {
  return loadReference([
    "dirty", "isTauriRuntime", "errorMessage", "recognitionConfigured", "openOcrResult", "applyRecognizedField",
    "clearUnconfirmedExpenseFields", "recognizeExpense",
  ], [
    "draft", "cellSelection", "isSaved", "saveText", "ocrProfiles", "llmProfiles", "defaultOcrProfile", "defaultLlmProfile",
    "handwritingMode", "ocrResultExpense", "isOcrResultOpen",
  ], state, {
    ...environment.globals, ElMessage: environment.messages, invoke: environment.io.invoke, persistDraft,
    switchTab: tab => { environment.trace.push({ kind: "switchTab", tab }); },
  });
}
function createLegacyWorkspace(state, environment, context) {
  const reference = loadReference([
    "dirty", "isTauriRuntime", "errorMessage", "today", "id", "transform", "createDraft",
    "cloneDraft", "historyItem", "uiPreferencesSnapshot", "formatSaveTime",
    "normalizeHistoryViewMode", "normalizeReimbursementStatus", "normalizeExtraAttachment",
    "normalizeExpense", "normalizeDraftForUse", "persistDraft", "saveDraft", "scheduleAutoSave",
    "applyDraft", "replaceActiveDraft", "applyWorkspace", "loadBrowserWorkspace",
  ], [
    ...Object.keys(state), "autoSaveRevision", "suppressAutoSave", "saveTimer", "dataDirectory",
    "STORAGE_KEY", "PROFILE_KEY", "DICTIONARY_KEY", "HISTORY_KEY", "SERVICE_KEY", "UI_PREFERENCES_KEY",
    "MAX_EXPENSES", "REIMBURSEMENT_STATUSES",
  ], state, {
    ...environment.globals, ElMessage: environment.messages, invoke: environment.io.invoke,
    refreshHistoryQuery: context.refreshHistoryQuery,
    commitActiveEdit: context.commitActiveEdit,
    hydrateDraftImages: context.hydrateDraftImages,
    revokeDraftImageUrls: context.revokeDraftImageUrls,
    clampLeftPanelWidth: context.clampLeftPanelWidth,
    normalizeOcrProfile: context.normalizeOcrProfile,
    normalizeLlmProfile: context.normalizeLlmProfile,
    normalizeHistory: context.normalizeHistory,
  });
  return {
    ...state, ...reference,
    setSuppressAutoSave: value => { reference.suppressAutoSave = value; },
    getSuppressAutoSave: () => reference.suppressAutoSave,
    getAutoSaveRevision: () => reference.autoSaveRevision,
    getSaveTimer: () => reference.saveTimer.value,
  };
}

function makeExtraAttachment(index) {
  const id = `expense-a-extra-${index}`;
  return {
    id, fileName: `${id}.jpg`, imageDataUrl: `data:image/jpeg;base64,${index}`,
    blobHash: `extra-hash-${index}`, mimeType: "image/jpeg", blobExtension: "jpg", sizeBytes: 100 + index,
    naturalWidth: 800 + index, naturalHeight: 600 + index,
    transform: { x: index, y: index + 1, width: 25, height: 25, rotation: index % 2 ? 90 : 0, cropZoom: 1, cropX: 50, cropY: 50 },
  };
}
function createWorkspaceHarness({ desktop = true, draft = makeDraft(), reference = false } = {}) {
  const environment = createEnvironment(desktop);
  const loader = createModuleLoader(environment);
  const { ref } = vue;
  const uiPreferences = vue.reactive({ leftPanelWidth: 404, historyViewMode: "company" });
  const selectedId = ref(null);
  const selectedAttachmentId = ref(null);
  const hydratedDrafts = [];
  const context = {
    profiles: ref([{
      id: "profile-a", name: "默认资料", applicant: "申请人", department: "测试部门",
      payeeName: "收款人", account: "fixture-account", bank: "测试银行", isDefault: true,
    }]),
    companyNames: ref(["测试公司"]), expenseReasons: ref(["字典事由"]), arrangers: ref(["字典安排人"]),
    defaultCompany: ref("测试公司"), defaultReason: ref("字典事由"), defaultArranger: ref("字典安排人"),
    ocrProfiles: ref([{ id: "ocr-main", name: "普通 OCR", endpoint: "", region: "", accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", timeoutSeconds: 30, isDefault: true }]),
    llmProfiles: ref([{ id: "llm-main", name: "测试模型", baseUrl: "", apiKey: "fixture-key", model: "fixture-model", timeoutSeconds: 30, multimodal: false, isDefault: true }]),
    historyRecords: ref([]),
    normalizeOcrProfile: value => ({ id: value.id ?? "ocr-fixture", name: value.name ?? "", endpoint: value.endpoint ?? "", region: value.region ?? "", accessKeyId: value.accessKeyId ?? "", accessKeySecret: value.accessKeySecret ?? "", timeoutSeconds: value.timeoutSeconds ?? 30, isDefault: Boolean(value.isDefault) }),
    normalizeLlmProfile: value => ({ id: value.id ?? "llm-fixture", name: value.name ?? "", baseUrl: value.baseUrl ?? "", apiKey: value.apiKey ?? "", model: value.model ?? "", timeoutSeconds: value.timeoutSeconds ?? 30, multimodal: Boolean(value.multimodal), isDefault: Boolean(value.isDefault) }),
    normalizeHistory: value => ({ id: value.id ?? "history-fixture", label: value.label ?? "", status: value.status ?? "未报销", companyName: value.companyName ?? "", applicant: value.applicant ?? "", reimbursementDate: value.reimbursementDate ?? "", expenseCount: Number(value.expenseCount) || 0, totalCents: Number(value.totalCents) || 0, firstOccurredDate: value.firstOccurredDate ?? "", updatedAt: value.updatedAt ?? "2026-06-01T04:00:00.000Z", draft: value.draft }),
    hydrateDraftImages: async value => {
      hydratedDrafts.push(value);
      for (const expense of value.expenses) {
        if (expense.blobHash) expense.imageDataUrl = `blob:fixture/${expense.blobHash}`;
        if (expense.recognitionBlobHash) expense.recognitionImageDataUrl = `blob:fixture/${expense.recognitionBlobHash}`;
        for (const attachment of expense.extraAttachments) {
          if (attachment.blobHash) attachment.imageDataUrl = `blob:fixture/${attachment.blobHash}`;
        }
      }
      return value;
    },
    revokeDraftImageUrls: value => { environment.trace.push({ kind: "revokeDraftImageUrls", value }); },
    setSelectedIds: id => { selectedId.value = id; selectedAttachmentId.value = id; },
    clearSelection: () => { environment.trace.push({ kind: "clearSelection" }); },
    getUiPreferences: () => ({ ...uiPreferences }),
    setUiPreferences: value => { Object.assign(uiPreferences, value); },
    clampLeftPanelWidth: value => Math.max(280, Math.min(560, value)),
    loadBackupStatus: async () => { environment.trace.push({ kind: "loadBackupStatus" }); },
    refreshHistoryQuery: async () => { environment.trace.push({ kind: "refreshHistoryQuery" }); },
    getActiveTab: () => "reimbursement",
    commitActiveEdit: () => { environment.trace.push({ kind: "commitActiveEdit" }); },
  };
  let workspace;
  if (reference) {
    const state = createLegacyState(draft);
    for (const [key, value] of Object.entries(context)) {
      if (vue.isRef(value) && Object.hasOwn(state, key)) state[key] = value;
    }
    Object.assign(state, {
      selectedId, selectedAttachmentId,
      leftPanelWidth: vue.computed({ get: () => uiPreferences.leftPanelWidth, set: value => { uiPreferences.leftPanelWidth = value; } }),
      historyViewMode: vue.computed({ get: () => uiPreferences.historyViewMode, set: value => { uiPreferences.historyViewMode = value; } }),
    });
    state.isLoadingWorkspace.value = true;
    state.storageReady.value = !desktop;
    state.isSaved.value = true;
    state.saveText.value = "等待保存";
    workspace = createLegacyWorkspace(state, environment, context);
  } else {
    const workspaceModule = loader.load("composables/useWorkspace.ts");
    assert.equal(typeof workspaceModule.useWorkspace, "function", "必须执行真实 useWorkspace 模块");
    workspace = workspaceModule.useWorkspace(context);
    assert.ok(loader.cache.has(path.resolve(sourceRoot, "composables/useWorkspace.ts")));
  }
  workspace.applyDraft(draft);
  return { environment, loader, context, workspace, uiPreferences, selectedId, selectedAttachmentId, hydratedDrafts };
}
async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function commands(environment) {
  return environment.io.calls.map(call => call.command);
}
function fields(expense) {
  return Object.fromEntries(["occurredDate", "reason", "description", "arranger", "amountCents"].map(key => [key, expense[key]]));
}
function ready(workspace) {
  workspace.isLoadingWorkspace.value = false;
  workspace.storageReady.value = true;
}
function createRecognitionHarness({ draft = makeDraft(), reference = false } = {}) {
  const harness = createWorkspaceHarness({ draft, reference });
  const { workspace, environment, context, loader } = harness;
  ready(workspace);
  const recognitionContext = {
    draft: workspace.draft,
    defaultOcrProfile: vue.computed(() => context.ocrProfiles.value.find(item => item.isDefault) ?? context.ocrProfiles.value[0]),
    defaultLlmProfile: vue.computed(() => context.llmProfiles.value.find(item => item.isDefault) ?? context.llmProfiles.value[0]),
    persistDraft: showMessage => {
      environment.trace.push({ kind: "persistDraft", showMessage });
      return workspace.persistDraft(showMessage);
    },
    dirty: () => { environment.trace.push({ kind: "dirty" }); workspace.dirty(); },
    switchTab: tab => { environment.trace.push({ kind: "switchTab", tab }); },
  };
  let recognition;
  if (reference) {
    const state = createLegacyState(workspace.draft);
    Object.assign(state, {
      draft: workspace.draft, isSaved: workspace.isSaved, saveText: workspace.saveText,
      ocrProfiles: context.ocrProfiles, llmProfiles: context.llmProfiles,
      defaultOcrProfile: recognitionContext.defaultOcrProfile, defaultLlmProfile: recognitionContext.defaultLlmProfile,
    });
    recognition = createLegacyRecognition(state, environment, recognitionContext.persistDraft);
  } else {
    const module = loader.load("composables/useRecognition.ts");
    assert.equal(typeof module.useRecognition, "function", "必须执行真实 useRecognition 模块");
    recognition = module.useRecognition(recognitionContext);
    assert.ok(loader.cache.has(path.resolve(sourceRoot, "composables/useRecognition.ts")));
  }
  return { ...harness, recognition, recognitionContext };
}

// 只读取 root 中明确导出的嵌套函数，避免启动其余 composable、watch 或桌面初始化。
let rootAst;
function loadRootFunctions(names, globals) {
  const fileName = path.resolve(sourceRoot, "composables/useSheepFinanceApp.ts");
  rootAst ??= parseSource(fileName, readFileSync(fileName, "utf8"));
  const roots = rootAst.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === "useSheepFinanceApp");
  assert.equal(roots.length, 1, "真实 root 应唯一声明 useSheepFinanceApp");
  const root = roots[0];
  assert.ok(root.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const returned = root.body.statements.findLast(ts.isReturnStatement)?.expression;
  assert.ok(returned && ts.isObjectLiteralExpression(returned), "root 应返回公开方法对象");
  const publicNames = returned.properties.filter(node => ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node))
    .map(node => node.name.getText(rootAst));
  const declarations = names.map(name => {
    const matches = root.body.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.equal(matches.length, 1, `真实 root 缺少或重复函数：${name}`);
    assert.ok(publicNames.includes(name), `真实 root 未公开函数：${name}`);
    return matches[0].getText(rootAst);
  });
  return runCommonJs(`${declarations.join("\n")}\nmodule.exports = { ${names.join(", ")} };`, fileName, specifier => {
    throw new Error(`root 函数 AST 不应加载其它代码：${specifier}`);
  }, globals);
}

// FileReader 必须由测试手动完成；小图绕过压缩，存储再用 deferred 控制第二次业务检查。
function installImageFixture(environment) {
  const pendingReaders = [];
  const createdUrls = [];
  const revokedUrls = [];
  const image = { dataUrl: "data:image/png;base64,AQID", width: 1200, height: 800 };
  class FixtureFileReader {
    readAsDataURL(file) {
      pendingReaders.push({ reader: this, file });
      environment.trace.push({ kind: "image:read", fileName: file.name });
    }
  }
  class FixtureImage {
    naturalWidth = image.width;
    naturalHeight = image.height;
    set src(value) {
      environment.trace.push({ kind: "image:load", src: value });
      this.onload();
    }
  }
  Object.assign(environment.globals, {
    FileReader: FixtureFileReader, Image: FixtureImage, File, Blob, atob,
    document: { createElement: tag => { throw new Error(`小图 fixture 不应请求 DOM：${tag}`); } },
    URL: {
      createObjectURL(value) {
        const url = `blob:fixture-managed/${createdUrls.length + 1}`;
        createdUrls.push({ value, url });
        return url;
      },
      revokeObjectURL(url) { revokedUrls.push(url); },
    },
  });
  return {
    image, pendingReaders, createdUrls, revokedUrls,
    finishRead() {
      assert.equal(pendingReaders.length, 1, "图片读取应停在唯一的受控 await 点");
      const { reader, file } = pendingReaders.shift();
      reader.result = image.dataUrl;
      reader.onload();
      return file;
    },
  };
}
function makeImageFile(name = "fixture.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}
function inventory(extraCounts) {
  return makeDraft(extraCounts.map((count, index) => makeExpense({
    id: `expense-${index + 1}`,
    extraAttachments: Array.from({ length: count }, (_, extraIndex) => ({ ...makeExtraAttachment(extraIndex + 1), id: `extra-${index + 1}-${extraIndex + 1}` })),
  })));
}
function createAttachmentsHarness({ draft = makeDraft([]) } = {}) {
  const harness = createWorkspaceHarness({ draft });
  const { environment, loader, workspace, context, selectedId, selectedAttachmentId } = harness;
  ready(workspace);
  const images = installImageFixture(environment);
  const { buildPreviewAttachments } = loader.load("utils/pagination.ts");
  const previewAttachments = vue.computed(() => buildPreviewAttachments(workspace.draft.expenses));
  const selectedAttachment = vue.computed(() => previewAttachments.value.find(item => item.id === selectedAttachmentId.value) ?? null);
  const { setSelectedIds } = loadRootFunctions(["setSelectedIds"], { selectedId, selectedAttachmentId });
  context.setSelectedIds = setSelectedIds;
  const recognized = [];
  const attachmentCalls = [];
  const attachmentContext = {
    draft: workspace.draft, previewAttachments, selectedAttachment,
    defaultReason: context.defaultReason, expenseReasons: context.expenseReasons,
    defaultArranger: context.defaultArranger, arrangers: context.arrangers,
    handwritingMode: vue.ref(true), recognitionConfigured: () => true,
    recognizeExpense: async (expense, notify) => { recognized.push({ expense, notify }); },
    dirty: workspace.dirty, persistDraft: workspace.persistDraft,
    reflowExpenses: () => { attachmentCalls.push("reflowExpenses"); },
    reflowAttachments: () => { attachmentCalls.push("reflowAttachments"); },
    scrollExpenseIntoView: expenseId => { attachmentCalls.push(`scroll:${expenseId}`); },
    setSelectedIds,
    saveAttachmentFile: async () => { throw new Error("附件测试禁止正式目录对话框"); },
  };
  const { useAttachments } = loader.load("composables/useAttachments.ts");
  assert.equal(typeof useAttachments, "function");
  const attachments = useAttachments(attachmentContext);
  assert.ok(loader.cache.has(path.resolve(sourceRoot, "composables/useAttachments.ts")));
  environment.io.handlers.set("store_attachment", () => Promise.resolve({
    blobHash: "uploaded-hash", mimeType: "image/png", blobExtension: "png", sizeBytes: 3,
    recognitionBlobHash: "uploaded-recognition", recognitionMimeType: "image/png", recognitionBlobExtension: "png", recognitionSizeBytes: 3,
  }));
  return { ...harness, images, attachments, attachmentContext, attachmentCalls, previewAttachments, recognized, setSelectedIds };
}
function makeLanSession(name, overrides = {}) {
  return {
    url: `http://fixture.invalid/${name}`, recordId: "record-a", label: "业务测试草稿",
    expiresAt: fixedNow + 900000, remainingSlots: 9, localAddress: "fixture-only", ...overrides,
  };
}
function createLanHarness() {
  const harness = createAttachmentsHarness({ draft: makeDraft() });
  const { environment, loader, workspace, attachments, previewAttachments } = harness;
  const { ref } = vue;
  const state = {
    isLanUploadOpen: ref(true), isLanUploadLoading: ref(false), lanUploadSession: ref(null),
    lanUploadQrCode: ref(""), lanUploadError: ref(""), lanUploadNow: ref(0), lanUploadTargetExpenseId: ref(null),
  };
  const addHandlers = {
    main: () => { throw new Error("手机主图必须提供受控添加回调"); },
    extra: () => { throw new Error("手机附图必须提供受控添加回调"); },
  };
  let unlistenCalls = 0;
  environment.io.handlers.set("listen_lan_upload_received", ({ callback }) => {
    assert.equal(typeof callback, "function");
    return Promise.resolve(() => { unlistenCalls += 1; });
  });
  environment.io.handlers.set("update_lan_upload_session", () => Promise.resolve());
  environment.io.handlers.set("stop_lan_upload_session", () => Promise.resolve());
  environment.qrCode = { toDataURL: (url, options) => environment.io.invoke("qrcode", { url, options }) };
  environment.io.handlers.set("qrcode", ({ url }) => Promise.resolve(`data:fixture-qr,${url}`));
  const { useLanUpload } = loader.load("composables/useLanUpload.ts");
  assert.equal(typeof useLanUpload, "function");
  const lanUpload = useLanUpload({
    draft: workspace.draft, previewAttachments, ...state,
    addFile: (...args) => addHandlers.main(...args),
    addExtraAttachmentFile: (...args) => addHandlers.extra(...args),
    extraAttachmentSlots: attachments.extraAttachmentSlots,
  });
  assert.ok(loader.cache.has(path.resolve(sourceRoot, "composables/useLanUpload.ts")));
  return { ...harness, state, lanUpload, addHandlers, getUnlistenCalls: () => unlistenCalls };
}

// 固定基线只用于核对旧同名业务轨迹；各场景在新旧实现中都先验证独立预期。
test("保存 gate 阻止 IO，新编辑的 revision 不被旧响应标 saved，失败保留 dirty 与提示", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const { workspace, environment, context } = createWorkspaceHarness({ reference });
    workspace.dirty();
    assert.equal(workspace.getAutoSaveRevision(), 0, "dirty 本身沿用旧语义，不增长 revision");
    const initialHistory = context.historyRecords.value;
    const before = workspace.cloneDraft();
    const gateResults = [];
    for (const gate of ["loading", "suppress", "storage"]) {
      workspace.isLoadingWorkspace.value = gate === "loading";
      workspace.storageReady.value = gate !== "storage";
      workspace.setSuppressAutoSave(gate === "suppress");
      gateResults.push(await workspace.persistDraft(true));
      assert.equal(workspace.saveText.value, "尚未保存");
      assert.equal(workspace.isSaved.value, false);
      assert.strictEqual(context.historyRecords.value, initialHistory, "gate 不得提前更新历史引用");
      assert.deepEqual(plain(workspace.cloneDraft()), plain(before));
    }
    assert.deepEqual(gateResults, [false, false, false]);
    assert.deepEqual(commands(environment), []);
    assert.equal(environment.trace.some(event => event.kind === "storage:set" || event.kind === "message"), false);
    ready(workspace);
    workspace.setSuppressAutoSave(false);
    const savingGate = deferred();
    environment.io.handlers.set("save_workspace", () => savingGate.promise);
    workspace.draft.label = "保存开始时的标题";
    workspace.dirty();
    workspace.scheduleAutoSave();
    const pending = workspace.persistDraft(false);
    assert.equal(workspace.saveText.value, "正在自动保存");
    assert.deepEqual(commands(environment), ["save_workspace"]);
    const snapshot = environment.io.calls[0].payload.request.draft;
    assert.notStrictEqual(snapshot, workspace.draft);
    assert.notStrictEqual(snapshot.expenses[0], workspace.draft.expenses[0]);
    assert.notStrictEqual(snapshot.expenses[0].manualFields, workspace.draft.expenses[0].manualFields);
    workspace.draft.label = "等待期间的新标题";
    workspace.draft.expenses[0].amountCents = 900;
    workspace.dirty();
    // 根 watch 才调度 revision；不凭空要求 dirty 增长原 let。
    workspace.scheduleAutoSave();
    assert.equal(workspace.getAutoSaveRevision(), 2);
    savingGate.resolve();
    assert.equal(await pending, true);
    assert.equal(workspace.isSaved.value, false);
    assert.equal(workspace.saveText.value, "尚未保存");
    assert.equal(snapshot.label, "保存开始时的标题");
    assert.equal(snapshot.expenses[0].amountCents, 0);
    assert.equal(workspace.draft.label, "等待期间的新标题");
    assert.equal(workspace.draft.expenses[0].amountCents, 900);
    const stale = { isSaved: workspace.isSaved.value, saveText: workspace.saveText.value };
    environment.io.handlers.set("save_workspace", () => Promise.reject(new Error("保存失败：fixture")));
    assert.equal(await workspace.persistDraft(true), false);
    assert.equal(workspace.isSaved.value, false);
    assert.equal(workspace.saveText.value, "自动保存失败");
    assert.deepEqual(environment.trace.filter(event => event.kind === "message"), [
      { kind: "message", level: "error", text: "保存失败：fixture" },
    ]);
    assert.equal(workspace.draft.label, "等待期间的新标题");
    assert.equal(workspace.draft.expenses[0].amountCents, 900);
    summaries.push({ gateResults, revision: workspace.getAutoSaveRevision(), stale, failedText: workspace.saveText.value, commands: commands(environment), snapshot: plain(snapshot) });
  }
  assert.deepEqual(summaries[0], summaries[1], "真实 useWorkspace 与固定基线保存轨迹一致");
});

test("自动保存九百毫秒取消旧 timer 且只保存一次，loading、抑制和未就绪不调度", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const { workspace, environment } = createWorkspaceHarness({ reference });
    ready(workspace);
    const savingGate = deferred();
    environment.io.handlers.set("save_workspace", () => savingGate.promise);
    workspace.dirty();
    assert.equal(workspace.getAutoSaveRevision(), 0);
    assert.deepEqual(environment.timers.pending, []);
    workspace.scheduleAutoSave();
    const firstTimer = workspace.getSaveTimer();
    assert.equal(vue.isRef(workspace.saveTimer), true);
    assert.strictEqual(workspace.saveTimer.value, firstTimer);
    assert.deepEqual(environment.timers.pending, [{ id: firstTimer, delay: 900, due: 900 }]);
    environment.timers.advanceBy(450);
    workspace.draft.expenses[0].amountCents = 1250;
    workspace.dirty();
    workspace.scheduleAutoSave();
    const secondTimer = workspace.getSaveTimer();
    assert.notEqual(secondTimer, firstTimer);
    assert.equal(workspace.getAutoSaveRevision(), 2);
    assert.deepEqual(environment.timers.pending, [{ id: secondTimer, delay: 900, due: 1350 }]);
    assert.deepEqual(environment.trace.filter(event => event.kind === "timer:clear"), [{ kind: "timer:clear", id: firstTimer }]);
    environment.timers.advanceBy(899);
    assert.deepEqual(commands(environment), []);
    environment.timers.advanceBy(1);
    assert.deepEqual(commands(environment), ["save_workspace"]);
    assert.equal(environment.io.calls[0].payload.request.draft.expenses[0].amountCents, 1250);
    assert.strictEqual(workspace.getSaveTimer(), null);
    assert.strictEqual(workspace.saveTimer.value, null);
    assert.deepEqual(environment.timers.pending, []);
    savingGate.resolve();
    await savingGate.promise;
    await flushMicrotasks();
    assert.equal(workspace.isSaved.value, true);
    assert.equal(workspace.saveText.value, "已保存 12:00:00");
    for (const gate of ["loading", "suppress", "storage"]) {
      workspace.isLoadingWorkspace.value = gate === "loading";
      workspace.storageReady.value = gate !== "storage";
      workspace.setSuppressAutoSave(gate === "suppress");
      assert.equal(workspace.getSuppressAutoSave(), gate === "suppress");
      workspace.scheduleAutoSave();
      assert.equal(workspace.getAutoSaveRevision(), 2);
      assert.equal(workspace.isSaved.value, true);
      assert.equal(workspace.saveText.value, "已保存 12:00:00");
      assert.deepEqual(environment.timers.pending, []);
      assert.strictEqual(workspace.getSaveTimer(), null);
    }
    assert.deepEqual(commands(environment), ["save_workspace"]);
    summaries.push({ revision: workspace.getAutoSaveRevision(), saved: workspace.isSaved.value, text: workspace.saveText.value, trace: plain(environment.trace.filter(event => event.kind.startsWith("timer:") || event.kind === "invoke")) });
  }
  assert.deepEqual(summaries[0], summaries[1], "真实 useWorkspace 与固定基线九百毫秒调度一致");
});

test("真实 workspace 新建及 normalize 补财务和经理审批默认，并保留显式选择", () => {
  const { workspace, environment } = createWorkspaceHarness();
  const defaults = { financeReviewer: "财务", showManagerApproval: true };
  const created = workspace.createDraft();
  assert.deepEqual(plain({ financeReviewer: created.financeReviewer, showManagerApproval: created.showManagerApproval }), defaults);
  // 用真正缺少新字段的旧单据验证补默认，不能依赖 makeDraft 已提供的默认值。
  const { financeReviewer, showManagerApproval, ...oldDraft } = makeDraft();
  for (const [approval, expected] of [
    [{}, defaults],
    [{ financeReviewer: undefined, showManagerApproval: undefined }, defaults],
    [{ financeReviewer: "未知审批人", showManagerApproval: null }, defaults],
    [{ financeReviewer: "秘书处", showManagerApproval: false }, { financeReviewer: "秘书处", showManagerApproval: false }],
    [{ financeReviewer: "财务", showManagerApproval: false }, { financeReviewer: "财务", showManagerApproval: false }],
    [{ financeReviewer: "秘书处", showManagerApproval: true }, { financeReviewer: "秘书处", showManagerApproval: true }],
  ]) {
    const input = { ...oldDraft, ...approval };
    const before = plain(input);
    const normalized = workspace.normalizeDraftForUse(input);
    assert.deepEqual(plain(workspace.cloneDraft(normalized)), { ...oldDraft, ...expected }, "normalize 的完整草稿与独立审批预期");
    workspace.applyDraft(input);
    assert.deepEqual(plain(workspace.cloneDraft()), { ...oldDraft, ...expected }, "applyDraft 和快照不能丢失审批字段");
    assert.deepEqual(plain(input), before, "补默认不能改写输入旧单据");
  }
  assert.deepEqual(commands(environment), []);
  assert.deepEqual(environment.timers.pending, []);
});

test("空浏览器与缺失 UI prefs 安全恢复，新建和快照字段完整，历史附图不截断", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const harness = createWorkspaceHarness({ desktop: false, draft: makeDraft([]), reference });
    const { workspace, environment, context, uiPreferences, selectedId, selectedAttachmentId, hydratedDrafts } = harness;
    const created = workspace.createDraft();
    assert.match(created.id, /^record-\d+-[0-9a-f]+$/);
    if (!reference) {
      assert.equal(created.financeReviewer, "财务", "真实新建草稿的审批人默认");
      assert.equal(created.showManagerApproval, true, "真实新建草稿默认显示经理审批");
    } else {
      assert.equal(Object.hasOwn(created, "financeReviewer"), false);
      assert.equal(Object.hasOwn(created, "showManagerApproval"), false);
    }
    // 旧 createDraft 没有这两个字段，仅此新建结果窄剥离；其余旧新轨迹使用同样的完整 fixture。
    const { financeReviewer, showManagerApproval, ...legacyCreated } = created;
    assert.deepEqual(plain({ ...legacyCreated, id: "新建 ID" }), {
      id: "新建 ID", label: "", status: "未报销", companyName: "", reimbursementDate: "",
      applicant: "申请人", department: "测试部门", payeeName: "收款人", account: "fixture-account", bank: "测试银行",
      totalOverrideCents: null, previewMode: "single", expenses: [], updatedAt: new FixtureDate().toISOString(),
    });
    assert.notStrictEqual(created, workspace.draft);
    assert.equal(workspace.loadBrowserWorkspace(), false, "空 localStorage 的 null prefs 不能解引用");
    assert.deepEqual(plain(uiPreferences), { leftPanelWidth: 404, historyViewMode: "company" });
    const prefsKey = "sheepfinance:ui-preferences:v1";
    for (const [preferences, expected] of [
      [{}, { leftPanelWidth: 404, historyViewMode: "company" }],
      [{ leftPanelWidth: 999 }, { leftPanelWidth: 560, historyViewMode: "company" }],
      [{ historyViewMode: "status" }, { leftPanelWidth: 560, historyViewMode: "status" }],
    ]) {
      environment.values.set(prefsKey, JSON.stringify(preferences));
      assert.equal(workspace.loadBrowserWorkspace(), false);
      assert.deepEqual(plain(uiPreferences), expected);
    }
    const baseWorkspace = { profiles: [], dictionaries: {}, services: {}, history: [], dataDirectory: "fixture-only" };
    for (const preferences of [undefined, {}]) {
      await workspace.applyWorkspace({ ...baseWorkspace, ...(preferences === undefined ? {} : { uiPreferences: preferences }) });
      assert.deepEqual(plain(uiPreferences), { leftPanelWidth: 560, historyViewMode: "status" });
      assert.deepEqual(plain(workspace.draft.expenses), []);
      assert.equal(workspace.dataDirectory.value, "fixture-only");
      assert.strictEqual(selectedId.value, null);
      assert.strictEqual(selectedAttachmentId.value, null);
    }
    await workspace.applyWorkspace({ ...baseWorkspace, uiPreferences: { leftPanelWidth: 500 } });
    assert.deepEqual(plain(uiPreferences), { leftPanelWidth: 500, historyViewMode: "status" });
    await workspace.applyWorkspace({ ...baseWorkspace, uiPreferences: { historyViewMode: "list" } });
    assert.deepEqual(plain(uiPreferences), { leftPanelWidth: 500, historyViewMode: "list" });
    const attachments = Array.from({ length: 12 }, (_, index) => makeExtraAttachment(index + 1));
    const rawExpense = makeExpense({
      extraAttachments: attachments, amountCents: -125, ocrMode: "handwriting", ocrStatus: "success", recognitionVersion: 7,
      recognitionImageDataUrl: "data:image/png;base64,Ag==", recognitionBlobHash: "recognition-hash",
      recognitionMimeType: "image/png", recognitionBlobExtension: "png", originalSizeBytes: 30000, recognitionSizeBytes: 1024,
      ocrText: "历史 OCR", llmText: "历史模型", recognitionError: "", lastOcrProfile: "历史 OCR 配置", lastLlmProfile: "历史模型配置", lastRecognitionMs: 19,
      recognizedFields: { amountCents: -125, confidence: { amount: 0.7 }, evidence: { amount: "-1.25" } },
      manualFields: { reason: true, arranger: true, amountCents: true },
    });
    const raw = makeDraft([rawExpense], { status: "报销中", previewMode: "double", totalOverrideCents: 12345 });
    const rawBefore = JSON.stringify(raw);
    environment.values.set("sheepfinance:workbench:v1", rawBefore);
    assert.equal(workspace.loadBrowserWorkspace(), true);
    assert.equal(hydratedDrafts.length, 0, "浏览器恢复不应请求桌面图片 IO");
    assert.deepEqual(plain(workspace.cloneDraft()), plain(raw));
    assert.equal(workspace.draft.expenses[0].extraAttachments.length, 12, "恢复不得套用新增上传数量限制");
    assert.strictEqual(selectedId.value, "expense-a");
    assert.strictEqual(selectedAttachmentId.value, "expense-a");
    const snapshot = workspace.cloneDraft();
    assert.notStrictEqual(snapshot, workspace.draft);
    assert.notStrictEqual(snapshot.expenses, workspace.draft.expenses);
    assert.notStrictEqual(snapshot.expenses[0].extraAttachments[11].transform, workspace.draft.expenses[0].extraAttachments[11].transform);
    snapshot.expenses[0].manualFields.reason = false;
    snapshot.expenses[0].extraAttachments[11].transform.rotation = 180;
    assert.equal(workspace.draft.expenses[0].manualFields.reason, true);
    assert.equal(workspace.draft.expenses[0].extraAttachments[11].transform.rotation, 0);
    const history = workspace.historyItem(workspace.draft, true);
    assert.deepEqual(plain({ ...history, draft: undefined }), {
      id: "record-a", label: "业务测试草稿", status: "报销中", companyName: "测试公司", applicant: "申请人",
      reimbursementDate: "2026-06-01", expenseCount: 1, totalCents: 12345, firstOccurredDate: "2026-06-01", updatedAt: "2026-06-01T04:00:00.000Z", draft: undefined,
    });
    assert.notStrictEqual(history.draft, workspace.draft);
    assert.deepEqual(plain(history.draft), plain(raw));
    const draftIdentity = workspace.draft;
    await workspace.applyWorkspace({ ...baseWorkspace, draft: raw });
    assert.strictEqual(workspace.draft, draftIdentity, "切换工作区保留共享 reactive 草稿身份");
    assert.equal(hydratedDrafts.length, 1);
    assert.notStrictEqual(hydratedDrafts[0], workspace.draft);
    assert.strictEqual(vue.toRaw(workspace.draft.expenses[0].manualFields), rawExpense.manualFields);
    assert.strictEqual(vue.toRaw(workspace.draft.expenses[0].recognizedFields), rawExpense.recognizedFields);
    assert.equal(JSON.stringify(raw), rawBefore, "恢复和内存 hydration 不能改调用方输入");
    const restored = workspace.cloneDraft();
    assert.deepEqual(plain(restored), plain({
      ...raw,
      expenses: [{
        ...rawExpense, imageDataUrl: "blob:fixture/fixture-blob", recognitionImageDataUrl: "blob:fixture/recognition-hash",
        extraAttachments: attachments.map(attachment => ({ ...attachment, imageDataUrl: `blob:fixture/${attachment.blobHash}` })),
      }],
    }));
    assert.equal(restored.expenses[0].extraAttachments.length, 12);
    assert.deepEqual(plain(restored.expenses[0].extraAttachments.map(attachment => attachment.id)), attachments.map(attachment => attachment.id));
    assert.equal(restored.expenses[0].extraAttachments[11].blobHash, "extra-hash-12");
    assert.deepEqual(commands(environment), []);
    assert.equal(environment.trace.some(event => event.kind === "storage:set"), false);
    assert.strictEqual(context.profiles.value[0].id, "profile-a");
    summaries.push({ created: plain({ ...legacyCreated, id: "新建 ID" }), uiPreferences: plain(uiPreferences), history: plain(history), restored: plain(restored) });
  }
  assert.deepEqual(summaries[0], summaries[1], "真实 useWorkspace 与固定基线恢复和快照一致");
});

const manualFields = { occurredDate: true, reason: true, description: true, arranger: true, amountCents: true };
const manualValues = { occurredDate: "2026-06-01", reason: "人工事由", description: "人工说明", arranger: "人工安排人", amountCents: -125 };

test("识别先 await 保存，失败不请求不改人工字段，普通与手写 id 和 payload 正确", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const traces = [];
    const failed = createRecognitionHarness({ reference, draft: makeDraft([makeExpense({ ...manualValues, manualFields: { ...manualFields } })]) });
    const failedGate = deferred();
    failed.environment.io.handlers.set("save_workspace", () => failedGate.promise);
    failed.environment.io.handlers.set("recognize_expense", () => Promise.resolve(makeRecognized()));
    const failedExpense = failed.workspace.draft.expenses[0];
    const manualIdentity = failedExpense.manualFields;
    const pendingFailure = failed.recognition.recognizeExpense(failedExpense);
    assert.deepEqual(commands(failed.environment), ["save_workspace"]);
    assert.deepEqual(fields(failedExpense), manualValues);
    assert.strictEqual(failedExpense.manualFields, manualIdentity);
    await flushMicrotasks();
    assert.deepEqual(commands(failed.environment), ["save_workspace"]);
    failedGate.reject(new Error("磁盘不可写：fixture"));
    await pendingFailure;
    assert.deepEqual(commands(failed.environment), ["save_workspace"]);
    assert.deepEqual(fields(failedExpense), manualValues);
    assert.equal(failedExpense.ocrStatus, "error");
    assert.equal(failedExpense.recognitionError, "识别前保存单据失败，已取消本次请求");
    assert.deepEqual(failed.environment.trace.filter(event => event.kind === "message"), [
      { kind: "message", level: "error", text: "识别前保存单据失败，已取消本次请求" },
    ]);
    traces.push({ failed: true, fields: fields(failedExpense), status: failedExpense.ocrStatus, error: failedExpense.recognitionError, commands: commands(failed.environment) });
    for (const [ocrMode, expenseId] of [["advanced", "expense-a"], ["handwriting", "expense-handwriting"]]) {
      const harness = createRecognitionHarness({ reference, draft: makeDraft([makeExpense({ ...manualValues, id: expenseId, ocrMode, manualFields: { ...manualFields } })]) });
      const { workspace, recognition, environment } = harness;
      const saveGate = deferred();
      const resultGate = deferred();
      environment.io.handlers.set("save_workspace", () => saveGate.promise);
      environment.io.handlers.set("recognize_expense", () => resultGate.promise);
      const expense = workspace.draft.expenses[0];
      recognition.handwritingMode.value = ocrMode === "advanced";
      const pending = recognition.recognizeExpense(expense);
      await recognition.recognizeExpense(expense);
      assert.equal(expense.ocrStatus, "recognizing");
      assert.equal(expense.recognitionVersion, 1);
      assert.deepEqual(commands(environment), ["save_workspace"], "识别中重复入口不得重复保存或请求");
      assert.deepEqual(fields(expense), manualValues);
      assert.deepEqual(environment.trace.filter(event => event.kind === "persistDraft"), [{ kind: "persistDraft", showMessage: false }]);
      const savedSnapshot = environment.io.calls[0].payload.request.draft;
      assert.notStrictEqual(savedSnapshot, workspace.draft);
      assert.notStrictEqual(savedSnapshot.expenses[0], expense);
      assert.equal(savedSnapshot.expenses[0].ocrStatus, "recognizing");
      await flushMicrotasks();
      assert.deepEqual(commands(environment), ["save_workspace"]);
      const nextRecognition = environment.io.nextCall("recognize_expense");
      saveGate.resolve();
      const call = await nextRecognition;
      const expectedRequest = { recordId: "record-a", expenseId, attachmentId: expenseId, ocrMode, ocrProfileId: "ocr-main", llmProfileId: "llm-main" };
      assert.deepEqual(plain(call.payload), { request: expectedRequest });
      assert.deepEqual(commands(environment), ["save_workspace", "recognize_expense"]);
      resultGate.resolve(makeRecognized());
      await pending;
      assert.deepEqual(fields(expense), manualValues);
      assert.equal(expense.ocrStatus, "success");
      assert.equal(expense.lastRecognitionMs, 40);
      assert.deepEqual(environment.trace.filter(event => event.kind === "message"), [
        { kind: "message", level: "success", text: "识别完成，请人工确认事由和安排人" },
      ]);
      traces.push({ request: plain(call.payload), savedExpense: plain(savedSnapshot.expenses[0]), fields: fields(expense), status: expense.ocrStatus, commands: commands(environment) });
    }
    summaries.push(traces);
  }
  assert.deepEqual(summaries[0], summaries[1], "真实识别与固定基线保存前置和 payload 一致");
});

test("manualFields 保护且事由安排人仍待确认，模型 partial 保留 OCR 与已有候选字段", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const cases = [
      { name: "人工确认", expense: makeExpense({ ...manualValues, manualFields: { ...manualFields } }), response: makeRecognized(), expected: manualValues },
      { name: "未人工确认", expense: makeExpense(), response: makeRecognized(), expected: { occurredDate: "2026-06-02", reason: "", description: "识别说明", arranger: "", amountCents: 4567 } },
      { name: "模型 partial", expense: makeExpense({ description: "人工说明", amountCents: 0, manualFields: { description: true, amountCents: true }, ocrText: "旧 OCR", llmText: "旧模型", recognizedFields: { description: "旧候选字段" } }), response: makeRecognized({ llmError: "模型提取失败", llmText: undefined, extracted: undefined }), expected: { occurredDate: "2026-06-01", reason: "", description: "人工说明", arranger: "", amountCents: 0 } },
    ];
    const results = [];
    for (const scenario of cases) {
      const { workspace, recognition, environment } = createRecognitionHarness({ reference, draft: makeDraft([scenario.expense]) });
      environment.io.handlers.set("save_workspace", () => Promise.resolve());
      const resultGate = deferred();
      environment.io.handlers.set("recognize_expense", () => resultGate.promise);
      const expense = workspace.draft.expenses[0];
      const protectedFields = expense.manualFields;
      const previousCandidates = expense.recognizedFields;
      const nextRecognition = environment.io.nextCall("recognize_expense");
      const pending = recognition.recognizeExpense(expense);
      await nextRecognition;
      if (scenario.name !== "人工确认") {
        assert.equal(expense.reason, "", "字典事由不能直接当作人工确认");
        assert.equal(expense.arranger, "", "字典安排人不能直接当作人工确认");
      }
      resultGate.resolve(scenario.response);
      await pending;
      assert.strictEqual(workspace.draft.expenses[0], expense);
      assert.strictEqual(expense.manualFields, protectedFields);
      assert.deepEqual(fields(expense), scenario.expected, scenario.name);
      assert.equal(expense.ocrText, "OCR 原文：2026-06-02，45.67 元");
      assert.equal(expense.lastOcrProfile, "普通 OCR");
      assert.equal(expense.lastLlmProfile, "测试模型");
      assert.equal(expense.lastRecognitionMs, 40);
      if (scenario.response.extracted) {
        assert.deepEqual(plain(expense.recognizedFields), {
          occurredDate: "2026-06-02", reason: "识别事由", description: "识别说明", amountCents: 4567,
          confidence: { amount: 0.8 }, evidence: { amount: "45.67 元" },
        });
        assert.strictEqual(vue.toRaw(expense.recognizedFields.confidence), scenario.response.extracted.confidence);
        assert.strictEqual(vue.toRaw(expense.recognizedFields.evidence), scenario.response.extracted.evidence);
        assert.equal(expense.ocrStatus, "success");
        assert.equal(expense.recognitionError, "");
        assert.equal(expense.llmText, "模型结构化原文");
      } else {
        assert.strictEqual(expense.recognizedFields, previousCandidates, "partial 无新提取字段时保留原候选对象");
        assert.deepEqual(plain(expense.recognizedFields), { description: "旧候选字段" });
        assert.equal(expense.ocrStatus, "partial");
        assert.equal(expense.recognitionError, "模型提取失败");
        assert.equal(expense.llmText, "");
        assert.deepEqual(environment.trace.filter(event => event.kind === "message"), [
          { kind: "message", level: "success", text: "OCR 已完成，大模型提取失败，可查看原文后手工填写" },
        ]);
      }
      recognition.openOcrResult(expense);
      assert.equal(recognition.isOcrResultOpen.value, true);
      assert.strictEqual(recognition.ocrResultExpense.value, expense, "结果查看沿用费用对象身份");
      results.push({ name: scenario.name, fields: fields(expense), candidates: plain(expense.recognizedFields), status: expense.ocrStatus, ocrText: expense.ocrText, llmText: expense.llmText, commands: commands(environment) });
    }
    summaries.push(results);
  }
  assert.deepEqual(summaries[0], summaries[1], "真实识别与固定基线人工保护、待确认和 partial 一致");
});

test("重试、删除、不同 ID 切单的成功和失败晚到回包不污染当前对象，新请求仍应用", async t => {
  const summaries = [];
  for (const reference of [false, true]) {
    const results = [];
    for (const scenario of ["重试", "删除", "切单"]) {
      for (const outcome of ["成功", "失败"]) {
        const { workspace, recognition, environment } = createRecognitionHarness({ reference, draft: makeDraft([makeExpense(), makeExpense({ id: "expense-keep" })]) });
        environment.io.handlers.set("save_workspace", () => Promise.resolve());
        const oldGate = deferred();
        const newGate = deferred();
        const gates = [oldGate, newGate];
        environment.io.handlers.set("recognize_expense", () => gates.shift().promise);
        const oldExpense = workspace.draft.expenses[0];
        const oldCall = environment.io.nextCall("recognize_expense");
        const oldPending = recognition.recognizeExpense(oldExpense);
        await oldCall;
        assert.equal(oldExpense.recognitionVersion, 1);
        let current;
        if (scenario === "重试") {
          // 允许同一费用再次进入入口；版本递增由真实 recognizeExpense 完成。
          oldExpense.ocrStatus = "error";
          current = oldExpense;
        } else if (scenario === "删除") {
          workspace.draft.expenses.splice(0, 1);
          current = workspace.draft.expenses[0];
        } else {
          workspace.applyDraft(makeDraft([makeExpense({ id: "expense-b" })], { id: "record-b" }));
          current = workspace.draft.expenses[0];
        }
        const newCall = environment.io.nextCall("recognize_expense");
        const newPending = recognition.recognizeExpense(current);
        const latestCall = await newCall;
        assert.equal(latestCall.payload.request.recordId, scenario === "切单" ? "record-b" : "record-a");
        assert.equal(latestCall.payload.request.expenseId, scenario === "重试" ? "expense-a" : scenario === "删除" ? "expense-keep" : "expense-b");
        assert.equal(current.recognitionVersion, scenario === "重试" ? 2 : 1);
        newGate.resolve(makeRecognized({ ocrText: "新请求原文", extracted: { occurredDate: "2026-06-02", reasonName: "新候选事由", description: "新请求说明", amountCents: 8800, confidence: {}, evidence: {} } }));
        await newPending;
        assert.deepEqual(fields(current), { occurredDate: "2026-06-02", reason: "", description: "新请求说明", arranger: "", amountCents: 8800 });
        assert.equal(current.ocrStatus, "success");
        assert.equal(current.ocrText, "新请求原文");
        assert.equal(current.recognitionError, "");
        const beforeLate = workspace.cloneDraft();
        const detachedBefore = plain(oldExpense);
        const traceLength = environment.trace.length;
        const savedBefore = workspace.isSaved.value;
        const saveTextBefore = workspace.saveText.value;
        if (outcome === "成功") oldGate.resolve(makeRecognized({ ocrText: "旧请求晚到原文" }));
        else oldGate.reject(new Error("旧请求晚到失败"));
        await oldPending;
        assert.deepEqual(plain(workspace.cloneDraft()), plain(beforeLate), `${scenario}/${outcome} 的旧回包不能改当前草稿`);
        assert.deepEqual(plain(oldExpense), detachedBefore, "被移除的对象也不应被晚到分支改写");
        assert.strictEqual(workspace.draft.expenses.find(item => item.id === current.id), current);
        assert.equal(environment.trace.length, traceLength, "过期分支不得触发新 IO、dirty 或通知");
        assert.equal(workspace.isSaved.value, savedBefore);
        assert.equal(workspace.saveText.value, saveTextBefore);
        results.push({ scenario, outcome, current: plain(current), draftId: workspace.draft.id, commands: commands(environment), messages: environment.trace.filter(event => event.kind === "message") });
      }
    }
    // 仅记录旧契约：人工构造另一单据的同 expense ID/version 会命中旧 find/version 检查。
    const edge = createRecognitionHarness({ reference });
    const edgeGate = deferred();
    edge.environment.io.handlers.set("save_workspace", () => Promise.resolve());
    edge.environment.io.handlers.set("recognize_expense", () => edgeGate.promise);
    const oldExpense = edge.workspace.draft.expenses[0];
    const edgeCall = edge.environment.io.nextCall("recognize_expense");
    const edgePending = edge.recognition.recognizeExpense(oldExpense);
    await edgeCall;
    edge.workspace.applyDraft(makeDraft([makeExpense({ recognitionVersion: 1, ocrStatus: "manual" })], { id: "record-b" }));
    const reusedExpense = edge.workspace.draft.expenses[0];
    assert.notStrictEqual(reusedExpense, oldExpense);
    edgeGate.resolve(makeRecognized({ ocrText: "旧单据晚到原文" }));
    await edgePending;
    assert.equal(edge.workspace.draft.id, "record-b");
    assert.equal(reusedExpense.ocrText, "旧单据晚到原文");
    assert.equal(reusedExpense.amountCents, 4567);
    assert.equal(reusedExpense.ocrStatus, "success");
    assert.equal(oldExpense.ocrStatus, "recognizing");
    results.push({ sameIdVersionEdge: plain(reusedExpense) });
    summaries.push(results);
  }
  assert.deepEqual(summaries[0], summaries[1], "真实识别与固定基线晚到分支及同 ID/version 现状一致");
  t.diagnostic("现状证据：另一单据人工复用同 expense ID 且 recognitionVersion 相同，会接收旧回包；常规不同 ID 切单不受此构造前提影响。");
});

test("实际附件新增区分主附图识别与双 ID，容量边界及 await 后容量或切单再次检查", async () => {
  for (const kind of ["主图", "附图"]) {
    const harness = createAttachmentsHarness({ draft: kind === "主图" ? inventory(Array(9).fill(0)) : inventory([8, 9, 9]) });
    const { workspace, attachments, environment, images, selectedId, selectedAttachmentId, previewAttachments, recognized, attachmentCalls } = harness;
    const file = makeImageFile(`${kind}.png`);
    const before = workspace.cloneDraft();
    const expense = workspace.draft.expenses[0];
    const storedGate = deferred();
    environment.io.handlers.set("store_attachment", () => storedGate.promise);
    const storeCall = environment.io.nextCall("store_attachment");
    const pending = kind === "主图" ? attachments.addFile(file, false) : attachments.addExtraAttachmentFile(file, expense.id, false);
    assert.equal(images.pendingReaders.length, 1);
    assert.deepEqual(commands(environment), [], "读图尚未完成不能提前持久化");
    assert.deepEqual(plain(workspace.cloneDraft()), plain(before));
    assert.strictEqual(images.finishRead(), file);
    const call = await storeCall;
    assert.deepEqual(plain(call.payload.request), {
      recordId: "record-a", dataUrl: "data:image/png;base64,AQID",
      recognitionDataUrl: kind === "主图" ? "data:image/png;base64,AQID" : undefined,
      naturalWidth: 1200, naturalHeight: 800,
    });
    assert.deepEqual(plain(workspace.cloneDraft()), plain(before), "存储 await 尚未完成不能插入费用或附图");
    storedGate.resolve({ blobHash: "uploaded-hash", mimeType: "image/png", blobExtension: "png", sizeBytes: 3 });
    assert.equal(await pending, true);
    const added = kind === "主图" ? workspace.draft.expenses.at(-1) : expense.extraAttachments.at(-1);
    assert.equal(added.fileName, `${kind}.png`);
    assert.equal(added.blobHash, "uploaded-hash");
    assert.equal(added.naturalWidth, 1200);
    assert.equal(added.naturalHeight, 800);
    assert.strictEqual(images.createdUrls[0].value, file);
    assert.equal(added.imageDataUrl, images.createdUrls[0].url);
    assert.equal(workspace.isSaved.value, false);
    if (kind === "主图") {
      assert.match(added.id, /^expense-/);
      assert.equal(workspace.draft.expenses.length, 10);
      assert.equal(previewAttachments.value.length, 10);
      assert.equal(added.ocrMode, "handwriting");
      assert.equal(added.ocrStatus, "queued");
      assert.strictEqual(selectedId.value, added.id);
      assert.strictEqual(selectedAttachmentId.value, added.id);
      assert.equal(recognized.length, 1);
      assert.strictEqual(recognized[0].expense, vue.toRaw(added));
      assert.equal(recognized[0].notify, false);
      assert.deepEqual(attachmentCalls, ["reflowExpenses", `scroll:${added.id}`]);
      assert.equal(await attachments.addFile(file, false), false, "第 11 笔费用在读图前被拦截");
    } else {
      assert.match(added.id, /^attachment-/);
      assert.strictEqual(workspace.draft.expenses[0], expense);
      assert.equal(workspace.draft.expenses.length, 3);
      assert.equal(expense.extraAttachments.length, 9);
      assert.equal(previewAttachments.value.length, 30);
      assert.strictEqual(selectedId.value, expense.id);
      assert.strictEqual(selectedAttachmentId.value, added.id);
      assert.deepEqual(recognized, [], "已配置识别服务，附图也不能触发识别");
      assert.deepEqual(attachmentCalls, ["reflowAttachments"]);
      assert.equal(await attachments.addFile(file, false), false, "费用未达十笔时第三十一张主图仍被拦截");
      assert.equal(await attachments.addExtraAttachmentFile(file, expense.id, false), false);
    }
    assert.deepEqual(images.pendingReaders, []);
    assert.equal(environment.trace.filter(event => event.kind === "image:read").length, 1);
    assert.deepEqual(commands(environment), ["store_attachment"]);
  }
  const singleLimit = createAttachmentsHarness({ draft: inventory([9]) });
  assert.equal(singleLimit.previewAttachments.value.length, 10);
  assert.equal(singleLimit.attachments.extraAttachmentSlots(singleLimit.workspace.draft.expenses[0]), 0);
  assert.equal(await singleLimit.attachments.addExtraAttachmentFile(makeImageFile(), "expense-1", false), false, "未达全单三十张时，单笔第十一张仍被拦截");
  assert.deepEqual(singleLimit.images.pendingReaders, []);
  assert.deepEqual(commands(singleLimit.environment), []);

  for (const kind of ["主图", "附图"]) {
    for (const changed of ["容量", "全单图片容量", "切单"]) {
      const draft = changed === "全单图片容量" ? inventory([8, 9, 9]) : kind === "主图" ? inventory(Array(9).fill(0)) : inventory([8]);
      const harness = createAttachmentsHarness({ draft });
      const { workspace, attachments, environment, images, selectedId, selectedAttachmentId, recognized, attachmentCalls } = harness;
      const storedGate = deferred();
      environment.io.handlers.set("store_attachment", () => storedGate.promise);
      const storeCall = environment.io.nextCall("store_attachment");
      const file = makeImageFile(`${changed}-${kind}.png`);
      const pending = kind === "主图" ? attachments.addFile(file, false, "record-a") : attachments.addExtraAttachmentFile(file, "expense-1", false, "record-a");
      assert.strictEqual(images.finishRead(), file);
      assert.equal((await storeCall).payload.request.recordId, "record-a");
      if (changed === "切单") {
        workspace.applyDraft({ ...inventory([0]), id: "record-b" });
      } else if (changed === "全单图片容量") {
        workspace.draft.expenses.push(makeExpense({ id: "concurrent-global-expense" }));
        assert.equal(harness.previewAttachments.value.length, 30);
        assert.equal(workspace.draft.expenses.length, 4, "费用容量仍有空位");
        assert.equal(workspace.draft.expenses[0].extraAttachments.length, 8, "目标单笔图片容量仍有空位");
      } else if (kind === "主图") {
        workspace.draft.expenses.push(makeExpense({ id: "concurrent-expense" }));
      } else {
        workspace.draft.expenses[0].extraAttachments.push(makeExtraAttachment(9));
      }
      const afterChange = workspace.cloneDraft();
      const selection = [selectedId.value, selectedAttachmentId.value];
      storedGate.resolve({ blobHash: "late-stored-image", mimeType: "image/png", blobExtension: "png", sizeBytes: 3 });
      assert.equal(await pending, false, `${kind}/${changed} 必须在存储 await 后拒绝新增`);
      assert.deepEqual(plain(workspace.cloneDraft()), plain(afterChange));
      assert.deepEqual([selectedId.value, selectedAttachmentId.value], selection);
      assert.deepEqual(recognized, []);
      assert.deepEqual(attachmentCalls, []);
      assert.deepEqual(images.createdUrls, [], "被二次检查拒绝后不能创建正式预览地址");
      assert.deepEqual(commands(environment), ["store_attachment"]);
      assert.equal(environment.trace.filter(event => event.kind === "image:load").length, 1, "必须实际跨过读图 await");
    }
  }
});

test("实际局域网上传 listener 单次注册，失败队列仍 FIFO 最后同步，版本抑制迟到状态", async () => {
  const harness = createLanHarness();
  const { lanUpload, state, environment, workspace, addHandlers } = harness;
  const listening = deferred();
  let listener;
  let unlistenCalls = 0;
  environment.io.handlers.set("listen_lan_upload_received", ({ callback }) => {
    listener = callback;
    return listening.promise;
  });
  const ensureCalls = [lanUpload.ensureLanUploadListener(), lanUpload.ensureLanUploadListener(), lanUpload.ensureLanUploadListener()];
  assert.deepEqual(commands(environment), ["listen_lan_upload_received"]);
  listening.resolve(() => { unlistenCalls += 1; });
  await Promise.all(ensureCalls);
  await lanUpload.ensureLanUploadListener();
  assert.deepEqual(commands(environment), ["listen_lan_upload_received"]);
  state.lanUploadSession.value = makeLanSession("queue");
  const names = ["first.png", "second.png", "third.png"];
  const additions = new Map(names.map(name => [name, { result: deferred(), started: deferred() }]));
  const received = [];
  function add(file, notify, recordId, expenseId) {
    assert.ok(file instanceof File);
    assert.equal(file.type, "image/png");
    assert.equal(file.size, 3);
    received.push({ name: file.name, notify, recordId, expenseId });
    const operation = additions.get(file.name);
    assert.ok(operation, "只允许明确的三张内存图片");
    operation.started.resolve();
    return operation.result.promise.then(added => {
      if (added && expenseId) workspace.draft.expenses[0].extraAttachments.push(makeExtraAttachment(1));
      if (added && !expenseId) workspace.draft.expenses.push(makeExpense({ id: "received-expense" }));
      return added;
    });
  }
  addHandlers.main = (file, notify, recordId) => add(file, notify, recordId);
  addHandlers.extra = (file, expenseId, notify, recordId) => add(file, notify, recordId, expenseId);
  names.forEach((name, index) => listener({
    recordId: "record-a", ...(index === 1 ? { targetExpenseId: "expense-a" } : {}), remainingSlots: 8 - index,
    file: { fileName: name, mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" },
  }));
  await additions.get("first.png").started.promise;
  assert.deepEqual(received.map(item => item.name), ["first.png"]);
  await lanUpload.synchronizeLanUploadSession();
  assert.equal(commands(environment).includes("update_lan_upload_session"), false, "pending 图片期间不向服务回写剩余容量");
  additions.get("first.png").result.reject(new Error("第一张添加失败"));
  await additions.get("second.png").started.promise;
  assert.deepEqual(received.map(item => item.name), ["first.png", "second.png"]);
  assert.deepEqual(environment.trace.filter(event => event.kind === "message"), [
    { kind: "message", level: "error", text: "手机图片接收失败：第一张添加失败" },
  ]);
  assert.equal(commands(environment).includes("update_lan_upload_session"), false);
  additions.get("second.png").result.resolve(true);
  await additions.get("third.png").started.promise;
  assert.equal(lanUpload.lanReceivedCount.value, 1);
  assert.equal(commands(environment).includes("update_lan_upload_session"), false, "第二张 finally 不能越过最后一张 pending");
  const synchronized = environment.io.nextCall("update_lan_upload_session");
  additions.get("third.png").result.resolve(true);
  const syncCall = await synchronized;
  await flushMicrotasks();
  assert.deepEqual(received, [
    { name: "first.png", notify: false, recordId: "record-a", expenseId: undefined },
    { name: "second.png", notify: false, recordId: "record-a", expenseId: "expense-a" },
    { name: "third.png", notify: false, recordId: "record-a", expenseId: undefined },
  ]);
  assert.deepEqual(plain(syncCall.payload), { request: { recordId: "record-a", targetExpenseId: null, label: "业务测试草稿", remainingSlots: 8 } });
  assert.equal(state.lanUploadSession.value.remainingSlots, 8);
  assert.equal(lanUpload.lanReceivedCount.value, 2);
  assert.deepEqual(commands(environment), ["listen_lan_upload_received", "update_lan_upload_session"], "reject 的 finally 必须递减 pending，最后一次仅同步一次");
  assert.equal(environment.timers.pending.length, 1);
  environment.timers.advanceBy(400);
  assert.equal(lanUpload.lanReceivedCount.value, 0);
  assert.deepEqual(environment.trace.filter(event => event.kind === "message").at(-1), { kind: "message", level: "success", text: "已从手机接收 2 张图片" });
  lanUpload.cleanupLanUploadListener();
  assert.equal(unlistenCalls, 1);

  for (const invalidation of ["刷新", "停止"]) {
    for (const outcome of ["成功", "失败"]) {
      const race = createLanHarness();
      const { lanUpload: api, state: refs, environment: env } = race;
      const oldStart = deferred();
      const latestStart = deferred();
      const oldQr = deferred();
      const oldSession = makeLanSession("old");
      const latestSession = makeLanSession("latest");
      let startCount = 0;
      env.io.handlers.set("start_lan_upload_session", () => ++startCount === 1 ? oldStart.promise : latestStart.promise);
      env.io.handlers.set("qrcode", ({ url }) => url === oldSession.url ? oldQr.promise : Promise.resolve("data:fixture-qr,latest"));
      const oldStartCall = env.io.nextCall("start_lan_upload_session");
      const oldRefresh = api.refreshLanUploadSession();
      assert.deepEqual(plain((await oldStartCall).payload), { request: {
        recordId: "record-a", targetExpenseId: null, label: "业务测试草稿", remainingSlots: 9, ttlSeconds: 900,
      } });
      assert.equal(refs.isLanUploadLoading.value, true);
      const failAtStart = invalidation === "停止" && outcome === "失败";
      if (!failAtStart) {
        const qrCall = env.io.nextCall("qrcode");
        oldStart.resolve(oldSession);
        assert.deepEqual(plain((await qrCall).payload), {
          url: oldSession.url,
          options: { errorCorrectionLevel: "M", margin: 1, width: 260, color: { dark: "#31483e", light: "#ffffff" } },
        });
      }
      let latestRefresh;
      if (invalidation === "刷新") {
        const latestStartCall = env.io.nextCall("start_lan_upload_session");
        latestRefresh = api.refreshLanUploadSession();
        await latestStartCall;
      } else {
        refs.lanUploadTargetExpenseId.value = "expense-a";
        await api.stopLanUploadSession();
        assert.strictEqual(refs.lanUploadTargetExpenseId.value, null);
      }
      if (failAtStart) oldStart.reject(new Error("停止后的旧服务失败"));
      else if (outcome === "失败") oldQr.reject(new Error("旧二维码失败"));
      else oldQr.resolve("data:fixture-qr,old-late");
      await oldRefresh;
      assert.equal(refs.isLanUploadOpen.value, true, "版本检查不能依赖关闭窗口来碰巧屏蔽旧响应");
      assert.strictEqual(refs.lanUploadSession.value, null);
      assert.equal(refs.lanUploadQrCode.value, "");
      assert.equal(refs.lanUploadError.value, "");
      assert.equal(refs.lanUploadNow.value, 0);
      assert.equal(refs.isLanUploadLoading.value, invalidation === "刷新", "旧 finally 不得清除新请求的 loading");
      if (latestRefresh) {
        latestStart.resolve(latestSession);
        await latestRefresh;
        assert.deepEqual(plain(refs.lanUploadSession.value), latestSession);
        assert.equal(refs.lanUploadQrCode.value, "data:fixture-qr,latest");
        assert.equal(refs.lanUploadError.value, "");
        assert.equal(refs.isLanUploadLoading.value, false);
        assert.equal(refs.lanUploadNow.value, fixedNow);
      }
      assert.equal(commands(env).filter(command => command === "listen_lan_upload_received").length, 1);
      assert.equal(commands(env).filter(command => command === "stop_lan_upload_session").length, invalidation === "停止" ? 1 : 0);
      assert.deepEqual(env.trace.filter(event => event.kind === "message"), []);
      api.cleanupLanUploadListener();
      assert.equal(race.getUnlistenCalls(), 1);
    }
  }
});

test("真实 root 临时草稿成功或抛错都恢复同一 proxy、选择与抑制，仅回收来源 URL 且顺序兼容", async () => {
  const summaries = [];
  for (const reference of [false, true]) {
    const outcomes = [];
    for (const fails of [false, true]) {
      const harness = createAttachmentsHarness();
      const { workspace, attachments, images, context, selectedId, selectedAttachmentId, setSelectedIds } = harness;
      const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
      const urls = Array.from({ length: 6 }, () => attachments.createManagedImageUrl(blob));
      const current = makeDraft([makeExpense({
        imageDataUrl: urls[0], recognitionImageDataUrl: urls[1],
        extraAttachments: [{ ...makeExtraAttachment(1), imageDataUrl: urls[2] }],
      })]);
      const source = makeDraft([makeExpense({
        id: "expense-source", imageDataUrl: urls[3], recognitionImageDataUrl: urls[4],
        extraAttachments: [{ ...makeExtraAttachment(1), id: "source-extra", imageDataUrl: urls[5] }],
      })], { id: "record-source", label: "临时导出草稿" });
      workspace.applyDraft(current);
      setSelectedIds("expense-a", "expense-a-extra-1");
      const draftIdentity = workspace.draft;
      const activeTab = vue.ref("history");
      const sourceBefore = JSON.stringify(source);
      const trace = [];
      let legacy;
      const suppressed = () => reference ? legacy.suppressAutoSave : workspace.getSuppressAutoSave();
      const state = () => ({ recordId: workspace.draft.id, tab: activeTab.value, expenseId: selectedId.value, attachmentId: selectedAttachmentId.value, suppressed: suppressed() });
      const editingApi = { commitActiveEdit: () => {
        trace.push({ kind: "commit", ...state() });
        context.commitActiveEdit();
        workspace.draft.expenses[0].description = "编辑框已提交";
      } };
      const observedWorkspace = {
        ...workspace,
        cloneDraft: value => {
          trace.push({ kind: "clone", recordId: value?.id ?? workspace.draft.id, suppressed: suppressed() });
          return workspace.cloneDraft(value);
        },
        applyDraft: value => {
          workspace.applyDraft(value);
          trace.push({ kind: "apply", ...state() });
        },
      };
      const previewApi = { updateScale: () => { trace.push({ kind: "scale", ...state() }); } };
      const attachmentsApi = { revokeDraftImageUrls: value => {
        assert.strictEqual(value, source, "只能将传入来源草稿交给 URL 回收");
        trace.push({ kind: "revokeSource", ...state() });
        attachments.revokeDraftImageUrls(value);
      } };
      const nextTick = async () => { await vue.nextTick(); trace.push({ kind: "tick", ...state() }); };
      let withTemporaryDraft;
      if (reference) {
        legacy = loadReference(["withTemporaryDraft"], ["suppressAutoSave"], {}, {
          activeTab, selectedId, selectedAttachmentId, nextTick,
          commitActiveEdit: editingApi.commitActiveEdit,
          cloneDraft: observedWorkspace.cloneDraft, applyDraft: observedWorkspace.applyDraft,
          revokeDraftImageUrls: attachmentsApi.revokeDraftImageUrls, updateScale: previewApi.updateScale,
        });
        withTemporaryDraft = legacy.withTemporaryDraft;
      } else {
        ({ withTemporaryDraft } = loadRootFunctions(["withTemporaryDraft"], {
          editingApi, workspaceApi: observedWorkspace, previewApi, attachmentsApi,
          activeTab, selectedId, selectedAttachmentId, nextTick,
        }));
      }
      const started = deferred();
      const completion = deferred();
      const result = { exported: "内存导出结果" };
      const failure = new Error("导出 callback 失败");
      const pending = withTemporaryDraft(source, async () => {
        assert.strictEqual(workspace.draft, draftIdentity);
        assert.deepEqual(plain(workspace.cloneDraft()), plain(source));
        assert.equal(suppressed(), true);
        trace.push({ kind: "callback", ...state() });
        started.resolve();
        await completion.promise;
        if (fails) throw failure;
        return result;
      });
      await started.promise;
      assert.equal(suppressed(), true);
      workspace.draft.label = "callback 中的临时变动";
      workspace.draft.expenses[0].amountCents = 9999;
      setSelectedIds("expense-source", "source-extra");
      activeTab.value = "settings";
      completion.resolve();
      if (fails) await assert.rejects(pending, error => error === failure);
      else assert.strictEqual(await pending, result, "成功返回 callback 的原对象");
      assert.strictEqual(workspace.draft, draftIdentity);
      const expected = { ...current, expenses: [{ ...current.expenses[0], description: "编辑框已提交" }] };
      assert.deepEqual(plain(workspace.cloneDraft()), plain(expected));
      assert.equal(activeTab.value, "history");
      assert.equal(selectedId.value, "expense-a");
      assert.equal(selectedAttachmentId.value, "expense-a-extra-1");
      assert.equal(suppressed(), false);
      assert.equal(workspace.getSuppressAutoSave(), false);
      assert.equal(JSON.stringify(source), sourceBefore, "临时 callback 不得改写来源草稿");
      assert.deepEqual(images.revokedUrls, urls.slice(3), "不能回收仍在当前工作区使用的 URL");
      const original = { recordId: "record-a", tab: "history", expenseId: "expense-a", attachmentId: "expense-a-extra-1", suppressed: false };
      const applied = { recordId: "record-source", tab: "history", expenseId: "expense-source", attachmentId: "expense-source", suppressed: true };
      const temporary = { ...applied, tab: "reimbursement" };
      const restoring = { recordId: "record-a", tab: "settings", expenseId: "expense-a", attachmentId: "expense-a", suppressed: true };
      const restored = { ...original, suppressed: true };
      assert.deepEqual(trace, [
        { kind: "commit", ...original },
        { kind: "clone", recordId: "record-a", suppressed: false },
        { kind: "clone", recordId: "record-source", suppressed: true },
        { kind: "apply", ...applied },
        { kind: "tick", ...temporary }, { kind: "scale", ...temporary }, { kind: "tick", ...temporary },
        { kind: "callback", ...temporary },
        { kind: "apply", ...restoring }, { kind: "revokeSource", ...restoring },
        { kind: "tick", ...restored }, { kind: "scale", ...restored },
      ], "临时展示、callback、恢复、回收和取消抑制必须按独立时序发生");
      outcomes.push({ fails, trace, restored: plain(workspace.cloneDraft()), revoked: images.revokedUrls });
    }
    summaries.push(outcomes);
  }
  assert.deepEqual(summaries[0], summaries[1], "真实 root 与固定基线临时草稿成功和异常恢复轨迹一致");
});
