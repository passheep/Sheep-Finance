# SheepFinance 开发设计文档

> 文档版本：v0.3
>
> 产品版本：0.3.0
>
> 更新日期：2026-10-10
>
> 参考模板：`文档/参考报销单.xlsx`

本文记录当前业务与兼容契约，不沿用旧版“5 笔、单页、画布导出”的设想，也不把源码能力等同于本轮验收。本轮模块化详细进度和验证证据仅记录在[代码重构计划](SheepFinance-代码重构计划.md)；检查入口见[app/README.md](../app/README.md)，发布条件见[开发计划](SheepFinance-开发计划.md)。

## 1. 产品与业务边界

报销单助手（原 SheepFinance）是 Windows 本地制单工具，不是审批系统或 WPS 自动化程序。本机完成字段编辑、图片管理、历史归档及 Excel/PDF 导出，识别调用阿里云 OCR 和 OpenAI 兼容大模型；手机上传使用局域网。

| 规则 | 当前语义 |
| --- | --- |
| 费用数量 | 每单最多 10 笔；空白草稿可以保存，导出需要费用 |
| 图片容量 | 每单最多 30 图；每笔费用主图与附图合计最多 10 图 |
| 图片用途 | 一笔费用有一张主图及 `extraAttachments`；仅主图参与 OCR/大模型识别 |
| 恢复容量 | 费用归一化截取前 10 笔；附图恢复没有同样完整的 10/30 图截断，不能把导入限制套到历史恢复而丢图 |
| 金额 | 算术表达式支持括号、四则运算、负数，结果转为整数分；非法表达式不写入 |
| 总额 | `totalOverrideCents === null` 时自动合计，否则使用人工覆盖值；大写金额随最终总额生成 |
| 新建字段 | `companyName`、`reimbursementDate` 为空；恢复时已有空值也保留，不默认补公司或当天 |
| 默认资料 | 从唯一默认资料对象复制申请人、部门、收款资料，无默认对象时按现有逻辑回退首项；之后修改设置不回写历史快照 |
| 状态与标签 | 保留 `未报销`、`报销中`、`已报销` 及记录 `label` |

事由、安排人需要人工确认，不把识别候选或字典默认值直接当成已确认业务内容。费用及附图以稳定 ID 关联，数组顺序决定显示序号和排版顺序，不用数组下标匹配异步识别结果。

## 2. 模板与字段映射

ExcelJS 生成单工作表 `报销单`，表格列为 A:F，费用从第 4 行开始；合计、收款和审批行随费用数量移动，不再固定为 `A1:F10`。模板是视觉参考，不是 WPS 像素级打印承诺。

| 模板/导出位置 | 实际字段或来源 | 当前规则 |
| --- | --- | --- |
| `A1:F1` 标题 | `Draft.companyName` | 公司名称与“费用报销单”组合，新建为空 |
| `A2:C2` 报销日期 | `Draft.reimbursementDate` | 记录保留此字段；当前纸面/Excel 的日期栏只显示“报销日期：”，不自动填值 |
| `D2` 申请人 | `Draft.applicant` | 默认资料快照，可人工修改 |
| `E2` 所属部门 | `Draft.department` | 默认资料快照，可人工修改 |
| `F2` 附票据张数 | 主图与附图汇总 | 当前纸面/Excel 仍留空栏，没有持久化 `attachmentCount`，不能按费用数宣称自动填张数 |
| 费用 A 列：序号 | `expenses` 数组顺序 | 显示 `index + 1`，SQL 保存对应排序 |
| 费用 B 列：发生日期 | `Expense.occurredDate` | 识别或人工输入；历史日期筛选使用第一笔该值 |
| 费用 C 列：事由 | `Expense.reason` | OCR/AI 返回的 `reasonName` 映射为识别候选，实际值需人工确认 |
| 费用 D 列：说明 | `Expense.description` | 人工可改，换行影响动态行高 |
| 费用 E 列：安排人 | `Expense.arranger` | 人工确认，换行影响动态行高 |
| 费用 F 列：金额 | `Expense.amountCents` | 整数分持久化，Excel 数值为分除以 100 |
| 小写合计 | 派生自动合计、最终合计；`Draft.totalOverrideCents` | 自动模式写 `SUM` 及计算缓存；覆盖模式写最终数值 |
| 人民币大写 | `ChineseAmount(最终合计)` | 本地生成；Excel 写文本快照，不是随单元格变化的实时大写公式 |
| 收款信息 | `Draft.payeeName/account/bank` | 默认资料快照，可人工修改 |
| 审批区域 | `Draft.financeReviewer/showManagerApproval` | 部门负责人保留；财务/秘书处二选一，总经理审核可隐藏。旧数据缺字段时按“财务 + 显示”恢复 |

