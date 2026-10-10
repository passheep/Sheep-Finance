import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { baseParse } from "@vue/compiler-dom";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = execFileSync(
  "git",
  ["show", "4aaa9e55ac2f0d8b33c38180facc3340e792e057:app/src/App.vue"],
  { cwd: root, encoding: "utf8" },
);
const appPath = path.join(root, "src/App.vue");
const preservedAttachment = path.join(root, "src/components/AttachmentSurface.vue");
const visited = new Map();

function normalizeExpression(source) {
  if (!source) return "";
  // 忽略搬迁产生的缩进，保留事件、赋值、条件与调用参数的语义。
  const tree = ts.createSourceFile("expression.ts", source, ts.ScriptTarget.Latest);
  function shape(node) {
    if (ts.isParenthesizedExpression(node)) return shape(node.expression);
    const children = [];
    ts.forEachChild(node, child => { children.push(shape(child)); });
    const text = ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)
      ? node.text : null;
    return [ts.SyntaxKind[node.kind], text, children];
  }
  return JSON.stringify(shape(tree));
}

function readView(file, source = fs.readFileSync(file, "utf8")) {
  const { descriptor, errors } = parse(source, { filename: file });
  assert.deepEqual(errors, [], `组件解析失败：${file}`);
  const ast = baseParse(descriptor.template.content);
  const imports = new Map();
  const script = ts.createSourceFile(
    "script.ts",
    descriptor.scriptSetup.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const node of script.statements) {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.name &&
      node.moduleSpecifier.text.endsWith(".vue")
    ) {
      imports.set(
        node.importClause.name.text,
        path.resolve(path.dirname(file), node.moduleSpecifier.text),
      );
    }
  }
  return { ast, imports, descriptor };
}

function normalizeNodes(nodes, view, stack = []) {
  return nodes.flatMap((node) => {
    if (node.type === 3) return [];
    if (node.type === 2) {
      const text = node.content.replace(/\s+/g, " ").trim();
      return text ? [{ text }] : [];
    }
    if (node.type === 5) {
      return [{ interpolation: normalizeExpression(node.content.content) }];
    }
    assert.equal(node.type, 1, "出现尚未审查的模板节点");
    const componentPath = view.imports.get(node.tag);
    if (componentPath && componentPath !== preservedAttachment) {
      assert.ok(!stack.includes(componentPath), "展示组件形成循环依赖");
      assert.deepEqual(node.props, [], "组件根新增了未经对照的参数或事件");
      const child = readView(componentPath);
      visited.set(componentPath, child);
      return normalizeNodes(child.ast.children, child, [...stack, componentPath]);
    }
    const props = node.props.map((prop) => {
      if (prop.type === 6) {
        return { attribute: prop.name, value: prop.value?.content ?? null };
      }
      return {
        directive: prop.name,
        argument: prop.arg?.content ?? null,
        expression: normalizeExpression(prop.exp?.content),
        modifiers: prop.modifiers.map(modifier => typeof modifier === "string" ? modifier : modifier.content),
      };
    });
    return [{
      tag: node.tag,
      props,
      children: normalizeNodes(node.children, view, stack),
    }];
  });
}

