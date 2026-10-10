import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { createServer as createPortServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer, normalizePath } from "vite";
import vue from "@vitejs/plugin-vue";
import ExcelJS from "exceljs";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const mode = process.env.SHEEPFINANCE_REFACTOR_MODE ?? "compare";
const artifactsRoot = process.env.SHEEPFINANCE_REFACTOR_ARTIFACTS ??
  path.join(os.tmpdir(), "SheepFinance-refactor");
const baselineRevision = "4aaa9e55ac2f0d8b33c38180facc3340e792e057";
const fixtureTime = "2026-01-01T00:00:00.000Z";
const executeFile = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Chrome 实测发送文本帧；仍显式兼容 Node WebSocket 的二进制消息，解析失败必须终结 pending。
async function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new TypeError(`不支持的 WebSocket 消息类型：${data?.constructor?.name ?? typeof data}`);
}

// 不新增自动化依赖；请求、连接和 target 的生命周期均由本客户端管理。
class BrowserConnection {
  pending = new Map();
  detachedSessions = new Set();
  sequence = 0;
  errors = [];
  messageQueue = Promise.resolve();

  constructor(socket, { signal, record = () => {}, onEvent = () => {} } = {}) {
    this.socket = socket;
    this.record = record;
    this.onEvent = onEvent;
    this.signal = signal;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // ready 也可能先被 Chrome 的退出事件拒绝，调用方仍可随后 await 同一个 Promise。
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail(new Error("WebSocket 连接在 5 秒内未就绪")), 5000);
    const opened = () => {
      clearTimeout(this.readyTimer);
      this.record({ event: "open", readyState: socket.readyState });
      this.resolveReady();
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", (event) => {
      this.fail(new Error(event.error?.message || event.message || "WebSocket 传输异常"));
    });
    socket.addEventListener("close", (event) => {
      this.fail(new Error(`WebSocket 已关闭：${event.code} ${event.reason ?? ""}`));
    });
    socket.addEventListener("message", ({ data }) => {
      this.record({ event: "message", dataType: typeof data, constructor: data?.constructor?.name,
        bytes: data?.byteLength ?? data?.size ?? data?.length });
      // Blob.text() 异步解码时也保持 CDP 消息顺序；不等待事件回调，避免回调内 command 死锁。
      this.messageQueue = this.messageQueue.then(async () => {
        if (this.failure) return;
        const message = JSON.parse(await messageText(data));
        this.record({ event: "receive", id: message.id, method: message.method,
          sessionId: message.sessionId, error: message.error });
        if (message.method === "Runtime.exceptionThrown") {
          this.errors.push(message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text);
        }
        if (message.method === "Target.detachedFromTarget") {
          const sessionId = message.params.sessionId;
          this.detachedSessions.add(sessionId);
          for (const [id, pending] of this.pending) {
            if (pending.sessionId === sessionId) {
              this.settle(id, new Error(`CDP session 已分离：${sessionId}，${pending.method}`));
            }
          }
        }
        if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          if (pending.sessionId !== message.sessionId) {
            throw new Error(`CDP 响应 session 不匹配：${pending.method} id=${message.id}`);
          }
          this.settle(message.id,
            message.error ? new Error(JSON.stringify(message.error)) : null, message.result);
        } else {
          Promise.resolve(this.onEvent(message)).catch((error) => this.fail(error));
        }
      }).catch((error) => this.fail(error));
    });
    this.aborted = () => this.fail(signal.reason ?? new Error("浏览器测试已取消"));
    signal?.addEventListener("abort", this.aborted, { once: true });
    if (signal?.aborted) this.aborted();
    else if (socket.readyState === WebSocket.OPEN) opened();
    else if (socket.readyState !== WebSocket.CONNECTING) this.fail(new Error("WebSocket 已关闭"));
  }

  settle(id, error, result) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    this.record({ event: "settle", id, method: pending.method,
      durationMs: performance.now() - pending.started, error: error?.message });
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    clearTimeout(this.readyTimer);
    this.rejectReady(this.failure);
    this.record({ event: "disconnect", error: this.failure.message,
      readyState: this.socket.readyState, pending: [...this.pending.keys()] });
    for (const id of this.pending.keys()) this.settle(id, this.failure);
    this.signal?.removeEventListener("abort", this.aborted);
    this.socket.close();
  }

  command(method, params = {}, sessionId, timeoutMs = 20000) {
    // Node 的全局 WebSocket 在 CLOSED/CLOSING 状态会静默丢弃 send，不能仅靠命令超时兜底。
    if (this.failure) return Promise.reject(this.failure);
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebSocket 未就绪：${method}，readyState=${this.socket.readyState}`));
    }
    if (this.detachedSessions.has(sessionId)) {
      return Promise.reject(new Error(`CDP session 已分离：${sessionId}`));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new Error(`浏览器命令超时：${method} id=${id} session=${sessionId ?? "browser"} readyState=${this.socket.readyState}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, sessionId, started: performance.now() });
      this.record({ event: "send", id, method, sessionId, readyState: this.socket.readyState });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async evaluate(expression, sessionId) {
    const result = await this.command("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  dispose() {
    this.fail(new Error("浏览器连接已回收"));
  }
}

async function bounded(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectBrowser(profile, browserProcess, options) {
  let activePort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    options.signal.throwIfAborted();
    assert.equal(browserProcess.exitCode, null, "隔离 Chrome 已提前退出");
    assert.equal(browserProcess.signalCode, null, "隔离 Chrome 已被终止");
    try {
      activePort = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await delay(100, undefined, { signal: options.signal });
    }
  }
  assert.ok(activePort, "隔离 Chrome 未在 10 秒内发布 DevToolsActivePort");
  const port = Number(activePort[0]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.match(activePort[1], /^\/devtools\/browser\/[\w-]+$/);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(2000)]),
  });
  assert.ok(response.ok, `Chrome 调试端点返回 ${response.status}`);
  const version = await response.json();
  const debuggerUrl = new URL(version.webSocketDebuggerUrl);
  // 从本次 profile 获取端口和 browser ID，再验证端点身份，绝不凭固定端口选 /json/list 的首个 target。
  assert.equal(debuggerUrl.pathname, activePort[1], "调试端点不属于本次独立 profile");
  assert.equal(debuggerUrl.port, String(port));
  assert.equal(debuggerUrl.hostname, "127.0.0.1");
  assert.equal(debuggerUrl.protocol, "ws:");
  const browser = new BrowserConnection(new WebSocket(debuggerUrl), options);
  browser.metadata = { port, debuggerUrl: debuggerUrl.href, version };
  await browser.ready;
  return browser;
}

async function sourceSelection(signal) {
  if (mode !== "baseline") return { plugins: [], metadata: { type: "workspace" } };
  const gitShow = async (file) => (await executeFile("git", ["show", `${baselineRevision}:app/${file}`], {
    cwd: path.dirname(appRoot), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000, signal,
  })).stdout;
  const source = await gitShow("src/App.vue");
  const originalHtml = await gitShow("index.html");
  const shared = {};
  for (const file of ["src/main.ts", "src/components/AttachmentSurface.vue", "package.json", "package-lock.json"]) {
    const original = (await gitShow(file)).replace(/\r\n/g, "\n");
    const current = (await fs.readFile(path.join(appRoot, file), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(current, original, `baseline 依赖已变化，不能借用工作区文件：${file}`);
    shared[file] = sha256(current);
  }
  const metadata = { type: "git-show", revision: baselineRevision, appSha256: sha256(source),
    indexHtmlSha256: sha256(originalHtml), shared, loads: 0, indexLoads: 0 };
  const appFile = normalizePath(path.join(appRoot, "src/App.vue"));
  return {
    metadata,
    plugins: [{
      name: "refactor-original-app", enforce: "pre",
      // favicon 等工作区 HTML 已更新；固定旧 HTML 仍交给 Vite 注入开发入口，不放松其余共享依赖核对。
      transformIndexHtml: {
        order: "pre",
        handler() {
          metadata.indexLoads += 1;
          return originalHtml;
        },
      },
      load(id) {
        if (normalizePath(id) !== appFile) return null;
        metadata.loads += 1;
        // 原 SFC 只在内存供应；Vue 插件的 script/style 子请求使用同一份 descriptor。
        return source;
      },
    }],
  };
}

async function stopChrome(browserProcess, profile) {
  if (!browserProcess?.pid || browserProcess.exitCode !== null || browserProcess.signalCode !== null) return;
  const exited = new Promise((resolve) => browserProcess.once("exit", resolve));
  try {
    await bounded(exited, 1500, "Chrome 未在宽限期退出");
    return;
  } catch {
    // 只终止本次 spawn 的 Chrome 树；不按进程名称清理桌面浏览器，也不删除 profile。
    if (process.platform === "win32") {
      const script = `
        $testProfile = '${profile.replaceAll("'", "''")}'
        $testPid = ${browserProcess.pid}
        $items = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
        $root = $items | Where-Object { $_.ProcessId -eq $testPid }
        if ($root -and -not $root.CommandLine.Contains($testProfile)) { throw 'Chrome profile 身份不匹配' }
        $owned = [System.Collections.Generic.HashSet[uint32]]::new()
        [void]$owned.Add([uint32]$testPid)
        do {
          $added = $false
          foreach ($item in $items) {
            if ($owned.Contains([uint32]$item.ParentProcessId) -and $owned.Add([uint32]$item.ProcessId)) { $added = $true }
          }
        } while ($added)
        $items | Where-Object { $owned.Contains([uint32]$_.ProcessId) } | ForEach-Object {
          Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
      `;
      await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 3000, windowsHide: true,
      });
    } else {
      browserProcess.kill();
    }
    await bounded(exited, 1000, "本次 Chrome 终止后仍未退出");
  }
}

class TestSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
    this.reply?.(this.sent.at(-1));
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  message(data) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

test("CDP 客户端：文本、Blob、ArrayBuffer 和视图响应均能结算", { timeout: 2000 }, async () => {
  for (const encode of [text => text, text => new Blob([text]), text => new TextEncoder().encode(text).buffer,
    text => Buffer.from(text), text => new TextEncoder().encode(text)]) {
    const socket = new TestSocket();
    const browser = new BrowserConnection(socket);
    await browser.ready;
    socket.reply = ({ id, sessionId }) => {
      assert.ok(browser.pending.has(id), "send 前必须注册 pending");
      socket.message(encode(JSON.stringify({ id, sessionId, result: { enabled: true } })));
    };
    assert.deepEqual(await browser.command("Page.enable", {}, "session"), { enabled: true });
    assert.equal(browser.pending.size, 0);
    browser.dispose();
  }
});

test("CDP 客户端：连接未就绪或已关闭时立即失败", { timeout: 2000 }, async () => {
  const socket = new TestSocket();
  socket.readyState = WebSocket.CONNECTING;
  const browser = new BrowserConnection(socket);
  await assert.rejects(browser.command("Page.enable"), /未就绪/);
  socket.readyState = WebSocket.OPEN;
  socket.dispatchEvent(new Event("open"));
  await browser.ready;
  const pending = browser.command("Network.enable", {}, "session");
  socket.close();
  await assert.rejects(pending, /已关闭/);
  await assert.rejects(browser.command("Page.enable"), /已关闭/);
  assert.equal(browser.pending.size, 0);
  assert.equal(socket.sent.length, 1, "关闭后不能再调用会静默丢弃数据的 send");
});

test("CDP 客户端：解析、send 和 session 错误不遗留 pending", { timeout: 2000 }, async () => {
  for (const kind of ["parse", "send", "session", "detach", "error"]) {
    const socket = new TestSocket();
    const browser = new BrowserConnection(socket);
    await browser.ready;
    if (kind === "send") socket.reply = () => { throw new Error("send 失败"); };
    const pending = browser.command("Page.enable", {}, "session");
    if (kind === "parse") socket.message(new Blob(["不是 JSON"]));
    if (kind === "session") socket.message(JSON.stringify({ id: 1, sessionId: "wrong", result: {} }));
    if (kind === "detach") socket.message(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "session" } }));
    if (kind === "error") socket.dispatchEvent(new Event("error"));
    await assert.rejects(pending);
    assert.equal(browser.pending.size, 0);
    browser.dispose();
  }
});

const image = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#f4e8d9"/><text x="30" y="110" font-size="32">报销单助手 123.45</text></svg>',
);

function draftFixture(count, extraCount = 0, previewMode = "single", long = false) {
  return {
    id: "record-1767225600000-refactor", label: "重构回归样例", status: "未报销",
    companyName: "回归测试有限公司", reimbursementDate: "2026-01-01",
    applicant: "测试申请人", department: "测试部门", payeeName: "测试收款人",
    account: "000000", bank: "测试银行", totalOverrideCents: null, previewMode,
    updatedAt: fixtureTime,
    expenses: Array.from({ length: count }, (_, index) => ({
      id: `expense-${index}`, fileName: `测试票据-${index + 1}.png`, imageDataUrl: image,
      occurredDate: "2026-01-01", reason: "办公费", arranger: "测试安排人",
      description: long ? "用于核对表格跨页和中文换行的报销事项。".repeat(12) : `测试费用 ${index + 1}`,
      amountCents: index % 2 ? -123 : 12345, ocrMode: "advanced", ocrStatus: "manual",
      naturalWidth: 360, naturalHeight: 200,
      manualFields: { reason: true, arranger: true, amountCents: true },
      extraAttachments: Array.from({ length: extraCount }, (_, extraIndex) => ({
        id: `extra-${index}-${extraIndex}`, fileName: `附图-${extraIndex + 1}.png`,
        imageDataUrl: image, naturalWidth: 360, naturalHeight: 200,
      })),
    })),
  };
}

async function waitForWorkspace(browser, sessionId, signal, previousTimeOrigin) {
  let loaded = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    signal.throwIfAborted();
    try {
      loaded = await browser.evaluate(`Boolean(document.querySelector('#app')?.__vue_app__?._instance?.setupState &&
        !window.__refactorModel().isLoadingWorkspace &&
        ${previousTimeOrigin === undefined ? "true" : `performance.timeOrigin !== ${previousTimeOrigin}`})`, sessionId);
    } catch (error) {
      // reload 切换 document 的瞬间可能销毁旧 context；只重试这一类导航错误，其余异常照常失败。
      if (previousTimeOrigin === undefined || !/Execution context was destroyed|Cannot find context with specified id|Inspected target navigated/i.test(error.message)) throw error;
    }
    if (loaded) break;
    await delay(100, undefined, { signal });
  }
  assert.ok(loaded, "应用未在 15 秒内完成浏览器存储加载");
}

// 探针只在隔离页面注入：保留实际绘制和下载字节，记录导出克隆的 CSS、审批文字及真实快捷键事件。
const featureProbe = `
  window.__refactorFeatureKeys = [];
  window.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'z' || !event.ctrlKey) return;
    queueMicrotask(() => window.__refactorFeatureKeys.push({
      key: event.key.toLowerCase(), ctrl: event.ctrlKey, shift: event.shiftKey,
      prevented: event.defaultPrevented, trusted: event.isTrusted,
      target: event.target?.tagName, targetClass: event.target?.className,
    }));
  });
  window.__refactorManualChanges = [];
  window.addEventListener('change', event => {
    if (event.target instanceof HTMLInputElement && event.target.matches('input.total-number')) {
      window.__refactorManualChanges.push({value: event.target.value, trusted: event.isTrusted});
    }
  });
  window.__refactorApproval = root => {
    const approval = root.querySelector('.paper-approval');
    if (!approval) return null;
    return {
      selects: [...approval.querySelectorAll('select')].map(select => ({
        label: select.getAttribute('aria-label'), display: getComputedStyle(select).display,
        value: select.selectedOptions[0]._value ?? select.value,
        valueType: typeof (select.selectedOptions[0]._value ?? select.value),
      })),
      texts: [...approval.querySelectorAll('.approval-export-text')].map(text => ({
        text: text.textContent, display: getComputedStyle(text).display,
      })),
      visibleText: approval.innerText.replace(/\\s+/g, ''),
    };
  };
  window.__refactorExportPhase = null;
  window.__refactorCaptureHosts = [];
  window.__refactorCaptureCanvases = [];
  const appendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function (child) {
    const result = appendChild.call(this, child);
    // html2canvas 还会克隆整份 DOM；只记录生产代码加入主 document.body 的导出 host。
    if (window.__refactorExportPhase && this === document.body && child instanceof HTMLElement &&
      child.ownerDocument === document && child.matches('.export-capture-host')) {
      const s = window.__refactorModel();
      const capture = { phase: window.__refactorExportPhase, stage: 'appended' };
      window.__refactorCaptureHosts.push(capture);
      // 与生产导出的两帧等待对齐；此时 Vue 已刷新 busy 按钮，克隆仍连接且尚未开始 html2canvas 绘制。
      requestAnimationFrame(() => Object.assign(capture, {
        stage: 'before-paint', connected: child.isConnected,
        exporting: child.classList.contains('exporting-document'),
        page: child.querySelector('[data-export-page]')?.getAttribute('data-export-page') ?? null,
        pdfBusy: s.isExportingPdf,
        undoDisabled: document.querySelector('button[aria-label="撤销预览编辑"]').disabled,
        redoDisabled: document.querySelector('button[aria-label="重做预览编辑"]').disabled,
        approval: window.__refactorApproval(child),
      }));
    }
    return result;
  };
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    const result = toDataURL.apply(this, args);
    if (window.__refactorExportPhase && this.width && this.height) {
      const pixels = this.getContext('2d').getImageData(0, 0, this.width, this.height).data;
      const stride = Math.max(1, Math.floor(this.width * this.height / 10000)) * 4;
      let samples = 0; let nonWhite = 0;
      for (let index = 0; index < pixels.length; index += stride) {
        samples += 1;
        if (pixels[index + 3] && Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 245) nonWhite += 1;
      }
      window.__refactorCaptureCanvases.push({phase: window.__refactorExportPhase,
        type: args[0] ?? 'image/png', width: this.width, height: this.height, samples, nonWhite});
    }
    return result;
  };
  window.__refactorPrintCalls = [];
  window.print = () => window.__refactorPrintCalls.push({
    printMedia: matchMedia('print').matches, approval: window.__refactorApproval(document),
  });
  true;
`;

