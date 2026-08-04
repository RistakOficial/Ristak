export const MOBILE_CHAT_CACHE_FALLBACK_GRACE_MS = 350

export function shouldRevealMobileChatCacheFallback({
  freshResolved,
  hasCachedData,
  requestIsCurrent
}: {
  freshResolved: boolean
  hasCachedData: boolean
  requestIsCurrent: boolean
}) {
  return hasCachedData && !freshResolved && requestIsCurrent
}
