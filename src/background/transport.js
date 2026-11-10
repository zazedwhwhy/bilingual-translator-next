import { Failure, fail } from "../shared/core.js";
export async function requestJson(
  spec,
  { signal, fetcher = fetch, timeout = 25000 } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Failure("CANCELLED", "停止"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Failure("TIMEOUT", "超时")),
    timeout,
  );
  let reader;
  const network = async (perform) => {
    try {
      return await perform();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TypeError || error?.name === "NetworkError")
        throw new Failure("NETWORK_ERROR", "网络错误", { cause: error });
      throw error;
    }
  };
  try {
    const res = await network(() =>
      fetcher(spec.url, {
        ...spec,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
      }),
    );
    if (!res.ok) {
      const seconds = Number(res.headers.get("Retry-After"));
      const date = Date.parse(res.headers.get("Retry-After"));
      const retryAfterMs =
        Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Number.isFinite(date)
            ? Math.max(0, date - Date.now())
            : undefined;
      const code = [401, 403].includes(res.status)
        ? "AUTH_FAILED"
        : res.status === 429
          ? "RATE_LIMITED"
          : res.status === 402
            ? "QUOTA_EXCEEDED"
            : "HTTP_ERROR";
      await res.body?.cancel();
      throw new Failure(code, "服务错误", { status: res.status, retryAfterMs });
    }
    let size = 0;
    const chunks = [];
    reader = res.body?.getReader();
    if (!reader) fail("RESPONSE_FORMAT", "响应为空");
    for (;;) {
      const { value, done } = await network(() => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > 262144) fail("RESPONSE_TOO_LARGE", "响应过大");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const x of chunks) {
      bytes.set(x, offset);
      offset += x.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail("RESPONSE_FORMAT", "格式无效");
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (reader)
      try {
        await reader.cancel();
      } catch {
        /* Cleanup cannot replace the primary request outcome. */
      }
  }
}
