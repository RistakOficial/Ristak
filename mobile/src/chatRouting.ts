import type { ChatContact, ChatMessage, WhatsAppApiPhoneNumber } from './types';
import { parseSortableDateValue } from './format';

export type NativeWhatsAppSenderRoute = {
  phoneNumberId?: string;
  fromPhone?: string;
  transport?: 'qr' | 'api';
};

export type LocalCatalogReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export type OutboundSendResultState = {
  status: string;
  pending: boolean;
  failed: boolean;
  errorReason: string;
};

const HIGHLEVEL_WHATSAPP_TRANSPORT_ALIASES = new Set([
  'ghl_whatsapp',
  'ghl_whatsapp_api',
  'highlevel_whatsapp',
  'highlevel_whatsapp_api',
]);

function cleanString(value: unknown) {
  return String(value || '').trim();
}

function normalizeRouteToken(value: unknown) {
  return cleanString(value).toLowerCase().replace(/[\s-]+/g, '_');
}

export function isHighLevelWhatsAppTransport(value: unknown) {
  return HIGHLEVEL_WHATSAPP_TRANSPORT_ALIASES.has(normalizeRouteToken(value));
}

function normalizePhoneForMatch(value: unknown) {
  return cleanString(value).replace(/\D/g, '');
}

function phonesMatch(left: unknown, right: unknown) {
  const leftDigits = normalizePhoneForMatch(left);
  const rightDigits = normalizePhoneForMatch(right);
  if (!leftDigits || !rightDigits) return false;
  return leftDigits === rightDigits
    || (leftDigits.length >= 10 && rightDigits.endsWith(leftDigits))
    || (rightDigits.length >= 10 && leftDigits.endsWith(rightDigits));
}

export function getNativeWhatsAppPhoneValue(phone?: WhatsAppApiPhoneNumber | null) {
  return cleanString(phone?.phone_number || phone?.display_phone_number || phone?.qr_connected_phone);
}

export function getPreferredWhatsAppPhoneId(contact: ChatContact) {
  return cleanString(
    contact.preferredWhatsAppPhoneNumberId
    || contact.preferred_whatsapp_phone_number_id
    || contact.lastInboundBusinessPhoneNumberId
    || contact.firstInboundBusinessPhoneNumberId
    || contact.lastBusinessPhoneNumberId,
  );
}

/**
 * Produces one coherent sender identity. When a phone is selected explicitly,
 * its id and visible phone travel together instead of mixing the selected id
 * with the contact's previous sender.
 */
export function normalizeNativeWhatsAppSenderRoute(
  contact: ChatContact,
  route: NativeWhatsAppSenderRoute = {},
): NativeWhatsAppSenderRoute {
  const phoneNumberId = cleanString(route.phoneNumberId) || getPreferredWhatsAppPhoneId(contact);
  let fromPhone = cleanString(route.fromPhone);

  if (!fromPhone && phoneNumberId && phoneNumberId === cleanString(contact.lastInboundBusinessPhoneNumberId)) {
    fromPhone = cleanString(contact.lastInboundBusinessPhone);
  }
  if (!fromPhone && phoneNumberId && phoneNumberId === cleanString(contact.firstInboundBusinessPhoneNumberId)) {
    fromPhone = cleanString(contact.firstInboundBusinessPhone);
  }
  if (!fromPhone && phoneNumberId && phoneNumberId === cleanString(contact.lastBusinessPhoneNumberId)) {
    fromPhone = cleanString(contact.lastBusinessPhone);
  }
  if (!fromPhone && !phoneNumberId) {
    fromPhone = cleanString(
      contact.lastInboundBusinessPhone
      || contact.firstInboundBusinessPhone
      || contact.lastBusinessPhone,
    );
  }

  return {
    phoneNumberId: phoneNumberId || undefined,
    fromPhone: fromPhone || undefined,
    transport: route.transport,
  };
}

