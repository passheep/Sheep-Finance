# SheepFinance App

> 产品版本：0.3.0 · 文档更新：2026-10-10

> 软件显示名已改为【报销单助手】，内部包名和存储标识仍保留 `SheepFinance` / `com.sheepfinance.app` 以兼容既有数据。

桌面端使用 Vue 3 + TypeScript + Element Plus + Vite + Tauri 2 + Rust。Excel 由 ExcelJS 生成，PDF 使用 html2canvas + jsPDF，局域网二维码使用 QRCode。Konva 虽为现有依赖，当前预览和图片交互使用 DOM/CSS；不新增 Pinia、Router、测试框架或依赖，不改 `package.json`。

## 前端目录职责

以下是本轮模块化采用的职责边界，不代表拆分或验证已经完成；详细进度与证据见[代码重构计划](../文档/SheepFinance-代码重构计划.md)。

```text
src/
├─ App.vue          组合入口与页面装配
├─ types/           业务模型和数据/事件载荷类型
├─ constants/       兼容存储键、容量、分页及配置格式常量
├─ utils/           金额、格式化、分页等纯函数
├─ services/        按原 Tauri 命令边界封装的 typed API
├─ composables/     组合根、共享上下文和业务模块
├─ features/        工作台、历史、设置、关于等展示组件
├─ export/          Excel/PDF 导出实现与 useDocumentExport
├─ styles/          全局样式、工作台、页面及打印样式
├─ components/      共用展示组件，如 AttachmentSurface
└─ __tests__/       Node 内置 test 的既有回归入口
```

`useSheepFinanceApp` 位于 `composables/`，组合 12 个业务模块，并以 typed `provide/inject` 提供同一 root 业务状态。各 view 复用这份状态和 DOM refs，不复制主控 state，不在组件内重新创建业务模块；草稿、设置各有唯一所有者。

| 模块 | 职责 |
| --- | --- |
| `useWorkspace` | 草稿生命周期、存储初始化、保存修订与恢复门禁 |
| `useSettings` | 申请人资料、公司/事由/安排人字典、OCR/大模型配置 |
| `useExpenseEditing` | 表头、费用、金额表达式、人工总额、审批选项及人工确认；使用内部 `usePreviewHistory` 维护字段撤销/重做 |
| `useRecognition` | 主图识别、人工字段保护、异步版本与存在性检查 |
| `useAttachments` | 主/附图导入、容量、原图引用、排序与图片操作 |
| `useLanUpload` | 局域网会话、二维码、目标容量同步及失效 |
| `usePreview` | A4 分页、合图规则、视口与预览交互 |
| `useHistory` | 查询、稳定排序、筛选、打开与历史操作 |
| `useRequestLogs` | 请求记录列表、详情及清理入口 |
| `useBackups` | 备份状态、导入导出及恢复门禁交互 |
| `useConfigurationTransfer` | version 1 配置 TXT 导入导出 |
| `useDocumentExport`（`export/`） | Excel/PDF、打印及历史单据临时导出 |

`services/` 只封装原有 IO 契约，不拥有另一份草稿或设置，不改变命令名、序列化字段和错误语义。CSS 入口 `styles/app.css` 保留 `base.css → workbench.css → pages.css → print.css` 的拼接次序；图标、审批控件及打印输出的授权变化由测试逐项验证，其余样式仍与固定旧版对照。

## 不可改变的业务与存储边界

- 每单 10 笔费用、30 图，每笔主图和附图合计 10 图，只有主图识别。恢复费用仍限 10 笔，但附图恢复没有同样完整的容量截断；不能借模块化丢弃历史附图。
- A4 为 `794 × 1123`，动态费用行预算首表页 `785`、续表页 `816`；图片每组 6 张。`single` 仅在表格一页且余量不少于 `126` 时合入第一组，`double` 图片独立；均可超过两页。
- 金额表达式结果为整数分，允许负数和人工总额覆盖。新建公司名称、报销日期为空；识别前必须成功保存，回包依赖 `recognitionVersion` 和费用存在性二次检查，`manualFields` 保护人工字段。
- 保存保留 `900ms` 防抖、revision 比较以及 loading、`storageReady`、suppress 门禁。桌面历史按 `createdAt + ID` 稳定倒序，日期筛选看第一笔费用日期，不看报销日期或更新时间。
- 浏览器 `localStorage` 仅持久化历史列表前 20 项，是演示回退，不等同于桌面存储。局域网上传默认 15 分钟，需同步目标容量并在切单后失效。
- SQLite v3/11 表、存储键、27 个 Tauri commands、3 个 events、图片引用和备份格式保持兼容。Rust 原有 `database`、`storage_sql`、`attachments`、`recognition`、`lan_upload`、`request_log`、`backup` 已分域，本轮必要性评估不要求修改或重构 Rust。

