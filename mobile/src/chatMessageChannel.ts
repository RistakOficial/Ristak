export type ChatMessageChannelKind = 'whatsapp_api' | 'whatsapp_qr' | 'instagram' | 'messenger' | 'sms' | 'email' | 'unknown';
export type ChatMessageBubbleTone = 'light' | 'dark';

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

export type ChatMessageBubblePalette = {
  inbound: string;
  outboundNeutral: string;
  outboundByChannel: Partial<Record<ChatMessageChannelKind, string>>;
  text: string;
  meta: string;
  scheduled: string;
  scheduledBorder: string;
  failed: string;
};

export const CHAT_MESSAGE_BUBBLE_PALETTES: Record<ChatMessageBubbleTone, ChatMessageBubblePalette> = {
  light: {
    inbound: '#ffffff',
    outboundNeutral: '#f0f1f4',
    outboundByChannel: {
      whatsapp_api: '#d9fdd3',
      whatsapp_qr: '#c6efbd',
      instagram: '#f2d7e6',
      messenger: '#dbeafe',
    },
    text: '#1d1d1f',
    meta: '#6e6e73',
    scheduled: '#f0f1f4',
    scheduledBorder: 'rgba(60,60,67,0.22)',
    failed: '#ffe4e8',
  },
  dark: {
    inbound: '#242527',
    outboundNeutral: '#303135',
    outboundByChannel: {
      whatsapp_api: '#0b4939',
      whatsapp_qr: '#124f3b',
      instagram: '#4a263d',
      messenger: '#1b3c66',
    },
    text: '#f5f5f7',
    meta: '#b7b7bd',
    scheduled: '#303135',
    scheduledBorder: 'rgba(235,235,245,0.32)',
    failed: '#55202a',
  },
};

export const CHAT_MESSAGE_OUTBOUND_BUBBLE_COLORS = CHAT_MESSAGE_BUBBLE_PALETTES.light.outboundByChannel;

export function getChatMessageBubblePalette(tone: ChatMessageBubbleTone = 'light') {
  return CHAT_MESSAGE_BUBBLE_PALETTES[tone];
}

export function getChatMessageBubbleBackground(
  channel: ChatMessageChannelKind,
  outbound: boolean,
  tone: ChatMessageBubbleTone = 'light',
) {
  if (!outbound) return undefined;
  return CHAT_MESSAGE_BUBBLE_PALETTES[tone].outboundByChannel[channel];
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
