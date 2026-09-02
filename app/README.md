# SheepFinance App

Tauri 2 + Vue 3 + TypeScript 桌面端代码。生产构建前执行：

```powershell
npm run build
cd src-tauri
cargo fmt --check
cargo check --offline
cargo test --offline
cd ..
npm run tauri -- build
```

SQLite 数据库和原始图片只写入 `%APPDATA%\com.sheepfinance.app`，不得把真实工作区、API 密钥或完整备份放入仓库。旧 JSON 仅用于 0.1.x 升级迁移兼容，新的业务读写统一通过 `database.rs`、`storage_sql.rs`、`attachments.rs` 和 `backup.rs`。
