const language = (value) =>
  typeof value === "string"
    ? value.toLowerCase().replace(/^ai-/, "").split(/[-_]/)[0]
    : "";
export function preferredCaption(
  video,
  { source = "auto", target = "zh-CN" } = {},
) {
  const targetLanguage = language(target),
    sourceLanguage = language(source);
  return (
    (video?.tracks || [])
      .filter((track) => {
        const value = language(track.language);
        return (
          /^[a-z]{2,3}$/.test(value) &&
          !["und", "auto"].includes(value) &&
          value !== targetLanguage &&
          (source === "auto" || value === sourceLanguage)
        );
      })
      .map((track, index) => ({
        track,
        index,
        rank:
          (language(track.language) === "en" ? 0 : 2) +
          (track.automatic ? 1 : 0),
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.track || null
  );
}
