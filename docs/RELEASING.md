# 发布指南

本指南用于从已提交源码构建和发布 Windows x64 包。macOS/Linux 的工作流配置不等于已完成发布验收；只有对应版本具备构建、测试和实机证据时才提供平台包。

## 准备源码

1. 对齐根 `Cargo.toml` 的 `workspace.package.version`、`package.json`、`packages/ui/package.json`、`crates/neb-app/tauri.conf.json` 和 `Cargo.lock` 的 workspace 包版本。
2. 更新 `CHANGELOG.md`，仅列出实际交付功能、已知限制和发布日期。
3. 检查待发布文件，排除用户数据、凭据、日志和临时输出。提交完整源码，记录提交 SHA；源码变化后重新执行相关验证和构建。
4. 标签采用 `v<版本>`，必须指向构建所用提交。已有同名标签或 Release 时先核实状态，不覆盖已有发布。

## 验证

需要 Rust 1.90+、Node.js 22+、pnpm 9、Python 3.11+ 及 Windows Tauri 2 依赖。在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm test
pnpm typecheck
pnpm build
$env:NEBULUME_BROWSER_CHANNEL = 'msedge'
pnpm --filter @nebulume/ui test:browser
```

Microsoft Edge 需已安装；不指定浏览器时需要 Playwright 对应的 Chromium。依赖完整缓存时可为 Cargo 增加 `--offline`，不得改变锁文件解析或省略检查。

记录当前提交实际验证结果。自动化与原生验收边界见[测试策略](TESTING.md)，不能用历史结果代替本次变更检查。

## 构建

在 `crates/neb-app` 运行：

```powershell
pnpm exec tauri build --bundles nsis -- --locked
```

默认产物为：

- `target/release/nebulume.exe`
- `target/release/bundle/nsis/Nebulume_<版本>_x64-setup.exe`

设置 `CARGO_TARGET_DIR` 时输出随之改变。Tauri 的 `beforeBuildCommand` 会构建前端，需确认打包使用当前提交的前端资源。

检查实际产物的代码签名状态并写入发布说明。当前未配置签名；构建成功不等于已验证安装、卸载或文件关联。

## 打包与完整性

使用 `scripts/package-release.py` 打包。先提交源码、完成检查和 release/NSIS 构建，再将该提交的验证结果写入上传目录之外的 JSON：

```json
{
  "version": "0.1.0",
  "source_commit": "<完整提交SHA>",
  "unsigned": true,
  "checks": {
    "rust_passed": 212,
    "rust_ignored": 1,
    "ui_unit": 62,
    "edge_workflows": 68,
    "clippy": true,
    "fmt": true,
    "tsc": true,
    "production_build": true,
    "windows_release_and_nsis": true
  }
}
```

以上数量是 0.1.0 的已知基线；发布新版本时填写实际结果，按测试变化更新脚本基线。`source_commit` 必须为当前完整 HEAD，`unsigned` 来自实际签名检查。

在仓库根目录执行：

```powershell
python scripts/package-release.py --version 0.1.0 --target-dir target --output-dir artifacts/releases/v0.1.0 --validation artifacts/release-validation-v0.1.0.json
```

`--target-dir` 必须对应构建使用的目录。脚本核对版本、Cargo.lock、提交、工作区、验证记录、产物格式、构建输入时间及复制前后摘要。输出目录必须全新，失败后保留部分输出供排查。

上传目录仅包含以下四份文件：

- `Nebulume_<版本>_x64-setup.exe`
- `Nebulume_<版本>_windows_x64.zip`
- `manifest.json`
- `SHA256SUMS.txt`

ZIP 内仅有独立程序、使用说明、运行清单和校验表。独立程序仍使用系统应用数据目录，不在程序旁保存图库。清单记录版本、源码提交、验证和产物摘要；脚本检查 ZIP CRC、成员大小、SHA-256 及上传文件白名单，不读取应用数据或替换运行进程。

也可用 `Get-FileHash -Algorithm SHA256 <产物路径>` 独立核对最终文件。ZIP 摘要不能替代内部程序或安装器的摘要。

## 发布与回读

核实 Git 远端、GitHub 身份、版本及标签指向，创建标签后只上传已核对的明确文件列表，不使用目录通配符。

Release 标题为 `Nebulume <版本>`。说明应概括实际功能及关键限制，附平台、签名状态和校验文件用途。

上传后通过 GitHub API 或 CLI 回读并核对：

- 正式发布状态、版本、日期、标签和目标提交。
- 资产名称、数量、大小与本地白名单一致，上传全部完成。
- 远端摘要与本地 SHA-256 一致；远端不提供摘要时，下载并校验。
- Release 和下载链接可用。

网络失败时先读取远端状态，再恢复缺失步骤，不重复创建标签或替换已发布资产。保留当前提交的验证和产物校验记录。
