export const AUTO_ORIGINS = ["http://*/*", "https://*/*"];
export const AUTO_SCRIPT_ID = "bt-next-auto-page";
const base = (value) =>
  typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : "";
export function foreignLanguage({ declared, sample, target, detected }) {
  if (typeof sample !== "string" || (sample.match(/\p{L}/gu) || []).length < 40)
    return null;
  const first = detected?.languages?.[0],
    language = base(first?.language),
    targetLanguage = base(target);
  if (
    !/^[a-z]{2,3}$/.test(language) ||
    language === "und" ||
    language === targetLanguage
  )
    return null;
  if (
    detected.isReliable !== true &&
    !(language === base(declared) && first.percentage >= 80)
  )
    return null;
  if (first.percentage < 70) return null;
  // Do not let an English HTML declaration override substantial Chinese text.
  if (
    targetLanguage === "zh" &&
    (sample.match(/\p{Script=Han}/gu) || []).length >
      (sample.match(/\p{L}/gu) || []).length * 0.35
  )
    return null;
  return language;
}
