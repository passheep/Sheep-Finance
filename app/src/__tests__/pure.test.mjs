import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = path.join(appRoot, "src");
const baselineCommit = "4aaa9e55ac2f0d8b33c38180facc3340e792e057";
const formatNames = [
  "today", "id", "transform", "parseAmountExpression", "amountExpressionToCents",
  "money", "normalizeReimbursementStatus", "normalizeHistoryViewMode",
  "reimbursementStatusType", "formatDateTime", "formatSaveTime", "ChineseAmount",
  "wrappedLineCount",
];
const paginationComputedNames = [
  "previewAttachments", "formPages", "attachmentPages", "lastFormPageRemainingHeight",
  "sharedAttachmentPage", "separateAttachmentPages", "previewPageCount",
];
const expectedConstants = {
  STORAGE_KEY: "sheepfinance:workbench:v1",
  PROFILE_KEY: "sheepfinance:profiles:v1",
  DICTIONARY_KEY: "sheepfinance:dictionaries:v1",
  HISTORY_KEY: "sheepfinance:history:v1",
  SERVICE_KEY: "sheepfinance:services:v1",
  UI_PREFERENCES_KEY: "sheepfinance:ui-preferences:v1",
  PAGE_WIDTH: 794,
  PAGE_HEIGHT: 1123,
  MAX_EXPENSES: 10,
  ATTACHMENTS_PER_PAGE: 6,
  MAX_TOTAL_ATTACHMENTS: 30,
  MAX_ATTACHMENTS_PER_EXPENSE: 10,
  FIRST_FORM_ROW_BUDGET: 785,
  CONTINUATION_FORM_ROW_BUDGET: 816,
  MIN_SHARED_ATTACHMENT_HEIGHT: 126,
  DEFAULT_LLM_MODEL: "deepseek-v4-flash",
  REIMBURSEMENT_STATUSES: ["未报销", "报销中", "已报销"],
  CONFIG_TRANSFER_ITERATIONS: 180_000,
  CONFIG_TRANSFER_SECRET: "SheepFinance::local-configuration-transfer::v1",
};

// 固定本地时间与随机值，验证日期和 ID 时不修改宿主的全局对象。
const fixedNow = new Date(2026, 0, 2, 3, 4, 5).getTime();
class FixtureDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [fixedNow]));
  }
  static now() {
    return fixedNow;
  }
}
const fixtureMath = Object.create(Math);
fixtureMath.random = () => 0.5;

function parseSource(fileName, source) {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, `${fileName} 应能解析为 TypeScript`);
  return ast;
}

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      verbatimModuleSyntax: false,
    },
  });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  assert.deepEqual(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")), []);
  return result.outputText;
}

function runCommonJs(source, fileName, require) {
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, require, Date: FixtureDate, Math: fixtureMath,
  });
  new vm.Script(transpile(source, fileName), { filename: fileName }).runInContext(context, { timeout: 1000 });
  return module.exports;
}

// 仅在内存中转译这三个纯模块；相对 require 只读本地 .ts，类型导入应已被消除。
const allowedModules = new Set([
  "utils/format.ts", "utils/pagination.ts", "constants/app.ts",
].map(fileName => path.resolve(sourceRoot, fileName)));
const moduleCache = new Map();
function loadPureModule(fileName) {
  const absolute = path.resolve(fileName);
  assert.ok(allowedModules.has(absolute), `禁止加载纯模块之外的文件：${absolute}`);
  if (!moduleCache.has(absolute)) {
    const source = readFileSync(absolute, "utf8");
    const exports = runCommonJs(source, absolute, specifier => {
      assert.ok(typeof specifier === "string" && specifier.startsWith("."), `禁止加载外部依赖：${specifier}`);
      const dependency = path.resolve(path.dirname(absolute), specifier);
      return loadPureModule(path.extname(dependency) ? dependency : `${dependency}.ts`);
    });
    moduleCache.set(absolute, { source, exports });
  }
  return moduleCache.get(absolute).exports;
}
const format = loadPureModule(path.join(sourceRoot, "utils/format.ts"));
const pagination = loadPureModule(path.join(sourceRoot, "utils/pagination.ts"));
const constants = loadPureModule(path.join(sourceRoot, "constants/app.ts"));

