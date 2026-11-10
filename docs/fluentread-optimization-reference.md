# FluentRead 交互与缓存优化参考

只读核查，基于固定提交 [`2f0fb198db20addfbfda06b84185a7638a6dfc52`](https://github.com/FluentRead/FluentRead/commit/2f0fb198db20addfbfda06b84185a7638a6dfc52)（2026-11-09）；未安装、运行或复制实现。以下是源码能确认的行为，不代表本项目应照搬。

## 1. 翻译缓存：热层、LRU touch 批量写回、维护调用

- [`cache.ts`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L18) 保留最多 128 条内存热记录；持久层是 IndexedDB/Dexie。单条 `get()` 先查内存，未命中再对 IndexedDB 查该 key；`set()` 逐 key 在事务内 `put()`，所以此处的“批量写回”具体指 LRU 访问时间，不是翻译结果写入的通用批处理。
- 命中记录时，`touch()` 更新内存访问时间并把最新时间按 key 合并在 `pendingTouches`；32 ms 定时器触发 `flushTouches()`。它在单个事务中 `bulkGet` 这些 key，再筛出仍是同一 `createdAt` 且时间更新的记录，`bulkPut` LRU 时间。`set()`/`maintain()` 前先清掉定时器并 `flushPendingTouches()`，确保后续 LRU 淘汰/统计看到已落盘的访问顺序。清缓存递增 epoch 并清空热层、touch 队列和定时器，避免旧 touch 复活。[touch 聚合与批写](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L202) · [维护前 flush 与 LRU prune](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L167) · [set 写事务](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L283) · [clear 代次](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L341)
- 维护去重另在 [`cachePolicyBinding.ts`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cachePolicyBinding.ts#L22)：按规范化后的容量签名去重重复配置通知，同签名复用当前 maintenance Promise；设置变化后调用 `setLimits()`。这不是时间限速。缓存 `maintain()` 会先 flush、再做过期和超限清理；`setLimits()`、`getStats()` 与 `cleanup()` 都可能触发。未发现基于时间窗口跳过重复 prune 的明确节流实现。[maintain 调用](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L192)

## 2. 悬停：同一候选移动不会重置停留计时

[`HoverTranslationScheduler.handle()`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/full-page-translation/content/hoverScheduler.ts#L83) 在 `delayMs > 0` 时解析真实候选。如果新旧候选一致（同一 DOM element、候选 key/kind/scope/reason、适配器/策略、可见 Range 与源文本），且翻译 scope、continuous、delay 和配置调用身份未变，只更新最近鼠标坐标并返回；保留原 timer，所以计时起点是进入该候选的首次调用。跨段、Range、文本或调用身份变化时清旧 timer，以新候选重新计时；到期时用最新坐标再次解析，并核验候选与可提交代次。[候选比较与同候选快速路径](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/full-page-translation/content/hoverScheduler.ts#L44) · [延时、保持或重设 timer 与到期复核](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/full-page-translation/content/hoverScheduler.ts#L83)

## 3. 选区丢失与输入焦点/编辑变化

- **选区**：普通选区丢失先等 160 ms，再重读当前 Range；能恢复则更新快照，否则 `hideAll()` 清状态并通过 `resetSelectionContentState()` 增加 request ID、abort 正在运行的翻译/查词。显式强制请求（`manuallyRequestedSelection && showTooltip`）及右键菜单捕获在丢选区时保留快照；因此不是“任何选区一消失都取消”。触摸打开的选区另有来源恢复路径。[160 ms 失选宽限与例外](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L791) · [状态 reset/abort](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L712) · [结果源与 request ID 检查](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L1512)
- **输入框**：键盘输入/`input`/`change` 发现当前目标内容变化会增加 edit generation 并 abort；提交前再核对请求 ID、元素有效性、值快照、配置和 edit generation。失焦监听重置三连触发；取消在途翻译仅对富文本编辑宿主执行，以免迟到结果抢回焦点。普通 `input`/`textarea` 在失焦后仍可提交，只要目标及原值仍有效（`isFormControl(element)` 免焦点门禁），故不能概括为“焦点一变就取消”。[`handleMutation` 与 edit generation](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L836) · [提交资格与快照](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L638) · [focusout 仅取消富文本](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L1056)

## 未确认

- 这是静态源码结论，未运行浏览器或商店构建验证实际事件时序。
- 缓存 `get()`/`set()` 单项路径是否在更上层被批量化，未在本次范围内追查；本文件只确认缓存模块自身对 value 的逐 key 写入及 touch 时间的批处理。
- 配置签名去重仅说明重复容量策略维护会复用 Promise；配置频繁变化时多个不同签名的维护如何排队由 Dexie/调用端共同决定，本次未做运行验证。
