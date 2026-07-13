import { db } from '../config/database.js'

export const INTEGRATION_APP_CONFIG_KEYS = {
  email: [
    'email_smtp_config',
    'email_smtp_password'
  ],
  googleCalendar: [
    'google_calendar_service_account_config'
  ],
  meta: [
    'meta_test_event_code',
    'meta_webhook_verify_token',
    'meta_whatsapp_business_account_id',
    'meta_whatsapp_purchase_enabled',
    'meta_whatsapp_schedule_enabled',
    'meta_payment_purchase_event_config',
    'meta_messenger_messaging_enabled',
    'meta_instagram_messaging_enabled',
    'meta_facebook_comments_enabled',
    'meta_instagram_comments_enabled',
    'meta_oauth_relay_last_received_at'
  ],
  whatsappApi: [
    'whatsapp_api_ycloud_api_key_encrypted',
    'whatsapp_api_key',
    'whatsapp_api_sender_phone',
    'whatsapp_api_phone_number_id',
    'whatsapp_api_waba_id',
    'whatsapp_api_webhook_endpoint_id',
    'whatsapp_api_webhook_secret_encrypted',
    'whatsapp_api_webhook_url',
    'whatsapp_api_webhook_status',
    'whatsapp_api_connected_at',
    'whatsapp_api_last_synced_at'
  ],
  whatsappMetaDirect: [
    'whatsapp_meta_direct_status',
    'whatsapp_meta_direct_app_id',
    'whatsapp_meta_direct_business_id',
    'whatsapp_meta_direct_waba_id',
    'whatsapp_meta_direct_phone_number_id',
    'whatsapp_meta_direct_display_phone_number',
    'whatsapp_meta_direct_coexistence_enabled',
    'whatsapp_meta_direct_system_user_token_encrypted',
    'whatsapp_meta_direct_webhook_mode',
    'whatsapp_meta_direct_installer_webhook_url',
    'whatsapp_meta_direct_installer_oauth_callback_url',
    'whatsapp_meta_direct_connected_at',
    'whatsapp_meta_direct_last_webhook_received_at',
    'whatsapp_meta_direct_last_relay_received_at',
    'whatsapp_meta_direct_last_subscription_refresh_at',
    'whatsapp_meta_direct_last_error',
    'whatsapp_meta_direct_dataset_id',
    'whatsapp_meta_direct_ad_account_id'
  ]
}

export function getIntegrationAppConfigKeys(...groups) {
  return groups.flatMap(group => INTEGRATION_APP_CONFIG_KEYS[group] || [])
}

export async function deleteAppConfigKeys(keys = []) {
  const uniqueKeys = [...new Set(keys.map(key => String(key || '').trim()).filter(Boolean))]
  if (!uniqueKeys.length) return { deletedKeys: [] }

  const placeholders = uniqueKeys.map(() => '?').join(', ')
  await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
  return { deletedKeys: uniqueKeys }
}

export async function clearEmailIntegrationCredentials() {
  return deleteAppConfigKeys(getIntegrationAppConfigKeys('email'))
}

export async function clearGoogleCalendarIntegrationCredentials() {
  return deleteAppConfigKeys(getIntegrationAppConfigKeys('googleCalendar'))
}

export async function clearHighLevelIntegrationCredentials() {
  await db.run('DELETE FROM highlevel_config')
}

export async function clearMetaIntegrationCredentials() {
  await db.run('DELETE FROM meta_config')
  return deleteAppConfigKeys(getIntegrationAppConfigKeys('meta'))
}

export async function clearWhatsAppApiIntegrationCredentials() {
  return deleteAppConfigKeys(getIntegrationAppConfigKeys('whatsappApi'))
}

export async function clearWhatsAppMetaDirectIntegrationCredentials() {
  return deleteAppConfigKeys(getIntegrationAppConfigKeys('whatsappMetaDirect'))
}