// git show 的旧 SFC 不落盘，只用 AST 选择函数、常量和分页 computed 声明。
const oldVue = execFileSync("git", ["show", `${baselineCommit}:app/src/App.vue`], {
  cwd: appRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000,
});
const scriptStart = oldVue.indexOf("<script setup");
const scriptEnd = oldVue.indexOf("</script>", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "基准提交应包含 script setup");
const oldAst = parseSource("baseline-App.ts", oldVue.slice(oldVue.indexOf(">", scriptStart) + 1, scriptEnd));

function declarations(ast, kind) {
  const entries = [];
  for (const statement of ast.statements) {
    if (kind === "variable" && ts.isVariableStatement(statement)) {
      // 这里只登记声明，旧工作台中的 let 不属于本次纯代码提取范围。
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) entries.push([declaration.name.text, declaration]);
      }
    } else if ((kind === "function" && ts.isFunctionDeclaration(statement)) ||
      (kind === "type" && (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)))) {
      entries.push([statement.name.text, statement]);
    }
  }
  return new Map(entries);
}
const oldFunctions = declarations(oldAst, "function");
const oldVariables = declarations(oldAst, "variable");
function oldDeclaration(map, name) {
  assert.ok(map.has(name), `基准提交缺少声明：${name}`);
  const node = map.get(name);
  if (ts.isVariableDeclaration(node)) {
    assert.ok(node.parent.flags & ts.NodeFlags.Const, `选中的纯逻辑声明应为 const：${name}`);
  }
  return node.getText(oldAst);
}
const oldSource = [
  ...Object.keys(expectedConstants).map(name => `const ${oldDeclaration(oldVariables, name)};`),
  ...[...formatNames, "expenseRowHeight"].map(name => oldDeclaration(oldFunctions, name)),
  `module.exports = {
    ${[...formatNames, "expenseRowHeight"].join(", ")},
    constants: { ${Object.keys(expectedConstants).join(", ")} },
    paginate(draft) {
      ${paginationComputedNames.map(name => `const ${oldDeclaration(oldVariables, name)};`).join("\n")}
      return { ${paginationComputedNames.map(name => `${name}: ${name}.value`).join(", ")} };
    }
  };`,
].join("\n");
// 旧代码只需要惰性 .value getter，不引入 Vue、浏览器或桌面运行时。
const legacy = runCommonJs(
  `const computed = getter => ({ get value() { return getter(); } });\n${oldSource}`,
  "baseline-pure.ts",
  specifier => { throw new Error(`旧纯代码不应 require：${specifier}`); },
);

// VM 的对象原型不同；只在值比较时归一化，引用断言仍使用原始对象。
function plain(value) {
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}
function assertCall(name, args, expected, label = name) {
  const current = format[name](...args);
  const previous = legacy[name](...args);
  assert.deepEqual(plain(current), plain(previous), `${label}：新旧结果`);
  assert.deepEqual(plain(current), expected, `${label}：独立预期`);
}

// 保留 AST 的类型、可选成员、继承、字面值及成员顺序，仅忽略空白、注释和 export。
function astShape(node) {
  const children = [];
  ts.forEachChild(node, child => {
    if (child.kind !== ts.SyntaxKind.ExportKeyword) children.push(astShape(child));
  });
  const text = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text : null;
  return [ts.SyntaxKind[node.kind], text, children];
}