async function runFeatureChecks({ browser, sessionId, signal, artifacts, diagnostics, readDownloads, assertWorkbenchRefs }) {
  const evidence = diagnostics.features = { assertions: [], screenshots: [], exports: [], prints: [], keys: [] };
  const evaluate = expression => browser.evaluate(expression, sessionId);
  const expect = (name, actual, expected) => {
    evidence.assertions.push({ name, actual, expected });
    assert.deepEqual(actual, expected, name);
  };
  const settle = () => evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  const state = () => evaluate(`(() => {
    const s = window.__refactorModel();
    return { id: s.draft.id, applicant: s.draft.applicant, financeReviewer: s.draft.financeReviewer,
      showManagerApproval: s.draft.showManagerApproval, totalOverrideCents: s.draft.totalOverrideCents,
      amount: s.draft.expenses[0]?.amountCents, calculatedTotal: s.calculatedTotal, effectiveTotal: s.effectiveTotal,
      canUndo: s.canUndoPreview, canRedo: s.canRedoPreview,
      undoLabel: s.undoPreviewLabel, redoLabel: s.redoPreviewLabel, editingKey: s.editingKey };
  })()`);
  const layout = () => evaluate(`(() => {
    const s = window.__refactorModel();
    return { pageCount: s.previewPageCount, domPages: document.querySelectorAll('[data-export-page]').length,
      rows: s.formPages.map(page => page.rows.map(row => ({id: row.expense.id, height: row.height}))),
      domRows: [...document.querySelectorAll('.paper-table tr[data-expense-id]')].map(row => ({
        id: row.dataset.expenseId, height: row.style.height,
        renderedHeight: Number(row.getBoundingClientRect().height.toFixed(3)),
      })),
      approvalHeight: Number(document.querySelector('.paper-approval').getBoundingClientRect().height.toFixed(3)) };
  })()`);
  const assertHistoryFlags = async (name, undo, redo) => {
    const actual = await evaluate(`(() => {
      const s = window.__refactorModel();
      return {undo: s.canUndoPreview, redo: s.canRedoPreview,
        undoDisabled: document.querySelector('button[aria-label="撤销预览编辑"]').disabled,
        redoDisabled: document.querySelector('button[aria-label="重做预览编辑"]').disabled};
    })()`);
    expect(name, actual, { undo, redo, undoDisabled: !undo, redoDisabled: !redo });
  };
  // 原生 select 的 bool option 使用 Vue 的 _value，必须派发 DOM 事件走 v-model 与变更命令。
  const selectApproval = async (label, value) => {
    const actual = await evaluate(`(() => {
      const selects = [...document.querySelectorAll('select[aria-label=${JSON.stringify(label)}]')];
      if (selects.length !== 1 || !(selects[0] instanceof HTMLSelectElement)) throw new Error('审批原生 select 缺失或重复');
      const select = selects[0];
      const index = [...select.options].findIndex(option => (option._value ?? option.value) === ${JSON.stringify(value)});
      if (index < 0) throw new Error('审批 option 的真实值缺失');
      select.focus(); select.selectedIndex = index;
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
      const selected = select.selectedOptions[0]; select.blur();
      return {value: selected._value ?? selected.value, valueType: typeof (selected._value ?? selected.value)};
    })()`);
    expect(`原生选择：${label}=${value}`, actual, { value, valueType: typeof value });
    await settle();
  };
  const click = async (selector, text) => {
    const point = await evaluate(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter(element => ${text === undefined ? "true" : `element.textContent.trim() === ${JSON.stringify(text)}`});
      if (elements.length !== 1) throw new Error('点击目标缺失或重复：' + ${JSON.stringify(selector)});
      const element = elements[0];
      if (element.disabled) throw new Error('点击目标被禁用：' + ${JSON.stringify(selector)});
      element.scrollIntoView({block: 'nearest', inline: 'nearest'});
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2; const y = rect.y + rect.height / 2;
      if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight ||
        !element.contains(document.elementFromPoint(x, y))) throw new Error('点击目标不可见或被遮挡');
      return {x, y};
    })()`);
    await browser.command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
    await browser.command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, sessionId);
    await browser.command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, sessionId);
    await settle();
  };
  const key = async (key, code, keyCode, modifiers = 0) => {
    const params = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await browser.command("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params }, sessionId);
    await browser.command("Input.dispatchKeyEvent", { type: "keyUp", ...params }, sessionId);
    await settle();
  };
  const focusOutside = () => evaluate(`document.activeElement?.blur(); document.body.tabIndex = -1; document.body.focus(); true`);
  const shortcut = async (name, redo, prevented) => {
    const start = await evaluate("window.__refactorFeatureKeys.length");
    await key(redo ? "Z" : "z", "KeyZ", 90, redo ? 10 : 2);
    const events = await evaluate(`window.__refactorFeatureKeys.slice(${start})`);
    evidence.keys.push({ name, events });
    expect(`${name}：真实 Ctrl 快捷键事件`, events.map(({key, ctrl, shift, prevented, trusted}) =>
      ({key, ctrl, shift, prevented, trusted})), [{ key: "z", ctrl: true, shift: redo, prevented, trusted: true }]);
  };
  const enterText = async (selector, text) => {
    expect(`真实输入焦点：${selector}`, await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`), true);
    await key("a", "KeyA", 65, 2);
    await browser.command("Input.insertText", { text }, sessionId);
    await settle();
    expect(`真实输入内容：${selector}`, await evaluate(`document.activeElement.value`), text);
  };
  const undoButton = () => click('button[aria-label="撤销预览编辑"]');
  const redoButton = () => click('button[aria-label="重做预览编辑"]');
  const assertApproval = (name, approval, reviewer, manager, exporting, cloned = false) => {
    assert.ok(approval, `${name}：审批行未被实际捕获`);
    // cloneNode 不复制 option._value；克隆中的 bool 已序列化为字符串，打印/live 仍必须是真 bool。
    expect(`${name}：审批 select 数量及真实值`, approval.selects.map(({label, value, valueType}) =>
      ({label, value, valueType})), [
      { label: "审批部门", value: reviewer, valueType: "string" },
      { label: "总经理审核栏", value: cloned ? String(manager) : manager, valueType: cloned ? "string" : "boolean" },
    ]);
    expect(`${name}：独立审批文字预期`, approval.texts.map(item => item.text),
      [`${reviewer}：`, manager ? "总经理审核：" : ""]);
    expect(`${name}：导出文字显示规则`, approval.texts.map(item => item.display),
      [exporting ? "inline" : "none", exporting ? "inline" : "none"]);
    if (exporting) {
      expect(`${name}：导出 select 隐藏`, approval.selects.map(item => item.display), ["none", "none"]);
      expect(`${name}：实际可见审批文字`, approval.visibleText,
        `部门负责人：${reviewer}：${manager ? "总经理审核：" : ""}`);
    } else {
      expect(`${name}：工作区 select 可见`, approval.selects.every(item => item.display !== "none"), true);
    }
  };
  const printCheck = async (name, reviewer, manager) => {
    await browser.command("Emulation.setEmulatedMedia", { media: "print" }, sessionId);
    try {
      const printed = await evaluate(`(() => {
        const start = window.__refactorPrintCalls.length;
        window.__refactorModel().printCurrentPage();
        return {calls: window.__refactorPrintCalls.length - start, ...window.__refactorPrintCalls.at(-1)};
      })()`);
      evidence.prints.push({ name, ...printed });
      expect(`${name}：生产打印入口及 print 媒体`, { calls: printed.calls, printMedia: printed.printMedia },
        { calls: 1, printMedia: true });
      assertApproval(name, printed.approval, reviewer, manager, true);
    } finally {
      await browser.command("Emulation.setEmulatedMedia", { media: "screen" }, sessionId);
    }
    await settle();
    assertApproval(`${name}恢复屏幕`, await evaluate("window.__refactorApproval(document)"), reviewer, manager, false);
  };
  const exportCheck = async (name, expression, extension, expenseCount, reviewer, manager, expectedPages) => {
    signal.throwIfAborted();
    const start = await evaluate("window.__refactorDownloads.length");
    await evaluate(`(async () => {
      window.__refactorExportPhase = ${JSON.stringify(name)};
      try { await (${expression}); return true; } finally { window.__refactorExportPhase = null; }
    })()`);
    const downloads = await readDownloads(start);
    const entry = { name, files: [], reviewer, manager };
    evidence.exports.push(entry);
    // 先落盘实际字节，再断言内容；生产导出 catch 后没有文件也会使本测试明确失败。
    for (const [index, item] of downloads.entries()) {
      const bytes = Buffer.from(item.base64, "base64");
      const artifact = path.join(artifacts, `features-${name}-${index}${path.extname(item.name)}`);
      await fs.writeFile(artifact, bytes, { flag: "wx" });
      entry.files.push({ name: item.name, artifact, bytes: bytes.length, sha256: sha256(bytes) });
    }
    expect(`${name}：生成实际下载`, downloads.length, 1);
    expect(`${name}：下载文件类型`, path.extname(downloads[0].name), extension);
    assert.match(downloads[0].name, /^2026-01-01_/);
    const bytes = Buffer.from(downloads[0].base64, "base64");
    if (extension === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      expect(`${name}：Excel 工作表`, workbook.worksheets.map(sheet => sheet.name), ["报销单"]);
      const approvalRow = expenseCount + 7;
      const sheet = workbook.worksheets[0];
      entry.approvalText = sheet.getCell(`A${approvalRow}`).value;
      entry.approvalRowHeight = sheet.getRow(approvalRow).height;
      // 固定审批行预期，不从生产 getApprovalLine 或另一份导出推导。
      const expected = ["部门负责人：", `${reviewer}：`, ...(manager ? ["总经理审核："] : [])].join(" ".repeat(25));
      expect(`${name}：实际 Excel 审批行`, entry.approvalText, expected);
      expect(`${name}：Excel 审批行高`, entry.approvalRowHeight, 36);
      if (reviewer === "秘书处" && !manager) assert.doesNotMatch(entry.approvalText, /财务|总经理审核/);
    } else {
      assert.match(bytes.toString("latin1", 0, 8), /^%PDF-/);
      entry.actualPages = (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
      entry.expectedPages = expectedPages;
      expect(`${name}：实际 PDF 页数`, entry.actualPages, expectedPages);
      entry.hosts = await evaluate(`window.__refactorCaptureHosts.filter(item => item.phase === ${JSON.stringify(name)})`);
      entry.canvases = await evaluate(`window.__refactorCaptureCanvases.filter(item => item.phase === ${JSON.stringify(name)} && item.type === 'image/jpeg')`);
      expect(`${name}：实际绘制克隆数量`, entry.hosts.length, expectedPages);
      expect(`${name}：捕获时克隆连接到导出 host`, entry.hosts.every(item => item.stage === "before-paint" && item.connected && item.exporting), true);
      expect(`${name}：PDF 导出期间撤销/重做按钮禁用`, entry.hosts.map(({pdfBusy, undoDisabled, redoDisabled}) =>
        ({pdfBusy, undoDisabled, redoDisabled})), Array.from({length: expectedPages}, () =>
        ({pdfBusy: true, undoDisabled: true, redoDisabled: true})));
      const approvals = entry.hosts.filter(item => item.approval);
      expect(`${name}：PDF 捕获包含最终审批行`, approvals.length, 1);
      for (const item of approvals) assertApproval(`${name}绘制`, item.approval, reviewer, manager, true, true);
      expect(`${name}：实际 JPEG 绘制数量`, entry.canvases.length, expectedPages);
      for (const canvas of entry.canvases) {
        expect(`${name}：A4 实际画布尺寸`, [canvas.width, canvas.height], [1588, 2246]);
        assert.ok(canvas.nonWhite > 20, `${name}：实际 PDF 画布为空白，${JSON.stringify(canvas)}`);
      }
    }
    console.log(`features 已验证导出：${name}；产物：${entry.files[0].artifact}`);
  };

  await browser.command("Page.addScriptToEvaluateOnNewDocument", { source: featureProbe }, sessionId);
  await evaluate(featureProbe);
  expect("features 使用工作区源码", diagnostics.source.type, "workspace");
  expect("预览 undo/redo 接线", await evaluate(`(() => {
    const s = window.__refactorModel();
    return ['undoPreviewEdit', 'redoPreviewEdit', 'resetPreviewHistory', 'enableManualTotal',
      'commitManualTotal', 'restoreAutomaticTotal', 'withTemporaryDraft'].map(name => typeof s[name]);
  })()`), Array(7).fill("function"));
  const legacyId = "record-features-legacy";
  const editableId = "record-features-editable";
  const legacyFixture = { ...draftFixture(1, 2), id: legacyId };
  assert.ok(!("financeReviewer" in legacyFixture) && !("showManagerApproval" in legacyFixture), "旧 Draft 样例不应预先填入新字段");
  await evaluate(`window.__refactorModel().applyDraft(${JSON.stringify(legacyFixture)}); window.__refactorWaitForPreview()`);
  const initial = await state();
  expect("旧 Draft 默认审批与金额", { reviewer: initial.financeReviewer, manager: initial.showManagerApproval,
    calculated: initial.calculatedTotal, effective: initial.effectiveTotal },
  { reviewer: "财务", manager: true, calculated: 12345, effective: 12345 });
  await assertHistoryFlags("旧 Draft 初始清栈", false, false);
  await assertWorkbenchRefs("features-legacy-default");
  assertApproval("旧 Draft 屏幕审批", await evaluate("window.__refactorApproval(document)"), "财务", true, false);
  await printCheck("legacy-default-print", "财务", true);
  await exportCheck("legacy-default-excel", "window.__refactorModel().exportExcel()", ".xlsx", 1, "财务", true);
  expect("默认历史单确实保存", await evaluate(`window.__refactorModel().historyRecords.some(item => item.id === ${JSON.stringify(legacyId)} && item.draft.financeReviewer === '财务' && item.draft.showManagerApproval === true)`), true);

  await evaluate(`window.__refactorModel().applyDraft(${JSON.stringify({ ...legacyFixture, id: editableId })}); window.__refactorWaitForPreview()`);
  const originalLayout = await layout();
  await selectApproval("审批部门", "秘书处");
  await selectApproval("总经理审核栏", false);
  expect("切换秘书处和隐藏经理保持所有行高/页数", await layout(), originalLayout);
  assertApproval("秘书处隐藏经理屏幕审批", await evaluate("window.__refactorApproval(document)"), "秘书处", false, false);
  await undoButton();
  expect("按钮撤销 bool 审批选择", (await state()).showManagerApproval, true);
  await redoButton();
  expect("按钮重做 bool 审批选择", (await state()).showManagerApproval, false);
  expect("审批 undo/redo 保持行高/页数", await layout(), originalLayout);

  // 三个桌面宽度独立断言；截图只证明当前功能和稳定/非白图，不与旧版 golden 对照。
  for (const [width, height] of [[1440, 1000], [1280, 900], [1180, 900]]) {
    await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate("window.__refactorWaitForPreview()");
    // 全窗截图包含顶栏；导出成功提示自动消失后再采集，避免提示计时污染稳定 SHA。
    expect(`${width}：临时提示已在有界窗口内结束`, await evaluate(`(async () => {
      const start = performance.now();
      while (document.querySelector('.el-message')) {
        if (performance.now() - start >= 4000) return false;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return true;
    })()`), true);
    await assertWorkbenchRefs(`features-${width}`);
    const icons = await evaluate(`(async () => {
      if (document.querySelector('.brand-block, .brand-mark')) throw new Error('顶栏品牌块应已移除');
      const topbar = document.querySelector('header.topbar');
      if (topbar?.firstElementChild?.tagName !== 'NAV') throw new Error('主导航应位于顶栏左侧');
      const favicon = document.querySelector('link[rel="icon"]');
      if (!favicon) throw new Error('favicon 未挂载');
      const faviconImage = new Image(); faviconImage.src = favicon.href; await faviconImage.decode();
      return { faviconPath: new URL(favicon.href).pathname,
        faviconWidth: faviconImage.naturalWidth, faviconHeight: faviconImage.naturalHeight,
        viewportWidth: innerWidth, minWidth: getComputedStyle(document.body).minWidth };
    })()`);
    expect(`${width}：favicon 路径`, icons.faviconPath, "/app-icon.png");
    expect(`${width}：桌面视口宽度`, icons.viewportWidth, width);
    assert.ok(icons.faviconWidth > 0 && icons.faviconHeight > 0,
      `${width}：图标实际解码尺寸必须大于零`);
    // 顶栏为两列网格：导航靠左完整显示，操作区靠右，二者不重叠。
    const topbarLayout = await evaluate(`(() => {
      const tabs = document.querySelector('nav.main-tabs');
      const actions = document.querySelector('.topbar-actions');
      if (!(tabs instanceof HTMLElement) || !(actions instanceof HTMLElement)) throw new Error('顶栏结构缺失');
      const tabsRect = tabs.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const tabRects = [...tabs.querySelectorAll('.main-tab')].map(tab => tab.getBoundingClientRect());
      return {
        tabsLeft: tabsRect.left,
        actionsRight: actionsRect.right,
        overlap: tabRects.some(rect => rect.right > actionsRect.left + 1),
        tabsFullyVisible: tabRects.every(rect => rect.width >= 40 && rect.height >= 20 && rect.right <= innerWidth && rect.left >= 0),
      };
    })()`);
    expect(`${width}：主标签完整显示`, topbarLayout.tabsFullyVisible, true);
    expect(`${width}：主标签区靠左`, topbarLayout.tabsLeft <= 40, true);
    expect(`${width}：操作区靠右`, topbarLayout.actionsRight >= width - 40, true);
    expect(`${width}：标签与操作区不重叠`, topbarLayout.overlap, false);
    assertApproval(`${width}工作区审批`, await evaluate("window.__refactorApproval(document)"), "秘书处", false, false);
    const capture = async () => (await browser.command("Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false,
    }, sessionId)).data;
    const first = await capture();
    const file = path.join(artifacts, `features-secretary-hidden-${width}.png`);
    await fs.writeFile(file, Buffer.from(first, "base64"), { flag: "wx" });
    await delay(250, undefined, { signal });
    const second = await capture();
    await fs.writeFile(path.join(artifacts, `features-secretary-hidden-${width}-stability.png`), Buffer.from(second, "base64"), { flag: "wx" });
    const pixels = await evaluate(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,' + ${JSON.stringify(first)}; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = Math.round(image.height * 320 / image.width);
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonWhite = 0;
      for (let index = 0; index < values.length; index += 4) {
        if (values[index + 3] && Math.min(values[index], values[index + 1], values[index + 2]) < 245) nonWhite += 1;
      }
      return {width: image.naturalWidth, height: image.naturalHeight, sampledPixels: values.length / 4, nonWhite};
    })()`);
    const check = { name: `features-${width}`, file, width, height, icons, pixels,
      first: sha256(Buffer.from(first, "base64")), second: sha256(Buffer.from(second, "base64")), gapMs: 250 };
    evidence.screenshots.push(check);
    diagnostics.screenshotChecks.push(check);
    expect(`${width}：实际截图尺寸`, [pixels.width, pixels.height], [width, height]);
    assert.ok(pixels.nonWhite > 100, `${width}：截图为空白，${JSON.stringify(pixels)}`);
    expect(`${width}：当前功能截图稳定`, check.second, check.first);
  }
  await browser.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evaluate("window.__refactorWaitForPreview()");

  await click('.paper-meta .meta-cell:nth-child(2) button.paper-editable');
  expect("真实点击申请人进入编辑器", (await state()).editingKey, "applicant");
  const beforeNativeUndo = await state();
  await enterText('.paper-meta input.paper-edit-input', "原生输入撤销探针");
  await shortcut("申请人编辑器保留原生撤销", false, false);
  await shortcut("申请人编辑器保留原生重做", true, false);
  expect("编辑器内快捷键不改预览栈或草稿", await state(), beforeNativeUndo);
  await enterText('.paper-meta input.paper-edit-input', "功能申请人");
  await key("Enter", "Enter", 13);
  expect("真实输入 Enter 提交申请人", [(await state()).applicant, (await state()).editingKey], ["功能申请人", null]);
  await undoButton();
  expect("按钮撤销申请人编辑", (await state()).applicant, "测试申请人");
  await redoButton();
  expect("按钮重做申请人编辑", (await state()).applicant, "功能申请人");
  await focusOutside();
  await shortcut("Ctrl+Z 恢复申请人", false, true);
  expect("真实 Ctrl+Z 还原字段", (await state()).applicant, "测试申请人");
  await shortcut("Ctrl+Shift+Z 重做申请人", true, true);
  expect("真实 Ctrl+Shift+Z 恢复字段", (await state()).applicant, "功能申请人");

  await click('.paper-table tr[data-expense-id="expense-0"] td:nth-child(6)');
  expect("真实点击 td 进入金额编辑器", (await state()).editingKey, "expense:expense-0:amountCents");
  await enterText('.paper-cell-input.amount-input', "=200+3.45");
  await click('.paper-title');
  expect("真实输入 blur 提交费用金额", [(await state()).amount, (await state()).effectiveTotal], [20345, 20345]);
  await undoButton();
  expect("撤销费用金额", (await state()).amount, 12345);
  await redoButton();
  expect("重做费用金额", (await state()).amount, 20345);

  await click('button.paper-editable.total-number');
  expect("人工合计初始值", (await state()).totalOverrideCents, 20345);
  await click('input.total-number');
  await enterText('input.total-number', "456.78");
  expect("人工合计尚未 blur/change 时草稿保留旧值", (await state()).totalOverrideCents, 20345);
  expect("人工合计直接撤销前仍在输入框内", await evaluate("document.activeElement?.matches('input.total-number')"), true);
  const manualChangeStart = await evaluate("window.__refactorManualChanges.length");
  // 不先 blur：真实 mousedown 必须触发原生 change，click 随后把这一条刚提交的总额撤销。
  await undoButton();
  evidence.manualChanges = await evaluate(`window.__refactorManualChanges.slice(${manualChangeStart})`);
  expect("真实鼠标直接撤销先触发原生 change", evidence.manualChanges, [{value: "456.78", trusted: true}]);
  expect("未 blur 的人工合计直接撤销恢复旧值", [(await state()).totalOverrideCents, (await state()).effectiveTotal], [20345, 20345]);
  await assertHistoryFlags("人工合计直接撤销已产生可重做命令", true, true);
  expect("人工合计直接撤销的重做标签", (await state()).redoLabel, "人工合计");
  await redoButton();
  expect("真实鼠标重做得到刚输入的新值", [(await state()).totalOverrideCents, (await state()).effectiveTotal], [45678, 45678]);
  await undoButton();
  expect("人工合计值可撤销", (await state()).totalOverrideCents, 20345);
  await undoButton();
  expect("人工合计开关可撤销回自动", [(await state()).totalOverrideCents, (await state()).effectiveTotal], [null, 20345]);
  await redoButton();
  await redoButton();
  expect("人工合计两步重做", (await state()).totalOverrideCents, 45678);
  await undoButton();
  await assertHistoryFlags("设置/临时导出前 undo 和 redo 均非空", true, true);

  await click('.main-tabs button', "设置");
  await focusOutside();
  const settingsBefore = await state();
  expect("已切换设置页", await evaluate("window.__refactorModel().activeTab"), "settings");
  await shortcut("设置 tab 不接管 Ctrl+Z", false, false);
  await shortcut("设置 tab 不接管 Ctrl+Shift+Z", true, false);
  expect("设置页直接 undo/redo 立即返回 false", await evaluate(`(() => {
    const s = window.__refactorModel(); return [s.undoPreviewEdit(), s.redoPreviewEdit()];
  })()`), [false, false]);
  expect("设置页快捷键及函数调用保留字段与两个栈", await state(), settingsBefore);
  await click('.main-tabs button', "报销");
  await evaluate("window.__refactorWaitForPreview()");

  // 历史源使用另一张默认审批单；通过实际历史导出入口调用 withTemporaryDraft，验证两个栈和当前工作区完整恢复。
  await click('.main-tabs button', "历史记录");
  const temporarySnapshot = () => evaluate(`(() => {
    const s = window.__refactorModel();
    return {draft: s.cloneDraft(), activeTab: s.activeTab, selectedId: s.selectedId,
      selectedAttachmentId: s.selectedAttachmentId, undo: s.canUndoPreview, redo: s.canRedoPreview,
      undoLabel: s.undoPreviewLabel, redoLabel: s.redoPreviewLabel,
      suppressed: s.getSuppressAutoSave(), saved: localStorage.getItem('sheepfinance:workbench:v1'),
      history: localStorage.getItem('sheepfinance:history:v1')};
  })()`);
  const beforeTemporary = await temporarySnapshot();
  expect("临时历史导出前两个栈确实非空", [beforeTemporary.undo, beforeTemporary.redo], [true, true]);
  await exportCheck("temporary-history-excel", `window.__refactorModel().exportHistoryExcel(window.__refactorModel().historyRecords.find(item => item.id === ${JSON.stringify(legacyId)}))`, ".xlsx", 1, "财务", true);
  expect("withTemporaryDraft 恢复草稿/页签/选择/存储及两个预览栈", await temporarySnapshot(), beforeTemporary);
  const suppressed = await evaluate(`(async () => {
    const s = window.__refactorModel();
    const source = s.cloneDraft(s.historyRecords.find(item => item.id === ${JSON.stringify(legacyId)}).draft);
    return await s.withTemporaryDraft(source, async () => {
      const flags = () => ({undo: s.canUndoPreview, redo: s.canRedoPreview, undoLabel: s.undoPreviewLabel, redoLabel: s.redoPreviewLabel});
      const before = flags();
      const results = [s.undoPreviewEdit(), s.redoPreviewEdit()];
      return {activeTab: s.activeTab, suppressed: s.getSuppressAutoSave(), id: s.draft.id, before, results, after: flags()};
    });
  })()`);
  evidence.suppressedCallback = suppressed;
  expect("临时 callback 正在报销页且 suppressed", [suppressed.activeTab, suppressed.suppressed, suppressed.id],
    ["reimbursement", true, legacyId]);
  expect("临时 callback 直接 undo/redo 立即返回 false", suppressed.results, [false, false]);
  expect("临时 callback 带入原 undo/redo 栈", suppressed.before, {
    undo: beforeTemporary.undo, redo: beforeTemporary.redo,
    undoLabel: beforeTemporary.undoLabel, redoLabel: beforeTemporary.redoLabel,
  });
  expect("临时 callback 的原栈不丢失", suppressed.after, suppressed.before);
  expect("临时 callback 结束完整恢复原工作区和栈", await temporarySnapshot(), beforeTemporary);
  await click('.main-tabs button', "报销");
  await settle();
  await redoButton();
  expect("临时历史导出后 redo 仍实际生效", (await state()).totalOverrideCents, 45678);
  await undoButton();
  await undoButton();
  expect("临时历史导出后 undo 命令仍实际生效", (await state()).totalOverrideCents, null);
  await redoButton();
  await redoButton();
  expect("临时历史导出后两步重做恢复人工合计", (await state()).totalOverrideCents, 45678);

  await printCheck("secretary-hidden-print", "秘书处", false);
  await exportCheck("secretary-hidden-excel", "window.__refactorModel().exportExcel()", ".xlsx", 1, "秘书处", false);
  await click('.topbar-actions button', "保存");
  const saved = await evaluate(`(() => {
    const draft = JSON.parse(localStorage.getItem('sheepfinance:workbench:v1'));
    const history = JSON.parse(localStorage.getItem('sheepfinance:history:v1'));
    return {draft, historyDraft: history.find(item => item.id === draft.id)?.draft};
  })()`);
  const persistedFields = draft => ({ applicant: draft.applicant, reviewer: draft.financeReviewer,
    manager: draft.showManagerApproval, total: draft.totalOverrideCents, amount: draft.expenses[0].amountCents,
    attachments: draft.expenses[0].extraAttachments.length });
  const expectedFields = { applicant: "功能申请人", reviewer: "秘书处", manager: false, total: 45678, amount: 20345, attachments: 2 };
  expect("保存 localStorage 保留功能字段", persistedFields(saved.draft), expectedFields);
  expect("历史草稿持久化保留功能字段", persistedFields(saved.historyDraft), expectedFields);
  const previousTimeOrigin = await evaluate("performance.timeOrigin");
  await browser.command("Page.reload", {}, sessionId);
  await waitForWorkspace(browser, sessionId, signal, previousTimeOrigin);
  await evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style>'); window.__refactorWaitForPreview()`);
  const reloaded = await evaluate("window.__refactorModel().cloneDraft()");
  expect("实际 reload 保留功能字段", persistedFields(reloaded), expectedFields);
  await assertHistoryFlags("reload 清空临时编辑栈", false, false);
  assertApproval("reload 后审批", await evaluate("window.__refactorApproval(document)"), "秘书处", false, false);

  await evaluate(`(async () => {
    const s = window.__refactorModel(); s.switchTab('history');
    const item = s.historyRecords.find(item => item.id === ${JSON.stringify(editableId)});
    if (!item) throw new Error('保存后的历史单缺失');
    await s.openHistoryPreview(item); return true;
  })()`);
  // CDP 按值传输 Vue Proxy 时不会枚举其字段；先在浏览器中序列化真实历史草稿。
  const historyPreview = await evaluate("JSON.parse(JSON.stringify(window.__refactorModel().historyPreviewDraft))");
  assert.ok(historyPreview, "历史单预览加载失败");
  expect("实际历史预览保留功能字段", persistedFields(historyPreview), expectedFields);
  await click('.el-dialog__footer button', "以此为模板新建");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await evaluate(`window.__refactorModel().draft.id !== ${JSON.stringify(editableId)} && window.__refactorModel().activeTab === 'reimbursement'`)) break;
    await delay(100, undefined, { signal });
  }
  const copied = await evaluate("window.__refactorModel().cloneDraft()");
  assert.notEqual(copied.id, editableId, "历史复制必须创建新的单据 ID");
  expect("历史复制后的功能字段保留", persistedFields(copied), expectedFields);
  await assertHistoryFlags("历史复制清空预览栈", false, false);
  await selectApproval("总经理审核栏", true);
  await selectApproval("审批部门", "财务");
  await undoButton();
  await assertHistoryFlags("切单前两个栈确实非空", true, true);
  await evaluate(`(async () => {
    const s = window.__refactorModel();
    await s.editHistory(s.historyRecords.find(item => item.id === ${JSON.stringify(editableId)})); return true;
  })()`);
  expect("切回原历史单恢复独立字段", persistedFields(await evaluate("window.__refactorModel().cloneDraft()")), expectedFields);
  expect("实际切换原历史单 ID", (await state()).id, editableId);
  await assertHistoryFlags("切单同时清空 undo/redo 栈", false, false);

  const longFixture = { ...draftFixture(10, 2, "single", true), id: "record-features-multipage" };
  await evaluate(`window.__refactorModel().applyDraft(${JSON.stringify(longFixture)}); window.__refactorWaitForPreview()`);
  const longLayout = await layout();
  assert.ok(longLayout.pageCount > 2, "features 多页 PDF 样例必须大于 2 页");
  expect("多页 PDF 的 DOM 与模型页数", longLayout.domPages, longLayout.pageCount);
  await selectApproval("审批部门", "秘书处");
  await selectApproval("总经理审核栏", false);
  await selectApproval("审批部门", "财务");
  await undoButton();
  await assertHistoryFlags("PDF 导出前两个工具栏按钮均可用", true, true);
  expect("多页单切换审批保持所有行高/页数", await layout(), longLayout);
  await assertWorkbenchRefs("features-multipage");
  await exportCheck("secretary-hidden-multipage-pdf", "window.__refactorModel().exportPdf()", ".pdf", 10,
    "秘书处", false, longLayout.pageCount);
  await settle();
  await assertHistoryFlags("PDF 导出结束两个工具栏按钮恢复可用", true, true);
  await fs.writeFile(path.join(artifacts, "features.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
}

// 每次使用新端口、新 profile 和新缓存；只测试浏览器存储，禁止调用真实识别服务。
test("隔离浏览器中的工作台、分页、历史与导出保持兼容", { timeout: 90000 }, async (t) => {
  assert.ok(["baseline", "compare", "features"].includes(mode), `未知浏览器验证模式：${mode}`);
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, `${mode}-`));
  const profile = path.join(artifacts, "chrome-profile");
  const cacheDir = path.join(artifacts, "vite-cache");
  await fs.mkdir(profile);
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(80000)]);
  const inheritedNodeEnv = process.env.NODE_ENV;
  const diagnostics = { mode, artifacts, profile, cacheDir, node: process.version,
    undici: process.versions.undici, inheritedNodeEnv: inheritedNodeEnv ?? null,
    fixedTime: fixtureTime, timezone: "Asia/Shanghai",
    randomSeed: 0x5eed, screenshotChecks: [], refChecks: [], blockedRequests: [], events: [] };
  const record = (event) => diagnostics.events.push({ elapsedMs: performance.now() - started, ...event });
  const started = performance.now();
  let server;
  let portReservation;
  let browserProcess;
  let browser;
  let chromeStderr = "";
  let failure;
  const browserPath = process.env.SHEEPFINANCE_TEST_BROWSER ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe";
  console.log(`隔离产物：${artifacts}；profile：${profile}；缓存：${cacheDir}`);
  // 最后一道有界退出保护，正常和失败路径都先执行 finally 中的 Chrome/Vite 回收。
  const watchdog = setTimeout(() => {
    browser?.dispose();
    void fs.writeFile(path.join(artifacts, "watchdog.json"), JSON.stringify(diagnostics, null, 2) + "\n")
      .finally(async () => {
        await stopChrome(browserProcess, profile).catch(() => browserProcess?.kill());
        process.exit(1);
      });
  }, 90000);
  try {
    const selection = await sourceSelection(signal);
    diagnostics.source = selection.metadata;
    // 宿主可能继承 NODE_ENV=production；生产 Vue 不提供本测试依赖的 root setupState。
    process.env.NODE_ENV = "development";
    diagnostics.viteNodeEnv = process.env.NODE_ENV;
    // Vite 6 的 port:0 会回退到 5173；先保留系统分配的正数端口，启动前释放，抢占时 strictPort 直接失败。
    portReservation = createPortServer();
    await bounded(new Promise((resolve, reject) => {
      portReservation.once("error", reject);
      portReservation.listen(0, "127.0.0.1", resolve);
    }), 2000, "隔离 Vite 端口分配超时");
    const vitePort = portReservation.address().port;
    server = await bounded(createServer({
      root: appRoot, configFile: false, cacheDir,
      plugins: [...selection.plugins, vue()], logLevel: "error",
      // 不扫描正在重构的工作区 App，也不因运行中的依赖发现触发重载。
      optimizeDeps: { entries: [], noDiscovery: true, include: [
        "vue", "element-plus", "element-plus/es/locale/lang/zh-cn", "@element-plus/icons-vue",
        "@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/plugin-dialog",
        "@tauri-apps/plugin-fs", "@tauri-apps/plugin-opener", "exceljs", "html2canvas",
        "jspdf", "qrcode", "canvg", "dompurify",
      ] },
      server: { host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false, ws: false, watch: null },
    }), 20000, "隔离 Vite 创建超时");
    await bounded(new Promise((resolve, reject) => portReservation.close(error => error ? reject(error) : resolve())),
      1000, "隔离 Vite 端口保留结束超时");
    portReservation = null;
    await bounded(server.listen(), 20000, "隔离 Vite 启动超时");
    signal.throwIfAborted();
    const appUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
    diagnostics.appUrl = appUrl;
    console.log(`已启动隔离 Vite：${appUrl}；源码：${selection.metadata.type}`);
    browserProcess = spawn(browserPath, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-extensions",
      "--window-size=1440,1000", "--force-device-scale-factor=1", "--lang=zh-CN",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    diagnostics.chromePid = browserProcess.pid;
    browserProcess.stderr.on("data", (data) => { chromeStderr += data.toString(); });
    browserProcess.on("error", (error) => { record({ event: "chrome-error", error: error.message }); browser?.fail(error); });
    browserProcess.on("exit", (code, exitSignal) => {
      record({ event: "chrome-exit", code, signal: exitSignal });
      browser?.fail(new Error(`本次 Chrome 已退出：${code ?? exitSignal}`));
    });
    browser = await connectBrowser(profile, browserProcess, { signal, record });
    diagnostics.chrome = browser.metadata;
    console.log(`已核验隔离 Chrome：端口 ${browser.metadata.port}，PID ${browserProcess.pid}`);
    const { targetId } = await browser.command("Target.createTarget", { url: "about:blank" });
    const { targetInfo } = await browser.command("Target.getTargetInfo", { targetId });
    assert.equal(targetInfo.targetId, targetId);
    assert.equal(targetInfo.type, "page");
    assert.equal(targetInfo.url, "about:blank");
    const { sessionId } = await browser.command("Target.attachToTarget", { targetId, flatten: true });
    diagnostics.target = { targetId, sessionId };
    await browser.command("Page.enable", {}, sessionId);
    await browser.command("Network.enable", {}, sessionId);
    await browser.command("Runtime.enable", {}, sessionId);
    browser.onEvent = async (message) => {
      if (message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      const url = new URL(request.url);
      const allowed = url.origin === appUrl && ["GET", "HEAD"].includes(request.method);
      if (!allowed) diagnostics.blockedRequests.push({ url: request.url, method: request.method });
      await browser.command(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }, sessionId);
    };
    await browser.command("Fetch.enable", { patterns: [{ urlPattern: "http*" }] }, sessionId);
    await browser.command("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await browser.command("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" }, sessionId);
    await browser.command("Emulation.setLocaleOverride", { locale: "zh-CN" }, sessionId);
    await browser.command("Page.addScriptToEvaluateOnNewDocument", { source: `
      const NativeDate = Date;
      const epoch = ${Date.parse(fixtureTime)};
      window.Date = new Proxy(NativeDate, {
        apply: () => new NativeDate(epoch).toString(),
        construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [epoch], newTarget),
        get: (target, key, receiver) => key === 'now' ? () => epoch : Reflect.get(target, key, receiver),
      });
      let seed = 0x5eed;
      Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 0x100000000; };
      window.__refactorDownloads = [];
      const objectUrl = URL.createObjectURL.bind(URL);
      const blobs = new Map();
      URL.createObjectURL = (blob) => { const url = objectUrl(blob); blobs.set(url, blob); return url; };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && blobs.has(this.href)) {
          window.__refactorDownloads.push({name: this.download, blob: blobs.get(this.href)});
          return;
        }
        return click.call(this);
      };
      window.__refactorModel = () => {
        const setup = document.querySelector('#app').__vue_app__._instance.setupState;
        const model = setup.workbench ?? setup;
        return new Proxy(model, { get(target, key) {
          const value = target[key];
          return value?.__v_isRef ? value.value : value;
        }, set(target, key, value) {
          if (target[key]?.__v_isRef) target[key].value = value;
          else target[key] = value;
          return true;
        } });
      };
      window.__refactorWaitForPreview = async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await document.fonts.ready;
        const root = document.querySelector('.preview-panel');
        if (!root) throw new Error('预览面板未挂载');
        root.scrollTop = 0; root.scrollLeft = 0; window.scrollTo(0, 0);
        const begin = performance.now();
        let previous = ''; let stableSince = begin;
        while (performance.now() - begin < 6000) {
          const images = [...root.querySelectorAll('img')];
          await Promise.all(images.map(image => image.decode()));
          if (images.some(image => !image.complete || !image.naturalWidth)) throw new Error('预览图片未成功解码');
          const rect = element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
          const s = window.__refactorModel();
          const signature = JSON.stringify({ rect: rect(root), text: root.innerText,
            pages: [...root.querySelectorAll('[data-export-page]')].map(rect),
            images: images.map(image => [image.currentSrc, ...rect(image)]),
            saving: s.saveTimer != null, saved: s.isSaved });
          const now = performance.now();
          if (signature !== previous) { previous = signature; stableSince = now; }
          // 跨过旧版 900ms 自动保存，并连续稳定 500ms，不能把两帧误当成图片和布局就绪。
          if (now - begin >= 1200 && now - stableSince >= 500 && s.saveTimer == null) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('预览未在 6 秒内进入稳定窗口');
      };
    ` }, sessionId);
    await browser.command("Page.navigate", { url: appUrl }, sessionId);
    await waitForWorkspace(browser, sessionId, signal);
    if (mode === "baseline") {
      assert.ok(selection.metadata.loads > 0, "旧版 SFC 未经过内存 load");
      assert.ok(selection.metadata.indexLoads > 0, "旧版 HTML 未经过 Vite transformIndexHtml");
    }
    assert.equal(await browser.evaluate(`'__TAURI_INTERNALS__' in window`, sessionId), false);
    assert.equal(await browser.evaluate(`Date.now()`, sessionId), Date.parse(fixtureTime));
    await browser.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style>'); document.fonts.ready.then(() => true)`, sessionId);
    console.log("浏览器工作区加载完成");

    const assertWorkbenchRefs = async (name) => {
      const refs = await browser.evaluate(`(() => {
        const s = window.__refactorModel();
        return Object.fromEntries([
          ['fileInput', '.upload-panel input.hidden-file[type="file"]'],
          ['uploadZone', 'section.upload-panel'],
          ['previewViewport', 'section.preview-panel'],
        ].map(([key, selector]) => {
          const element = s[key];
          return [key, {
            isElement: element instanceof (key === 'fileInput' ? HTMLInputElement : HTMLElement),
            connected: Boolean(element?.isConnected && element.ownerDocument === document && document.contains(element)),
            matchesTemplate: element === document.querySelector(selector),
          }];
        }));
      })()`, sessionId);
      diagnostics.refChecks.push({ name, refs });
      for (const [key, check] of Object.entries(refs)) {
        assert.deepEqual(check, { isElement: true, connected: true, matchesTemplate: true },
          `样例 ${name} 的共享 ${key} 未连接到正确模板元素`);
      }
    };
    const readDownloads = (start = 0) => browser.evaluate(`Promise.all(window.__refactorDownloads.slice(${start}).map(async ({name,blob}) => { const bytes=new Uint8Array(await blob.arrayBuffer()); let binary=''; for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return {name,base64:btoa(binary)}; }))`, sessionId);
    if (mode === "features") {
      await runFeatureChecks({ browser, sessionId, signal, artifacts, diagnostics, readDownloads, assertWorkbenchRefs });
      assert.deepEqual(diagnostics.blockedRequests, [], "浏览器尝试访问非本次 Vite 的网络或真实接口");
      assert.deepEqual(browser.errors, [], "浏览器出现未捕获异常");
      console.log(`浏览器 features 验证通过：审批、真实编辑/快捷键、人工合计、保存/reload/历史复制、临时导出栈、图标、3 桌面截图及实际 Excel/PDF/print；产物：${artifacts}`);
      return;
    }
    const snapshots = [];
    const cases = [
      ["empty", draftFixture(0)], ["single", draftFixture(1, 2)],
      ["double", draftFixture(1, 2, "double")],
      ["thirty-images", draftFixture(10, 2)],
      ["long-multipage", draftFixture(10, 2, "single", true)],
      ["manual-total", { ...draftFixture(2), totalOverrideCents: 123456 }],
    ];
    for (const [name, fixture] of cases) {
      await browser.evaluate(`window.__refactorModel().applyDraft(${JSON.stringify(fixture)}); window.__refactorWaitForPreview()`, sessionId);
      await assertWorkbenchRefs(name);
      const snapshot = await browser.evaluate(`(() => {
        const s = window.__refactorModel();
        return {
          name: ${JSON.stringify(name)}, ids: s.draft.expenses.map(e => e.id),
          amounts: s.draft.expenses.map(e => e.amountCents),
          calculatedTotal: s.calculatedTotal, effectiveTotal: s.effectiveTotal,
          uppercase: s.ChineseAmount(s.effectiveTotal),
          rows: s.formPages.map(p => p.rows.map(r => ({id:r.expense.id,index:r.index,height:r.height}))),
          attachments: s.attachmentPages.map(p => p.map(a => ({id:a.id,label:a.label,isPrimary:a.isPrimary}))),
          shared: s.sharedAttachmentPage?.map(a => a.id) ?? null,
          separate: s.separateAttachmentPages.map(p => p.map(a => a.id)),
          pageCount: s.previewPageCount,
          domPages: document.querySelectorAll('[data-export-page]').length,
          paperText: [...document.querySelectorAll('[data-export-page]')].map(p => p.innerText),
        };
      })()`, sessionId);
      snapshots.push(snapshot);
      const clip = await browser.evaluate(`(() => { const r=document.querySelector('.preview-panel').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()`, sessionId);
      const capture = async () => Buffer.from((await browser.command("Page.captureScreenshot", {
        format: "png", clip, fromSurface: true, captureBeyondViewport: false,
      }, sessionId)).data, "base64");
      const png = await capture();
      await fs.writeFile(path.join(artifacts, `${mode}-${name}.png`), png, { flag: "wx" });
      await delay(250, undefined, { signal });
      const second = await capture();
      await fs.writeFile(path.join(artifacts, `${mode}-${name}-stability.png`), second, { flag: "wx" });
      snapshot.screenshotSha256 = sha256(png);
      diagnostics.screenshotChecks.push({ name, first: snapshot.screenshotSha256, second: sha256(second), gapMs: 250 });
      assert.equal(sha256(second), snapshot.screenshotSha256, `样例 ${name} 的截图 SHA 在稳定窗口内仍变化`);
      console.log(`已采集稳定样例：${name}`);
    }

    await browser.evaluate(`window.__refactorModel().applyDraft(${JSON.stringify(draftFixture(1, 2))}); window.__refactorWaitForPreview()`, sessionId);
    await browser.evaluate(`window.__refactorModel().exportExcel().then(()=>true)`, sessionId);
    await browser.evaluate(`window.__refactorModel().exportPdf().then(()=>true)`, sessionId);
    const downloads = await readDownloads();
    // 即使后续内容断言失败，也保留已生成的导出文件供定位。
    for (const [index, item] of downloads.entries()) {
      await fs.writeFile(path.join(artifacts, `${mode}-export-${index}${path.extname(item.name)}`),
        Buffer.from(item.base64, "base64"), { flag: "wx" });
    }
    assert.equal(downloads.length, 2, "Excel/PDF 应各生成一个文件");
    const workbook = new ExcelJS.Workbook();
    const excel = downloads.find(item => item.name.endsWith(".xlsx"));
    const pdf = downloads.find(item => item.name.endsWith(".pdf"));
    assert.ok(excel && pdf);
    assert.match(excel.name, /^2026-01-01_/);
    assert.match(pdf.name, /^2026-01-01_/);
    await workbook.xlsx.load(Buffer.from(excel.base64, "base64"));
    const exportSnapshot = {
      excel: workbook.worksheets.map(sheet => ({
        name: sheet.name, rows: sheet.getSheetValues(),
        merges: sheet.model.merges, pageSetup: sheet.pageSetup,
        images: sheet.getImages().map(item => {
          const point = (value) => value && typeof value === "object"
            ? { nativeCol: value.nativeCol, nativeRow: value.nativeRow,
                col: value.col, row: value.row, width: value.width, height: value.height }
            : value;
          const range = item.range ?? {};
          return { tl: point(range.tl), br: point(range.br), ext: point(range.ext) };
        }),
      })),
      pdfPages: (Buffer.from(pdf.base64, "base64").toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length,
    };
    console.log("已生成并解析 Excel/PDF");
    await browser.evaluate(`window.__refactorModel().saveDraft(); new Promise(resolve=>setTimeout(resolve,50))`, sessionId);
    const saved = await browser.evaluate(`JSON.parse(localStorage.getItem('sheepfinance:workbench:v1'))`, sessionId);
    assert.equal(saved.expenses.length, 1);
    assert.equal(saved.expenses[0].extraAttachments.length, 2);
    assert.equal(saved.expenses[0].manualFields.reason, true);
    await browser.evaluate(`window.__refactorModel().switchTab('history'); new Promise(resolve=>requestAnimationFrame(resolve))`, sessionId);
    const history = await browser.evaluate(`window.__refactorModel().historyFolders.map(f=>({label:f.label,count:f.count}))`, sessionId);
    const result = JSON.parse(JSON.stringify({ snapshots, exportSnapshot, history }));
    await fs.writeFile(path.join(artifacts, `${mode}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    if (mode === "compare") {
      const baselineFile = process.env.SHEEPFINANCE_REFACTOR_BASELINE ?? path.join(artifactsRoot, "baseline.json");
      const baseline = JSON.parse(await fs.readFile(baselineFile, "utf8"));
      assert.deepEqual(result, baseline, "重构结果与旧版浏览器基线不一致");
    }
    // 多页导出有独立业务预期；放在 golden 对照之后，避免保存副作用改变原有历史快照。
    const [, longFixture] = cases.find(([name]) => name === "long-multipage");
    await browser.evaluate(`window.__refactorModel().switchTab('reimbursement'); window.__refactorModel().applyDraft(${JSON.stringify(longFixture)}); window.__refactorWaitForPreview()`, sessionId);
    await assertWorkbenchRefs("long-multipage-remount");
    diagnostics.multiPdf = await browser.evaluate(`({
      fixture: 'long-multipage', expectedPages: window.__refactorModel().previewPageCount,
      domPages: document.querySelectorAll('[data-export-page]').length,
    })`, sessionId);
    assert.ok(diagnostics.multiPdf.expectedPages > 2, "多页 PDF 样例的模型页数必须大于 2");
    assert.equal(diagnostics.multiPdf.domPages, diagnostics.multiPdf.expectedPages,
      "多页 PDF 样例的 DOM 页数与模型不一致");
    const downloadStart = await browser.evaluate("window.__refactorDownloads.length", sessionId);
    await browser.evaluate(`window.__refactorModel().exportPdf().then(()=>true)`, sessionId);
    const longDownloads = await readDownloads(downloadStart);
    assert.equal(longDownloads.length, 1, "多页 PDF 应独立生成一个文件");
    assert.ok(longDownloads[0].name.endsWith(".pdf"), "多页导出未生成 PDF");
    const longPdfBytes = Buffer.from(longDownloads[0].base64, "base64");
    diagnostics.multiPdf.artifact = path.join(artifacts, `${mode}-long-multipage.pdf`);
    await fs.writeFile(diagnostics.multiPdf.artifact, longPdfBytes, { flag: "wx" });
    diagnostics.multiPdf.actualPages = (longPdfBytes.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
    assert.equal(diagnostics.multiPdf.actualPages, diagnostics.multiPdf.expectedPages,
      "多页 PDF 的实际页数与 DOM/模型预期不一致");
    console.log(`已验证多页 PDF：${diagnostics.multiPdf.actualPages} 页；产物：${diagnostics.multiPdf.artifact}`);
    assert.deepEqual(diagnostics.blockedRequests, [], "浏览器尝试访问非本次 Vite 的网络或真实接口");
    assert.deepEqual(browser.errors, [], "浏览器出现未捕获异常");
    console.log(`浏览器 ${mode} 验证通过：6 组单据、共享 refs、稳定截图、Excel/PDF、多页 PDF、保存及历史；产物：${artifacts}`);
  } catch (error) {
    failure = error;
    diagnostics.failure = error.stack ?? String(error);
    throw error;
  } finally {
    const cleanupErrors = [];
    if (portReservation?.listening) {
      await bounded(new Promise((resolve, reject) => portReservation.close(error => error ? reject(error) : resolve())),
        1000, "隔离端口关闭超时").catch(error => cleanupErrors.push(error.message));
    }
    if (browser) {
      await browser.command("Browser.close", {}, undefined, 1500).catch(error => record({ event: "browser-close", error: error.message }));
      browser.dispose();
    }
    await stopChrome(browserProcess, profile).catch(error => cleanupErrors.push(error.message));
    if (server) await bounded(server.close(), 2000, "隔离 Vite 关闭超时").catch(error => cleanupErrors.push(error.message));
    if (inheritedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = inheritedNodeEnv;
    diagnostics.runtimeErrors = browser?.errors ?? [];
    diagnostics.cleanupErrors = cleanupErrors;
    diagnostics.elapsedMs = performance.now() - started;
    diagnostics.status = failure || cleanupErrors.length ? "failed" : "passed";
    await fs.writeFile(path.join(artifacts, "chrome.stderr.log"), chromeStderr, { flag: "wx" });
    await fs.writeFile(path.join(artifacts, "diagnostics.json"), JSON.stringify(diagnostics, null, 2) + "\n", { flag: "wx" });
    clearTimeout(watchdog);
    console.log(`验证状态：${diagnostics.status}；诊断：${path.join(artifacts, "diagnostics.json")}`);
    // 保留全部独立 profile、依赖缓存和产物；不运行生产 build，不删除任何文件。
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join("；"));
  }
});