### 2.1 数据模型

- `Draft`：稳定 ID、标签、状态、表头/收款快照、人工总额、`previewMode`、`financeReviewer?: "财务" | "秘书处"`、`showManagerApproval?: boolean`、费用和更新时间。审批选项为单据级快照，保存在完整单据 JSON 中，不新增 SQL 列、迁移版本或备份格式。
- `Expense`：稳定 ID、主图/识别副本引用、日期/事由/说明/安排人/整数分金额、识别状态与结果、图片变换及附图数组。
- `ExtraAttachment`：稳定 ID、图片引用、尺寸和 `transform`，不独立识别。
- `recognizedFields` 保存最近识别候选及可选 `confidence/evidence`；当前值仍在费用字段上，`manualFields` 标记人工保护，不虚构逐字段 `recognizedValue/currentValue/isUserEdited` 模型或差异对比界面。
- 图片变换保留位置、尺寸、旋转、裁剪缩放与中心；原图不被预览取景覆盖。

### 2.2 预览编辑历史

`useExpenseEditing` 内部使用 `usePreviewHistory` 保存最多 100 次字段变更命令。一次完成输入并提交是一步；范围为表头、五类费用单元格、人工合计、公司/申请人选择和审批选项。撤销后新编辑清空重做分支；无变化、取消或无效金额不新增记录。表头与费用对象保持原 reactive 身份，费用人工确认标记随字段一起回退，识别版本、状态、响应和图片引用保持实时值。

复制按钮右侧的撤销/重做按钮以及 `Ctrl+Z` / `Ctrl+Shift+Z` 操作同一栈；输入框和可编辑文本内保留原生撤销，弹窗或其他页面不接管快捷键。新建、切换或重新载入单据清空历史；临时历史单据导出保持原栈，导出期间不允许回放。费用已删除或字段被其他入口改写时，冲突历史失效，避免覆盖新值。历史不写入数据库或备份，保存后本会话仍可撤销，重新启动后为空；图片变换、附件增删和标签编辑不纳入此字段历史。

## 3. A4、导出与打印

A4 基准尺寸为 `794 × 1123` CSS 像素。费用行根据说明、安排人的换行计算高度，首表页行高预算 `785`、续表页 `816`；这是高度预算，不是固定费用行数。

图片按“每笔主图在前、附图随后”的费用顺序展开，每组最多 6 张：

- `single`：只有一页表格且余量至少 `126` 时，将第一组图片合入该页；其余组独立分页。条件不满足则所有图片组独立。
- `double`：所有图片组独立于表格分页。
- 两种模式均允许表格续页、多个图片页，名称不代表最多一页或两页。

当前预览和图片交互是 DOM/CSS 与 `AttachmentSurface`，不是 Konva 画布。ExcelJS 写表格、动态行、合计和分页，并嵌入捕获的图片分组；html2canvas 捕获 A4 DOM 后由 jsPDF 逐页生成 PDF，不承诺固定 300 DPI。打印使用 `window.print()` 与打印 CSS，不自动打开 WPS。导出只包含选定单据，不附带其他历史单据、API 配置或请求日志；WPS 打开、再编辑和打印一致性待实机验证。

审批栏在预览中使用下拉控件，PDF/打印时隐藏控件，仅显示所选审批文字；隐藏总经理时留空该位置并保持审批行高度和分页预算。Excel 使用同一默认和选项规则写入纯文本，不把下拉控件导出。

## 4. 识别与异步保护

