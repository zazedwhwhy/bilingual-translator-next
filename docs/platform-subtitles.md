# 0.2.1 YouTube / B站字幕

本轮在0.2.0文件与媒体版本上继续优化两站。旧0.2.0交付保持独立，未安装到日常Chrome，未发布。测试日期2026-11-09，Chrome for Testing 151.0.7922.34，1440×1000；Browser插件未提供，使用Playwright独立临时profile。没有登录、规避访问限制或新增付费请求。

## 实现和调用链

```text
弹窗读取视频 VIDEO_LIST
  → background/video.inject（顶层内容脚本和字幕CSS）
  → platforms.identity（B站读取公开getManifest的活动CID）
  → content DISCOVER（视频ID绑定currentSrc与平台身份）
  → platforms.metadata(fresh)
      YouTube: 当前movie_player.getPlayerResponse → 缺失时才用initial
      B站: getManifest.bvid/cid → Resource Timing中的当前CID /x/player/wbi/v2
  → 列出经过视频ID和字幕URL白名单验证的轨道，或明确显示不可用原因

点击翻译 VIDEO_START
  → 建立操作代数，停止旧字幕
  → platforms.read（重新读取当前元数据，拒绝陈旧轨道）或读取native TextTrack
  → 解析返回的真实时间轴；空体/缺失时间/畸形结构直接失败
  → 读取私有配置及公开显示设置，再核对操作代数和当前视频身份
  → 创建来源绑定job → content INIT(expectedIdentity)
  → cueDocument(priorityTime=video.currentTime) → DocumentRunner
  → PREPARE_ITEMS（缓存、Unicode字符/片段预算、稳定ID）
  → BATCH → 所选文字服务 → 按ID严格对齐译文
  → SubtitlePlayer.update → hidden TextTrack/VTTCue
  → cuechange/timeupdate/seeked → 播放器容器内的原文和译文textContent
```

跳转只重排尚未派发的字幕，当前请求不会被重复发送；源cue、起止时间、导出顺序保持不变。没有提高并发或额外调用模型来制造速度提升。之前两次DeepSeek实测见 `deepseek-live.md`，不能把其耗时当成本轮两站的实时性能。

YouTube保留最多500条轨道并优先常用源/目标语言，修复先前 `.slice(0,40)` 丢失英文/中文的问题。字幕请求必须是当前视频的同源timedtext。B站字幕地址必须为HTTPS hdslb的subtitle/ai_subtitle路径；不构造WBI签名，不提取/伪造播放器令牌。

B站不能依赖网址或blob URL判断分P。MAIN世界只共享活动BVID/CID到视频上的自有属性；字幕/录音各持一个watch token，活动时每250ms刷新公开身份。内容脚本400/500ms检查录音/字幕身份，改变后停止旧任务。未知身份会作废旧值。停止一方只释放自己的token，不关闭另一方的观察。VIDEO_START保留字幕读取返回的CID并在创建job之前再次核对，停止期间等待设置的旧启动不再派发INIT。

双语层挂在 `#movie_player` / `.bpx-player-container` 内，支持容器全屏。隐藏TextTrack提供时钟；若直接全屏video元素，显示native track。字幕层不接收鼠标，按容器宽度使用14–28px字号；没有活动cue时清空。恢复移除层和自有标记，恢复原轨道模式。

## 实际发送的数据

| 请求             | 数据与接收方                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| YouTube字幕      | 站点已提供且经当前video ID检查的timedtext地址；同源凭据。请求中可能有网站自己生成的字幕查询参数；不转交给模型。                                        |
| B站字幕元数据    | 在原站MAIN上下文复用播放器已请求的当前CID `/x/player/wbi/v2` URL；原站Cookie只在该站请求中使用。跨边界只返回所需字幕元数据。                           |
| B站字幕文件      | 已验证的hdslb字幕URL，credentials omit，无网站Cookie转发。最大5 MiB，15秒超时，不允许重定向。                                                          |
| 文字翻译         | 原字幕文字、条目ID、源/目标语言，以及配置中的模型和协议字段。Key留在后台Authorization或供应商规定的字段。视频URL、标题、Cookie、音视频不进入文字翻译。 |
| 导入已有双语字幕 | VIDEO_APPLY只显示现有文字，不创建翻译job，不调用文字或语音服务。                                                                                       |

