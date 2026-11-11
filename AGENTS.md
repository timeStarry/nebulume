# Nebulume working agreement

- Build a cross-platform, local-first photo catalog. Rust owns filesystem, credentials, storage, codecs, index and import safety; SolidJS owns interaction; Tauri and CLI call the same command service.
- Original files are immutable by default. Crops are recipes; exports are new files. An import never deletes the source and never overwrites unrelated destination content.
- Library metadata is SQLite; credentials must not appear in the database, logs, git or UI responses. Remote access is explicit.
- Keep modules independently testable. Test failure and recovery paths for imports and storage, coordinate API changes in docs/API.md.
- Mark unsupported codecs and unavailable connections honestly. Do not fabricate metadata or silently substitute demonstration data in production.
- Document decisions and actual validation in docs. Cross-platform claims require CI evidence; a Windows build alone is insufficient.
- Other agents may edit this repository concurrently. Preserve their edits and respect assigned ownership.

## UI & UX 工程治理铁律

Token 与原语索引见 `packages/ui/README.md`；开发节奏与验收清单见 `docs/UI_WORKFLOW.md`。`pnpm --filter @nebulume/ui test` 中的 `check:design` 是这些规则的机器门禁，不得用 allowlist 绕过新代码。

1. 三层解耦。状态层（`model.ts`、`management-sync.ts`、`culling.ts` 等纯 TS + Tauri 命令与跨窗口事件契约）不 import 组件与 CSS；原语层（`src/tokens.css` + `src/ui/`）是唯一可写色值、阴影、模糊、圆角、控件高度与字号的地方；视图层只编排状态与原语，新文件不超过 300 行，不新增业务逻辑到 `ManagementApp.tsx`。
2. 只用语义 Token。视图 CSS 引用 `--nl-*` 语义变量；需要新颜色先在 `tokens.css` 深浅两套同时登记，再使用。间距只取 `--nl-s-*`（4px 网格），圆角只取 `--nl-r-*` 阶梯，控件高度只取 24/28/32/40。
3. 视口锁定。应用根为 `height: 100vh; overflow: hidden`（等价 `h-screen overflow-hidden`），只有明确的内容区（网格、侧栏列表、检查器、设置正文）各自滚动；任何页面都不得出现窗口级或嵌套的双滚动条。
4. 桌面质感。非输入、非文本查看区默认 `user-select: none`，路径、EXIF 值、错误详情等可复制内容显式 `user-select: text`；全局屏蔽 WebView 默认右键菜单，只有自定义 `ContextMenu` 与文本输入例外。
5. 空间层次。暗色主题靠表面明度阶梯（stage < rail < side < canvas < raised）区分层级；浮起层可加顶部 1px `--nl-highlight` 受光边；毛玻璃（`--nl-glass-*`）只用于浮动层（Toast、HUD、浮动操作坞、菜单、查看器工具栏），不用于常驻面板。阴影与渐变仍然禁止。
6. 网格性能。缩略图网格必须窗口化渲染（`JustifiedGrid` 只挂载视口 ± 余量的行），按可见性调度预览请求；严禁对全量网格项做 JS 布局动画或 FLIP 重排，严禁 transition `width/height/top/left/margin/padding/all`（`check:design` 的 `layout-transition` 规则）。
7. 动效边界。弹簧微动效（`--nl-spring`）只用于分段控制器、浮动操作坞、单张悬停与局部状态切换，且只动 `transform`/`opacity`；`prefers-reduced-motion` 下即时完成；动效期间的按键立即结束当前动效并作用于下一项，不丢键。
8. 渐进加载。图片按「骨架（`--nl-skeleton`）→ 已缓存缩略图放大占位 → 高清预览淡入」替换，新图就绪前保留旧图或占位；严禁先清空再请求造成白屏或空帧。
9. 乐观交互。移到废纸篓、淘汰、评级、旗标等可逆动作不弹阻塞确认：先更新界面，再写入；写入失败回滚并提示。统一用 `toasts` 原语的底部 Undo Toast（10 秒），并支持 `Ctrl/⌘+Z` 撤回。只有不可逆或影响范围超出当前选择的操作（移除图片库、清空缓存、重新绑定目录）才用 `Dialog` 确认。
10. 键盘可达。高频操作必须有单键或组合键，集中定义并由设置页「快捷键」同一份数据渲染；对应按钮的 Tooltip 用 `<Kbd>` 标注。网格保持单一 Tab 停靠点（roving tabindex）。
11. HUD 反馈。盲操（键盘打星、留用、淘汰、撤销）在视口底部渲染瞬态毛玻璃 HUD 胶囊（约 1.2 秒，可被下一次按键立即替换），`role="status"`，不抢焦点。
12. 排版防溢出。数字、EXIF 参数、文件大小、计数与序号使用 `tabular-nums`；单行标签用省略号截断并保留 `title` 全文；多行中文标题与说明用 `text-wrap: pretty`（标题 `balance`），禁止孤字成行与内容撑破容器。
13. 两段式开发。新功能先交付白盒阶段（状态、跨窗口同步、键盘、虚拟滚动性能，在 1 万张样本下验证无卡顿），通过后再做材质与动效精修；PR 必须附 `docs/UI_WORKFLOW.md` 的自检清单结果。
