import { validateCues } from "./cues.js";
export function priorityCueIds(cues, time) {
  const indexed = cues.map((cue, index) => ({ cue, index }));
  if (Number.isFinite(time))
    indexed.sort((a, b) => {
      const rank = ({ cue, index }) =>
        cue.end > time
          ? cue.start <= time
            ? 0
            : 1 + cue.start - time
          : 1000000 + index;
      return rank(a) - rank(b);
    });
  return indexed.map(({ index }) => "cue" + index);
}
export function cueDocument(cues, name = "字幕", { priorityTime } = {}) {
  validateCues(cues);
  const model = {
    kind: "subtitles",
    name,
    batchItems: true,
    cues,
    segments: cues.map((cue, index) => ({
      id: "cue" + index,
      text: cue.text,
      location: cue.start.toFixed(3) + " → " + cue.end.toFixed(3),
      cueId: cue.id,
    })),
  };
  if (Number.isFinite(priorityTime)) {
    const rank = new Map(
      priorityCueIds(cues, priorityTime).map((id, index) => [id, index]),
    );
    model.segments.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  }
  return model;
}
export function translatedCues(document, translations) {
  return document.cues.map((cue, index) => ({
    ...cue,
    ...(translations.has("cue" + index)
      ? { translation: translations.get("cue" + index) }
      : {}),
  }));
}
export function activeSubtitle(cues, time, offset = 0) {
  return cues
    .filter((cue) => cue.start + offset <= time && cue.end + offset > time)
    .map((cue) => cue.text + (cue.translation ? "\n" + cue.translation : ""))
    .join("\n");
}