export function buildNativeWhatsAppSenderRoute(
  contact: ChatContact,
  phone: WhatsAppApiPhoneNumber | null | undefined,
  transport: 'qr' | 'api',
): NativeWhatsAppSenderRoute {
  return normalizeNativeWhatsAppSenderRoute(contact, {
    phoneNumberId: cleanString(phone?.id) || undefined,
    fromPhone: getNativeWhatsAppPhoneValue(phone) || undefined,
    transport,
  });
}

function nativeMessageMatchesSender(message: ChatMessage, sender?: NativeWhatsAppSenderRoute) {
  const senderId = cleanString(sender?.phoneNumberId);
  const senderPhone = cleanString(sender?.fromPhone);
  if (!senderId && !senderPhone) return true;

  const messageId = cleanString(message.businessPhoneNumberId);
  const messagePhone = cleanString(message.businessPhone);
  if (senderId && messageId && senderId === messageId) return true;
  if (senderPhone && messagePhone && phonesMatch(senderPhone, messagePhone)) return true;

  // A selected sender must not borrow the reply window from another number.
  // Legacy rows without sender identity fail closed and require a template.
  return false;
}

export function nativeMessageOpensReplyWindow(
  message: ChatMessage,
  sender?: NativeWhatsAppSenderRoute,
) {
  if (message.direction !== 'inbound') return false;
  const probe = `${message.transport || ''} ${message.channel || ''}`.toLowerCase();
  if (
    probe.includes('sms')
    || probe.includes('messenger')
    || probe.includes('instagram')
    || probe.includes('email')
    || probe.includes('highlevel')
    || probe.includes('ghl_')
  ) return false;
  return nativeMessageMatchesSender(message, sender);
}

export function getNativeLastReplyWindowInboundTime(
  messages: ChatMessage[],
  sender?: NativeWhatsAppSenderRoute,
) {
  let newest = 0;
  messages.forEach((message) => {
    if (!nativeMessageOpensReplyWindow(message, sender)) return;
    const time = parseSortableDateValue(message.date);
    if (time > newest) newest = time;
  });
  return newest;
}

export function getLastHighLevelWhatsAppBusinessPhone(messages: ChatMessage[]) {
  let newest = 0;
  let businessPhone = '';
  messages.forEach((message) => {
    if (message.direction !== 'inbound') return;
    if (
      !isHighLevelWhatsAppTransport(message.transport)
      && !isHighLevelWhatsAppTransport(message.channel)
    ) return;
    const candidate = cleanString(message.businessPhone);
    const timestamp = parseSortableDateValue(message.date);
    if (!candidate || timestamp < newest) return;
    newest = timestamp;
    businessPhone = candidate;
  });
  return businessPhone;
}

export function getNativeApiReplyWindowOpen(
  messages: ChatMessage[],
  sender?: NativeWhatsAppSenderRoute,
  now = Date.now(),
) {
  const newest = getNativeLastReplyWindowInboundTime(messages, sender);
  if (!newest) return false;
  return now - newest < 24 * 60 * 60 * 1000;
}

/**
 * Retries a local catalog read once by default. This is request-scoped: it does
 * not start an interval and never polls Meta/HighLevel directly.
 */