function makeDraft(extraCounts, previewMode = "single") {
  function attachment(id, isPrimary, index) {
    return {
      id, fileName: `${id}.png`,
      imageDataUrl: `data:image/png;base64,${Buffer.from(id).toString("base64")}`,
      blobHash: `hash-${id}`, mimeType: "image/png", blobExtension: "png", sizeBytes: 100 + index,
      naturalWidth: 1200 + index, naturalHeight: 800 + index,
      transform: {
        x: 0, y: 0, width: 100, height: 100, rotation: isPrimary ? 0 : 90,
        cropZoom: 1, cropX: 50, cropY: 50,
      },
    };
  }
  return {
    previewMode,
    expenses: extraCounts.map((extraCount, index) => {
      const id = `expense-${index + 1}`;
      return {
        ...attachment(id, true, index),
        occurredDate: "2026-01-02", reason: "办公费", description: "费用说明", arranger: "经办人",
        amountCents: index % 2 ? -123 : 12345, ocrMode: "advanced", ocrStatus: "manual",
        manualFields: { amountCents: true },
        extraAttachments: Array.from({ length: extraCount }, (_, extraIndex) =>
          attachment(`${id}-extra-${extraIndex + 1}`, false, extraIndex)),
      };
    }),
  };
}
function currentPages(draft) {
  const previewAttachments = pagination.buildPreviewAttachments(draft.expenses);
  const formPages = pagination.paginateFormRows(draft.expenses);
  const attachmentPages = pagination.paginateAttachments(previewAttachments);
  const lastFormPageRemainingHeight = pagination.lastFormPageRemainingHeight(formPages);
  const sharedAttachmentPage = pagination.getSharedAttachmentPage(draft, formPages, attachmentPages);
  const separateAttachmentPages = pagination.getSeparateAttachmentPages(sharedAttachmentPage, attachmentPages);
  return {
    previewAttachments, formPages, attachmentPages, lastFormPageRemainingHeight,
    sharedAttachmentPage, separateAttachmentPages,
    previewPageCount: pagination.getPreviewPageCount(formPages, separateAttachmentPages),
  };
}
function pageSummary(state) {
  return {
    rows: plain(state.formPages.map(page => page.rows.map(row => row.index))),
    heights: plain(state.formPages.map(page => page.rows.map(row => row.height))),
    flags: plain(state.formPages.map(page => [page.isFirst, page.isLast])),
    attachmentSizes: plain(state.attachmentPages.map(page => page.length)),
    ids: plain(state.previewAttachments.map(item => item.id)),
    labels: plain(state.previewAttachments.map(item => item.label)),
    remaining: state.lastFormPageRemainingHeight,
    sharedIds: state.sharedAttachmentPage ? plain(state.sharedAttachmentPage.map(item => item.id)) : null,
    separateSizes: plain(state.separateAttachmentPages.map(page => page.length)),
    pageCount: state.previewPageCount,
  };
}
function assertPages(draft, expected, label) {
  const before = plain(draft);
  const current = currentPages(draft);
  const previous = legacy.paginate(draft);
  assert.deepEqual(plain(current), plain(previous), `${label}：新旧分页完整结果`);
  assert.deepEqual(pageSummary(current), expected, `${label}：独立分页预期`);
  const originals = new Map();
  for (const expense of draft.expenses) {
    originals.set(expense.id, { source: expense, expenseId: expense.id, primary: true });
    for (const extra of expense.extraAttachments) {
      originals.set(extra.id, { source: extra, expenseId: expense.id, primary: false });
    }
  }
  for (const state of [current, previous]) {
    for (const page of state.formPages) {
      for (const row of page.rows) {
        assert.strictEqual(row.expense, draft.expenses[row.index], `${label}：Expense 引用不能被克隆`);
      }
    }
    for (const item of state.previewAttachments) {
      const original = originals.get(item.id);
      assert.ok(original, `${label}：附件 ID 应来自原对象`);
      assert.equal(item.expenseId, original.expenseId);
      assert.equal(item.isPrimary, original.primary);
      for (const field of ["fileName", "imageDataUrl", "blobHash", "mimeType", "blobExtension", "sizeBytes", "naturalWidth", "naturalHeight", "transform"]) {
        assert.strictEqual(item[field], original.source[field], `${label}：保留 ${item.id} 的 ${field}`);
      }
    }
  }
  const flattened = current.attachmentPages.flat();
  flattened.forEach((item, index) => assert.strictEqual(item, current.previewAttachments[index]));
  if (current.sharedAttachmentPage) {
    assert.strictEqual(current.sharedAttachmentPage, current.attachmentPages[0]);
    current.separateAttachmentPages.forEach((page, index) => assert.strictEqual(page, current.attachmentPages[index + 1]));
  } else {
    assert.strictEqual(current.separateAttachmentPages, current.attachmentPages);
  }
  assert.deepEqual(plain(draft), before, `${label}：分页不能修改输入`);
}

