export const CHAT_LIVE_FIRST_CACHE_GRACE_MS = 350;

export function shouldRevealChatCacheFallback({
  freshResolved,
  hasCachedData,
  requestIsCurrent,
}: {
  freshResolved: boolean;
  hasCachedData: boolean;
  requestIsCurrent: boolean;
}) {
  return hasCachedData && !freshResolved && requestIsCurrent;
}
