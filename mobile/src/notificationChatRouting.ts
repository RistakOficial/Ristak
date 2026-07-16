import type { ChatContact } from './types';

export async function resolveNotificationChatContact(
  contactId: string,
  chats: ChatContact[],
  fetchContact: (contactId: string) => Promise<ChatContact>,
) {
  const cleanContactId = String(contactId || '').trim();
  if (!cleanContactId) return null;
  const cached = chats.find((contact) => contact?.id === cleanContactId);
  if (cached) return cached;
  const fetched = await fetchContact(cleanContactId);
  if (!fetched?.id || fetched.id !== cleanContactId) {
    throw new Error('El servidor no entregó el contacto solicitado por la notificación.');
  }
  return fetched;
}
