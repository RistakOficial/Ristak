export type ChatMessageChannelKind = 'whatsapp_api' | 'whatsapp_qr' | 'instagram' | 'messenger' | 'sms' | 'email' | 'unknown';

export type ChatMessageChannelSignals = {
  eventType?: unknown;
  channel?: unknown;
  transport?: unknown;
  provider?: unknown;
  platform?: unknown;
  commentPlatform?: unknown;
  messageType?: unknown;
  hasEmail?: boolean;
};

export const CHAT_MESSAGE_OUTBOUND_BUBBLE_COLORS: Partial<Record<ChatMessageChannelKind, string>> = {
  whatsapp_api: '#d9fdd3',
  whatsapp_qr: '#c6efbd',
  instagram: '#f2d7e6',
  messenger: '#dbeafe',
};

export function getChatMessageBubbleBackground(channel: ChatMessageChannelKind, outbound: boolean) {
  if (!outbound) return undefined;
  return CHAT_MESSAGE_OUTBOUND_BUBBLE_COLORS[channel];
}

function normalizeSignal(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

function containsAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

export function resolveChatMessageChannel(signals: ChatMessageChannelSignals): ChatMessageChannelKind {
  const eventType = normalizeSignal(signals.eventType);
  const channel = normalizeSignal(signals.channel);
  const transport = normalizeSignal(signals.transport);
  const provider = normalizeSignal(signals.provider);
  const platform = normalizeSignal(signals.platform);
  const commentPlatform = normalizeSignal(signals.commentPlatform);
  const messageType = normalizeSignal(signals.messageType);
  const explicitProbe = [commentPlatform, platform, channel, provider, transport].filter(Boolean).join(' ');

  if (
    signals.hasEmail
    || eventType === 'email_message'
    || messageType === 'email'
    || containsAny(explicitProbe, ['email', 'e-mail', 'gmail', 'smtp', 'mailgun'])
  ) return 'email';

  if (containsAny(explicitProbe, ['instagram', 'instagram_comment']) || commentPlatform === 'instagram') {
    return 'instagram';
  }

  if (containsAny(explicitProbe, ['messenger', 'facebook', 'facebook_comment']) || commentPlatform === 'messenger') {
    return 'messenger';
  }

  if (eventType === 'sms_message' || messageType === 'sms' || containsAny(explicitProbe, ['sms', 'text_message', 'lc_phone'])) {
    return 'sms';
  }

  const isWhatsApp = (
    eventType === 'whatsapp_message'
    || containsAny(explicitProbe, ['whatsapp', 'waba', 'ycloud', 'baileys'])
    || ['api', 'qr', 'native', 'whatsapp_api'].includes(channel)
    || ['api', 'qr', 'baileys', 'web'].includes(transport)
  );
  if (isWhatsApp) {
    const usesQr = containsAny(`${channel} ${transport} ${provider}`, ['baileys', 'whatsapp_web', 'whatsapp_qr'])
      || ['qr', 'web'].includes(channel)
      || ['qr', 'web', 'baileys'].includes(transport)
      || ['qr', 'baileys'].includes(provider);
    return usesQr ? 'whatsapp_qr' : 'whatsapp_api';
  }

  return 'unknown';
}