function templateNode(source) {
  const nodes = normalizeNodes(baseParse(source).children, { imports: new Map() });
  assert.equal(nodes.length, 1, "局部模板预期应只有一个根节点");
  return nodes[0];
}
function findNodes(nodes, predicate) {
  return nodes.flatMap(node => [
    ...(predicate(node) ? [node] : []),
    ...findNodes(node.children ?? [], predicate),
  ]);
}
function replaceDisplayText(nodes, replacements) {
  for (const node of nodes) {
    for (const prop of node.props ?? []) {
      if (prop.value && typeof prop.value === "string") {
        for (const [from, to] of replacements) prop.value = prop.value.split(from).join(to);
      }
    }
    for (const child of node.children ?? []) {
      if (child.text) {
        for (const [from, to] of replacements) child.text = child.text.split(from).join(to);
      }
    }
    replaceDisplayText(node.children ?? [], replacements);
  }
}
function nodeWithClass(nodes, className) {
  const matches = findNodes(nodes, node => node.props?.some(prop => prop.attribute === "class" && prop.value === className));
  assert.equal(matches.length, 1, `授权例外的定位节点必须唯一：${className}`);
  return matches[0];
}
function removeNodeWithClass(nodes, className) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.props?.some(prop => prop.attribute === "class" && prop.value === className)) {
      nodes.splice(index, 1);
      return true;
    }
    if (removeNodeWithClass(node.children ?? [], className)) return true;
  }
  return false;
}
function authorizedTargets(nodes) {
  const topbar = nodeWithClass(nodes, "topbar");
  assert.equal(findNodes([topbar], node => node.props?.some(prop => prop.attribute === "class" && prop.value === "brand-block")).length, 0, "顶栏不应保留旧品牌块");
  const companyLabel = nodeWithClass(nodes, "preview-context-selects").children[1];
  assert.equal(companyLabel.tag, "label");
  assert.equal(companyLabel.children[1].tag, "el-select");
  return {
    topbar,
    about: nodeWithClass(nodes, "about-mark"),
    toolbar: nodeWithClass(nodes, "preview-toolbar-right"),
    approval: nodeWithClass(nodes, "paper-approval"),
    company: companyLabel.children[1],
    total: nodeWithClass(nodes, "total-value"),
    automaticTotal: nodeWithClass(nodes, "manual-total-action"),
  };
}