const sixIds = ["expense-1", "expense-1-extra-1", "expense-1-extra-2", "expense-1-extra-3", "expense-1-extra-4", "expense-1-extra-5"];
const sixLabels = ["1", "1-2", "1-3", "1-4", "1-5", "1-6"];
const tenIds = Array.from({ length: 10 }, (_, index) => `expense-${index + 1}`);
const tenLabels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
const thirtyIds = tenIds.flatMap(id => [id, `${id}-extra-1`, `${id}-extra-2`]);
const thirtyLabels = tenLabels.flatMap(label => [label, `${label}-2`, `${label}-3`]);
const thirtyFirstPage = ["expense-1", "expense-1-extra-1", "expense-1-extra-2", "expense-2", "expense-2-extra-1", "expense-2-extra-2"];

const modelsAst = parseSource("models.ts", readFileSync(path.join(sourceRoot, "types/models.ts"), "utf8"));
const newTypes = declarations(modelsAst, "type");
const approvalMemberNames = ["financeReviewer", "showManagerApproval"];

function isApprovalMember(node) {
  return ts.isPropertySignature(node) && ts.isIdentifier(node.name) && approvalMemberNames.includes(node.name.text);
}

test("Draft 新增审批成员保持可选、财务或秘书处字面量与 boolean 的精确类型", () => {
  const draft = newTypes.get("Draft");
  assert.ok(draft && ts.isInterfaceDeclaration(draft), "Draft 应保留 interface 声明");
  const expected = parseSource("approval-members.ts", `interface Draft {
    financeReviewer?: "财务" | "秘书处";
    showManagerApproval?: boolean;
  }`).statements[0];
  assert.deepEqual(
    draft.members.filter(isApprovalMember).map(astShape),
    expected.members.map(astShape),
    "独立断言新增两个成员的名字、顺序、可选标记与完整类型",
  );
});

test("类型与常量的 AST 结构保持一致，关键取值符合独立预期", () => {
  const constantsAst = parseSource("constants/app.ts", moduleCache.get(path.join(sourceRoot, "constants/app.ts")).source);
  const oldTypes = declarations(oldAst, "type");
  assert.deepEqual([...newTypes.keys()].sort(), [...oldTypes.keys()].sort(), "提取后的类型不能遗漏或改名");
  for (const [name, node] of newTypes) {
    // 仅从 Draft 中移除已独立断言的两个新增成员；原成员、继承和其余类型仍完整对照。
    const comparable = name === "Draft" ? ts.factory.updateInterfaceDeclaration(
      node, node.modifiers, node.name, node.typeParameters, node.heritageClauses,
      node.members.filter(member => !isApprovalMember(member)),
    ) : node;
    assert.deepEqual(astShape(comparable), astShape(oldTypes.get(name)), `${name} 的类型结构`);
  }
  const newConstants = declarations(constantsAst, "variable");
  assert.deepEqual([...newConstants.keys()].sort(), Object.keys(expectedConstants).sort());
  for (const [name, node] of newConstants) {
    assert.ok(node.parent.flags & ts.NodeFlags.Const, `${name} 应保持 const 声明`);
    assert.deepEqual(astShape(node), astShape(oldVariables.get(name)), `${name} 的常量结构`);
  }
  assert.deepEqual(plain(constants), expectedConstants, "所有常量的固定预期");
  assert.deepEqual(plain(constants), plain(legacy.constants), "常量的新旧运行值");
  assert.deepEqual(Object.keys(format).sort(), [...formatNames].sort());
  assert.deepEqual([...moduleCache.keys()].sort(), [...allowedModules].sort(), "运行时只加载三个本地纯模块");
});

