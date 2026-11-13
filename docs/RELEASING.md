# 发布指南

本指南用于从已提交源码构建和发布 Windows x64 包。macOS/Linux 的工作流配置不等于已完成发布验收；只有对应版本具备构建、测试和实机证据时才提供平台包。

正式发布由 `.github/workflows/release.yml` 完成：推送 `v<版本>` 标签后，流水线在 Windows 上运行全部检查、构建并签名 NSIS 安装器、打包、创建草稿 Release 并回读核对，由人工确认后转为正式发布。下文的本地步骤在流水线不可用时作为备用路径，规则相同。

## 更新签名密钥

应用内更新要求每个安装器带有更新签名（`.sig`），签名校验无法关闭。密钥与 Windows 代码签名无关；未做代码签名只会触发 SmartScreen 提示，不影响更新。

- 生成：`pnpm --dir crates/neb-app exec tauri signer generate -w ~/.tauri/nebulume-updater.key`。公钥内容写入 `crates/neb-app/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 保管：私钥文件和密码存入密码管理器，另存一份离线备份，并配置为 GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY`（文件内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥不得进入仓库、日志或 `.env` 文件。
- 丢失私钥后，已安装的用户无法再收到任何更新，只能手动安装新版本。
- 轮换：先用旧私钥签名发布一个携带新 `pubkey` 的版本，用户更新到该版本后，后续版本改用新私钥。

## 流水线发布

1. 按“准备源码”完成版本对齐和 `CHANGELOG.md`（需有 `## <版本> · YYYY-MM-DD` 小节，作为更新说明），提交并推送。
2. 推送标签：`git tag v<版本> && git push origin v<版本>`。也可在 Actions 页面手动运行并填写已存在的标签。
3. 流水线拒绝标签与 `package.json` 版本不符、标签不指向检出提交，或同名 Release 已正式发布的情况。同名草稿视为上一次失败留下，删除后重建。
4. 草稿创建后流水线下载全部资产并核对名称、大小、SHA-256 及 `latest.json` 中的签名和地址。失败时检查 Actions 日志与保存 90 天的 `release-<标签>` 工件后重跑。
5. 人工检查草稿说明和资产后发布：`gh release edit v<版本> --draft=false`。已安装客户端只读取 `releases/latest` 指向的正式发布，草稿不会被拉到。