export async function readLocalCatalogWithRetry<T>(
  loader: () => Promise<T>,
  retries = 1,
  retryDelayMs = 250,
): Promise<LocalCatalogReadResult<T>> {
  const safeRetries = Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= safeRetries; attempt += 1) {
    try {
      return { ok: true, value: await loader() };
    } catch (error) {
      lastError = error;
      const status = Number(
        error && typeof error === 'object' && 'status' in error
          ? (error as { status?: unknown }).status
          : 0,
      );
      const retryable = !Number.isFinite(status)
        || status <= 0
        || status === 408
        || status === 425
        || status === 429
        || status >= 500;
      if (attempt >= safeRetries || !retryable) break;
      if (retryDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return { ok: false, error: lastError };
}

export function keepLastKnownCatalogValue<T>(
  result: LocalCatalogReadResult<T>,
  lastKnown: T | null,
) {
  return result.ok ? result.value : lastKnown;
}

export function getOutboundMessageChannelFamily(message: Pick<ChatMessage, 'channel' | 'transport'>) {
  const raw = `${message.channel || ''} ${message.transport || ''}`.toLowerCase();
  if (raw.includes('ghl_') || raw.includes('highlevel')) {
    if (raw.includes('sms')) return 'highlevel_sms';
    if (raw.includes('whatsapp')) return 'highlevel_whatsapp';
    return 'highlevel_other';
  }
  // Meta Direct is a WhatsApp transport, not Messenger/Instagram. Matching a
  // generic `meta` token here used to strand Meta Direct optimistic bubbles.
  if (raw.includes('messenger') || raw.includes('instagram') || raw.includes('social') || raw.includes('facebook')) return 'meta_social';
  if (raw.includes('email') || raw.includes('mail')) return 'email';
  if (raw.includes('sms')) return 'sms';
  // `native` is the optimistic transport; its channel already carries the
  // actual family and only falls through here for native WhatsApp.
  if (
    raw.includes('whatsapp')
    || raw.includes('meta_direct')
    || raw.includes('ycloud')
    || raw.includes('baileys')
    || raw.includes('qr')
    || raw.includes('native')
  ) return 'whatsapp';
  return 'other';
}

/**
 * HTTP 2xx no equivale a entrega. HighLevel, en particular, puede aceptar el
 * POST y devolver después `failed`; el globo debe conservar `pending` o pintar
 * el error real en vez de forzar una palomita de éxito.
 */
export function getOutboundSendResultState(response?: {
  status?: unknown;
  success?: unknown;
  provider?: unknown;
  transport?: unknown;
  channel?: unknown;
  requestedChannel?: unknown;
  error?: unknown;
  errorMessage?: unknown;
  message?: unknown;
} | null): OutboundSendResultState {
  const normalized = normalizeRouteToken(response?.status);
  const providerProbe = [
    response?.provider,
    response?.transport,
    response?.channel,
    response?.requestedChannel,
  ].map(normalizeRouteToken).filter(Boolean).join(' ');
  const highLevelAccepted = providerProbe.includes('highlevel') || providerProbe.includes('ghl_');
  const failed = response?.success === false
    || ['failed', 'error', 'undelivered', 'bounced', 'rejected'].includes(normalized);
  const acceptedWithoutReceipt = highLevelAccepted
    && ['', 'sent', 'accepted', 'success', 'succeeded', 'ok'].includes(normalized);
  const pending = !failed && (
    acceptedWithoutReceipt
    || ['pending', 'queued', 'processing', 'scheduled', 'sending', 'enviando'].includes(normalized)
  );
  const rawReason = response?.errorMessage || response?.error || (failed ? response?.message : '');
  const errorReason = cleanString(
    rawReason && typeof rawReason === 'object'
      ? (rawReason as { message?: unknown }).message || JSON.stringify(rawReason)
      : rawReason,
  );

  return {
    status: failed ? 'failed' : (acceptedWithoutReceipt ? 'pending' : (normalized || 'sent')),
    pending,
    failed,
    errorReason: failed ? (errorReason || 'El proveedor rechazó el mensaje.') : '',
  };
}

/**
 * HighLevel responde normalmente con `messageId`, mientras otros proveedores
 * usan `id`. Leer ambos evita reconciliar por texto/tiempo cuando ya existe una
 * identidad remota exacta.
 */
export function getOutboundProviderMessageId(response: unknown) {
  if (!response || typeof response !== 'object') return '';
  const record = response as Record<string, unknown>;
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : {};
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : {};
  const dataMessage = data.message && typeof data.message === 'object'
    ? data.message as Record<string, unknown>
    : {};
  const messageIds = Array.isArray(record.messageIds) ? record.messageIds : [];

  return [
    record.messageId,
    messageIds[0],
    record.id,
    message.id,
    message.messageId,
    data.id,
    data.messageId,
    dataMessage.id,
    dataMessage.messageId,
  ].map(cleanString).find(Boolean) || '';
}
