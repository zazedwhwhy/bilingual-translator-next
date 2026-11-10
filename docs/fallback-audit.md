# 0.4.0 学习模块增量

保留：学习记录保存失败时继续显示有效译文并提示未保存；取消请求后的资源清理不替换主要错误。拒绝：无密钥/Google不支持教学、无效AI结构/原文证据、坏导入、陈旧页面结果、存储超限；不伪造学习材料，不自动重试或切服务。网页合成点击不能发起学习AI请求。存储串行尾链捕获只恢复后续操作能力，原调用仍收到失败。

# 回退与过度防御专项审计（0.2.0）

0.2.2增量：自动翻译开发审查发现1项错误隐藏：失败/缺Key只设置attempted导致本页不再启动，而开关仍显示开启。已用回归复现并修复为可见弹窗错误；明确保存连接后只重新探测尚未派发的配置失败页。网络结果未知仍需手动重试。未知语言/后台页延后属于合理闭包，初始化失败隔离手动翻译会显示AUTO_INIT_FAILED，关页通知失败只记录AUTO_PAGE_DISCONNECTED且后台job已取消。没有静默改服务、伪译文或盲目重放。97项Node与10项速度/自动浏览器场景通过。旧30组及0.2.1增量口径保留如下，不把合批/并发改动伪装成回退统计。

审计对象是本扩展自有代码（src，排除vendor），包括原网页与新增文档/媒体链路；不把第三方库内部或REA工具自身算进统计。检索覆盖fallback/degrade/default\_/conclude、catch、空值/空串默认和安全闭包，再沿调用链人工归并。下面的30项是独立行为分组，不是catch语句或正则命中的总数。

## 全景统计

30项分组中，发现6项过度防御（20%）并在本轮修复；24项合理防御（80%）保留。修复后的行为不是“网络失败就成功”，也没有自动换服务/伪造译文。取消泄漏、PDF动作和录音分段空档另属生命周期/安全/完整性缺陷，不混进回退占比。

## 评估清单

| 模块/子系统 | 回退点名称                         | 源码位置（修复后）               | 判定结果 | 改造动作                                      |
| ----------- | ---------------------------------- | -------------------------------- | -------- | --------------------------------------------- |
| EPUB        | 丢失spine引用默认空路径            | `src/documents/formats.js:262`   | 过度防御 | 直接报错，已修复                              |
| ASR后台     | 持久transcribing伪装为已接受       | `src/background/media.js:233`    | 过度防御 | 核实活跃任务，否则INTERRUPTED，已修复         |
| ASR网络     | 所有异常统一网络错误               | `src/media/asr.js:103`           | 过度防御 | 只映射网络边界并保留cause，已修复             |
| 文字网络    | 所有异常统一网络错误               | `src/background/transport.js:15` | 过度防御 | 保留非网络原异常，已修复                      |
| 媒体清除    | 忽略删除失败后显示已清除           | `src/background/media.js:305`    | 过度防御 | finally删除本地记录，前端失败显式显示，已修复 |
| 录音        | 时钟改变中止所有完整段识别         | `src/media/capture.js:114`       | 过度防御 | 只丢尾片，完整片段继续排空，已修复            |
| 缓存        | 读取失败继续内存/真实请求          | `src/background/cache.js:102`    | 合理防御 | 保持；展示CACHE_DEGRADED                      |
| 缓存        | 写入失败保留真实译文               | `src/background/cache.js:123`    | 合理防御 | 保持；不把缓存失败当翻译成功依据              |
| 缓存        | 裁剪失败标记降级                   | `src/background/cache.js:133`    | 合理防御 | 保持；缓存是可选能力                          |
| 请求        | reader取消失败不覆盖主结果         | `src/background/transport.js:81` | 合理防御 | 保持；只做资源清理                            |
| PDF         | 解析失败后清理task                 | `src/documents/pdf.js:188`       | 合理防御 | 保持；原异常继续抛出                          |
| OCR         | 取消后晚初始化对象清理             | `src/documents/pdf.js:128`       | 合理防御 | 保持；取消不能遗留worker                      |
| 任务        | stop/release失败仍拒绝本地迟到回填 | `src/documents/runner.js:150`    | 合理防御 | 保持；不承诺远端未计费                        |
| 媒体存储    | 已删除会话不被异步回写重建         | `src/media/store.js:41`          | 合理防御 | 保持；取消路径不复活隐私数据                  |
| ASR任务     | 失败写入会话错误后结束             | `src/media/offscreen.js:98`      | 合理防御 | 保持；持久错误及MEDIA_STATUS可观察            |
| 端口        | 来源未知时断开租约并停止           | `src/background.js:306`          | 合理防御 | 保持；不允许未知来源继续请求                  |
| UI          | 按钮操作catch显示错误              | `src/ui/asr-workbench.js:16`     | 合理防御 | 保持；不返回伪成功                            |
| 初始化      | ready.catch避免未处理拒绝          | `src/background.js:11`           | 合理防御 | 保持；每个实际handle仍await ready             |
| 字幕显示    | 缺少可选轨道名称使用语言/编号      | `src/ui/video-popup.js:13`       | 合理防御 | 保持；仅展示标签                              |
| YouTube     | 无语音文字事件不拼造cue            | `src/subtitles/youtube.js:15`    | 合理防御 | 保持；有文字却无时间会报错                    |
| HTML        | 删除脚本事件远程资源               | `src/documents/formats.js:197`   | 合理防御 | 保持；不执行书页主动内容                      |
| 协议        | 缺ID/截断/拒答明确失败             | `src/providers/registry.js:100`  | 合理防御 | 保持；不使用部分伪译文                        |
| ASR时间     | 纯文本结果拒绝伪造时间             | `src/subtitles/cues.js:132`      | 合理防御 | 保持；不平均分配时间                          |
| 迟到响应    | 代数/源revision改变丢弃结果        | `src/documents/runner.js:26`     | 合理防御 | 保持；防止停止后错回填                        |
| 配置        | 缺Key或权限直接阻断                | `src/background/media.js:57`     | 合理防御 | 保持；不找其他凭据或切换服务                  |
| 后台恢复    | 活跃处理器缺失标为中断             | `src/background/media.js:242`    | 合理防御 | 保持；不自动重放收费请求                      |
| 限流预算    | 达到上限等待显式继续/重试          | `src/background/jobs.js:16`      | 合理防御 | 保持；防止无界请求                            |
| 首次设置    | 默认语言/服务但不提供默认密钥      | `src/background/settings.js:26`  | 合理防御 | 保持；没有Key仍不能发请求                     |
| 归档安全    | 超限/加密/路径穿越拒绝             | `src/documents/formats.js:8`     | 合理防御 | 保持；不执行不可信资源                        |
| 诊断        | 仅白名单元数据                     | `src/background/cache.js:8`      | 合理防御 | 保持；观测不暴露正文与密钥                    |

