export function platformIdentity(value) {
  const url = new URL(value);
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    const id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1];
    return id ? "youtube:" + id : "youtube:none";
  }
  if (/(^|\.)bilibili\.com$/.test(url.hostname)) {
    const bvid = url.pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1];
    return bvid
      ? "bilibili:" + bvid + ":" + (url.searchParams.get("p") || "1")
      : "bilibili:none";
  }
  return null;
}
export function sourceIdentity(video, value) {
  const identity = platformIdentity(value);
  if (!identity?.startsWith("bilibili:")) return identity;
  const bvid = new URL(value).pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)?.[1],
    active = video.getAttribute("data-bt-next-source-id");
  return bvid && active?.startsWith("bilibili:" + bvid + ":")
    ? active
    : "bilibili:unavailable";
}