1. 主图原件保留，识别使用派生副本；桌面请求传入记录、费用、附件和配置 ID，由 Rust 读取本地图像及配置。
2. 必须成功保存当前单据后才发送识别请求；保存失败直接停止，不能跳过附件持久化。
3. `advanced` 调用 `RecognizeAdvanced`，`handwriting` 调用 `RecognizeHandwriting`，Rust 使用 ACS3-HMAC-SHA256 签名。
4. OCR 原文交给 OpenAI 兼容 `chat/completions` 提取结构化字段，可按配置携带多模态图片。
5. 应用结果前，再按稳定费用 ID 检查对象是否仍存在及 `recognitionVersion` 是否匹配；失败分支也执行检查，丢弃删除、切单或新请求之后的迟到结果。
6. `manualFields` 阻止人工字段被重识别覆盖。大模型失败保留 OCR 原文并标记部分完成，允许手工继续；事由和安排人仍需人工确认。

保留 `queued/recognizing/success/partial/error/manual` 状态、原文、配置名称、耗时及错误信息。网络失败不等于数据损坏；当前没有真实 API 的准确率、耗时或失败恢复验收结果。

## 5. 保存、历史与局域网

草稿和设置各有唯一所有者。保存保留 `900ms` 防抖、revision 比较：旧保存结束不能把保存期间的新编辑误标为已保存。加载中、桌面存储未就绪（`storageReady`）、临时抑制（suppress）时阻止自动保存；历史导出等临时替换草稿不能写回真实工作区。

桌面历史由 SQL 查询，按 `created_at DESC, id DESC`（即 `createdAt + ID`）稳定排序，不因保存更新而改变创建顺序。日期筛选使用第一笔费用的 `occurredDate`，不是最早日期、报销日期或更新时间。

浏览器回退使用既有 `localStorage` 键，历史仅持久化列表前 20 项；不提供桌面事务、原图文件池或备份恢复保证。六个键保持不变：

```text
sheepfinance:workbench:v1
sheepfinance:profiles:v1
sheepfinance:dictionaries:v1
sheepfinance:history:v1
sheepfinance:services:v1
sheepfinance:ui-preferences:v1
```

局域网上传会话默认 15 分钟，绑定 `recordId` 及可选 `targetExpenseId`；前端同步目标剩余容量，接收事件重新检查当前目标及容量。切单、目标失效或关闭会话后，旧二维码不得向其他单据追加图片。

## 6. 技术架构与目录

实际栈：Vue 3、TypeScript、Element Plus、Vite、Tauri 2、Rust、ExcelJS、html2canvas、jsPDF、QRCode。现有 Konva 依赖不等于采用画布展示，不新增 Pinia、Router 或测试框架。

前端由 `App.vue` 装配，`types/constants/utils/services/composables/features/export/styles` 分别承担模型、常量、纯函数、typed 命令 IO、业务组合、展示组件、导出和样式。`composables/useSheepFinanceApp` 组合 12 个模块（其中 `useDocumentExport` 位于 `export/`），各 view 用 typed `provide/inject` 复用同一 root state 和 DOM refs，不复制主控状态。模块清单和 CSS 顺序见 [app/README.md](../app/README.md)；目录职责不是本轮完成证明。

Rust 原有模块职责继续保留：

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | 注册命令、插件及局域网上传状态 |
| `storage_sql.rs` / `database.rs` | 工作区命令、SQLite 事务、历史查询、结构升级、JSON 迁移 |
| `attachments.rs` | 原图/识别副本存储、读取及文件交互 |
| `recognition.rs` | OCR 签名、API 请求和结构化结果校验 |
| `lan_upload.rs` | 局域网服务与会话管理 |
| `request_log.rs` | 请求记录落库及查询 |
| `backup.rs` | 快照、完整 ZIP、恢复和归档门禁 |

本轮评估无需为前端拆分修改 Rust，不宣称进行了 Rust 重构。保留原有 27 个 commands、3 个 events（`lan-upload-received`、`storage-migration-progress`、`database-backup-failed`）、参数字段、错误语义、数据键及备份格式；typed API 按原命令边界封装，不改变协议。

## 7. 数据目录与事务

默认 `%APPDATA%\com.sheepfinance.app`，以 Tauri runtime 返回的实际路径为准：

```text
com.sheepfinance.app/
├─ sheepfinance.db
├─ images/<报销单ID>/<sha256>.<扩展名>
├─ backups/database/SheepFinance-<时间>.db
├─ backups/full/
└─ legacy-json-<时间>/
```

SQLite schema v3，共 11 表，启用 WAL、外键、`synchronous=FULL` 和忙等待：

