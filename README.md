# SheepFinance

SheepFinance 是一款面向行政、财务和报销经办人的 Windows 本地报销单据工作台。它可以从发票、车票、购物小票和支付截图中识别费用信息，由用户复核后排版并导出 Excel 或 PDF。

## 主要功能

- 点击、拖入或 `Ctrl+V` 粘贴图片，单张报销单最多管理 10 笔费用。
- 电脑生成短期局域网二维码，手机扫码后可从相册多选票据并自动传入当前报销单。
- 调用阿里云 OCR 全文识别高精版或通用手写体识别，再由 OpenAI 兼容的大模型 API 提取结构化字段。
- 所有识别字段均可手工修改，金额自动合计并生成中文大写。
- 支持一页/两页 A4 预览、票据图片裁剪取景、旋转、缩放、移动和排序。
- 导出 Excel 与 PDF，并保存报销记录、标签、状态及原始图片以便留档交接。
- 历史单据、设置和请求记录由 SQLite 事务保存；原图按 SHA-256 去重后以原始格式单独存放。
- 每次启动检查备份，距最近有效快照满 72 小时会在后台自动备份数据库，并保留最近 5 份。
- OCR、大模型、字典和申请人资料可导出为轻量加密 TXT，并在另一台电脑上导入。

## 运行环境

- Windows 10 x64 或更高版本。
- 建议安装 WPS Office，用于打开和继续编辑导出的 `.xlsx` 文件。
- 软件主体离线运行；只有 OCR 和大模型识别会访问互联网，手机上传仅在局域网内通信。
- 手机扫码上传要求手机与电脑处于同一局域网；Windows 首次监听时需允许 SheepFinance 通过防火墙。

## 开发与构建

需要 Node.js、Rust 和 Tauri 2 的 Windows 构建环境。

```powershell
cd app
npm install
npm run tauri dev
```

执行检查与生产构建：

```powershell
cd app
npm run build
cd src-tauri
cargo test
cd ..
npm run tauri build
```

NSIS 安装包默认生成在 `app/src-tauri/target/release/bundle/nsis/`。

## 数据与安全

数据默认保存在 `%APPDATA%\com.sheepfinance.app`：`sheepfinance.db` 保存单据、费用、设置与请求记录，`images/` 保存原始图片，`backups/database/` 保存数据库快照。0.2.0 首次启动会自动迁移旧版 JSON，成功后将旧文件归档为 `legacy-json-<时间>`，至少存在一份有效数据库备份后才允许手工清理。

自动备份只包含数据库并继续引用本机不可变图片池；跨电脑迁移或防范整块磁盘故障时，应在设置中导出“完整备份” ZIP，其中包含一致性数据库快照、全部引用图片和哈希清单。数据库、完整 ZIP 和配置 TXT 都包含 OCR/大模型密钥，应按敏感资料保管。请勿将 API Key、真实报销数据或本地导出的备份提交到 Git。

## 项目说明

本项目的需求梳理、部分代码实现与测试由 OpenAI Codex 协助完成，最终功能与发布内容由项目维护者审核。
