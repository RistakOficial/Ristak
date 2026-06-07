export interface ContactPayment {
  id: string
  amount: number
  status?: string | null
  date: string
  payment_mode?: 'live' | 'test'
  paymentMode?: 'live' | 'test'
}

export interface ContactAppointment {
  id: string
  title?: string | null
  status?: string | null
  appointment_status?: string | null
  start_time: string
  end_time?: string | null
  notes?: string | null
}

export interface ContactFirstSession {
  started_at?: string | null
  page_url?: string | null
  landing_page?: string | null
  referrer_url?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
  source_platform?: string | null
  site_source_name?: string | null
  campaign_name?: string | null
  adset_name?: string | null
  ad_name?: string | null
  ad_id?: string | null
  device_type?: string | null
  browser?: string | null
  os?: string | null
  placement?: string | null
  geo_city?: string | null
  geo_region?: string | null
  geo_country?: string | null
}

export interface ContactMetaAttribution {
  source?: 'meta_ads' | string | null
  matchType?: 'ad_id' | 'ad_name_exact' | string | null
  campaignId?: string | null
  campaignName?: string | null
  adsetId?: string | null
  adsetName?: string | null
  adId?: string | null
  adName?: string | null
  creativeThumbnailUrl?: string | null
  creativeImageUrl?: string | null
  creativeVideoUrl?: string | null
  creativePreviewUrl?: string | null
  date?: string | null
}

export type ContactCustomFieldValue =
  | string
  | number
  | boolean
  | null
  | unknown[]
  | Record<string, unknown>

export interface ContactCustomField {
  id?: string | null
  definitionId?: string | null
  key?: string | null
  fieldKey?: string | null
  label?: string | null
  name?: string | null
  dataType?: string | null
  value?: ContactCustomFieldValue
  options?: unknown[]
  model?: string | null
  syncTarget?: string | null
  sourceType?: string | null
  sourceId?: string | null
  sourceSiteId?: string | null
  sourcePageId?: string | null
  sourceFormId?: string | null
  sourceFormName?: string | null
  sourceFieldId?: string | null
  sourceFieldName?: string | null
  sourceLabel?: string | null
  sourceContext?: Record<string, unknown> | null
}

export interface ContactCustomFieldDefinition {
  definitionId: string
  key: string
  fieldKey: string
  label: string
  name: string
  description?: string
  dataType: string
  options?: unknown[]
  folderId?: string
  folderName?: string
  fieldGroup?: string
  syncTarget?: string
  sourceType?: string
  sourceId?: string
  sourceSiteId?: string
  sourcePageId?: string
  sourceFormId?: string
  sourceFormName?: string
  sourceFieldId?: string
  sourceFieldName?: string
  sourceLabel?: string
  sourceContext?: Record<string, unknown> | null
  ownerUserId?: number | null
  archived?: boolean
  sources?: ContactCustomFieldDefinitionSource[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ContactCustomFieldDefinitionSource {
  id: string
  definitionId: string
  sourceType: string
  sourceId?: string
  sourceSiteId?: string
  sourcePageId?: string
  sourceFormId?: string
  sourceFormName?: string
  sourceFieldId?: string
  sourceFieldName?: string
  sourceLabel?: string
  sourceContext?: Record<string, unknown> | null
  occurrenceCount?: number
  firstSeenAt?: string | null
  lastSeenAt?: string | null
}

export interface Contact {
  id: string
  createdAt: string
  name: string
  email?: string
  phone?: string
  ltv: number
  status: 'lead' | 'appointment' | 'customer'
  lastPurchase?: string
  purchases: number
  source?: string
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
  attribution_url?: string | null
  attribution_session_source?: string | null
  attribution_medium?: string | null
  attribution_ctwa_clid?: string | null
  whatsappAttributionPlatform?: string | null
  ad_name?: string
  ad_id?: string
  preferredWhatsAppPhoneNumberId?: string | null
  preferred_whatsapp_phone_number_id?: string | null
  notes?: string
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
  firstAppointmentDate?: string | null
  nextAppointmentDate?: string | null
  hasAppointments?: boolean
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  payments?: ContactPayment[]
  appointments?: ContactAppointment[]
  firstSession?: ContactFirstSession | null
  metaAttribution?: ContactMetaAttribution | null
  customFields?: ContactCustomField[]
}