test("四则表达式、负数、分位舍入及无效与边界金额保持兼容", () => {
  // 预期值直接列出，尤其保留浮点舍入和负零的原有行为。
  const cases = [
    ["", 0, 0], [" \t\n ", 0, 0], [",，", 0, 0], ["=", null, null],
    ["1 + 2 * 3", 7, 700], ["= (100 + 25) * 2 - 30 / 3", 240, 24000],
    ["(8 - 2) / (1 + 2)", 2, 200], ["8 / 2 * 3", 12, 1200], ["8 - 3 - 2", 3, 300],
    ["1，000 + 2,345.67", 3345.67, 334567], ["1,2", 12, 1200],
    [".5 + 1.", 1.5, 150], ["0.1 + 0.2", 0.30000000000000004, 30],
    ["-(2 + 3) * 4", -20, -2000], ["2 * -3", -6, -600],
    ["--2", 2, 200], ["1++2", 3, 300], ["1+-2", -1, -100], ["1--2", 3, 300],
    ["1.125", 1.125, 113], ["-1.125", -1.125, -112], ["1.005", 1.005, 100],
    ["0.005", 0.005, 1], ["-0.005", -0.005, -0], ["0 * -1", -0, -0],
    ["1000000000000", 1_000_000_000_000, 100_000_000_000_000],
    ["-1000000000000", -1_000_000_000_000, -100_000_000_000_000],
    ["1000000000000+1", null, null], ["-1000000000000-1", null, null],
    ["0".repeat(159) + "1", 1, 100], ["0".repeat(160) + "1", null, null],
    ["9".repeat(160), null, null],
    ...["1/0", "1/-0", "0/0", "()", "(1+2", "1+2)", "1+", "*2", "1..2", "1 2", "1e3", "NaN", "Infinity", "2**3", "3%2", "2×3", "abc", "globalThis.process", "1;2"].map(raw => [raw, null, null]),
  ];
  for (const [raw, value, cents] of cases) {
    assertCall("parseAmountExpression", [raw], value, `解析 ${JSON.stringify(raw)}`);
    assertCall("amountExpressionToCents", [raw], cents, `转分 ${JSON.stringify(raw)}`);
  }
});

test("金额显示与大写、报销状态和历史视图的默认值保持兼容", () => {
  for (const [cents, expected] of [[0, "0.00"], [-0, "0.00"], [1, "0.01"], [125, "1.25"], [123456, "1,234.56"], [-123456, "-1,234.56"]]) {
    assertCall("money", [cents], expected);
  }
  // 不足一元时旧版不补“零元”，固定断言这一现状，避免重构时悄悄改动。
  const uppercaseCases = [
    [0, "零元整"], [-0, "零元整"], [1, "元零壹分"], [10, "元壹角"], [11, "元壹角壹分"],
    [100, "壹元整"], [105, "壹元零伍分"], [110, "壹元壹角"], [-105, "负壹元零伍分"],
    [123.6, "壹元贰角肆分"], [-123.5, "负壹元贰角叁分"], [-0.5, "零元整"],
    [1_000_100, "壹万零壹元整"], [10_000_000_100, "壹亿零壹元整"],
    [123_456_789, "壹佰贰拾叁万肆仟伍佰陆拾柒元捌角玖分"],
    [100_000_000_000_000, "壹兆元整"],
  ];
  for (const [cents, expected] of uppercaseCases) assertCall("ChineseAmount", [cents], expected);
  for (const status of ["未报销", "报销中", "已报销"]) assertCall("normalizeReimbursementStatus", [status], status);
  for (const value of [undefined, null, "", "申请中", "已报销 ", 0, {}, ["已报销"], new String("已报销")]) {
    assertCall("normalizeReimbursementStatus", [value], "未报销");
  }
  for (const [status, expected] of [["未报销", "info"], ["报销中", "warning"], ["已报销", "success"], ["未知", "info"]]) {
    assertCall("reimbursementStatusType", [status], expected);
  }
  for (const value of ["company", "status", "list"]) assertCall("normalizeHistoryViewMode", [value], value);
  for (const value of [undefined, null, "", "STATUS", 0, {}]) assertCall("normalizeHistoryViewMode", [value], "company");
});

