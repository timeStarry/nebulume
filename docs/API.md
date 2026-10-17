# 命令契约 v1

桌面前端调用 `invoke('execute', { command, params })`。CLI 使用 `neb run <command> --json '<params>'`，相同 service 分派。成功返回业务 JSON；失败为 `{code,message}`，CLI 单次调用写入 stderr 并返回非零退出码。字段统一 snake_case。可选请求字段可省略；响应中的 Rust Option 字段使用 JSON null。

## 图库 / 影像（core）

- `library.list {}` → `Library[]`; 本地建库 `library.add {name,root,pair_raw_jpeg?}` 直接登记目录，不创建存储源；远端建库 `library.add {name,storage_id,prefix?,pair_raw_jpeg?}` 绑定已保存连接。两者返回 `Library`，配对默认关闭。显式引用旧本地storage_id的调用继续兼容。
- `library.update {id,name?,pair_raw_jpeg?,root?,storage_id?,source_prefix?}` → `Library`；省略字段保留原值，空前缀须显式传 `""`。root与storage_id互斥；root指定直接本地目录并解除旧连接绑定。同一真实本地目录解除历史绑定保留资产id、评级与裁剪；实际变更来源或目录时清除该库旧索引/配方，随后需要重新扫描，不移动或修改任何原文件。
- `library.remove {id}` → `{id,removed_assets}`；移除库登记和索引/配方，不删除原文件、来源目录或存储源。
- `library.scan {library_id}` → `{indexed,skipped,errors:[{path,message}],partial?}`；本地扫描文件，远端递归索引目录属性，尚不下载原图。
- `asset.list {library_id?,query?,rating?,format?:'all'|'raw'|'jpeg',sort_by?:'captured_at'|'created_at'|'modified_at'|'filename'|'rating',sort_direction?:'asc'|'desc',limit?,offset?}` → `{items:Asset[],total,file_total}`；格式/评级/搜索与排序字段/方向可任意组合，默认 all / captured_at / desc。筛选、配对、排序均先于分页，`total` 为显示项数，`file_total` 为筛选命中的实体文件数。captured_at与created_at升降序的未知值均置后，再以path/id升序稳定排序。选择拍摄时间只查索引，不隐式读取整库原件或连接远端。
- `library.capture_index.status {library_id}` → `CaptureIndexStatus`；只读本库的持久计数及当前Service实例的最新作业，不启动读取。
- `library.capture_index.start {library_id}` → `CaptureIndexStatus`；显式后台处理启动时仍为pending的实体文件。同库已有running/stopping作业时返回该作业；同一Service实例内另一库正在运行时返回`E_IN_USE`。
- `library.capture_index.cancel {library_id,job_id}` → `CaptureIndexStatus`；校验最新job_id，活动作业转stopping，终态作业保持原状态。无作业返回`E_NOT_FOUND`，job_id已变返回`E_CONFLICT`。
- `asset.get {id}` → `Asset`；远端只读索引与离线快照，不发起图像正文请求。本地仍按需检查已有文件的变更。`asset.rate {id,rating}` → `Asset`。
- `asset.refresh {id}` → `Asset`；显式更新原图，包含固定离线版本。远端新文件完整接收、核对长度并校验发布后才切换引用；网络、预约或发布失败保留旧缓存。评级与裁剪保留。
- `asset.fetch_original {id}` → `Asset`；显式获取缺失原图，已有当前缓存时复用；允许手动预览策略下下载。
- `asset.offline.set {id,pinned:boolean}` → `{asset_id,pinned,stats}`；固定前先取得完整原图，固定当前快照并计入总限额。远端重扫发现更新后不自动替换该快照；`asset.get` 附 `cache_update_available=true`，由用户执行 refresh 更新。解除固定允许作用于已移除库留下的孤立固定项。
- `file.open {path}` → `Asset`；只索引指定文件，独立查看不隐式扫描同目录或新增可见图片库。
- `asset.preview {id,max_size?,uncropped?}` → `{data_url,width,height,source,coordinate_mapping?,asset?}`（默认应用配方；编辑裁剪时以 uncropped=true 请求方向校正后的全图）。桌面响应的 `coordinate_mapping={orientation,full_width,full_height,crop}` 记录实际渲染采用的EXIF方向、裁剪前方向校正后的帧尺寸及实际像素取整后的归一化裁剪；用于可靠的画面叠加，不修改图像。
- `asset.focus {id}` → `FocusInfo`；独立读取相机对焦元数据；远端优先有界分段读取，缺少可靠Range能力时返回不可用，不为自动能力检测下载整份原图。与RAW传感器解码是否成功无关。查看器在当前 `asset.get` 成功后自动检测可用性，不预取其他照片；显示开关只控制覆盖层。
- `asset.histogram {id}` → `{red:number[],green:number[],blue:number[],luminance:number[],pixels:number,source:string,asset?}` (256 bins, display-rendered values)
- `asset.crop {id,x,y,width,height}` → `Asset` (normalized 0..1, oriented coordinates)
- `asset.reset_crop {id}` → `Asset`
- `asset.export {id,destination}` → `{path}` (new JPEG file, never overwrite)

