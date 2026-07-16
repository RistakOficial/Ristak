export type CachePreloadFileSnapshot = {
  size: number;
  modifiedAt: number;
};

/**
 * A deferred preload runs while foreground screens may refresh the same cache
 * files. Only delete a candidate when it is still the exact file that was
 * inspected and no active screen owns a newer in-memory value.
 */
export function shouldDeletePreloadCandidate(
  captured: CachePreloadFileSnapshot,
  current: CachePreloadFileSnapshot | null,
  hasActiveMemoryValue: boolean,
): boolean {
  if (hasActiveMemoryValue || !current) return false;
  return current.size === captured.size && current.modifiedAt === captured.modifiedAt;
}
