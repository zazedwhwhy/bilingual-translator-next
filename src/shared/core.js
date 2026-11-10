export const length = (text) => [...text].length;
export class Failure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "TranslationError";
    this.code = code;
    Object.assign(this, details);
  }
}
export const fail = (code, message, details) => {
  throw new Failure(code, message, details);
};
export function publicError(error) {
  const messages = {
    LEARNING_PROVIDER:
      "当前翻译服务不能生成学习内容，请在连接设置中选择已配置的文字模型。",
    LEARNING_RESPONSE: "学习结果格式或原文证据无效，未保存，请手动重试。",
    LEARNING_INVALID:
      "学习资料或设置格式无效，未保存。请检查导入文件或学习库容量。",
    LEARNING_ERROR: "学习操作失败，请检查设置或页面状态后手动重试。",
    AUTH_FAILED: "API Key 无效或没有权限，请检查设置。",
    PERMISSION_MISSING: "访问权限未授予，请在设置中重新授权。",
    CONFIG_INVALID: "翻译配置无效或已改变，请检查设置后重新开始。",
    VIDEO_UNAVAILABLE: "当前页面没有可访问的主视频，请先打开并播放视频。",
    VIDEO_CHANGED: "视频或分P已切换，请重新读取当前字幕。",
    SUBTITLE_LOGIN_REQUIRED:
      "这个视频的字幕需要先在原网站登录。可手动导入字幕；不会自动调用语音识别。",
    SUBTITLE_UNAVAILABLE:
      "没有匹配原文语言的可读现成外语字幕。可选择轨道或导入SRT/VTT；不会自动调用语音识别。",
    SUBTITLE_EMPTY:
      "网站返回了空字幕。请先在原播放器确认字幕可见，再手动重试或换轨道。",
    SUBTITLE_INVALID: "字幕内容或时间轴无效，本次未开始翻译。",
    SUBTITLE_HTTP_ERROR: "网站没有允许读取字幕，请在原播放器检查字幕访问状态。",
    SUBTITLE_FETCH_FAILED: "现成字幕下载失败，请检查原播放器后手动重试。",
    AUTO_INIT_FAILED: "自动翻译初始化失败，请重新设置；仍可手动翻译。",
    AUTO_SAVE_FAILED: "自动翻译设置未保存，请重试；重新启动后可能恢复原设置。",
    INTERACTION_INIT_FAILED: "快捷翻译初始化失败，请在设置中重新开启。",
    INTERACTION_STATE_INVALID: "快捷翻译用量记录无效，请重新打开网页。",
    INTERACTION_DISABLED: "这个翻译入口已关闭，请在设置中开启。",
    INTERACTION_TOO_LONG: "一次最多翻译6000字符，请缩小选区。",
    BUDGET_EXCEEDED: "本页快捷翻译额度已用尽，请确认后继续下一轮。",
    INPUT_CHANGED: "原文或编辑区已改变，请重新翻译；当前输入未替换。",
    INPUT_UNSUPPORTED: "这个编辑区不支持安全替换，可选中文字后翻译并复制。",
    INPUT_REJECTED: "编辑器阻止了替换，请复制译文后自行粘贴。",
    QUOTA_EXCEEDED: "服务额度不足，请检查账户。",
    RATE_LIMITED: "服务限流，请稍后手动重试。",
    TIMEOUT: "请求超时，远端可能已处理，请手动重试。",
    NETWORK_ERROR: "网络请求失败，远端处理结果未知。",
    HTTP_ERROR: "翻译服务返回错误。",
    RESPONSE_FORMAT: "服务返回格式不完整，本批未应用。",
    RESPONSE_TOO_LARGE: "服务响应过大，本批未应用。",
    CANCELLED: "任务已停止。",
    INTERRUPTED: "连接已中断，可能已计费，请显式重新开始。",
    OUTCOME_UNKNOWN: "请求结果未知，可能已计费，请显式重新开始。",
  };
  return {
    code: error.code || "INTERNAL_ERROR",
    message: messages[error.code] || "操作失败，请检查配置或重新开始。",
    status: error.status,
    manualRetryAllowed: ![
      "AUTH_FAILED",
      "QUOTA_EXCEEDED",
      "CONFIG_INVALID",
      "PERMISSION_MISSING",
      "CANCELLED",
      "INTERRUPTED",
      "OUTCOME_UNKNOWN",
    ].includes(error.code),
    retryAfterMs: error.retryAfterMs,
  };
}
export function validateBatch(value) {
  if (
    !value ||
    Object.keys(value).some(
      (k) => !["jobId", "batchId", "items"].includes(k),
    ) ||
    typeof value.jobId !== "string" ||
    typeof value.batchId !== "string" ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.length > 8
  )
    fail("INVALID_MESSAGE", "请求无效");
  const ids = new Set();
  let chars = 0;
  for (const x of value.items) {
    if (
      typeof x.id !== "string" ||
      !x.id ||
      ids.has(x.id) ||
      typeof x.text !== "string" ||
      !x.text.trim()
    )
      fail("INVALID_MESSAGE", "请求无效");
    ids.add(x.id);
    chars += length(x.text);
  }
  if (
    chars > 2400 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 65536
  )
    fail("INVALID_MESSAGE", "请求过大");
  return value;
}
export function parseTranslations(text, ids) {
  let result;
  try {
    const clean = text
      .trim()
      .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
    result = JSON.parse(clean).translations;
  } catch {
    fail("RESPONSE_FORMAT", "格式无效");
  }
  if (!Array.isArray(result) || result.length !== ids.length)
    fail("RESPONSE_FORMAT", "格式不完整");
  const map = new Map();
  for (const x of result) {
    if (
      !x ||
      typeof x.text !== "string" ||
      !x.text.trim() ||
      !ids.includes(x.id) ||
      map.has(x.id)
    )
      fail("RESPONSE_FORMAT", "格式无效");
    if (new TextEncoder().encode(x.text).length > 65536)
      fail("RESPONSE_TOO_LARGE", "译文过大");
    map.set(x.id, { id: x.id, text: x.text });
  }
  return ids.map((id) => map.get(id));
}
export function splitText(text, max = 1200) {
  const chars = [...text],
    out = [];
  for (let start = 0; start < chars.length; ) {
    let end = Math.min(start + max, chars.length);
    if (end < chars.length) {
      for (let i = end - 1; i > start + max / 2; i--)
        if (/[.!?。！？\n]/u.test(chars[i])) {
          end = i + 1;
          break;
        }
    }
    out.push(chars.slice(start, end).join(""));
    start = end;
  }
  return out;
}
export function batches(items) {
  const out = [];
  let row = [],
    n = 0;
  for (const x of items) {
    const c = length(x.text);
    if (row.length && (row.length === 8 || n + c > 2400)) {
      out.push(row);
      row = [];
      n = 0;
    }
    row.push(x);
    n += c;
  }
  if (row.length) out.push(row);
  return out;
}
export class Budget {
  constructor() {
    this.round = 1;
    this.used = 0;
    this.chars = 0;
    this.total = 0;
    this.totalChars = 0;
    this.reservations = new Map();
  }
  reserve(id, texts) {
    const n = texts.length,
      c = texts.reduce((a, t) => a + length(t), 0);
    if (n > 300 || c > 60000) fail("SEGMENT_TOO_LARGE", "段落超过一轮上限");
    if (this.reservations.has(id)) fail("INVALID_MESSAGE", "重复预留");
    const r = [...this.reservations.values()];
    if (
      this.used + n + r.reduce((a, x) => a + x.n, 0) > 300 ||
      this.chars + c + r.reduce((a, x) => a + x.c, 0) > 60000
    )
      return false;
    this.reservations.set(id, { n, c });
    return true;
  }
  dispatch(id, texts) {
    const r = this.reservations.get(id);
    if (!r) fail("INVALID_MESSAGE", "没有预算预留");
    const n = texts?.length ?? r.n,
      c = texts ? texts.reduce((a, t) => a + length(t), 0) : r.c;
    if (n > r.n || c > r.c) fail("INVALID_MESSAGE", "超过预留");
    r.n -= n;
    r.c -= c;
    this.used += n;
    this.chars += c;
    this.total += n;
    this.totalChars += c;
    if (!r.n) this.reservations.delete(id);
  }
  release(id) {
    this.reservations.delete(id);
  }
  nextRound() {
    if (this.reservations.size) fail("INVALID_STATE", "等待在途段落结束");
    this.round++;
    this.used = 0;
    this.chars = 0;
  }
  snapshot() {
    return {
      round: this.round,
      segmentsUsed: this.used,
      codePointsUsed: this.chars,
      lifetimeSegments: this.total,
      lifetimeCodePoints: this.totalChars,
    };
  }
}
export function phase(s) {
  if (s.cancelled) return "cancelled";
  if (s.interrupted) return "interrupted";
  if (s.fatal) return "error";
  if (s.errors) return s.translated ? "partial_error" : "error";
  if (s.budgetBlocked) return "paused_budget";
  if (s.active) return "translating";
  if (s.offscreen) return "waiting_visible";
  return "complete";
}