视频页可看见显示字幕及公开视频ID标记；它们不是凭据。AI字幕只有用户主动点击上传识别或录音才发送音频，详见 `data-flow.md`。

## 真实网页与模拟证据

| 项目                                       | 观察及结论                                                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YouTube公开TED `eIho2S0ZahI`，较早同日观察 | 正常播放598.061秒；native textTracks为空，播放器有49条caption tracks。英文/中文在原先40条截断之外。直接请求及站内正常CC按钮均HTTP200、0字节；英文站内请求已含网站自己生成的pot/potc，仍无字幕。未修改令牌。 |
| YouTube本轮最终验证                        | 页面标题和公开内容可见，但playability为LOGIN_REQUIRED，提示登录确认不是机器人，video readyState=0。停止在限制处；没有把真实播放器显示、seek、全屏或换片标成通过。                                           |
| B站公开CC合集 `BV1J94y177Nt`               | 正常播放器字幕接口code=0，need_login_subtitle=true、subtitles为空；扩展明确提示先在站内登录。正向CC获取/解析未完成线上验收，解析契约只有模拟样本。                                                          |
| B站真实播放器显示                          | 使用明确标注“Imported control cue / 导入测试字幕”的两条受控字幕，非视频转写。6.4秒显示第二条双语；5.2秒空档清空；容器全屏保留字幕；字号24.45px、层在播放器内；恢复移除自己的层/标记/watch。无pageerror。    |
| B站真实同网址分P                           | 点击页面实际显示的第二集。URL和performance.timeOrigin均未改变，公开CID从1359939486变为1359948500；旧双语层被清除，继续使用旧videoId返回VIDEO_CHANGED。不是通过page.goto伪装SPA验证。                        |
| 本机模拟容器                               | 8项通过：两种容器、批量翻译、指定cue跳转、容器全屏、导出、恢复与换源；模拟API与线上结果分别记录。                                                                                                           |
| Node契约                                   | 79项通过，含>40轨道、当前播放器优先、跨视频地址拒绝、B站登录/缺失结构、同URL CID改变、watch按需释放、停止竞态、seek重排不重复计费。                                                                         |

历史REA被动证据ID分别为 `ev_857bf969a3292c5eb8eb18b57a886d71e32303eaa10f2e66d3a7219a86d950c4` 和 `ev_60016eab73b61e47291601e875681b447b0bfc0246a16b0bc1ecdc5efa7f6abb`。它们对应较早观察，不替代最终YouTube登录限制的浏览器记录。没有读取被工具URL策略拒绝的view-source，也没有换接口绕过该拒绝。

精简机器证据见 `evidence/platform-site-results.json`、`evidence/youtube-final-boundary.json` 和 `evidence/platform-layout-results.json`。截图留在原项目 `.tmp/bt-public-bilibili/bilibili-fullscreen.png`，文字明确为测试字幕。

## 失败与回退

| 触发                      | 行为                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| 未登录/空字幕/元数据缺失  | 明确显示登录或不可用原因；不生成伪字幕，不自动启动ASR。用户可自行导入SRT/VTT。        |
| 视频/CID改变              | 拒绝旧轨道和旧videoId；取消旧job、清除显示、停止录音尾片。已录完整段沿0.2.0规则排空。 |
| 元数据/字幕超时、HTTP错误 | 停止读取并返回具体错误；不重试、不改走代理。                                          |
| 文字服务鉴权/格式错误     | 沿既有错误类型、预算和人工重试规则处理；不改用别的模型或服务。                        |
| 停止发生于初始化等待      | 代数核对拒绝迟到INIT，不能在停止后创建新翻译请求。已发出的远端请求仍可能计费。        |
| 普通video或video自身全屏  | 使用浏览器native字幕轨道，是展示适配；没有替换译文或放宽错误检查。                    |

未验证：登录后的两站正向CC、YouTube本轮实际播放展示、付费ASR质量、任意直播/新cue、跨域iframe、其它浏览器和所有播放器布局。文件PPTX/XLSX与两种AI字幕输入沿用0.2.0能力；本轮不把站点受限描述为这些功能自动补齐。