## 过度防御的因果链

### 1. EPUB缺资源回退成OPF路径

位置：`src/documents/formats.js` 的getEpubSpine。触发：spine.idref不在manifest，或href空白。原来将缺失href替成空串，再基于OPF位置解析路径；可能把包元数据当正文，不显示“书已损坏”。当前先验证href，直接抛 `Failure("FILE_INVALID", "EPUB阅读顺序引用了不存在或空白的资源")`。损坏EPUB浏览器样本已先复现未报错，再验证明确失败。

```js
// 修复前
archivePath(root, items.get(idref) || "");
// 修复后：缺资源是结构错误
if (!href?.trim()) fail("FILE_INVALID", "EPUB阅读顺序引用了不存在或空白的资源");
```

### 2. ASR陈旧状态返回假accepted

位置：`src/background/media.js` 的ASR_RUN。触发：offscreen消失，而IndexedDB仍为transcribing。原来仅凭这个字段返回accepted，没有处理器在运行。当前查询实际context和MEDIA_STATUS.active；缺失则写interrupted并抛 `INTERRUPTED / 语音任务已中断，请显式重试，远端可能已处理`。浏览器测试实际关闭offscreen，先复现假accepted，修复后拒绝。

```js
// 修复前
if (session.phase === "transcribing") return { accepted: true };
// 修复后
if (!live.active.includes(session.id)) {
  markInterrupted();
  fail("INTERRUPTED", message);
}
```

### 3–4. ASR与文字请求的宽泛NETWORK_ERROR

位置：`src/media/asr.js` 的transcribeBlob、`src/background/transport.js` 的requestJson。触发：适配器编程异常、非法响应对象或非网络的运行错误。原来统一改成“网络连接失败”，丢失真实类型和cause，误导用户反复重试并可能计费。当前只在fetch/reader边界映射原生TypeError/NetworkError，并把原错误放cause；取消/超时沿signal.reason传播，JSON/缺body有专门响应错误，其他程序异常原样抛出。