`Library={id,name,root,created_at,storage_id,source_prefix,hidden,pair_raw_jpeg,source_kind,source_name,source_endpoint,connected}`。`source_prefix` 相对于存储源的 root；远端库的 `root` / `Asset.path` 是历史稳定逻辑路径，不保证指向现用物理缓存。实际I/O按缓存对象的root/relative_path解析，迁移不改库绑定或资产身份；原始位置用来源字段表示。独立打开文件的隐藏库不出现在 `library.list` 和默认 `asset.list` 中。

`pair_raw_jpeg=true` 只影响显示：整库内同目录、同文件名主体（区分大小写、扩展名不区分大小写），且恰好一份RAW和一份jpg/jpeg时配为一组；跨目录/跨库或多个RAW/JPEG有歧义时保持独立。先建立配对，再筛选匹配成员，all优先以匹配的JPEG作代表；仅看RAW时以RAW为代表。配对项附 `variants:[{id,filename,extension,kind}]`（RAW、JPEG顺序），始终允许分别打开两份。只按代表的字段排序，每份文件的评级、裁剪、导出仍独立，不合并文件或同步配方。

`Asset={id,library_id,path,filename,extension,kind:'raster'|'raw',size,modified_at,created_at,captured_at,capture_status:'available'|'missing'|'pending',width?:number,height?:number,rating:number,metadata:Record<string,string>,crop?:{x,y,width,height},availability:string,source_key:string|null}`。远端 `path` 为缓存位置，`source_key` 为存储源内原始键；`asset.get`不下载正文，preview/histogram/export可按需获取并解析，文件名始终保留原名。未获得远端修改时间时 `modified_at` 为空，不把缓存写入时间伪装成拍摄或原始修改时间。

`captured_at`只来自相机EXIF DateTimeOriginal及可用的SubSecTimeOriginal，规范为`YYYY-MM-DDTHH:mm:ss.nnnnnnnnn`；按相机墙上时间排序，不转UTC，不从文件创建/修改时间、EXIF DateTime或入库时间回退。有效OffsetTimeOriginal保留在metadata的`Capture Time Zone`，缺失时不猜测；排序也不按该offset跨时区换算。未知`captured_at`为空。`capture_status=available`表示已有有效值；missing表示已检查但未获得有效值，包括未记录、记录无效或格式暂不支持，不能一概解释为相机未记录；pending表示尚未完成检查或读取失败后仍待重试。v4→v5仅从SQLite已有metadata建立拍摄索引，保留id/评级/裁剪，不读原件、不解码像素、不访问网络；已有有效或无效DateTimeOriginal记为已检查，没有该记录的旧资产仍为pending。

`created_at`是源文件系统的创建/birth时间或WebDAV成功属性中的DAV:creationdate，统一UTC RFC3339纳秒精度；未知为空，不回退到EXIF拍摄时间、入库时间、缓存文件或S3 LastModified。v3→v4迁移保留原索引/评级/配方，旧本地库首次选择创建排序时补齐真实元信息，文件IO不持Core数据库锁，未知结果也记录已检查，后续scan/refresh重试。旧远端库须扫描更新才能补充服务端创建属性；浏览器File无创建信息时保持未知。文件详情仅在已知时显示创建时间。

界面将captured_at命名为“拍摄时间”（默认），created_at/modified_at保留并命名为“文件创建时间”/“文件修改时间”。浏览器File只提供修改时间，不能据此伪造创建或拍摄时间。

### 拍摄时间后台索引