数据默认位于 `%APPDATA%\com.sheepfinance.app`，以 runtime 实际返回目录为准。JSON/DB/ZIP 中现有凭据没有 DPAPI 保护；配置 TXT 使用固定内置 secret 的 AES-256-GCM/PBKDF2-SHA256（180000 次、version 1），不是用户密码保护。详细字段和恢复规则见[开发设计文档](../文档/SheepFinance-开发设计文档.md)。

## 检查入口

以下均从 `app/` 执行，复用已装 Node、TypeScript、Vue/Vite 工具；按改动选择最窄目标。实际通过数、产物和未验证范围见代码重构计划。

```bash
node --test src/__tests__/pure.test.mjs
node --test src/__tests__/views.test.mjs
node --test src/__tests__/business.test.mjs
node --test src/__tests__/preview-editing.test.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p tsconfig.json
```

- `pure.test.mjs`：金额、分页、类型和常量与固定旧提交的比较。
- `views.test.mjs`：展开组件后比对原 DOM/事件表达式、CSS 字节顺序及共享 DOM refs。
- `business.test.mjs`：保存门禁与版本、防抖、恢复、人工保护及识别异步结果，使用内存存储和 mock 服务。
- `preview-editing.test.mjs`：真实编辑与工作区模块的 100 步历史、输入事务、手工标记、重做分支、切单/冲突、快捷键焦点及审批默认/保存。
- `refactor.browser.test.mjs`：独立 Chrome profile、CDP、Vite 与 `localStorage` 的 baseline/compare，覆盖稳定截图、导出、保存和历史；compare 必须使用完整有效的旧版基线。新增功能使用 `features` 模式，按独立业务预期验证有意变化，旧截图基线不覆盖。

```bash
SHEEPFINANCE_REFACTOR_MODE=baseline node --test src/__tests__/refactor.browser.test.mjs
SHEEPFINANCE_REFACTOR_MODE=compare SHEEPFINANCE_REFACTOR_BASELINE='<baseline输出目录>/baseline.json' node --test src/__tests__/refactor.browser.test.mjs
SHEEPFINANCE_REFACTOR_MODE=features node --test src/__tests__/refactor.browser.test.mjs
```

compare 使用上一条实际输出的基线文件；可用 `SHEEPFINANCE_TEST_BROWSER` 指定独立 Chrome 可执行文件。测试保留隔离产物，不连接正式桌面数据或真实识别服务。

需要前端产物时使用保留现有输出的构建入口：

```bash
node --input-type=module -e 'import {build} from "vite"; await build({build:{emptyOutDir:false}})'
```

`vite.config.ts` 已设置 `build.emptyOutDir: false`，因此 `npm run build` 及 Tauri 的 `beforeBuildCommand` 也保留旧的哈希资源。NSIS 打包使用已授权的 `npm run tauri build`，不是每阶段必跑门禁；重建同名安装包前须另存旧包并核对哈希。旧 0.2.2 最终包（SheepFinance_0.2.2_x64-setup.exe，8,564,950 bytes，SHA-256 763b8eae322825baa897c30e29d6a8f2b17e88ad53a1fa21948811bb4c87f725）已另存保全。当前 0.3.0 最终包：`src-tauri/target/release/bundle/nsis/报销单助手_0.3.0_x64-setup.exe`，9,340,531 bytes，SHA-256 `01835f3931dadd78425bc6875cc5dfbc7f2d77ce61c0f8f6a9865b9bffc5232e`，未安装或启动。图标源为 `../文档/报销申请.png`，使用现有 Tauri CLI 生成 `src-tauri/icons/`；软件内和 favicon 读取 `public/app-icon.png`，NSIS 安装/卸载显式引用 `icons/icon.ico`。

## 验证安全与未完成项

正式数据目录不做测试。本轮不启动 Tauri、不触发备份/恢复/轮换或永久删除测试；桌面写入验证必须先准备数据库与引用图片的一致性隔离副本，并确认 runtime 实际指向该副本，不能只复制正在使用 WAL 的 `.db` 文件。

源码中的 54 个 Rust 测试只是测试数量，不是本轮通过结果。真实 OCR/大模型、WPS、干净 Win10、备份恢复/轮换、迁移一致性、安装升级均未在本轮验证；旧 0.1.x/0.2.2 包和历史检查不构成 0.3.0 发布证据。发布条件见[开发计划](../文档/SheepFinance-开发计划.md)。仓库和文档不得包含真实凭据、真实报销数据或导出的敏感备份。
