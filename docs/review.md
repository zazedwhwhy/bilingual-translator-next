# mattpocock-skills 双轴审查记录

固定审查起点 8bcab41，首轮实现截至 f98235d；两个独立只读代理分别看 Standards 和 Spec。之后由主代理做一次修复与回归验证，不用作者自审冒充独立审查。

## Standards

1. 高：STATUS 的宽泛 catch 将所有错误变为 idle，伪造“尚未开始”。已修复：只有显式确认页面未初始化才返回 idle；其他错误向上返回。background.test.mjs 回归先失败后通过。
2. 轻微建议（保留）：部分队列局部变量 j/b 可扩展命名；属于 Fowler 命名启发式，不是已复现功能错误。未作为阻断项。

该轴发现 1 项重要问题，已修复；保留 1 项轻微建议。

## Spec

1. 高：并行批次中的 CANCELLED 可能遮住触发任务取消的 AUTH_FAILED。已修复：后台保留致命原因，页面优先传播致命错误，禁止无效重试。scheduler.test.mjs 回归先失败后通过。
2. 中：失败请求已扣预算但未传到 content，UI 显示旧计数。已修复：失败响应仅向绑定来源带权威预算快照，页面同步该快照。scheduler.test.mjs 与浏览器错误用例覆盖。

该轴发现 2 项需求偏差，已修复；未发现明确范围扩张。

## 验证与执行选择

最终 42 项单元测试、17 项隔离浏览器模拟场景通过。额外修复了输出大小、提前重置预算、在途 revision 重排队、重试 UI 等待长任务、保存失败后的新增权限清理；均有回归覆盖。

源码保留在 codex/bilingual-translator-next 独立工作区。原项目 dirty 改动保持原状，没有合并、推送或安装到日常浏览器。四服务真实账户与工具栏原生弹窗外壳仍未实测。

执行选择：原生 ES modules；核心纯函数与 provider 注册表合并相近职责文件；测试使用 Node 单进程隔离模式以适配进程权限；Playwright 使用独立下载的 Chrome for Testing 和临时 profile，测试包仅改 loopback endpoint 与 popup-as-tab 的目标页绑定。正式包不含这些测试改动。具体影响与限制见验证记录和执行 ledger。
