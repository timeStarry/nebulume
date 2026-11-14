# Nikon Z5 II 本地兼容修复 · 2026-11-14

样片 `DSC_9237.NEF` 的 EXIF 机型为 `NIKON Z5_2`，14 bit，文件大小 31,980,312 字节。原有 rawloader 0.37.2 缺少该机型资料，强制传感器预览返回 `E_UNSUPPORTED_CODEC`；MakerNote 2.11 中 AFInfo2 为 `0402`，此前解析器仅接受 `0300/0301`。

## 实现决定

- 保留其他机型的 rawloader 路径，仅 `NEF` 且 EXIF 厂商/机型精确匹配的 Nikon Z5 II 使用固定版本 rawler 0.8.0。真实传感器数据适配到现有基础显影流程，本地预览、纯内存预览及 JPEG 导出共用同一适配器。
- 转换 RGGB 的黑白电平、D65 相机矩阵和相机裁剪。方向来自主 EXIF，避免新版解码器默认正常方向造成竖拍显示错误。保留 512 MiB / 120 MP 上限，在完整传感器解码前先验证头信息。
- AFInfo2 `0300/0301` 的尺寸/区域从偏移 42 开始；`0400/0401/0402` 从偏移 62 开始。布局依据 [ExifTool Nikon.pm 的 AFInfo2V0400](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm)，机型资料来自 rawler 0.8.0 的 `data/cameras/nikon/z5_mk2.toml`。
- 继续要求 `AFCoordinatesAvailable=1`，未知版本、纯点位 bitmask、无效尺寸、越界和截断数据均不推测坐标。仅返回区域，不暴露私有 MakerNote 数据。
- `source=raw_demosaic` 和 `source=embedded_jpeg` 保持真实区分；基础显影与相机直出亮度/色彩存在差异。此次不是全局替换解码器，也不扩大 CR3 或其他机型的传感器支持声明。
- 检查缓存指纹升级为 `inspect-v3`，让旧图库中已缓存的“RAW 原始解码不可用”在重新打开或扫描时更新；不修改数据库结构、原文件、资产 ID 或用户标记。

## 本机验证

Windows x64，Rust 1.99.1；所有样片操作只读原片，目录、缓存及导出放入隔离目录。

| 检查 | 实际结果 |
| --- | --- |
| `cargo test --workspace --locked` | 仅本次 PR 提交的干净源码：346 通过，0 失败，3 项既有原生/规模测试默认忽略 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 通过 |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| UI 设计门禁及 Vitest | 设计门禁 0 例外，183 项通过 |
| TypeScript、Vite 生产构建 | 通过；本机 pnpm 自动依赖检查失败后直接调用已安装的相同 tsc/Vite 工具完成 |
| `cargo build -p neb-app -p neb-cli --locked` | 通过 |
| `cargo build -p neb-app --features tauri/custom-protocol --locked` | 通过，内置当前前端资源的 `target/debug/nebulume.exe` |
| 真实 NEF 默认预览 | `embedded_jpeg`，1707×2560；已目视检查 |
| 真实 NEF 强制传感器预览 | `raw_demosaic`，1707×2560，方向 8；已目视检查 |
| 纯内存传感器预览 | `raw_demosaic`，1707×2560，解码器正确标注 rawler |
| 全尺寸 JPEG 导出 | 4032×6048；同名目标再次导出被拒绝 |
| 本地及有界 Read+Seek 对焦读取 | 一致返回 `available`，方向 8，参考帧 4032×6048，1 个选定区域 |
| 旧检查缓存升级 | 将该样片记录降为 inspect-v2/解码不可用后重新打开，保留资产 ID 与 3 星标记，更新解码状态及尺寸 |
| 原片 SHA-256 | 前后均为 `80eaed7ad199f5e4fdddc12cd4989b8484dc5c4fc5a9d197bb20e09b9e2b5840` |

照片记录的 AF 坐标帧为 6048×4032，中心 (3023, 2016)，区域 293×316。按方向 8 转换后的归一化区域为 x=0.4608134921、y=0.4759424603、width=0.0783730159、height=0.0484457672。

回归测试覆盖五个 AFInfo2 版本、TIFF/JPEG 容器、两种字节序、八种方向、无坐标/未知版本、字段截断、越界及读取预算；适配器测试覆盖传感器数据、电平、矩阵、裁剪和损坏/未验证布局拒绝。真实相机验证工具作为 opt-in example，不增加默认忽略测试：

```powershell
$env:NEBULUME_NIKON_Z5II_SAMPLE = 'Y:\RAW\110NZ5_2\DSC_9237.NEF'
cargo run -p neb-core --example nikon_z5ii_probe --locked
```

可传一个尚不存在的输出目录作为首参数，保存两种预览及 `focus.json`。工具在独立 8 MiB 栈线程执行，匹配 CLI 的解码线程预算；不提供栈预算的 Windows example 主线程曾触发栈溢出，已修复并重新验证。

UI_WORKFLOW 自检：本次无组件、样式、交互、快捷键或虚拟网格修改；状态/视图边界及设计 allowlist 保持原状，设计门禁和 UI 单测通过。主题、动效、1 万张滚动及原生窗口点击验收本次未重跑。macOS/Linux 未验证，本次不提供新增跨平台 CI 结论，也未发布或覆盖当前安装程序。

当前已安装程序仍需退出，再运行 `C:\work\lumen\target\debug\nebulume.exe` 才能使用修复；该文件为本地 debug 构建，未改变已安装版本。验证日志及照片派生预览保存在 Git 忽略的 `.local/z5ii-investigation/`；`pr-workspace-tests.log` 与 `pr-clippy.log` 为隔离当前 PR 源码的检查结果。
