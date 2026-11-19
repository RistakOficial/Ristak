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

export type AnalyticsPeriod = '30d' | '60d' | '180d' | 'year' | 'custom';
type AnalyticsScope = AnalyticsRangeContext | { period: Exclude<AnalyticsPeriod, 'custom'>; timezone: string; currency: string };
export type AnalyticsReportQuery = { exactKey: string; periodKey: string; startDate: string; endDate: string };

export function analyticsReportQuery(
  range: AnalyticsRangeContext,
  period: AnalyticsPeriod,
  build: (scope: AnalyticsScope) => string,
): AnalyticsReportQuery {
  return {
    exactKey: build(range),
    periodKey: period === 'custom' ? '' : build({ period, timezone: range.timezone, currency: range.currency }),
    startDate: range.startDate,
    endDate: range.endDate,
  };
}

function analyticsRangeKey(range: AnalyticsScope) {
  return 'period' in range
    ? ['period', range.period, range.timezone, range.currency].join('|')
    : [range.startDate, range.endDate, range.timezone, range.currency].join('|');
}

export function analyticsMetricsCacheKey(range: AnalyticsScope): string {
  return `analytics:metrics:${analyticsRangeKey(range)}`;
}

export function analyticsChartCacheKey(range: AnalyticsScope, chartView: string, scope: string): string {
  return `analytics:chart:${analyticsRangeKey(range)}:${chartView}:${scope}`;
}

export function analyticsFunnelCacheKey(range: AnalyticsScope, scope: string, includeWeb: boolean): string {
  return `analytics:funnel:${analyticsRangeKey(range)}:${scope}:${includeWeb ? 'web' : 'crm'}`;
}

export function analyticsOriginCacheKey(range: AnalyticsScope, includeWeb: boolean, family: 'origin' | 'phone-origin' = 'origin'): string {
  return `analytics:${family}:${analyticsRangeKey(range)}:${includeWeb ? 'web' : 'crm'}`;
}

export function conversationCacheKey(contactId: string): string {
  return `conv:${contactId}`;
}