三个`library.capture_index.*`命令均返回：

```ts
type CaptureIndexStatus = {
  library_id: string;
  total: number;
  known: number;
  missing: number;
  pending: number;
  job: null | {
    id: string;
    library_id: string;
    status: 'running' | 'stopping' | 'completed' | 'cancelled' | 'failed';
    total: number;
    processed: number;
    found: number;
    missing: number;
    failed: number;
    error: string | null;
  };
};
```

外层为当前本库全部实体文件的实时计数，不受网格筛选、分页或RAW/JPEG合并影响：total=known+missing+pending。job.total是启动时的pending候选数；processed为已处理候选数（包括错误及因已被其他操作更新而跳过的项），found/missing只计本次成功写入的有效/无有效时间结果，failed为读取失败数，因此processed不保证等于found+missing+failed。error为首个单项错误或使任务提前停止的作业错误，正常无错时为null。无候选时立即返回completed且job.total=0；候选处理结束但有失败项时为failed，网络/认证失败可提前停止。错误项不标为missing，仍保留pending供再次start重试。

只读取JPEG APP1 EXIF或经典TIFF主IFD0→ExifIFD中的DateTimeOriginal/SubSecTimeOriginal/OffsetTimeOriginal；适用于采用该结构的部分RAW，不保证所有RAW，不解析MakerNote、BigTIFF或缩略图/子图的拍摄时间。单项解析累计读取上限128KiB，单目录512/总计1024条目、单字段256字节、JPEG最多256段。越界、结构损坏、传输或预算耗尽返回错误并保留pending；已确认不支持的容器或无效日期记为missing。已存在当前版本原图缓存时可复用租约读取；否则远端优先使用版本锁定Range。Range不可用且允许安全回退时，仅从单个GET响应逐64KiB读取最多1MiB前缀并重试解析，不拼接不同响应，不发布或增加原图缓存。128KiB是解析读取预算，底层Range传输仍受256KiB块、16MiB/128请求等边界约束，不等同于网络字节总量。

后台不持全局catalog锁、不进入预览/下载队列，不解码图片像素；当前项使用库与资产租约，核对库绑定及登记版本后仅写入拍摄字段，不改评级、裁剪、尺寸和其他元数据。cancel是协作式停止：当前读取可完成并保留结果，发起下一项前停止，随后转cancelled；切换页面不取消。已完成索引持久化，但job仅保存在当前Service实例内存，重启不续跑；重启后status的job为null，再次显式start处理剩余pending。单次CLI进程不提供跨调用持久后台作业，持续任务应由常驻Service承载。

界面仅在running/stopping时每秒读状态，终态后统一重新查询已加载窗口；拍摄元数据变化不递增preview_revision或重新解码已加载缩略图/直方图，不逐项发起全库查询。

Metadata uses human-readable keys (Camera, Lens, ISO etc); absent data remains absent. Re-scan preserves rating and crop.

远端扫描上限为50k条目、2048目录、4096页；未完整完成时保留已有索引，不将未枚举项目标记为丢失。大小变化可建立新缓存版本；同尺寸内容更新须显式 `asset.refresh`。缓存原图可离线查看；实际磁盘策略与清理见下节。普通缓存按版本复用，离线固定为用户选择的内容快照；同尺寸远端变化仍须显式刷新。

远端 `asset.get` 的额外字段为 `cache_pinned?:boolean` 与 `cache_update_available?:boolean`；固定快照的只读尺寸/EXIF/大小及拍摄时间字段来自快照，评级与裁剪始终使用当前记录。旧快照缺少拍摄索引字段时，仅从该快照的有效EXIF Original推导available；无有效值保持pending，不冒充已检查。预览/直方图可附带 `asset` 补齐冷图元数据，前端应核对id后接收。

`asset.list.rating` 表示最低星级，`asset.rate.rating` 为 0–5 整数。预览默认最长边 1600；界面查看器请求 2400。直方图基于已应用裁剪的渲染图，不能作为传感器 RAW 直方图。导出为 JPEG，剥离源 EXIF/ICC。

