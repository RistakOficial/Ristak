export const CHAT_LIST_PAGE_SIZE = 50;
export const NATIVE_INBOX_CACHE_KEY = 'chats';
export const NATIVE_INBOX_CACHE_LIMIT = 200;
export const CONVERSATION_MESSAGE_CACHE_LIMIT = 150;

// Account-scoped snapshot keys. `cache.ts` supplies the session namespace; the
// keys below describe which screen/query owns a value inside that namespace.
// Keep range, scope and chart explicit so a cached 30-day dashboard never
// briefly masquerades as a custom range while the server revalidates it.
export const MOBILE_CACHE_KEYS = {
  paymentAccountContext: 'payments:account-context',
  paymentAccess: 'payments:access',
  paymentProducts: 'payments:products',
  paymentSettings: 'payments:settings',
  analyticsAccountContext: 'analytics:account-context',
  analyticsPhones: 'analytics:whatsapp-phones',
  settingsAppConfig: 'settings:app-config',
  settingsUserConfig: 'settings:user-config',
  settingsWhatsAppStatus: 'settings:whatsapp-status',
  settingsTemplates: 'settings:templates',
  settingsCustomFields: 'settings:custom-fields',
  settingsTags: 'settings:tags',
  settingsCalendars: 'settings:calendars',
  settingsAIAgent: 'settings:ai-agent',
  chatFilterCatalog: 'chat:filter-catalog',
} as const;

export function paymentRecentCacheKey(period: string, startDate: string, endDate: string): string {
  return `payments:recent:${period}:${startDate}_${endDate}`;
}

export function analyticsMetricsCacheKey(startDate: string, endDate: string): string {
  return `analytics:metrics:${startDate}_${endDate}`;
}

export function analyticsChartCacheKey(
  startDate: string,
  endDate: string,
  chartView: string,
  scope: string,
): string {
  return `analytics:chart:${startDate}_${endDate}:${chartView}:${scope}`;
}

export function analyticsFunnelCacheKey(startDate: string, endDate: string, scope: string): string {
  return `analytics:funnel:${startDate}_${endDate}:${scope}`;
}

export function analyticsOriginCacheKey(startDate: string, endDate: string, hasWebAnalyticsAccess: boolean): string {
  return `analytics:origin:${startDate}_${endDate}:${hasWebAnalyticsAccess ? 'web' : 'crm'}`;
}

export function conversationCacheKey(contactId: string): string {
  return `conv:${contactId}`;
}
