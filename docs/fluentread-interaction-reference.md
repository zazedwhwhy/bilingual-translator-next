# FluentRead 交互入口参考

仅用于交互行为参考；静态只读检查，没有安装或运行。下列源码链接固定到 FluentRead `main` 于 2026-11-09 的提交 [`2f0fb198db20addfbfda06b84185a7638a6dfc52`](https://github.com/FluentRead/FluentRead/commit/2f0fb198db20addfbfda06b84185a7638a6dfc52)。这里只总结机制，不复制实现代码，也不作许可证法律结论。

## 划词翻译

- **触发与输入**：[`SelectionTranslator.vue`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L618) 监听 `selectionchange`，下一帧读取非空、仍连在当前文档的 Range；选区文本最多 4096 字。根据配置可直接出卡、显示图标后由用户点开、按快捷键、或通过浏览器右键菜单触发；触发模式/延迟见[设置计算](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L520)和[选区应用](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L812)。自动模式会跳过已是目标语言的文本。右键入口保存 Range 快照，并在菜单返回时复核原文、文档连接状态和排除规则；不把浏览器菜单给的裸文本直接作为来源。[菜单恢复](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L2094)
- **范围排除**：[`core.ts`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/core.ts#L286) 明确排除表单控件、媒体、交互角色、扩展自身 UI、`contenteditable` 和 `translate="no"` 等内容；支持可读的代码/公式拆分处理。这里是 DOM/语义类别过滤，不是对任意正文作敏感信息识别。
- **取消与迟到结果**：开始新内容请求时先增加 generation 并 abort 旧请求；异步完成时同时检查 request ID、文本/语言与当前 Range 来源，过期结果不提交。关闭卡片会 abort 并清掉选择状态。[请求建立与来源门禁](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L1352) · [翻译与响应校验](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L1512) · [关闭/取消](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/selection-translation/ui/SelectionTranslator.vue#L2142)

## 悬停翻译

- **触发**：指南说明默认启用后按住 Control 并指向段落翻译；按住可经过多个段落，松键完成单点翻译，已显示译文保留。用户可自定义快捷键与触发延时。[悬停指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/hover-translation.md#L1)
- **工作取消/复核**：焦点进入编辑器、IME 开始组合、选区活动、滚动、失焦、页面隐藏、路由变化、指针取消或额外组合键会撤销待处理工作。共享 [`hoverScheduler.ts`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/full-page-translation/content/hoverScheduler.ts#L78) 在延时前后重查候选段落、配置/可用性和候选身份；来源变化时不向错误段落提交。手势及取消监听见[`hover-translation/content/index.ts`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/hover-translation/content/index.ts#L208)和[按键流程](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/hover-translation/content/index.ts#L301)。

## 输入框翻译

- **触发与支持范围**：可配三连空格、等号或减号；设置区间默认 1000 ms、可调 200–2000 ms。旧 Ctrl+Enter 仍受支持。只接受 `text/search/url/email/tel`、`textarea` 和非只读 `contenteditable`；排除 password、数字/日期等其它 input 类型、代码编辑器、disabled/readOnly 和 ARIA-disabled 宿主。[快捷键处理](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L930) · [字段资格与类型白名单](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/inputBox.ts#L7) · [公开指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/input-translation.md#L7)
- **触发字符清理与写回**：前两次按键仍是用户输入；第三次被拦截并删除属于本序列的触发符。原生控件通过原生 `value` setter 派发 `input/change`；富文本优先走 `beforeinput`、粘贴/剪切编辑事件，最后才尝试浏览器原生编辑命令，不直接改 `innerHTML`。替换原文是默认模式，也可首尾追加译文。自动插入失败时提示用户复制译文；恢复原文是单独操作。富文本若要恢复格式，指南要求再用编辑器 Undo。[清理三连字符/触发](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L930) · [原生控件写回](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L199) · [富文本写回守卫](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/editableHost.ts#L221) · [恢复指南](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/docs/en/guide/input-translation.md#L27)
- **取消/迟到与隐私边界**：Esc、取消按钮、编辑内容、关闭功能或配置失效会中止请求并尽力向后台发取消消息；失焦会取消富文本编辑器的在途请求，避免迟到结果抢焦点。提交前要求请求代次、原文快照、配置代次、编辑代次和目标资格均未变，旧回复不能覆盖新编辑。[取消/校验/提交](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L336) · [编辑事件取消](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/src/features/input-translation/content/index.ts#L820)。这些是字段类型与编辑器排除，不是通用 PII/秘密内容检测；允许的 `email`、URL、textarea 或富文本内容仍可能含私人文本，触发后会发送给所选翻译服务。无需密码排除就推断其它敏感文本被阻止。

## 许可证标识

README 标注 [`GPL-3.0`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/README.md#L8)，仓库 [`LICENSE`](https://github.com/FluentRead/FluentRead/blob/2f0fb198db20addfbfda06b84185a7638a6dfc52/LICENSE#L1) 文本为 GNU GPL Version 3（GPL v3，29 June 2007），且文本中的授权模板写有 “version 3 or later” 选项。此处只记录项目标识与文件内容；复用边界需由主项目另行处理。

## 未确认

- 本次没有运行代码验证商店包与该提交行为一致；事件时序总结来自静态源码与同提交官方指南。
- 划词“direct/icon/shortcut/context menu/dot”选项的产品默认值取决于用户设置；本笔记不假定所有用户都使用同一触发模式。
- 没有确认所有富文本编辑器都能保持同一格式/撤销行为；源码明确保留宿主编辑器控制权，指南也承认格式恢复可能需要宿主 Undo。
- 没有找到对任意选区或输入内容做密码以外的通用敏感信息扫描的依据。
