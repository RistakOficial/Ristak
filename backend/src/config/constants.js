// Constantes y URLs de APIs centralizadas

// URL pública del servidor para webhooks
export const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3002'

export const API_URLS = {
  // HighLevel API
  HIGHLEVEL_BASE: 'https://services.leadconnectorhq.com',
  HIGHLEVEL_LOCATIONS: (locationId) => `https://services.leadconnectorhq.com/locations/${locationId}`,
  HIGHLEVEL_CONTACTS: 'https://services.leadconnectorhq.com/contacts',
  HIGHLEVEL_CONTACT: (contactId) => `https://services.leadconnectorhq.com/contacts/${contactId}`,
  HIGHLEVEL_CALENDARS: 'https://services.leadconnectorhq.com/calendars',
  HIGHLEVEL_CALENDAR_EVENTS: 'https://services.leadconnectorhq.com/calendars/events',
  HIGHLEVEL_PAYMENTS: 'https://services.leadconnectorhq.com/payments/transactions',
  HIGHLEVEL_CUSTOM_VALUES: (locationId) => `https://services.leadconnectorhq.com/locations/${locationId}/customValues`,
  HIGHLEVEL_CUSTOM_VALUE: (locationId, cvId) => `https://services.leadconnectorhq.com/locations/${locationId}/customValues/${cvId}`,

  // Meta Graph API
  META_GRAPH: 'https://graph.facebook.com/v23.0',
  META_AD_INSIGHTS: (accountId) => `https://graph.facebook.com/v23.0/act_${accountId}/insights`,
  META_TOKEN_DEBUG: 'https://graph.facebook.com/debug_token',
  META_TOKEN_REFRESH: 'https://graph.facebook.com/v23.0/oauth/access_token'
}

export const CUSTOM_VALUE_KEYS = {
  WEBHOOK_CONTACTS: 'webhook_contacts',
  WEBHOOK_PAYMENTS: 'webhook_payments',
  WEBHOOK_REFUNDS: 'webhook_refunds',
  WEBHOOK_APPOINTMENTS: 'webhook_appointments',
  WEBHOOK_WHATSAPP_ATTRIBUTION: 'webhook_whatsapp_attribution',
  META_AD_ACCOUNT_ID: 'Facebook - Ad Account ID',
  META_ACCESS_TOKEN: 'Facebook - App Access Token',
  META_APP_ID: 'Facebook - App ID',
  META_APP_SECRET: 'Facebook - App Secret'
}

export const WEBHOOK_PATHS = {
  CONTACT: '/webhook/contact',
  PAYMENT: '/webhook/payment',
  REFUND: '/webhook/refund',
  APPOINTMENT: '/webhook/appointment',
  WHATSAPP_ATTRIBUTION: '/webhook/whatsapp/attribution'
}

export const PAGINATION = {
  HIGHLEVEL_CONTACTS_LIMIT: 100,
  HIGHLEVEL_PAYMENTS_LIMIT: 100,
  HIGHLEVEL_APPOINTMENTS_LIMIT: 100,
  META_ADS_LIMIT: 500
}

export const META_INSIGHTS_FIELDS = [
  'date_start',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'reach',
  'clicks',
  'cpc'
].join(',')

export const SYNC_STATUS = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  COMPLETED: 'completed',
  ERROR: 'error'
}