test("日期与 ID、附图变换、中文换行和费用行高符合固定预期", () => {
  assertCall("today", [], "2026-01-02");
  assertCall("id", ["expense"], `expense-${fixedNow}-8`);
  assertCall("formatDateTime", ["2026-01-02T03:04:05"], "2026/01/02 03:04");
  assertCall("formatDateTime", ["不是日期"], "不是日期");
  assertCall("formatDateTime", [""], "");
  assertCall("formatSaveTime", ["2026-01-02T03:04:05"], "03:04:05");
  assertCall("formatSaveTime", [new FixtureDate(2026, 0, 2, 3, 4, 5)], "03:04:05");
  assertCall("formatSaveTime", [new FixtureDate(NaN)], "");
  assertCall("formatSaveTime", ["不是日期"], "");
  const transformCases = [
    [[0], [0, 0, 100 / 3, 50]], [[5, 6], [200 / 3, 50, 100 / 3, 50]],
    [[6, 7], [0, 200 / 3, 100 / 3, 100 / 3]], [[9, 10], [0, 75, 100 / 3, 25]],
    [[0, 0], [0, 0, 100 / 3, 50]],
  ];
  for (const [args, [x, y, width, height]] of transformCases) {
    assertCall("transform", args, { x, y, width, height, rotation: 0, cropZoom: 1, cropX: 50, cropY: 50 });
  }
  const lineCases = [
    ["", 18, 1], ["\n", 18, 2], ["甲\r\n\r\n乙", 18, 3],
    ["中".repeat(18), 18, 1], ["中".repeat(19), 18, 2],
    ["a".repeat(32), 18, 1], ["a".repeat(33), 18, 2], ["é".repeat(32), 18, 1],
    ["Ａ".repeat(19), 18, 2], ["😀".repeat(18), 18, 1], ["😀".repeat(19), 18, 2],
    ["甲".repeat(17) + "ab", 18, 2], ["人".repeat(8), 8, 1], ["人".repeat(9), 8, 2],
  ];
  for (const [value, capacity, expected] of lineCases) assertCall("wrappedLineCount", [value, capacity], expected);
  const expense = makeDraft([0]).expenses[0];
  for (const [description, arranger, expected] of [
    ["", "", 42], ["中".repeat(36), "经办人", 42], ["中".repeat(37), "经办人", 57],
    ["简短", "人".repeat(17), 57], ["中".repeat(216), "", 198], ["甲\r\n乙\n丙", "", 57],
  ]) {
    Object.assign(expense, { description, arranger });
    assert.equal(pagination.expenseRowHeight(expense), legacy.expenseRowHeight(expense));
    assert.equal(pagination.expenseRowHeight(expense), expected, "费用行高的独立预期");
  }
});

test("空单、单笔与六七张附图、十笔三十图的分页及引用与顺序保持兼容", () => {
  const cases = [
    ["空单", [], {
      rows: [[]], heights: [[]], flags: [[true, true]], attachmentSizes: [], ids: [], labels: [],
      remaining: 785, sharedIds: null, separateSizes: [], pageCount: 1,
    }],
    ["一笔一图", [0], {
      rows: [[0]], heights: [[42]], flags: [[true, true]], attachmentSizes: [1], ids: ["expense-1"], labels: ["1"],
      remaining: 743, sharedIds: ["expense-1"], separateSizes: [], pageCount: 1,
    }],
    ["一笔六图", [5], {
      rows: [[0]], heights: [[42]], flags: [[true, true]], attachmentSizes: [6], ids: sixIds, labels: sixLabels,
      remaining: 743, sharedIds: sixIds, separateSizes: [], pageCount: 1,
    }],
    ["一笔七图", [6], {
      rows: [[0]], heights: [[42]], flags: [[true, true]], attachmentSizes: [6, 1],
      ids: [...sixIds, "expense-1-extra-6"], labels: [...sixLabels, "1-7"],
      remaining: 743, sharedIds: sixIds, separateSizes: [1], pageCount: 2,
    }],
    ["十笔三十图", Array(10).fill(2), {
      rows: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], heights: [Array(10).fill(42)], flags: [[true, true]],
      attachmentSizes: [6, 6, 6, 6, 6], ids: thirtyIds, labels: thirtyLabels,
      remaining: 365, sharedIds: thirtyFirstPage, separateSizes: [6, 6, 6, 6], pageCount: 5,
    }],
  ];
  for (const [label, extraCounts, expected] of cases) {
    const draft = makeDraft(extraCounts);
    assertPages(draft, expected, `${label} single`);
    draft.previewMode = "double";
    assertPages(draft, {
      ...expected, sharedIds: null, separateSizes: expected.attachmentSizes,
      pageCount: expected.pageCount + (expected.sharedIds ? 1 : 0),
    }, `${label} double`);
  }
  const reordered = makeDraft([2, 1]);
  const originalExpenses = [...reordered.expenses];
  reordered.expenses[0].extraAttachments.reverse();
  reordered.expenses.reverse();
  const reorderedIds = ["expense-2", "expense-2-extra-1", "expense-1", "expense-1-extra-2", "expense-1-extra-1"];
  assertPages(reordered, {
    rows: [[0, 1]], heights: [[42, 42]], flags: [[true, true]], attachmentSizes: [5],
    ids: reorderedIds, labels: ["1", "1-2", "2", "2-2", "2-3"],
    remaining: 701, sharedIds: reorderedIds, separateSizes: [], pageCount: 1,
  }, "费用与附图重排后 ID 和图片顺序");
  assert.strictEqual(reordered.expenses[0], originalExpenses[1]);
  assert.strictEqual(reordered.expenses[1], originalExpenses[0]);
});