```js
try {
  return await networkOperation();
} catch (error) {
  if (signal.aborted) throw signal.reason;
  if (isNetworkFailure(error))
    throw new Failure("NETWORK_ERROR", message, { cause: error });
  throw error;
}
```

两个公共请求接口均有RangeError保持身份的先失败后通过测试；ASR另有空响应体映射ASR_RESPONSE_INVALID测试。不是把全部异常继续包成另一个通用错误。

### 5. 删除失败后UI假称已清除

位置：`src/background/media.js` 的ASR_DELETE与`src/ui/asr-workbench.js`的destroy。触发：offscreen取消/创建失败。原来取消失败会跳过本地删除，前端又吞掉删除异常并显示已清除。现在无offscreen时直接清本地；有处理器时在finally保证删除本地记录，前端不吞核心删除错误，租约清理失败记录MEDIA_CLEANUP_FAILED。正常关页、立即断开租约、主动清除已用浏览器验证。尚未模拟磁盘永久失效，不将正常结果当磁盘故障保证。

```js
try {
  if (offscreenExists) await cancelSession();
} finally {
  await removeSession(id);
}
// UI只在await成功后显示清除完成
```

### 6. 视频时钟改变时过度取消完整录音

位置：`src/media/capture.js`的stop及capture-controller.onStop。触发：暂停、seek、变速、换源。停止未知映射尾片是合理闭包，但原来把discard尾片当致命错误，连先前完整片段的在途ASR也中止。当前discard只作用于正在录制的容器，完整片段排空；用户显式取消/删除/关闭才abort识别。用延迟ASR与真实seek验证完整录音仍产生字幕，而尾片不发请求。

```js
stopRecording({ discardCurrentTail: true });
await persistAlreadyCompleteChunks();
finishRecognitionQueue();
// explicit cancel / delete / close:
abortRecognition();
```

## 合理防御为何保留

缓存属于可选加速，失效可继续真实请求，但要显示降级；不会切服务或注入缓存伪值。reader/PDF/worker/release清理不得覆盖主异常。SESSION_GONE意味着用户已删除，晚回调不能重建记录。来源/预算/配置/格式/时间戳未知时停止或报错，避免无界计费和错误回填。展示名称、只读发现和元数据诊断失败不应伪装主业务成功；按钮catch只把真实错误呈现在UI。完整分类和对应位置见上表。

上述审计属于本项目实现验收，不是对原版沉浸式翻译全部后端、所有网站或第三方依赖内部逻辑的保证。

## 0.2.1 平台字幕增量审计

原30组/6项过度防御的统计保留为0.2.0历史口径。新增平台字幕归并为下列6个独立行为组，0项过度防御、6项合理防御；不与旧表的展示标签/清理逻辑重复累计。停止竞态和CID失配属于生命周期/身份完整性缺陷，已修复，但不冒充回退点来提高统计数量。

| 模块     | 回退点                         | 源码位置（函数）                                 | 判定     | 动作及理由                                                                               |
| -------- | ------------------------------ | ------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| YouTube  | 当前播放器缺失时使用初始元数据 | `src/subtitles/youtube.js:youtubeTrackChoices`   | 合理防御 | 保留；视频ID仍须相符，存在不符的当前播放器时直接VIDEO_CHANGED，不能用旧initial掩盖换片。 |
| B站      | 尚无播放器正常元数据请求       | `src/background/platforms.js:readPageMetadata`   | 合理防御 | 保留空轨道与明确notice，不伪装读取成功、不自造签名。                                     |
| B站      | need_login_subtitle或无可用CC  | `src/subtitles/bilibili.js:bilibiliTrackChoices` | 合理防御 | 保留显式登录/不可用原因；缺失结构是SUBTITLE_INVALID；不自动ASR。                         |
| 身份     | getManifest缺失/异常           | `src/background/platforms.js:syncPageIdentity`   | 合理防御 | 保留fail-closed；将旧CID作废为unavailable，停止旧显示/录音，不继续相信历史值。           |
| 字幕网络 | HTTP/超时/空体/过大内容        | `src/background/platforms.js:fetchCaptionText`   | 合理防御 | 保留明确错误和边界；不空译文、重试、改代理或换服务。清理失败不覆盖主结果。               |
| 全屏显示 | DIV双语层切换video原生字幕     | `src/subtitles/player.js:renderLayer`            | 合理防御 | 保留；纯展示兼容，同一组真实cue与时间轴，不改变请求/译文。                               |

