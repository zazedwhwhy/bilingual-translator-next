# 沉浸式翻译：网页速度与自动翻译机制（只读资料审查）

日期：2026-11-09。范围：官方公开文档、版本日志与本机已安装1.34.4的局部静态查证；未操作浏览器、未调用翻译服务。下方先列文档证据，再列本轮补充的安装包核查；文档说明、REA的partial图和普通文本片段分别标明，不能混作运行时调用链。

## 可确认的机制

| 机制 | 证据与含义 | 证据边界 |
|---|---|---|
| 主内容优先 | FAQ 说默认“Translate Webpage”识别并翻译文章/帖子等核心内容，排除导航、页眉页脚等非核心区域；整页翻译是手动切换的另一模式。这样减少无关文本工作量，也保护页面布局。 | 官方产品行为说明；未验证具体 DOM 提取器或当前规则实现。 |
| 首批/即时回填 | 官方历史 changelog 记载可设“immediate translation mode”和“first X text count to translate immediately”；另一条记录文章正文先于侧栏翻译。说明其设计有优先首批内容、逐步呈现的意图。 | 历史版本功能记录，未证明当前版本的队列优先级、首批数值或实际回填时序。 |
| 并发请求 | changelog 记录从串行请求改为并发请求；又记有 throttle（多 frame）请求、AI 批量翻译稳定性优化。可确认项目历史上采用/优化并发及限流。 | 未公开当前并发上限、分批规则、引擎差异或何时串行。 |
| 缓存与去重 | 高级配置文档公开缓存 30 天清理周期；changelog 记载有翻译缓存开关、修复缓存和重复翻译问题、减少重复翻译请求。 | 可确认存在翻译缓存相关功能；缓存键、持久层、命中路径和默认开关状态未从这些资料确认。 |
| 语言判断 | 高级配置可设置始终翻译/不翻译语言，且可按站点声明源语言。changelog 记录准确性优化同语言检测，并曾以提高检测最短文本长度为速度优化。 | 语言判断算法、阈值和 unknown 处理不公开；旧版本 minLength 记录不可视为当前配置值。 |
| 自动翻译与关闭 | 语言规则 `translationLanguagePattern` 可自动指定语言范围；`translationUrlPattern.matches` / `excludeMatches` 可设置始终翻译/不翻译的网站。FAQ 说明在 popup 或 Options 关闭自动翻译；产品文档推荐默认翻译主内容。历史日志说明中文用户初始设置曾默认翻译英文网页，并可在 popup/设置取消。 | 自动触发的当前精确优先级、首次安装默认值、站点规则与语言规则冲突次序，不能只靠这些页面确定。 |
| 站点和动态内容适配 | 高级规则支持按 URL 命中、自定义 `selectors` / `excludeSelectors`；日志还记录适配折叠列表内容、动态页面和多 iframe 的加载优化。 | 规则更新、MutationObserver 策略和页面导航事件链未作源码分析。 |

## 对快速、无感体验的启发（推论，非对方实现证据）

1. 页面进入后先判定跳过条件，再识别语言；把正文/可见区域和首批短段放到前面，尽早提交并回填，长尾段和侧栏继续后台处理。
2. 将服务支持的多文本批处理与有限并发结合，并按服务限制节流；不同服务的批大小、并发数不能盲目共用。
3. 对相同文本/同一页导航复用缓存与 in-flight 请求，避免重复网络往返；缓存必须允许关闭/失效，以免模型或提示变化返回旧结果。
4. 自动翻译需要组合“语言可翻译 + 非黑名单 + 网站/路径规则 + 页面可注入权限”条件，并给全局关闭和当前站点例外入口。
5. “可见区域优先”有一条旧版 changelog 明确写过 visible translate；公开材料不足以证明当前版本仍按 IntersectionObserver/视口距离调度。把它视为值得针对目标版本源码/运行时复核的方案，而非现状结论。

## 官方来源

- FAQ（主内容/整页区别、关闭自动翻译、错误提示）：https://immersivetranslate.com/en/docs/faq/
- 高级自定义（站点规则、语言策略、源语言、缓存周期）：https://immersivetranslate.com/docs/advanced/
- 官方网页翻译说明（手动触发入口、默认 smart content area、整页快捷键）：https://immersivetranslate.com/en/docs/features/webpage/
- 官方 changelog（即时翻译/首批文本、并发、缓存、正文优先、语言检测与近期优化）：https://immersivetranslate.com/en/docs/CHANGELOG/