`FocusInfo={status:'available'|'missing'|'unsupported',reason?:string,source:'nikon_afinfo2'|null,coordinate_space:'oriented_full_image',orientation:number,image_width?:number,image_height?:number,regions:[{x,y,width,height,kind:'selected'|'active'}]}`。区域为按主EXIF方向校正后的完整图像归一化矩形，未应用用户裁剪；宽高是对应方向下AF坐标帧尺寸。当前只解析标准JPEG EXIF/TIFF中的Nikon Type3 MakerNote（2.10/2.11）AFInfo2 0300/0301显式坐标，不推断纯点位bitmask、不读取其他私有字段、不返回MakerNote原文。记录缺失与格式/版本不支持明确区分，损坏或越界数据不猜测为中心点。

查看器核对实际预览的方向及帧比例后，按实际crop映射并裁边区域，跟随缩放/平移；无法可靠显示时将对焦按钮置灰，原因放在悬停提示与可访问描述中，不占用画布。裁剪编辑期间暂隐藏对焦框。选定区域不代表合焦成功或最终最清晰区域，锁焦后重新构图、主体移动或后期编辑可使其不再对应当前主体。

RAW 传感器解码失败时，查看与直方图可回退到标准 TIFF IFD / IFD1 / SubIFD 中最大的可解码内嵌 JPEG，`source=embedded_jpeg`。界面明确标识“相机内嵌预览 · RAW 原始解码不可用”。若 RAW 元数据头也无法解析，Asset 宽高使用方向校正后的预览尺寸，并附 `Preview Source/Preview Dimensions/Decode Status`，不能视为传感器分辨率；元数据头可读时仍保留原始尺寸，实际渲染来源以预览/直方图响应为准。JPEG 自身有效 EXIF 方向优先，再采用所在 IFD 和主/父 IFD 方向。`asset.export` 始终要求 RAW 传感器解码成功，绝不悄悄导出内嵌预览。

该回退只读取经典 TIFF 明确标注的 JPEGInterchangeFormat/Length，或 Compression 6/7 的完整单条 JPEG strip；不扫描 JPEG 签名、不解析 MakerNote/BigTIFF、不拼接多 strip。上限：32 个 IFD、深度 8、每目录 1024/总计 4096 条目、16 个候选、单 JPEG 32 MiB、累计读取 96 MiB、目录元数据 1 MiB、单图 120 MP、候选累计解码 240 MP；原文件仍限制 512 MiB。EXIF ASCII 字段去除空白/NUL 填充，空字段省略，原始有效字段保留在 EXIF 展开区。

## 本机缓存（service + core/cache）

- `cache.stats {}` → `{policy,location,usage,objects_count,pinned,migration}`。
- `cache.policy.set {budget_bytes?,max_unused_days?,preview_policy?}` → 完整stats；总上限1–1024GiB，默认10GiB；普通原图默认30天未使用回收，0表示仅按容量。`preview_policy='automatic'|'manual'` 决定不能分段预览时是否自动完整获取。降低容量不能突破固定、在用、预约及不可托管内容的保护边界。
- `cache.prune {originals:boolean,previews:boolean,temporary:boolean,dry_run?:boolean}` → `{reclaimable_bytes,freed_bytes,skipped_bytes}`；预检不删除文件，实际清理跳过固定、租约中和迁移中的对象。不删除远端/本地用户原件、评级、裁剪或凭据。
- `cache.location.check {path}` → `{path,valid,can_use,hard_links,available_bytes,reason}`；检查专用目录归属、库/应用数据冲突、链接/卷根、可写与无覆盖发布能力。当前FAT/exFAT不支持安全硬链接发布，明确拒绝。非法目录也可返回命令错误。
- `cache.migration.plan {path,mode:'all'|'pinned',allow_overage?:boolean}` → `{plan_id,from_path,to_path,bytes,extra_bytes,budget_overage_bytes,available_bytes,can_start,reason}`；extra为临时复制副本占用，budget_overage为临时超过预算的部分。计划失效必须重审。
- `cache.migration.start {plan_id,allow_overage:boolean}` → `Migration`；只有临时超额才必须授权；后台逐文件复制/哈希校验，SQLite事务切换对象引用。模式pinned只迁移固定内容，其余普通内容在安全边界回收。
- `cache.migration.get {id}` / `cache.migration.cancel {id}` → `Migration={id,status,from_path,to_path,total_bytes,copied_bytes,error}`；status为running/completed/cancelled/failed/cleanup_pending。提交前可取消，提交后只剩旧根清理；在用文件延迟清理，崩溃日志重开恢复。