| 表 | 职责 |
| --- | --- |
| `records`、`expenses` | 查询字段、单据结构化 JSON、费用字段及排序 |
| `attachments`、`image_blobs` | 主/附图关系、识别副本引用和不可变图片元数据 |
| `profiles`、`dictionary_items` | 申请人组合资料及字典 |
| `ocr_profiles`、`llm_profiles` | 含凭据的识别配置 |
| `ui_preferences`、`request_logs`、`app_meta` | 界面偏好、请求记录、当前单据与迁移状态 |

`records.data_json`、费用和附件 SQL 引用连同工作区设置在同一保存事务中提交，不能拆成独立提交。图片先写文件并校验 SHA-256，再建立 SQL 引用，按报销单归集并保留既有去重策略；图片文件不能由 SQL 回滚，失败可能留下未引用文件，不能把事务称为“数据库与文件完全原子”。桌面持久化的 JSON 不内嵌图片 Base64，载入时按引用恢复可显示图片。

## 8. 迁移、备份与损坏恢复

### 8.1 旧 JSON 迁移

`workspace.json` 不可读时回退 `workspace.bak`，`records/` 内各单据独立回退同名 `.bak`。迁移在临时数据库/图片池完成数量、外键、哈希及完整性检查后才启用；单据主文件和备份都损坏时停止迁移，不静默丢弃。设置损坏时，只有允许回退且用户明确确认后才能使用默认设置恢复可读单据。

成功后旧文件保留在 `legacy-json-<时间>/`，至少有一份有效数据库备份才允许清理。`ready/migrated/recoveryRequired/migrationFailed` 门禁和既有 corrupt 恢复语义不变，失败不能放行自动保存。

### 8.2 数据库快照与完整 ZIP

数据库快照保留最近 5 份，使用 SQLite Online Backup 获取一致性视图，通过完整性和图片引用检查后才参与轮换。72 小时为最近有效快照的到期条件，调度发生在启动和保存成功等既有条件路径，并有首份用户数据及并发门禁；不是持续每隔 72 小时运行的计时器。

快照只含数据库，继续依赖本机不可变图片池。完整 ZIP 另含所有数据库引用图片及 SHA-256 清单，用于跨机器恢复；不能用裸 `.db` 代替完整迁移。ZIP 的格式、版本、哈希校验和恢复前保护策略保持不变。

主数据库损坏，或缺失但存在可恢复备份时，进入恢复门禁，不静默建立空数据库。恢复/导入前，存储可用时须成功保存当前草稿；图片不完整、哈希不匹配或完整性失败必须明确报错。正式目录不做恢复、轮换或删除试验；桌面验证须使用数据库与图片的一致性隔离副本，并确认 runtime 指向副本，不能只复制活跃 WAL 下的 `.db`。

## 9. 凭据与安全限制

当前配置可在前端编辑，凭据存在于配置 JSON、SQLite、数据库快照和完整 ZIP 中，尚未实现 DPAPI 或系统凭据引用。不能声称数据库、ZIP 或全部请求内容不含敏感信息；请求记录虽有敏感字段处理，票据文本和返回正文仍需按敏感数据保管。

配置 TXT 的 payload/envelope 为 version 1，使用 AES-256-GCM、PBKDF2-SHA256（180000 次）及随机 salt/IV，但密钥来源为程序内置固定 secret，不是用户密码，也不是 DPAPI。它不提供独立于程序的强访问控制。开发文档、示例和仓库不得包含真实凭据、真实报销数据或备份。

## 10. 验证边界与非目标

本轮实际检查、产物及未验证范围统一记录在代码重构计划。复用 Node 内置 test、现有 vue-tsc 和保留产物的 Vite 检查入口；不把默认清空产物、全量 `cargo test` 或每阶段 `tauri build` 当作本轮门禁。浏览器检查使用固定旧提交 baseline 与当前代码 compare，不代替桌面存储验收；54 个 Rust 测试只是源码数量，不是本轮执行结果。

WPS、干净 Win10、真实 API、备份恢复/轮换、迁移一致性和安装升级本轮均未验证，旧 0.1.x/0.2.2 包不是当前 0.3.0 发布产物。多人审批、云同步、模板设计器、发票真伪查验、完全离线 OCR、数据库/凭据加密升级均不属于本轮模块化范围；多页分页则已经是当前业务，不能再列为未实现目标。
