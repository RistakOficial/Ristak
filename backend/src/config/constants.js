// Constantes y URLs de APIs centralizadas

// URL pública del servidor para webhooks
export const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3002'

// Version de Meta API (se actualiza dinamicamente desde BD)
// El startup del backend, GitHub Actions y el cron mensual revisan si hay version nueva.
let META_API_VERSION = process.env.META_API_VERSION?.trim() || 'v23.0' // Fallback inicial

/**
 * Actualiza la versión de Meta API en memoria
 * @param {string} version - Nueva versión (ej: "v24.0")
 */
export function setMetaApiVersion(version) {
  META_API_VERSION = version
}

/**
 * Obtiene la versión actual de Meta API
 * @returns {string} Versión actual (ej: "v23.0")
 */
export function getMetaApiVersion() {
  return META_API_VERSION
}

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

  // Meta Graph API (con versión dinámica)
  get META_GRAPH() { return `https://graph.facebook.com/${META_API_VERSION}` },
  META_AD_INSIGHTS: (accountId) => `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights`,
  META_TOKEN_DEBUG: 'https://graph.facebook.com/debug_token',
  get META_TOKEN_REFRESH() { return `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` },
  get META_OAUTH() { return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth` },
  get META_OAUTH_TOKEN() { return `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token` },
  get META_AD_ACCOUNTS() { return `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts` },
  get META_BUSINESS_PORTFOLIOS() { return `https://graph.facebook.com/${META_API_VERSION}/me/businesses` }
}

export const CUSTOM_VALUE_KEYS = {
  WEBHOOK_CONTACTS: 'webhook_contacts',
  WEBHOOK_PAYMENTS: 'webhook_payments',
  WEBHOOK_INVOICE: 'webhook_invoice',
  WEBHOOK_REFUNDS: 'webhook_refunds',
  WEBHOOK_APPOINTMENTS: 'webhook_appointments',
  WEBHOOK_APPOINTMENT_SHOWED: 'webhook_appointment_showed',
  WEBHOOK_WHATSAPP_ATTRIBUTION: 'webhook_whatsapp_attribution',
  WEBHOOK_CONVERSATIONS: 'webhook_conversations',
  META_AD_ACCOUNT_ID: 'Facebook - Ad Account ID',
  META_ACCESS_TOKEN: 'Facebook - App Access Token',
  META_APP_ID: 'Facebook - App ID',
  META_APP_SECRET: 'Facebook - App Secret'
}

export const WEBHOOK_PATHS = {
  CONTACT: '/webhook/contact',
  PAYMENT: '/webhook/payment',
  INVOICE: '/webhook/invoice',
  REFUND: '/webhook/refund',
  APPOINTMENT: '/webhook/appointment',
  APPOINTMENT_SHOWED: '/webhook/appointment/showed',
  WHATSAPP_ATTRIBUTION: '/webhook/whatsapp/attribution',
  CONVERSATION: '/webhook/conversation'
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

// Scopes necesarios para OAuth de Meta
export const META_OAUTH_SCOPES = [
  'ads_read',              // Leer datos de anuncios
  'ads_management',        // Gestionar campañas (opcional pero recomendado)
  'business_management',   // Acceso a Business Manager
  'pages_show_list'        // Listar páginas asignadas al usuario/sistema
].join(',')

export const SYNC_STATUS = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  COMPLETED: 'completed',
  ERROR: 'error'
}