`policy={budget_bytes,max_unused_days,preview_policy}`；`location={path,state:'online'|'offline',available_bytes}`；`usage={total_bytes,originals_bytes,previews_bytes,temporary_bytes,pinned_bytes,reserved_bytes,unmanaged_bytes,in_use_bytes}`。total含物理对象、临时副本和未消费预约；pin/in_use是可重叠的保护子集，不再相加。pinned列表项为 `{asset_id,name,size,last_used}`。磁盘断开不自动回退C盘，元数据与设置仍可打开。

启动恢复/兼容登记后及新写入预约时执行维护；普通原图按过期与LRU回收，预览优先保留。持久预览与缩略图共用预算；同资产跨线程/CLI合并访问，Service每实例最多4个远程下载/预览操作，本地预览不占远程名额。本地预览遇到缓存锁忙时直接解码，最多2个后台持久写入，不等待缓存维护。缓存容量被保护内容占满时停止新增磁盘文件；已成功生成的预览仍可仅在内存显示。

预览热路径使用SQLite容量账和按id查找，不遍历整个缓存目录；新写入仍检查预约与磁盘可用空间。启动、stats、显式维护、改容量和清理会对账磁盘的外部增删/未知内容。旧缓存全库接管只执行一次；之后可对当前访问的单资产恢复旧进程留下且数据库可证明归属的文件。

远端经典TIFF/RAW的内嵌JPEG读取采用强ETag或S3 versionId锁定；不以弱ETag、mtime、大小代替可靠版本。严格校验206、Content-Range、正文长度与版本，每次reader最多16MiB/128请求，单块256KiB、8块内存LRU。服务器忽略Range、无版本或无标准内嵌图时按策略回退完整GET；版本改变、协议错误或预算耗尽直接报错，不拼接混用。`source=remote_embedded_jpeg` 表示主动使用相机预览，未断言RAW传感器解码失败；导出仍须完整原始解码。

旧remote-cache仅登记SQLite明确引用的文件；无法确认归属的文件计入unmanaged，不自动删除。数据库、凭据目录不迁移。跨进程按库共享/独占租约保护完整资产操作与重绑；远端扫描在网络期间释放库/目录锁，发布每页前重新核对绑定，同库扫描另行串行，避免交错标记缺失。存储check/browse/fetch捕获连接快照后在注册表锁外执行网络。短时目录结构锁与缓存事务预约、租约共同保护扫描、导出、清理及迁移。

## 存储 / 导入（service + storage/ingest）

- `storage.list {}` → `StorageConfig[]`
- `storage.remove {id}` → `StorageConfig`；移除配置、会话连接和该源系统凭据，不删除本地/远端文件。有关联图片库时返回 `E_IN_USE` 并列明库名，先编辑关联或移除库。凭据删除/验证或配置发布失败时保留源并恢复原凭据；不把部分失败当作删除成功。
- `storage.add {name,kind:'local'|'webdav'|'s3',endpoint,root?,bucket?,region?,username?,password?,access_key?,secret_key?,session_token?,tls_certificate_sha256?,remember_credentials?}` → `StorageConfig`（不返回秘密；相同位置重连沿用 id）
- `storage.check {id}` → `{id,connected,credential_status,checked_at,error:string|null}`；实际列举目录验证连接，认证/网络失败返回 connected=false 与 error，不把“请求成功返回”当作“连接成功”。
- `storage.inspect_tls {endpoint}` → `{endpoint,sha256,subject,issuer,not_before,not_after,subject_alt_names:string[]}`；无凭据检查局域网 HTTPS 服务器证书，不保存或自动信任证书。日期使用 RFC3339。
- `storage.browse {id,prefix?,limit?,cursor?}` → `{entries:[{key,size,is_dir,created_at?:string}],next_cursor:string|null}`；limit 默认 200，范围 1–1000。created_at可选，来自源的真实创建属性；缺失/无效省略，S3不把LastModified视为创建时间。
- `storage.fetch {id,key,destination}` → `{path,size,sha256}`（新文件，无覆盖发布）
- `import.plan {source,destination,layout?:'preserve'|'date',deduplicate?:boolean}` → `ImportPlan`；默认 preserve / true，创建计划不复制文件。
- `import.execute {plan_id}` → `ImportResult`；仅当前会话已审核计划可执行，计划消费后重试须重新规划。
- `import.history {}` → `ImportResult[]`，来自持久日志；遗留 running 作业返回 interrupted。
- `system.info {}` → runtime version, capability status and explicit limits.

