type ChatSelectionCandidate = string | { id?: string | null } | null | undefined;

function cleanChatId(value: unknown) {
  return String(value || '').trim();
}

export function normalizeChatSelectionIds(candidates: ChatSelectionCandidate[]) {
  const ids: string[] = [];
  const seen = new Set<string>();

  candidates.forEach((candidate) => {
    const id = cleanChatId(typeof candidate === 'string' ? candidate : candidate?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  });

  return ids;
}

export function toggleVisibleChatSelectionIds(current: string[], visible: string[]) {
  const currentIds = normalizeChatSelectionIds(current);
  const visibleIds = normalizeChatSelectionIds(visible);
  if (!visibleIds.length) return currentIds;

  const selected = new Set(currentIds);
  if (visibleIds.every((id) => selected.has(id))) {
    const visibleSet = new Set(visibleIds);
    return currentIds.filter((id) => !visibleSet.has(id));
  }

  visibleIds.forEach((id) => selected.add(id));
  return Array.from(selected);
}