const expectedTemplates = {
  about: templateNode(`<img class="about-mark" src="/app-icon.png" alt="报销单助手应用图标" width="112" height="112" />`),
  finance: templateNode(`<span class="approval-field">
    <span class="approval-export-text">{{ financeReviewer }}：</span>
    <select v-model="financeReviewer" class="approval-select" aria-label="审批部门" title="审批部门">
      <option value="财务">财务：</option>
      <option value="秘书处">秘书处：</option>
    </select>
  </span>`),
  manager: templateNode(`<span class="approval-field">
    <span class="approval-export-text">{{ showManagerApproval ? '总经理审核：' : '' }}</span>
    <select v-model="showManagerApproval" class="approval-select" aria-label="总经理审核栏" title="总经理审核栏">
      <option :value="true">总经理审核：</option>
      <option :value="false">隐藏</option>
    </select>
  </span>`),
  undo: templateNode(`<el-button circle text :icon="RefreshLeft"
    :title="undoPreviewLabel ? \`撤销：\${undoPreviewLabel}（Ctrl+Z）\` : '撤销（Ctrl+Z）'"
    aria-label="撤销预览编辑" :disabled="isExportingPdf || (!canUndoPreview && !editingKey)"
    @click="undoPreviewEdit" />`),
  redo: templateNode(`<el-button circle text :icon="RefreshRight"
    :title="redoPreviewLabel ? \`重做：\${redoPreviewLabel}（Ctrl+Shift+Z）\` : '重做（Ctrl+Shift+Z）'"
    aria-label="重做预览编辑" :disabled="isExportingPdf || !canRedoPreview"
    @click="redoPreviewEdit" />`),
  company: templateNode(`<el-select :model-value="draft.companyName" @update:model-value="changePreviewCompany">
    <el-option v-for="company in companyNames" :key="company" :label="company" :value="company" />
  </el-select>`),
  total: templateNode(`<div class="total-value">
    <button v-if="!manualTotal" class="paper-editable total-number" type="button"
      @click="enableManualTotal(effectiveTotal)">￥{{ money(effectiveTotal) }}</button>
    <input v-else class="paper-edit-input total-number" :value="(effectiveTotal / 100).toFixed(2)"
      type="text" inputmode="decimal" autocomplete="off"
      @change="commitManualTotal(($event.target as HTMLInputElement).value)" />
  </div>`),
  automaticTotal: templateNode(`<div v-if="manualTotal" class="manual-total-action">
    <el-button text size="small" @click="restoreAutomaticTotal">恢复自动合计</el-button>
  </div>`),
};
function assertAuthorizedTemplates(nodes) {
  const targets = authorizedTargets(nodes);
  assert.equal(targets.topbar.children[0].tag, "nav", "主导航应位于顶栏左侧");
  assert.deepEqual(targets.about, expectedTemplates.about, "关于页应显示报销单助手图标和名称");
  assert.deepEqual(targets.approval.children.slice(1), [expectedTemplates.finance, expectedTemplates.manager], "审批下拉、布尔选项与导出文本的完整预期");
  assert.deepEqual(targets.toolbar.children.slice(-2), [expectedTemplates.undo, expectedTemplates.redo], "撤销重做的图标、禁用条件、快捷键提示和事件预期");
  for (const name of ["company", "total", "automaticTotal"]) {
    assert.deepEqual(targets[name], expectedTemplates[name], `${name} 的 setter 和合计操作模板预期`);
  }
  return targets;
}
function usePreviousEvent(current, previous, event) {
  const isEvent = prop => prop.directive === "on" && prop.argument === event;
  assert.equal(current.props.filter(isEvent).length, 1, `新增 ${event} 事件应唯一`);
  const previousProps = previous.props.filter(isEvent);
  assert.equal(previousProps.length, 1, `旧 ${event} 事件应唯一`);
  current.props = current.props.map(prop => isEvent(prop) ? previousProps[0] : prop);
}
function comparableTemplate(current, previous) {
  const result = structuredClone(current);
  const targets = assertAuthorizedTemplates(result);
  replaceDisplayText(result, [["允许报销单助手通过", "允许 SheepFinance 通过"], ["另一台报销单助手", "另一台 SheepFinance"], ["报销单助手应用图标", "SheepFinance 应用图标"], ["报销单助手", "SheepFinance"], ["版本 0.3.0", "版本 0.2.2"]]);
  for (const node of findNodes(result, node => node.props?.some(prop => prop.attribute === "class" && prop.value === "eyebrow"))) {
    for (const child of node.children ?? []) if (child.text === "SheepFinance") child.text = "SHEEPFINANCE";
  }
  const comparablePrevious = structuredClone(previous);
  removeNodeWithClass(comparablePrevious, "brand-block");
  const oldTargets = authorizedTargets(comparablePrevious);
  assert.deepEqual(oldTargets.approval.children.slice(1), [templateNode(`<span>财务：</span>`), templateNode(`<span>总经理审核：</span>`)]);
  // 关于页图标和顶栏品牌块都是本轮授权变化，不参与旧版结构比较。
  Object.assign(targets.about, oldTargets.about);
  // 仅替换独立校验过的局部；祖先、相邻节点、分页属性和其余事件继续全等。
  targets.approval.children.splice(1, 2, ...oldTargets.approval.children.slice(1));
  targets.toolbar.children.splice(targets.toolbar.children.length - 2, 2);
  targets.company.props = oldTargets.company.props;
  usePreviousEvent(targets.total.children[0], oldTargets.total.children[0], "click");
  usePreviousEvent(targets.total.children[1], oldTargets.total.children[1], "change");
  usePreviousEvent(targets.automaticTotal.children[0], oldTargets.automaticTotal.children[0], "click");
  return result;
}
function replaceExactlyOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label} 必须精确出现一次`);
  return source.replace(before, () => after);
}
function templateRefs(nodes) {
  return findNodes(nodes, node => node.props?.some(prop => prop.attribute === "ref"))
    .flatMap(node => node.props.filter(prop => prop.attribute === "ref").map(prop => prop.value));
}

const currentView = readView(appPath);
const currentTemplate = normalizeNodes(currentView.ast.children, currentView);
const previousView = readView(appPath, baseline);
const previousTemplate = normalizeNodes(previousView.ast.children, previousView);

test("授权的应用图片、审批下拉、撤销重做、公司 setter 和合计操作符合独立模板预期", () => {
  assertAuthorizedTemplates(currentTemplate);
});

test("拆分组件展开后保留旧版 DOM、分页定位属性和全部事件表达式", () => {
  assert.equal(normalizeExpression("a +\n b"), normalizeExpression("a + b"));
  assert.notEqual(normalizeExpression("commitHeader('applicant')"), normalizeExpression("commitHeader('bank')"));
  assert.notEqual(normalizeExpression("(a + b) * c"), normalizeExpression("a + b * c"));
  const expected = structuredClone(previousTemplate);
  removeNodeWithClass(expected, "brand-block");
  assert.deepEqual(comparableTemplate(currentTemplate, previousTemplate), expected);
});

test("全局样式按原次序拼接，包含原有打印和响应式规则", () => {
  const previous = parse(baseline).descriptor.styles[0].content;
  const imports = fs.readFileSync(path.join(root, "src/styles/app.css"), "utf8");
  const cssFiles = [...imports.matchAll(/@import "\.\/([^"]+)";/g)].map(match => match[1]);
  assert.deepEqual(cssFiles, ["base.css", "workbench.css", "pages.css", "print.css"]);
  const current = cssFiles.map(file => fs.readFileSync(path.join(root, "src/styles", file), "utf8")).join("");
  const approvalRules = `.approval-field {
  min-width: 0;
}
.approval-select {
  max-width: 100%;
  padding: 0;
  border: 0;
  background-color: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.approval-export-text {
  display: none;
}
.exporting-document .approval-select {
  display: none;
}
.exporting-document .approval-export-text {
  display: inline;
}
`;
  const printApprovalRules = `  .approval-select {
    display: none !important;
  }
  .approval-export-text {
    display: inline !important;
  }
`;
  const currentAboutImageRules = `  font-size: 62px;
  font-weight: 800;
  object-fit: contain;
  padding: 10px;
`;
  const previousAboutImageRules = `  font-size: 62px;
  font-weight: 800;
`;
  let comparable = replaceExactlyOnce(current, approvalRules, "", "审批下拉和导出局部样式");
  comparable = replaceExactlyOnce(comparable, printApprovalRules, "", "打印审批局部样式");
  comparable = replaceExactlyOnce(comparable, currentAboutImageRules, previousAboutImageRules, "关于页图标样式");

  const previousBrandContainer = `.brand-block,
.topbar-actions,
.preview-tools,
.inspector-actions {
  display: flex;
  align-items: center;
}
`;
  const previousBrandBlock = `.brand-block {
  gap: 11px;
}
`;
  const previousBrand = `.brand-mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #fff;
  background: #cf674d;
  font-size: 18px;
  font-weight: 800;
  box-shadow: 0 7px 14px rgba(207, 103, 77, 0.2);
}
`;
  const previousBrandName = `.brand-name {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
`;
  const previousBrandSubtitle = `.brand-subtitle {
  margin-top: 1px;
  color: #87918d;
  font-size: 11px;
}
`;
  const previousAboutMark = `  font-weight: 800;
`;
  let comparablePrevious = replaceExactlyOnce(previous, previousBrandContainer, `.topbar-actions,
.preview-tools,
.inspector-actions {
  display: flex;
  align-items: center;
}
`, "顶栏品牌容器样式");
  comparablePrevious = replaceExactlyOnce(comparablePrevious, previousBrandBlock, "", "顶栏品牌块样式");
  comparablePrevious = replaceExactlyOnce(comparablePrevious, previousBrand, "", "旧品牌图标样式");
  comparablePrevious = replaceExactlyOnce(comparablePrevious, previousBrandName, "", "旧品牌名称样式");
  comparablePrevious = replaceExactlyOnce(comparablePrevious, previousBrandSubtitle, "", "旧品牌副标题样式");
  assert.equal(comparable, comparablePrevious);
});

test("拆分后的 DOM 模板引用仍绑定共享状态，而非组件内的独立引用", () => {
  assert.deepEqual(templateRefs(currentTemplate), templateRefs(previousTemplate), "所有 DOM ref 的名称、数量和顺序应与旧模板全等");
  let count = 0;
  for (const [file, view] of visited) {
    const bindings = compileScript(view.descriptor, { id: file }).bindings;
    function visit(node) {
      if (node.type === 1) {
        for (const prop of node.props) {
          if (prop.type === 6 && prop.name === "ref" && prop.value) {
            assert.ok(bindings[prop.value.content]?.startsWith("setup-"), `${file} 缺少共享模板引用 ${prop.value.content}`);
            count += 1;
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(view.ast);
  }
  assert.equal(count, templateRefs(currentTemplate).length, "共享引用绑定检查应覆盖全部 DOM ref");
  assert.ok(count >= 10, "模板引用审查没有覆盖上传、编辑和预览输入");
});
