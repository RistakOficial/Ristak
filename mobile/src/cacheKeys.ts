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
  chatFilterCatalog: 'chat:filter-catalog',
  firstSyncCompleted: 'mobile:first-sync:completed',
} as const;

export function paymentRecentCacheKey(period: string, startDate: string, endDate: string): string {
  return `payments:recent:${period}:${startDate}_${endDate}`;
}

export type AnalyticsRangeContext = {
  startDate: string;
  endDate: string;
  timezone: string;
  currency: string;
};

function analyticsRangeKey(range: AnalyticsRangeContext) {
  return [range.startDate, range.endDate, range.timezone, range.currency].join('|');
}

export function analyticsMetricsCacheKey(range: AnalyticsRangeContext): string {
  return `analytics:metrics:${analyticsRangeKey(range)}`;
}

export function analyticsChartCacheKey(range: AnalyticsRangeContext, chartView: string, scope: string): string {
  return `analytics:chart:${analyticsRangeKey(range)}:${chartView}:${scope}`;
}

export function analyticsFunnelCacheKey(range: AnalyticsRangeContext, scope: string, includeWeb: boolean): string {
  return `analytics:funnel:${analyticsRangeKey(range)}:${scope}:${includeWeb ? 'web' : 'crm'}`;
}

export function analyticsOriginCacheKey(range: AnalyticsRangeContext, includeWeb: boolean, family: 'origin' | 'phone-origin' = 'origin'): string {
  return `analytics:${family}:${analyticsRangeKey(range)}:${includeWeb ? 'web' : 'crm'}`;
}

export function conversationCacheKey(contactId: string): string {
  return `conv:${contactId}`;
}
