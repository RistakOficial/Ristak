const RISTAK_AD_ID_MARKER_PATTERN = /\brstkad_id\s*=\s*\d+!/ig
const RISTAK_AD_ID_PARENTHESIZED_MARKER_PATTERN = /\(\s*rstkad_id\s*=\s*\d+!\s*\)/ig
const RISTAK_AD_ID_BRACKETED_MARKER_PATTERN = /\[\s*rstkad_id\s*=\s*\d+!\s*\]/ig
const RISTAK_AD_ID_BRACED_MARKER_PATTERN = /\{\s*rstkad_id\s*=\s*\d+!\s*\}/ig

export function stripRistakAdIdMarkersFromText(value: unknown) {
  const text = String(value ?? '').trim()
  if (!/\brstkad_id\s*=\s*\d+!/i.test(text)) return text

  return text
    .replace(RISTAK_AD_ID_PARENTHESIZED_MARKER_PATTERN, ' ')
    .replace(RISTAK_AD_ID_BRACKETED_MARKER_PATTERN, ' ')
    .replace(RISTAK_AD_ID_BRACED_MARKER_PATTERN, ' ')
    .replace(RISTAK_AD_ID_MARKER_PATTERN, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
