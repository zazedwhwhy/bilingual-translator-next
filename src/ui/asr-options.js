import { validateAsrConfig } from "../media/asr.js";
import { saveWithPermission } from "./permission-save.js";
import { providers } from "../providers/registry.js";
export async function mountAsrOptions() {
  const $ = (id) => document.getElementById(id);
  const send = async (type, data = {}) => {
    const reply = await chrome.runtime.sendMessage({
      channel: "BT_BG",
      type,
      ...data,
    });
    if (!reply?.ok)
      throw Object.assign(
        Error(reply?.error?.message || "语音设置操作失败"),
        reply?.error,
      );
    return reply.data;
  };
  const show = (text) => ($("asr-config-status").textContent = text);
  const action = async (fn) => {
    try {
      await fn();
    } catch (error) {
      show((error.code || "ERROR") + "：" + error.message);
    }
  };
  let origins = new Set();
  $("asr-endpoint").onchange = () => {
    $("asr-key").value = "";
    show("更换接口后需要填写对应语音密钥。");
  };
  $("asr-save").onclick = () => {
    let config;
    try {
      config = {
        endpoint: $("asr-endpoint").value,
        model: $("asr-model").value,
        secret: $("asr-key").value,
        language: $("asr-language").value || "auto",
        responseFormat: $("asr-response").value,
      };
      const validated = validateAsrConfig({
        ...config,
        secret: config.secret || "retained-key",
      });
      const origin = validated.origin,
        granted = chrome.permissions.request({ origins: [origin] });
      void action(async () => {
        show("正在保存语音连接…");
        await saveWithPermission({
          granted,
          origin,
          alreadyGranted: origins.has(origin),
          save: () => send("ASR_SAVE", { config }),
          isUsed: async (origin) => {
            const [asr, text] = await Promise.all([
              send("ASR_CONFIG"),
              send("CONFIG"),
            ]);
            return (
              (asr.hasKey && asr.origin === origin) ||
              (text.hasKey && providers[text.provider].origin === origin)
            );
          },
          remove: (origin) => chrome.permissions.remove({ origins: [origin] }),
        });
        origins = new Set((await chrome.permissions.getAll()).origins || []);
        $("asr-key").value = "";
        show("语音配置已保存。保存没有调用语音服务。");
      });
    } catch (error) {
      show(error.message);
    }
  };
  $("asr-clear").onclick = () =>
    void action(async () => {
      await send("ASR_CLEAR_KEY");
      $("asr-key").value = "";
      show("语音密钥已移除，进行中的语音任务已停止。");
    });
  await action(async () => {
    const c = await send("ASR_CONFIG");
    origins = new Set((await chrome.permissions.getAll()).origins || []);
    $("asr-endpoint").value = c.endpoint;
    $("asr-model").value = c.model;
    $("asr-language").value = c.language;
    $("asr-response").value = c.responseFormat;
    $("asr-fields").disabled = false;
    show(
      c.hasKey
        ? "语音密钥已保存；留空保留。"
        : "语音识别与文本翻译使用独立的接口和密钥。",
    );
  });
}