test("长说明跨页使用不同首续页预算，超高单行不丢失费用", () => {
  const draft = makeDraft(Array(10).fill(0));
  draft.expenses.forEach(expense => { expense.description = "中".repeat(216); });
  assertPages(draft, {
    rows: [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9]],
    heights: [[198, 198, 198], [198, 198, 198, 198], [198, 198, 198]],
    flags: [[true, false], [false, false], [false, true]], attachmentSizes: [6, 4],
    ids: tenIds, labels: tenLabels, remaining: 222, sharedIds: null, separateSizes: [6, 4], pageCount: 5,
  }, "四行 792 高度仅能放入续页");
  const longDraft = makeDraft(Array(10).fill(2));
  longDraft.expenses.forEach(expense => { expense.description = "中".repeat(234); });
  assertPages(longDraft, {
    rows: [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]],
    heights: [[213, 213, 213], [213, 213, 213], [213, 213, 213], [213]],
    flags: [[true, false], [false, false], [false, false], [false, true]], attachmentSizes: [6, 6, 6, 6, 6],
    ids: thirtyIds, labels: thirtyLabels, remaining: 603, sharedIds: null, separateSizes: [6, 6, 6, 6, 6], pageCount: 9,
  }, "十笔长说明与三十图");
  const oversized = makeDraft([0, 0]);
  oversized.expenses[0].description = "中".repeat(1080);
  assertPages(oversized, {
    rows: [[0], [1]], heights: [[946], [42]], flags: [[true, false], [false, true]], attachmentSizes: [2],
    ids: ["expense-1", "expense-2"], labels: ["1", "2"], remaining: 774,
    sharedIds: null, separateSizes: [2], pageCount: 3,
  }, "超高单行及后续费用");
});

test("single 与 double 在共享附图剩余高度 126 和 125 的边界保持兼容", () => {
  // 19 行加四个 5 行说明得到总行高 659；38 行加 3 行说明得到 660。
  const boundary = makeDraft([0, 0, 0, 0, 0]);
  [19, 5, 5, 5, 5].forEach((lines, index) => { boundary.expenses[index].description = "中".repeat(18 * lines); });
  const below = makeDraft([0, 0]);
  [38, 3].forEach((lines, index) => { below.expenses[index].description = "中".repeat(18 * lines); });
  for (const mode of ["single", "double"]) {
    boundary.previewMode = mode;
    below.previewMode = mode;
    const boundaryIds = ["expense-1", "expense-2", "expense-3", "expense-4", "expense-5"];
    assertPages(boundary, {
      rows: [[0, 1, 2, 3, 4]], heights: [[307, 88, 88, 88, 88]], flags: [[true, true]], attachmentSizes: [5],
      ids: boundaryIds, labels: ["1", "2", "3", "4", "5"], remaining: 126,
      sharedIds: mode === "single" ? boundaryIds : null,
      separateSizes: mode === "single" ? [] : [5], pageCount: mode === "single" ? 1 : 2,
    }, `${mode} 恰好达到共享阈值`);
    assertPages(below, {
      rows: [[0, 1]], heights: [[603, 57]], flags: [[true, true]], attachmentSizes: [2],
      ids: ["expense-1", "expense-2"], labels: ["1", "2"], remaining: 125,
      sharedIds: null, separateSizes: [2], pageCount: 2,
    }, `${mode} 低于共享阈值`);
  }
});