## 未确认事项

- 本机 Chrome 安装版本及其对应扩展构建未通过浏览器读取；没有本机扩展源文件/构建 hash 与官方 changelog 的版本映射。
- 没有对真实网页进行动态时序、请求数量、缓存命中或 DOM 回填验证；当前任务限制禁止浏览器交互。
- 文档和日志只能说明公开功能/变更，不能单独得出当前版内部函数名、完整调用链、端到端速度收益或自动触发优先级。

## 当前本机扩展包静态核查（REA + 局部 bundle 片段）

候选 ID `bpoadfkcbjbfhfodiogcnhhhpibjhbnh` 在 Chrome `Profile 1` 找到，`manifest.json` 版本为 **1.34.4**；`_locales/zh_CN/messages.json` 的品牌名为“沉浸式翻译 - AI 双语网页翻译 | PDF翻译 | 视频翻译 | 漫画翻译”，确认是目标扩展。只读取 manifest/zh_CN 品牌字符串，以及五个 JS bundle；未读 Chrome Preferences、Cookie、Local Storage 或凭据，未运行扩展。

REA 对扩展目录做了静态 JavaScript 应用分析，未执行 bundle。完整扩展目录 SHA-256：`863e5685ca083674f909ec301d95f465b85c992b3ea3824bf06b100c22c432bc`。分析选择 `content_guard.js`、`content_main.js`、`background.js`、`popup.js`、`options.js` 五个文件；统计中五个均被解析，读取源码文本约 12,013,030 字节。语义节点上限 12,000、单文件 4,000，产生 9,547 个语义 unknown；REA 将覆盖标为 partial，另有 49 个未选文件。按 `translationCache`、`cacheMaxAgeDay`、`translationLanguagePattern`、`translationUrlPattern` 和 `IntersectionObserver` 做的静态图 trace 没有匹配节点；REA 明确提醒 partial 图上的 no-match 不代表功能不存在。所以下列源码定位来自对指定 minified bundle 的局部文本读取，不冒称为 REA 函数级图追踪。bundle 文件均为压缩的一行 JS，位置使用字符偏移，不是源码行号。

选定 bundle SHA-256：

- `content_guard.js`: `f6c7a072b0e85166156aa016b6df20c068b2c0b5d183ddf8e835ebe059e5d648`
- `content_main.js`: `18c1956a1037dc48ea990d9ce751ea0249dca62c1f6ec5ef57c061e07c5abe5e`
- `background.js`: `0200d0d6e340217beb63d9e87036418be347685af418d8297eb368de77bd4ab4`
- `popup.js`: `e7d197c2cf52d92a9a68021ae6cc04ae57eafef1514a65abcf7afdf18508d9b3`
- `options.js`: `bad5db63b2909756b43c1ecf73af9537f5cb29f908386f6a0e5de1b354c58058`

### 有界代码证据