WebDAV 列表按各 `propstat` 的成功状态合并属性，忽略失败属性块。空、空白或缺失的 `getcontentlength` 按未知大小处理；当前 `size` 字段沿用 0 占位，不能仅凭它判断文件为空。成功属性中的非空非法长度、负数、溢出或相互冲突的长度仍报错。

`StorageConfig={id,name,kind,endpoint,root,bucket,region,connected,tls_certificate_sha256,remember_credentials,credential_status}`。本地 endpoint 为目录；远端 endpoint 为 HTTPS URL，或指向局域网的 HTTP URL；root 为 source 内相对前缀。`credential_status` 为 system/session/missing/unavailable/not_required。connected 表示当前进程最近实际连接结果，启动/保存后须测试或浏览才得到验证。

远端 `remember_credentials` 默认true，凭据安全存入Windows Credential Manager/macOS Keychain/Linux Secret Service，按用户数据目录、源id与具体位置绑定；启动不访问钥匙库或网络，首次操作按需恢复。设false为仅会话，系统库不可用时明确报错；配置/SQLite/日志/返回JSON不保存秘密。旧版会话凭据无法追溯，升级需首次重连。同位置编辑时省略/空秘密保留已有值；改身份须提供匹配秘密。按source id作用域的环境变量仍可用。

HTTP 允许私有 IPv4、回环、链路本地地址及 IPv6 ULA。主机名须全部解析为允许的地址，连接固定这些解析结果并禁用代理/重定向；公网 HTTP 拒绝。标准 HTTPS 继续使用公共 CA 和主机名校验。

`tls_certificate_sha256` 为用户明确确认的服务器叶证书 SHA-256，适用于局域网 HTTPS 自签证书或私有 CA。仅对应存储源生效，允许证书名称与访问地址不同，但仍校验证书有效期和 TLS 握手签名。证书变化会拒绝连接，须重新检查确认；缺省或 null 恢复标准校验。指纹作为非秘密连接配置持久化，原有配置缺少该字段时保持原行为。UI 将确认绑定本次 endpoint 与证书，地址变化或重新检查会清空确认。

`ImportPlan={id,source,destination,layout,deduplicate,items,total_bytes,duplicate_count,warnings,created_at}`。每个 item 包含 `source,source_relative_path,relative_path,size,status,sha256,date_source,duplicate_path,modified_nanos`。status 为 pending / duplicate；date_source 为 preserved / exif / paired_exif / unknown。`modified_nanos` 是 Rust 内部快照信息，前端不得以 JavaScript Number 重建其精确值；执行仅提交 plan_id，不接受客户端修改计划。

`ImportResult={id,plan_id,source,destination,status,started_at,finished_at,total,copied,duplicates,failed,items,originals_retained}`。结果 item 为 `{source,destination,status,size,sha256,error}`，status 为 copied / duplicate / failed。失败原因保留完整上下文，原文件始终保留。

目标目录属于已登记的本地图片库时，导入完成自动扫描并附加 `library_id` 与 `indexing` 或 `indexing_error`。索引失败不将已成功复制的结果改成复制失败。远端来源图片库当前不作为SD导入写入目标。

## 原生窗口接口

这些Tauri调用由app适配层处理：`open_viewer {assetId,assetIds}` → 新窗口label；`viewer_context {}` → 当前查看窗口专属 `{asset_id,asset_ids}`；`show_manager {}` 打开管理页；`list_volumes {}` → `[{id,name,path,kind,removable,available_bytes?}]`。卷类型由OS报告，不把所有可移动卷推断为SD卡；可以手选挂载目录。

命令行图片路径或安装包文件关联打开独立查看器；已有进程接收后续文件打开请求，不重复启动管理实例。不会改动用户系统默认应用设置。

CLI 的 `neb stdio` 可在同一会话保留连接凭据和导入计划。输入逐行 `{id,command,params}`，输出 `{id,result}` 或 `{id,error}`，仅使用本机 stdin/stdout，无网络监听端口。

契约变更需同步 Rust、前端类型、本文件及相应集成验证。此文档记录当前发布实现，未来版本的功能以产品设计和里程碑管理。