首个带更新器的版本需要用户手动安装一次；0.1.x 没有更新器，无法自动升级到它。便携 ZIP 不支持自动更新。

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
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw <私钥文件>
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<密码>'
pnpm exec tauri build --bundles nsis -- --locked
```

签名变量必须在当前 shell 中设置，`.env` 文件不会生效。

默认产物为：

- `target/release/nebulume.exe`
- `target/release/bundle/nsis/Lumen_<版本>_x64-setup.exe`
- `target/release/bundle/nsis/Lumen_<版本>_x64-setup.exe.sig`

设置 `CARGO_TARGET_DIR` 时输出随之改变。Tauri 的 `beforeBuildCommand` 会构建前端，需确认打包使用当前提交的前端资源。

检查实际产物的代码签名状态并写入发布说明。当前未配置签名；构建成功不等于已验证安装、卸载或文件关联。

## 打包与完整性

使用 `scripts/package-release.py` 打包。先提交源码、完成检查和 release/NSIS 构建，再将该提交的验证结果写入上传目录之外的 JSON：

```json
{
  "version": "0.2.1",
  "source_commit": "<完整提交SHA>",
  "unsigned": true,
  "checks": {
    "rust_passed": 311,
    "rust_ignored": 3,
    "rust_ignored_tests": [
      "credentials::native_test::windows_native_vault_roundtrip_cleans_up_its_entry",
      "watch::live::platform_events_for_a_new_photo_match_the_canonical_root",
      "list_pages_on_a_hundred_thousand_photos"
    ],
    "ui_unit": 129,
    "edge_workflows": 141,
    "clippy": true,
    "fmt": true,
    "tsc": true,
    "production_build": true,
    "windows_release_and_nsis": true
  }
}
```

以上数量是 0.2.1 的已验证基线；发布时填写实际结果，按测试变化更新脚本基线。忽略测试必须逐项出现在 `scripts/release_lib.py` 的已审查名单中，数量与实际 cargo 日志吻合；新增忽略项会阻止发布，不能只放宽数量。`source_commit` 必须为当前完整 HEAD，`unsigned` 来自实际签名检查。

在仓库根目录执行：

```powershell
python scripts/package-release.py --version 0.2.1 --target-dir target --output-dir artifacts/releases/v0.2.1 --validation artifacts/release-validation-v0.2.1.json --notes-from CHANGELOG.md
```

验证 JSON 可由 `scripts/collect-validation.py` 根据 cargo 测试日志、Vitest 与 Playwright 的 JSON 报告生成，流水线即使用此方式。

`--target-dir` 必须对应构建使用的目录。脚本核对版本、Cargo.lock、提交、工作区、验证记录、产物格式、构建输入时间及复制前后摘要。输出目录必须全新，失败后保留部分输出供排查。

上传目录仅包含以下六份文件：

- `Lumen_<版本>_x64-setup.exe`
- `Lumen_<版本>_x64-setup.exe.sig`
- `Lumen_<版本>_windows_x64.zip`
- `latest.json`
- `manifest.json`
- `SHA256SUMS.txt`

`latest.json` 只列出 `windows-x86_64`。任何一个平台条目格式错误都会让所有平台的更新失败，因此只写入已验收的平台，脚本拒绝写出版本、签名或日期不合规的清单。`SHA256SUMS.txt` 覆盖其余五份文件。

ZIP 内仅有独立程序、使用说明、运行清单和校验表。独立程序仍使用系统应用数据目录，不在程序旁保存图库。清单记录版本、源码提交、验证和产物摘要；脚本检查 ZIP CRC、成员大小、SHA-256 及上传文件白名单，不读取应用数据或替换运行进程。

也可用 `Get-FileHash -Algorithm SHA256 <产物路径>` 独立核对最终文件。ZIP 摘要不能替代内部程序或安装器的摘要。

## 发布与回读

核实 Git 远端、GitHub 身份、版本及标签指向，创建标签后只上传已核对的明确文件列表，不使用目录通配符。

Release 标题为 `Lumen <版本>`。说明应概括实际功能及关键限制，附平台、签名状态和校验文件用途。

上传后通过 `python scripts/verify-release.py --tag v<版本> --output-dir <上传目录>` 或 GitHub CLI 回读并核对：

- 正式发布状态、版本、日期、标签和目标提交。
- 资产名称、数量、大小与本地白名单一致，上传全部完成。
- 远端摘要与本地 SHA-256 一致；远端不提供摘要时，下载并校验。
- Release 和下载链接可用。

网络失败时先读取远端状态，再恢复缺失步骤，不重复创建标签或替换已发布资产。保留当前提交的验证和产物校验记录。

## Windows 本机升级核对

升级前退出应用，核对实际运行程序路径、版本、数据目录和数据库结构后再做一致性 SQLite 备份及完整目录备份。备份数据库时同时记录 WAL；`-shm` 是易变共享内存文件，读取或检查副本可能改变它，不能仅凭它的差异宣称业务数据损坏，也不能省略数据库和其他文件的摘要比对。

从 MSIX 打包的工具运行验收时，普通 `%LOCALAPPDATA%` 路径和 `Get-Item` 观察可能落在包的私有副本。应与未受该重定向影响的系统进程观察、实际应用进程路径及物理用户目录交叉核对；可在有权限时使用物理路径的 UNC 视图辅助确认。不要只凭相同的显示路径、旧副本版本或一次文件复制，宣称已升级用户日常安装。本次使用系统 WMI 进程代理完成交叉核对，无提权或系统设置修改。重定向行为的适用范围见 [Microsoft MSIX AppData 文档](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes#appdata-operations-on-windows-10-version-1903-and-later)。

NSIS 内的主程序不一定与便携 ZIP 中的主程序具有相同摘要。Tauri CLI 2.12.2 所用 bundler 将包类型标记由 `__TAURI_BUNDLE_TYPE_VAR_UNK` 改为 `__TAURI_BUNDLE_TYPE_VAR_NSS`，完成打包后恢复未打标的构建输出，见[对应版本的 bundle.rs](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-bundler/src/bundle.rs#L35)。本次已安装程序与便携程序仅有该三字节标记差异，规范化后其余字节相同。对其他版本必须重新定位并核验差异，不得将任意摘要差异归因于打标，也不要修改正式程序来取得摘要相等。

升级后确认实际程序版本、数据库完整性及外键、原有图库/资产/评级/旗标/裁剪/连接配置、真实图片载入和更新页，并复核系统默认文件关联。隔离副本中的路径、测试来源及内部绑定 epoch 重映射需单列，不能和用户数据保留比较混为一谈。发现问题时保存现场，退出进程后按同一时点的程序与数据备份回退；不要让旧版直接打开新版 schema。0.2.1 的实际结果见[本机升级记录](WINDOWS-UPGRADE-0.2.1.md)。
