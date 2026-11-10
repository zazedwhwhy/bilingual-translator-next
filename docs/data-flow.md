# 0.4.0 学习数据增量

学习模式单独开启。查询译文与上下文存入独立本地学习库；输入框草稿不自动收录。推荐发送正文前18000字符及水平、偏好，解释发送选中表达和邻近段落，练习发送正文；不发送学习库或来源URL。模型结果先验证结构和原文证据；仅推荐不创建学习条目。参见 [学习说明](english-learning.md)。

# 数据流与权限

0.3.1没有新增权限或远程接收者。已有Cache把同批结果写为一个IndexedDB事务，32ms合并访问时间；内存命中不等待访问时间写回。清空使用代次和串行写队列隔离旧hash/read/write/touch。缓存故障可在浮层/后续状态中观察，不注入伪译文；清理失败仍返回错误。输入目标或新非空选区变化会作废旧请求，手动阅读卡片可保留失选快照。见`existing-feature-refinement.md`。

0.3.0新增用户明确触发的划词、Alt悬停和输入框翻译；三个入口分别开启，初始关闭，首次勾选时申请普通网页权限。只发送当前选区/段落/输入文字，输入目标语言单独设置；不发送其它表单、Cookie或页面URL元数据。页面URL仅在本机核对身份，文字本身含私人信息或URL仍可能发送。密码及已标记的支付/凭据字段排除，这不是通用PII识别。后台session仅持久化该document的额度计数；密钥不返回给内容脚本。输入先预览再确认替换并触发原站input事件；扩展不执行提交，原站的输入行为仍可能运行。详见`quick-translation.md`。

0.2.3的VIDEO_QUICK只读现成字幕：确认拿到非空有效时间轴后才建立文字任务，原生READ和INIT绑定原documentId，平台读取前后验证当前视频/CID；没有新增权限，没有自动语音识别。平台自动生成的字幕是现成文本，不上传音频重做识别。网站元数据、Cookie和视频URL仍不交给模型；见 `existing-caption-fast-path.md`。

0.2.2增加可选自动翻译：只有用户开启开关时申请普通HTTP/HTTPS host权限，并动态注册顶层启动脚本；关闭会注销后续脚本并取消自动任务，不撤销可能仍被服务连接使用的域权限。最多4000字符的正文语言样本只在本机内容脚本与后台间传递，使用Chrome本地CLD，不调用语言检测服务。自动模式同样只把选中的待译文字、ID、语言/模型参数发送给配置的文字提供方。后台tab延后，目标语言或不确定页面跳过；没有自动录音或上传。详细开关、导航绑定和错误行为见 `speed-and-auto.md`。

用户点击 → 当前页内容脚本提取正文 → 后台缓存/预算检查 → 所选官方 API → 完整性校验 → content 检查 job/revision → textContent 双语节点。

| 接收者   | 数据                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Google   | q 文本数组、source（auto 时省略）、target、format=text；API Key 仅后台构造到官方请求 query                        |
| OpenAI   | 用户配置 model、翻译 system 指令、含 ID/原文/source/target 的 user JSON、stream=false、store=false；Bearer header |
| DeepSeek | 配置 model、翻译指令和相同批量 JSON、stream=false、thinking disabled、max_tokens=4096；Bearer header              |
| Claude   | model、system、messages、max_tokens=4096、stream=false；Bearer 和固定版本 header                                  |

不额外附带网址、页面标题元数据、Cookie、截图、表单值、其他标签页或浏览历史。正文自身若包含网址/标题/私人信息，仍可能作为正文发送。API 服务器仍能接收正常网络连接信息；本扩展不能代替供应商的数据处理规则。

页面内容不会被发送到本扩展运营方，因为没有运营后台或遥测。API 失败不改走别家服务。

密钥：chrome.storage.local，TRUSTED_CONTEXTS；只由设置页写入与后台使用，普通页面/content/popup 查询不返回密钥。内容脚本不能提交任意 fetch、域名或鉴权参数。后台按 tabId/documentId/frameId 绑定任务。

缓存：扩展源 IndexedDB（可选）和有界内存，包含原文哈希及译文，不保存密钥。设置中的清空缓存会清除两者。取消后的旧请求即使返回，也不能写入页面。

诊断：最近 100 条白名单元数据（服务、模型、计数、耗时、错误码），无正文、译文、URL query、完整响应或密钥；只在设置中主动查看。

文件：文档原件保留在工作台内存，PDF/OCR/ZIP/XML在本机解析。只将提取文字、文字ID与语言传给所选文本服务；原文件二进制、图片和公式不会上传。工作台不执行HTML/EPUB内脚本或远程资源。PDF导出排除原页交互批注与动作。

AI字幕：只有点击识别或录音后，所选文件/标签页音频二进制、文件名、模型、响应协议和可选语言通过multipart POST发送到显式配置的语音端点；语音Key仅放Authorization头。返回的分段文字再发送给文本翻译服务，音频不发给文本服务。上传文件名会发送；录音采用通用片段名。没有网页URL、标题或Cookie字段；音频本身可能包含私人声音。语音请求120秒超时，不自动重试或跨服务回退。纯文本语音响应不被伪造为字幕。

扩展源IndexedDB `bt-next-media` 暂存当前音频Blob、片段实测时间、识别结果与会话归属；清除按钮/正常关闭工作台会删除本次记录。浏览器崩溃/系统断电的残留需要再次检查本地数据，不能把正常关闭验收当作异常断电清除保证。Key单独在trusted storage，不进入音频存储或内容脚本。字幕本地播放使用Blob URL，结束后撤销。

权限：activeTab/scripting/storage/offscreen/tabCapture；服务域名均按需授权。manifest声明可选HTTPS和loopback域以支持用户显式配置语音端点，不预先申请所有站点权限。tabCapture需从目标视频页调用扩展才可启动；录音采集标签页输出，不采集麦克风。offscreen恢复扬声器监听，停止时关闭音轨和AudioContext。没有启用日常Chrome调试端口。

0.2.1站点字幕：YouTube在原站请求已加载元数据提供的当前视频timedtext，使用同源凭据；B站仅在原站MAIN上下文复用播放器已生成的当前CID字幕元数据请求，原站Cookie不会发给模型或字幕CDN。B站字幕文件请求credentials omit。活动BVID/CID通过自有DOM属性供身份检查，不共享播放地址或认证信息。字幕文字与条目ID进入所选文本服务；视频URL、标题、Cookie和音视频不会进入文字服务。读取失败不自动调用付费ASR。细节和实际限制见 `platform-subtitles.md`。