本轮审查的两项重要缺陷均有RED→GREEN回归；最终79项Node测试全绿，B站实测同网址CID改变后移除旧层并拒绝旧videoId。不存在“读不到CC就静默当作翻译完成”的路径。完整触发条件、数据与失败行为见 `platform-subtitles.md`。

## 0.2.3 现成字幕快路径增量

本节按4组新增行为记录，均属合理防御，不与历史统计重复累计；不是重新统计全部依赖中的catch。

| 模块 | 回退点 | 源码位置 | 判定 | 动作与理由 |
| --- | --- | --- | --- | --- |
| 快速选轨 | 无匹配原生外语轨时查询平台现成轨 | `src/background/video.js:85` | 合理防御 | 保留；只读取当前主视频可访问的现成文字，没有外语轨或需登录时明确失败，不自动ASR。 |
| 读取与启动 | 空cue、停止、配置或视频身份改变 | `src/background/video.js:46` | 合理防御 | 保留安全闭包；验证后才建job，拒绝迟到启动、伪字幕和错误回填。 |
| 平台元数据 | 快路径复用刚获取的metadata | `src/background/platforms.js:297` | 合理防御 | 保留；下载前后fresh校验video/CID，失配即VIDEO_CHANGED，不能用旧metadata继续。 |
| 字幕排队 | 视频首请求优先，后续回FIFO | `src/background/jobs.js:188` | 合理防御 | 保留受限调度；全局仍2个在途，不抢占或重发已发请求，不隐藏服务错误。 |

无字幕/登录限制/空体/读取期间停止均有不建job的测试。最终105项Node通过；无字幕不触发文字API或ASR，正向本机快路径仅调用文字模拟API。公开站点的访问限制与未验证范围见`existing-caption-fast-path.md`。

## 0.3.0 随手翻译增量

本节归并6组新增行为，不与历史口径重复相加；修复后均属合理防御。原先只写控制台并清空偏好的初始化失败属于掩盖核心错误，已改为可见失败/显式重连；宿主拒绝替换也不能注入“已成功”的假状态。两项均有浏览器RED→GREEN证据，见`quick-translation-review.md`。

| 模块 | 触发 | 当前行为与保留理由 |
| --- | --- | --- |
| 权限/开关 | 未授权、关闭或偏好无效 | 不注册/不请求，显示原因；不借整页自动翻译权限状态伪装已启用。 |
| 文档额度 | ledger读取/保存失败或额度用尽 | 保存派发计数前不调用服务；未知记录不当0，超额需明确继续。 |
| 请求身份 | 选区/悬停/输入/配置/文档变化或取消 | 终止并拒绝迟到回填；旧请求清理只释放自己的预留。 |
| 编辑写入 | beforeinput拒绝、内容变更、超长或宿主恢复旧内容 | 不报告成功、不覆写后续输入；允许用户复制已得译文。 |
| 初始化 | 模块或配置连接失败 | 可见通知/重连；旧失败不能覆盖新成功，不自动请求翻译。 |
| 剪贴板 | API不存在或访问被拒 | 仅提示手动复制，保留真实译文；外围展示能力失败不阻断已完成翻译。 |

没有自动换供应商、代理、模型、重试或假译文。英文敏感字段规则不是任意私人内容识别器；普通文本需由用户决定是否发送。

## 0.3.1 缓存与交互优化增量

以下4组均属合理防御，不与历史数量重复累计。关键变化是把错误状态与有效结果分清，不用默认值伪造成功。

| 模块 | 触发 | 行为与理由 |
| --- | --- | --- |
| Cache.get | 缓存读异常、无效记录或过期 | 无效内容不当译文，异常可观察；后续真实翻译仍走权限/预算。缺失/过期是正常miss，不换服务。 |
| Cache.clear/写队列 | 清空与旧hash/read/write/touch交错 | 代次和串行队列拒绝旧数据复活；清理失败仍报错，不能声称已删。 |
| Jobs.execute | 提供方已返回，缓存处理期间取消 | 缓存处理后再次检查取消，返回CANCELLED，不能把已停止任务当完成。 |
| LRU touch/可选持久写 | 磁盘写入失败 | 不损坏已经有效的内存/提供方译文；浮层或后续状态提示缓存异常，重复操作可能再次请求。 |

切换输入目标、显式空输入及新非空Range先作废旧请求，不回退到旧上下文。手动阅读卡片失选时保留原快照是展示策略，不能用于写回其它输入框。完整RED→GREEN及原生数据库对照见`existing-feature-refinement.md`与`evidence/*0.3.1*.json`。