| 结论 | 文件位置（压缩 bundle 字符偏移） | 可直接读到的代码事实 | 边界 |
|---|---|---|---|
| 视口可见后恢复/处理延迟段落 | `content_main.js:1@2309819` (`IWe`)、`@2310460` (`LWe`)、`@2311224` (`W9`) | `IntersectionObserver` 回调仅在 `isIntersecting` 时调用 reveal；`W9` 注册 deferred 元素前保存原 `display` 并设为 `none`；reveal 时移除隐藏标记、恢复 `display`，再以节点集合调用 `wWe(n)`。observer 使用由 `zoe(...)` 计算的 `rootMargin`。 | 静态证明按视口相交延迟隐藏/回填；没有运行时观察，无法断言首屏具体顺序、rootMargin 数值或网络请求只为可见节点发出。 |
| 页面翻译任务并发闸门 | `content_main.js:1@1601667` (`vBe`)、`@1615796` (`getDefaultConcurrencyLimit`); `background.js:1@1080228` (permit 队列)、`@1111258` (消息分发) | 一个 sentence group 开始前按 service key 调 `acquirePermit(key, limit, meta)`，完成/失败都会在 `finally` 调 `releasePermit`；基类默认 concurrency 为 200，可由 `serviceConfig.concurrencyLimit` 正数覆盖。后台以 `inFlight`、FIFO `queue` 和 `limit` 控制 permit；释放时 drain 队列。 | 这是许可上限实现，不是实测吞吐量；真实服务配置、页面每批生成多少 sentence group，以及限流等待时间均未确认。 |
| 请求节流与分组参数 | `content_main.js:1@1615796` 之后；provider schema `@399217` | 同一基类显示默认 rate-limit `{limit:7, interval:1250}`；provider 字段定义 `maxTextLengthPerRequest` 默认 1200、`maxTextGroupLengthPerRequest` 默认 1。 | 配置字段默认值不证明每一种服务的有效值，也不能等同整页并发批数。 |
| 结果缓存 | `content_main.js:1@1902400` (`Use/jse/zse/kse/Ise/Fze`) | 站点段落 IndexedDB fallback 除非 rule 显式 `enable:false` 才关闭；读路径先查主 cache，miss 时可查 fallback；写路径尝试主 DB，失败或未写入时尝试 fallback，并记录 warning。fallback 参数取 `cacheMaxAgeDay`、`maxEntries`、`maxKB`。`background.js:1@1666107` 有过期 cache 清理，阈值由 `cacheCleanIntervalDay` / `cacheMaxAgeDay` 及运行条件决定。 | 此处证明的是命名为 site paragraph 的缓存备用层与过期清理代码；缓存 key 具体字段、实际命中率、用户开关当前值和当前浏览器存储内容都没有读取。 |
| 自动翻译触发条件的一条路径 | `content_main.js:1@1300396` (`tX`) | `tX` 先要求 `rule.enableSiteAutoTranslate` 和 `rule.enableAutoTranslateByReferrer` 均为真；拒绝条件检查后再比较 `document.referrer` 与保存/查询到的 referrer URL，匹配后调用 `aX(...)`。异常记录日志并返回 false。 | 这是按 referrer 的一种自动翻译路径，不能据此声称“所有外语页自动翻译”的完整策略。设置当前值、其它触发路径与语言检测调用顺序未确认。 |
| 语言和站点规则 UI/配置 | `content_main.js:1@606395`、`@967903`; `options.js:1@2159653`; `popup.js:1@426570`、`@1938151` | 代码含 `translationStartMode:"dynamic"` 默认项；语言配置对象包含 `matches` / `excludeMatches`，options 有不翻译语言选择；popup 站点状态区分 `matches` 与 `excludeMatches`，并处理始终翻译 URL 的同步/删除。content bundle 的默认语言规则在条件满足时可设成 `matches:["en"]`，条件计算函数名 minified 且当前配置未知。 | 这些是可观察到的字段和界面选择，不证明本机当前配置或“任何非目标语言”会自动翻译。 |
| `immediate` 起始模式 | `content_main.js:1@2309784`、默认项 `@606395` | bundle 有 `translationStartMode:"dynamic"` 默认；一段长文本处理条件会读取 `translationStartMode==="immediate"`；视口延迟则走 `IntersectionObserver` 路径。 | 没找到足以确认当前首批 X 项数量或 immediate/dynamic 两种模式完整分支的源码图证据；历史 changelog 中 first-X 是历史功能证据。 |

### 静态伪代码（依据上述局部片段）

```text
for each candidate paragraph:
    if deferred_by_current_rule:
        save original display style
        hide paragraph
        register its shared ancestor with IntersectionObserver(rootMargin)

on observer entry where isIntersecting:
    restore paragraphs registered under that ancestor
    remove their deferred bookkeeping
    hand restored paragraph set to wWe(...)

for each translation sentence-group request:
    await background.acquirePermit(serviceKey, serviceConcurrencyLimit)
    try:
        send translation request for sentence group
    finally:
        background.releasePermit(serviceKey)

read paragraph cache:
    try primary cache
    if miss and site fallback is enabled: try fallback cache
write paragraph cache:
    try primary cache
    on miss/failure: try fallback cache
```

### 本地核查新增的未知

- bundle 已压缩成单行且使用 minified 名称；REA 受节点上限影响未形成可用的缓存/队列函数关系图，本次不扩容重跑。
- 当前安装包是 1.34.4，但官方 changelog 当前更新高于该安装版本；官方页面上的最新特性不能直接套给本机安装包。
- 没有读取用户配置或本地缓存内容，也没有观察真实页面的 observer 事件、网络请求并发、结果回填延迟或自动翻译行为。静态证据不证明任何默认触发条件在该用户配置下实际打开。
