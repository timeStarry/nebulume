# Lumen

安静、顺手的照片库与选片工具。选择本地或外接硬盘目录原地建立图片库，或连接 WebDAV、S3 浏览远端照片；原片始终严格只读。

[更新记录](CHANGELOG.md) · [品牌与设计矩阵](docs/IDENTITY.md)

## 核心能力

- **图库组织与检索**：支持文件夹层级树、精选集与智能精选集、星级（`1–5`）、选片旗标（`P/X/U`）、四色标签（`6–9`）、层级关键词、连拍自动堆叠（Burst Stacks）、RAW+JPEG 合并及右侧时间轴快速定位，`⌘K` 全局直达。
- **沉浸式查看与同步对比**：`40px` 常驻非遮挡窄顶栏（可选自动隐藏）、零跳变邻帧预解码切图、真 1:1 原生查焦、对焦点覆盖、高光/暗部溢出警告（`J`）、2/4 图同步缩放平移对比台（`C`）与定比非破坏裁剪。
- **现代格式与色彩管理**：支持主流相机 RAW（含 CR3、NEF、ARW、RAF、DNG 等）、HEIC/HEIF、AVIF、JPEG、PNG、TIFF、WebP 解码及内嵌 ICC 到 sRGB/Display P3 色彩转换。
- **伴随生态与专业导入导出**：非破坏性 `.xmp` 伴随文件双向同步、访达定位与外部精修软件移交（`⌘E`）；支持存储卡勾选导入、双盘同步备份、模板重命名与校验去重；提供可配置 ICC 与锐化的预设化批量导出。
- **网络位置与可控缓存**：支持公网 HTTPS、局域网（含 Tailscale / CGNAT）HTTP 及设备证书指纹信任管理；凭据存入系统钥匙串；远端缓存支持总配额、期限策略与离线固定。

原片默认只读：扫描建立索引，评分/色标/裁剪保存于本地目录与可选 `.xmp` 伴随文件，导出始终写入新文件。

## 开发与构建

需要 Rust 1.90+、Node.js 22+、pnpm 9，以及 Tauri 2 系统依赖。

```sh
pnpm install --frozen-lockfile
pnpm build
cargo test --workspace --locked
pnpm test
pnpm typecheck
pnpm desktop
```

- 浏览器演示模式：`pnpm dev`。完整 EXIF、RAW 解码、网络存储与导入导出能力需使用桌面版。
- 命令行入口：`cargo run -p neb-cli -- --help`。
- 图标资产校验：`python3 scripts/make-icon.py`。

## 文档索引

- [品牌识别与设计矩阵](docs/IDENTITY.md)
- [架构与数据设计](docs/ARCHITECTURE.md)
- [管理与查看交互](docs/INTERACTION.md)
- [命令契约](docs/API.md)
- [实施状态与限制](docs/STATUS.md)
- [测试策略](docs/TESTING.md)
- [发布指南](docs/RELEASING.md)

本项目未授予开源许可。
