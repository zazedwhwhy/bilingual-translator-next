import { Failure, fail } from "../shared/core.js";
import { validateTimedSegments, parseSubtitles } from "../subtitles/cues.js";
export function validateAsrConfig(input) {
  let url;
  try {
    url = new URL(input.endpoint);
  } catch {
    fail("ASR_CONFIG_INVALID", "语音识别接口地址无效");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    fail(
      "ASR_CONFIG_INVALID",
      "语音接口必须是HTTPS，或本机测试地址，且不能在URL中放密钥",
    );
  if (
    typeof input.secret !== "string" ||
    !input.secret.trim() ||
    /[\r\n]/.test(input.secret) ||
    input.secret.length > 4096
  )
    fail("ASR_CONFIG_INVALID", "请填写语音服务API Key");
  if (
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 200
  )
    fail("ASR_CONFIG_INVALID", "请填写支持时间戳的语音模型");
  if (
    !["verbose_json", "diarized_json", "vtt", "srt"].includes(
      input.responseFormat,
    )
  )
    fail("ASR_CONFIG_INVALID", "必须选择带时间轴的响应协议");
  const language = input.language || "auto";
  if (language !== "auto" && !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language))
    fail("ASR_CONFIG_INVALID", "语音语言代码无效");
  return {
    endpoint: url.href,
    origin: url.protocol + "//" + url.hostname + "/*",
    model: input.model.trim(),
    secret: input.secret.trim(),
    language,
    responseFormat: input.responseFormat,
  };
}
export function publicAsrConfig(config) {
  if (!config)
    return {
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "",
      language: "auto",
      responseFormat: "verbose_json",
      hasKey: false,
    };
  const { secret, ...publicConfig } = config;
  return { ...publicConfig, hasKey: !!secret };
}
export async function transcribeBlob(
  blob,
  config,
  { signal, fetcher = fetch, timeout = 120000, duration } = {},
) {
  if (!(blob instanceof Blob) || !blob.size)
    fail("AUDIO_INVALID", "音频文件为空");
  if (blob.size >= 25 * 1024 * 1024)
    fail("AUDIO_TOO_LARGE", "音频片段必须小于25 MiB，请分段或压缩后再识别");
  const form = new FormData();
  form.append(
    "file",
    blob,
    (config.name || "audio.webm").replace(/[\r\n\\/]/g, "_").slice(-180),
  );
  form.append("model", config.model);
  form.append("response_format", config.responseFormat);
  if (config.responseFormat === "verbose_json")
    form.append("timestamp_granularities[]", "segment");
  if (config.responseFormat === "diarized_json")
    form.append("chunking_strategy", "auto");
  if (config.language && config.language !== "auto")
    form.append("language", config.language);
  const controller = new AbortController(),
    abort = () => controller.abort(new Failure("CANCELLED", "语音识别已停止"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Failure("TIMEOUT", "语音识别超时，远端可能已处理，请手动重试"),
      ),
    timeout,
  );
  let reader;
  const network = async (perform) => {
    try {
      return await perform();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TypeError || error?.name === "NetworkError")
        throw new Failure(
          "NETWORK_ERROR",
          "语音请求连接失败，结果未知，请手动重试",
          { cause: error },
        );
      throw error;
    }
  };
  try {
    const response = await network(() =>
      fetcher(config.endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + config.secret },
        body: form,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Failure(
        [401, 403].includes(response.status)
          ? "AUTH_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "ASR_HTTP_ERROR",
        "语音服务请求失败（HTTP " + response.status + "）",
        { status: response.status },
      );
    }
    if (!response.body || typeof response.body.getReader !== "function")
      fail("ASR_RESPONSE_INVALID", "语音服务没有返回可读取的结果");
    reader = response.body.getReader();
    let size = 0;
    const pieces = [];
    for (;;) {
      const part = await network(() => reader.read());
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 5 * 1024 * 1024) fail("RESPONSE_TOO_LARGE", "语音结果过大");
      pieces.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of pieces) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    let cues;
    if (["srt", "vtt"].includes(config.responseFormat))
      cues = parseSubtitles(text, config.responseFormat);
    else {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        fail("ASR_RESPONSE_INVALID", "语音服务返回了无效JSON");
      }
      cues = validateTimedSegments(data);
    }
    if (Number.isFinite(duration) && cues.some((cue) => cue.end > duration + 2))
      fail("ASR_TIMING_INVALID", "语音服务时间轴超出了实际音频时长");
    return cues;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (reader)
      try {
        await reader.cancel();
      } catch {}
  }
}
