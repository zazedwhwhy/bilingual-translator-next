# FluentRead 公开项目调研（2026-11-10）

范围：只读 GitHub 官方仓库、指南、源码、release 与公开 issue；未安装、运行或修改 FluentRead。以 `main` 分支提交 [`2f0fb198db20addfbfda06b84185a7638a6dfc52`](https://github.com/FluentRead/FluentRead/commit/2f0fb198db20addfbfda06b84185a7638a6dfc52)（2026-11-09）为源码快照；截至调研时可见最新 release 是 `v0.0.41`（2026-11-08）。下列“指南宣称”是产品文档，“源码确认”表示静态源码可见，不等于本次端到端实测。

## 关键事实

1. **产品定位与网页阅读（指南宣称）**：浏览器扩展式双语网页阅读，可逐段/整页翻译、选区/悬停/输入翻译、原文恢复、站点规则、段落失败重试；页面重复段落可复用同批结果和可选缓存。扩展还支持按文章区段保存翻译规则。README 称用户脚本仅提供核心网页翻译功能，功能范围不等同完整扩展。证据：[README](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/README.md)、[网页翻译指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/webpage-translation.md#L1)。

2. **学习收藏和材料整理（指南宣称）**：可保存词、短语、句子及原文上下文；另有阅读材料，按文章、文档或视频关联段落、问题、笔记和阅读位置，可加主题/个人笔记、续读、导出/恢复。文档明确“问题与学习笔记引用其原始记录”，续读回到段落、文档页或视频时间；这确认了**应用内资料和位置引用**，不等同学术引文管理。AI 学习回答可选择使用相关学习笔记；阅读历史的问题与回答保留 30 天。此功能已经覆盖一部分跨网页/文档/视频的个人资料整理，但公开文档未说明能否按“项目”隔离术语表、自动抽取项目术语，或让翻译请求检索整组材料并保持跨文档术语一致。后几项是**未在本次查阅的公开资料中确认**，不能据此断言没有。证据：[Learning center 指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/vocabulary-book.md#L1)、[材料位置续读](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/vocabulary-book.md#L58)、[问题/笔记与源记录关系](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/vocabulary-book.md#L62)。

3. **视频字幕与边界（指南宣称）**：文档列出 YouTube、X、Udemy、Disney+，以及 Google Meet、Teams、Zoom 网页会议；多数平台依赖可读原生字幕。X 视频可在浏览器本地用 Whisper 转写（模型需先下载；指南写明单视频 20 分钟上限）；可双语显示和导出 SRT。对没有提供字幕的会议，FluentRead 不启动录制/转写，也不生成字幕。来源、账号、地区和播放器限制影响可用性。证据：[视频/会议指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/video-subtitles.md#L1)、[本地 Whisper 与限制](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/video-subtitles.md#L45)。

4. **文件翻译（指南宣称）**：文档阅读器支持 PDF、ePub、DOCX、HTML、TXT、Markdown、JSON，以及 SRT/VTT/ASS/SSA/LRC；PDF 上限 50 MB，其他格式 10 MB；可双语阅读、校对/编辑并导出。PDF 可选原版布局或重排，扫描页可先 OCR。文档保存在浏览器本地，刷新可续读。证据：[文档翻译指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/document-translation.md#L1)。

5. **服务、私有模型与成本（指南宣称）**：支持免费翻译候选、第三方机器翻译/API、AI 服务、自定义 OpenAI Chat Completions 兼容端点、FluentRead 可下载的本地翻译模型、Ollama，以及 Chrome 内置翻译/本地翻译。新用户可选择无需 API Key 的免费翻译启动；指南同时说扩展不自营翻译服务器，免费服务使用启用的候选端点，候选会变更、限流或停止；因此这是接入公共/第三方服务的免费入口，不是 FluentRead 自营且保证持续可用的翻译额度。免 Key 不适用于所有服务。FluentRead 自称免费开源，但第三方用量和费用由服务商决定；Chat 订阅不必然包含 API 额度。可按功能单独选服务。Ollama 需用户本机已安装并运行服务和模型；缓存、重试不免除配额或账单。证据：[快速开始（免费翻译无需 API Key）](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/getting-started.md#L28)、[服务选择与费用声明](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/config/translation-engines.md#L1)、[免费候选边界](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/config/translation-engines.md#L41)、[隐私政策：不自营翻译服务器](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/privacy.md#L1)、[本地模型与 Ollama](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/config/translation-engines.md#L128)。

6. **浏览器与移动可用性（指南/README 宣称）**：桌面可从 Chrome、Edge、Firefox 商店安装，另有用户脚本；Android 指南列 Edge、Firefox 和 Via。iPhone/iPad 可用 Safari Userscripts，范围为核心网页/选区翻译；文档明确原生 Safari 扩展尚无商店包，仍需 Xcode 构建的开发预览。移动端特性有差异：用户脚本缺字幕、图像 OCR 等多项扩展功能；iOS 系统视频全屏不显示网页叠层。商店可用性、权限和设备行为要以实际浏览器/地区为准；本次只核对文档，没有实机安装。证据：[README 安装渠道](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/README.md#L1)、[移动与 Safari 指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/mobile-safari.md#L1)、[用户脚本能力边界](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/userscript.md#L53)。

7. **隐私、缓存与并发（文档 + 源码静态确认）**：隐私指南称扩展不自营翻译服务器；文本按所选服务发送，文档在浏览器解析、待译文本发往所选服务；学习记录和配置默认保存在本地。翻译缓存默认最多 5 MiB/2,000 条、24 小时且可调整清除；本地文档记录上限 20 份/80 MiB。源码 `cache.ts` 实现内存热层及 IndexedDB 持久缓存；读写/维护失败会记录警告并当作缓存未命中，让翻译继续，这属于缓存辅助路径的可用性策略。`requestScheduler.ts` 实现全局/服务/模型并发与请求频率限制、FIFO、取消、deadline 和 `Retry-After` 冷却；但本次没有实测具体配置下的并发值或运行效果。证据：[隐私指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/privacy.md#L1)、[缓存源码](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/cache.ts#L1)、[调度源码](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/services/translation/requestScheduler.ts#L1)。

8. **公开 issue 中的边界线索（历史个案，非当前能力全景）**：issue #522（旧版本 0.0.32）报告当时自定义 OpenAI 兼容服务只支持改请求体，不能自定义请求头；issue #112（历史实现）质疑当时遥测和网页 localStorage 缓存。两者都不能直接外推至当前 main；当前 README/隐私指南描述了更新后的本地存储与云服务数据流，但我没有在本调研中逐项审计整个遥测实现。不要引用旧 issue 作为“当前仍不支持/当前仍存在”的结论。证据：[自定义请求头 issue #522](https://github.com/FluentRead/FluentRead/issues/522)、[历史隐私 issue #112](https://github.com/FluentRead/FluentRead/issues/112)。

## 未确认事项

- 本次未运行浏览器扩展，也未验证商店构建与 `main` 完全一致；仅基于公开文档和源码快照。
- 未发现可据以确认“项目级术语库自动构建与强制一致性”的当前公开说明；有用户词汇表、保存表达、主题/学习笔记和可选 AI 上下文，但它们是否能构成项目翻译记忆需另行核实。
- 未确认自动把课程视频归档为课程/章节、从本地文件夹批量导入整个课程库、把 PDF 页码与视频时间戳汇总成统一笔记的端到端流程。
- 没有针对各供应商的实际单价、地区可达性或翻译质量做比较；文档也说明服务商可能收费、配额和可用性各异。

## 与本项目0.2.3的对照

用户明确目标是“面向大众的公开产品”。本项目按本地提交`ea3576f`核对README和实际源码；以下不是竞品同场运行结果。

| 能力 | FluentRead本轮证据 | 本项目现状 | 对策略的意义 |
| --- | --- | --- | --- |
| 网页翻译、自动触发、缓存 | 已有，含更多交互与站点规则 | 已有自动开关、首屏合批/缓存；尚无划词/悬停/站点规则 | 属基础体验，不能仅凭拥有这些功能主张差异或速度领先。 |
| 文档阅读、编辑、导出 | 官方指南已有PDF/ePub/DOCX等、编辑与续读 | 已有8类文件解析与导出，正文结果保存在当前工作台内存 | “文档翻译”“可编辑”单独作为定位也会重叠。 |
| PPTX/XLSX | 本次官方支持格式列表未列出；未据此断言全部源码或将来版本都不支持 | 已实现原格式追加译文，XLSX跳过数字/公式；Office换行/溢出仍是明确限制 | 可作为窄入口候选；目前是格式覆盖基础，尚非成熟的版式优势。 |
| 学习材料、收藏、笔记、续读 | 官方文档已列出跨文章/文档/视频组织和位置关联 | 当前没有用户资料库、批注、阅读位置持久化 | 追平这些功能有使用价值，单独加上它们不构成明确差异。 |
| 服务接入 | 免Key候选、自定义兼容服务、本地模型/Ollama等 | 文字服务为4个固定官方端点，需Key；ASR端点可单独自定义 | 大众首次使用门槛是现有短板；免Key或多模型本身也不是独有卖点。 |
| 视频与ASR | 原生字幕、多平台，以及X本地Whisper的公开说明 | 原生/YT/B站现成字幕，以及显式上传/标签页捕获到配置的ASR | 存在范围差异，但本项目真实ASR、登录后的两站CC仍未验收，不适合先宣传为成熟领先能力。 |

本项目源码定位：`src/providers/registry.js:2`（固定文字服务）、`:38`附近（固定批量指令）、`src/background/settings.js:36`（Key与域名权限）、`src/documents/formats.js:128`（段落ID/位置）、`:276`（XML文档）、`:411`附近（原格式回填）、`src/documents/pdf.js:167`（页码/提取方式）、`src/subtitles/model.js:16`（时间轴）、`src/documents/runner.js:11`（译文Map）、`src/ui/workbench.js:14`与`:310`（会话内模型/关闭释放）。`src/background/cache.js:84`附近的缓存键含模型/语言/固定prompt版本，尚无项目术语或人工修订版本。

## 建议定位与改动顺序（建议，尚未实现）

建议以“可校对、术语一致、可交付的双语文件”为首个公开产品场景，保留网页翻译入口。先服务需要处理外语课件、工作资料的普通用户。它仍是大众需求，但首个使用理由更具体：用户拿到外语PPT，经过翻译、检查和必要修改，得到可以继续编辑或交付的文件。

这是一项产品假设，不是已确认的竞品空白或市场需求结论。FluentRead已有文档编辑，差异必须落实到具体格式、校对和导出流程。

1. **先把一个格式做成完整流程，建议从PPTX开始。** 提供逐页原译对照、译文编辑、长文本/溢出提示、可选的原文保留方式和可编辑导出。用真实课件检查导出后是否还能使用。当前追加段落的实现可能溢出，不能直接宣称“完美保留版式”。XLSX后续补表头/单元格预览、术语一致检查，同时保持公式和数值不变。
2. **项目术语与人工修订复用。** 用户确认术语译法后，同组材料使用同一规则；发现冲突时定位原文并让用户处理。记录已确认修订，复用时考虑上下文；修改术语/修订后更新相关缓存版本，避免继续显示旧译法。单纯新增可编辑提示词不足以体现这项价值。
3. **译后问题清单。** 检查数字/单位、占位符、漏译、术语冲突与文件布局问题。合法的数字/单位表达转换要先归一化；不确定项标待核对，不自动改写事实。否定、逻辑与含义判断可另做用户主动触发的AI辅助检查，不能保证正确，也不默认增加计费。
4. **恢复与记录作为基础能力补齐。** 保存用户选择保留的文件/结果/修改/位置，关闭后能继续；已完成结果不应无故再次请求。未知远端结果不能因自动恢复而盲目重发。跨次定位需要原文件哈希、版本和位置锚点，当前`s0/s1`不是稳定的跨次引用。

面向大众的发布基础另行补齐：正常入口不要求用户先理解API和模型；保留自带Key作为高级选项。如果选择托管服务，需要明确额度、费用和服务可用性，不能把不可控的免费候选当永久承诺。当前段落/字符预算不等于人民币支出上限。首屏速度与覆盖率需用同页、同服务和网络做真实比较，现有167ms来自固定120ms的本机模拟接口，不能作为竞品速度胜负证据。

建议顺序：先补首次使用和真实账户/文件回归；随后完成PPTX的校对导出闭环；再做术语/人工修订与问题检查；验证后扩展XLSX、批量文件和更复杂资料整理。把生词本、更多模型、通用AI聊天、跨平台铺开等放到需求验证以后。先观察用户拿生成文件还要花多少时间返工、重复修正术语多少次、是否愿意再次处理下一份资料，比统计新增功能数量更有用。

本轮只新增调研笔记，没有修改产品代码、运行收费接口、安装竞品或实施上述方案。
