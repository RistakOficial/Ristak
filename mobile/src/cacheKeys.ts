export const CHAT_LIST_PAGE_SIZE = 50;
export const NATIVE_INBOX_CACHE_KEY = 'chats';
export const NATIVE_INBOX_CACHE_LIMIT = 200;
export const CONVERSATION_MESSAGE_CACHE_LIMIT = 150;

export function conversationCacheKey(contactId: string): string {
  return `conv:${contactId}`;
}
