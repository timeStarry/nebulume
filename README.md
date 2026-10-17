# Nebulume

本地优先的图像管理工具。选择本地目录建立图片库，或连接 WebDAV、S3 浏览远端照片；双击图片进入独立查看窗口。

[下载 Windows x64 版本](https://github.com/timeStarry/nebulume/releases) · [更新记录](CHANGELOG.md)

当前提供 Windows x64 安装器与独立程序。macOS、Linux 尚未完成本版本发布验收，暂不提供对应安装包。

## 功能

- 图库搜索、星级、格式筛选、RAW/JPEG 合并及整库排序。默认按 EXIF 拍摄时间排序，支持后台补索引；未知时间保持未知。
- WebDAV、S3 目录索引与按需预览，支持部分 TIFF/RAW 的分段内嵌 JPEG 读取。
- 可设置缓存位置、总容量、原图保留期限及自动获取策略，支持缓存清理、迁移和固定离线。
- 独立查看窗口提供缩放、全屏、EXIF、直方图、非破坏裁剪和 JPEG 导出；部分 Nikon 照片可显示记录的对焦区域。
- 从存储卡或挂载目录安全导入本地图库，支持计划审核、校验、内容去重和结果记录。
- 深色、浅色及跟随系统主题。

原片默认只读。扫描建立索引，裁剪保存为配方，导出写入新文件；导入保留源文件，不覆盖无关目标内容。

## 使用范围

RAW 支持受格式和机型限制，不支持 CR3、HEIC/HEIF、AVIF。查看器使用最长边 2400px 的预览，1:1 对应该预览像素；完整分辨率瓦片与专业 ICC 色彩管理尚未实现。

远端当前只读；普通 JPEG/PNG 首次预览通常需要下载完整文件。导入目标限于本地图库，尚不支持暂停、续传、多份备份或安全弹出。更多限制见[实施状态](docs/STATUS.md#已知边界)。

WebDAV、S3 公网连接使用 HTTPS，也支持局域网 HTTP 和用户确认的设备证书。凭据默认保存在系统凭据库，也可选择仅本次会话；配置和 SQLite 不保存秘密。

## 开发

需要 Rust 1.90+、Node.js 22+、pnpm 9，以及 Tauri 2 系统依赖。Windows 需要 Visual Studio C++ Build Tools 和 WebView2。

```sh
pnpm install --frozen-lockfile
pnpm build
cargo test --workspace --locked
pnpm test
pnpm typecheck
pnpm desktop
```

浏览器模式：`pnpm dev`。可选择浏览器支持的图片进行临时会话，关闭页面后清除；完整 EXIF、RAW、远端存储和导入能力需使用桌面版。

命令行入口：`cargo run -p neb-cli -- --help`。使用 `--data-dir` 指定隔离测试目录。桌面开发和验收可通过 `NEBULUME_DATA_DIR` 指定独立数据目录；默认路径由平台确定，应用标识为 `app.nebulume.desktop`。

在 `crates/neb-app` 运行 `pnpm exec tauri build --no-bundle` 构建桌面程序，运行 `pnpm exec tauri build --bundles nsis -- --locked` 构建 Windows 安装器。完整步骤见[发布指南](docs/RELEASING.md)。

## 文档

- [架构与数据设计](docs/ARCHITECTURE.md)
- [管理与查看交互](docs/INTERACTION.md)
- [命令契约](docs/API.md)
- [实施状态与限制](docs/STATUS.md)
- [测试策略](docs/TESTING.md)
- [发布指南](docs/RELEASING.md)

本项目未授予开源许可。
