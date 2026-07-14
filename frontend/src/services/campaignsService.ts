import apiClient from './apiClient'
import type { ContactCustomField } from '@/types'
import { trackingService, type CursorPage } from './trackingService'

export interface Campaign {
  id: string
  name: string
  spend: number
  reach: number
  impressions: number
  clicks: number
  cpc: number
  cpm: number
  revenue?: number
  roas?: number
  sales?: number
  leads?: number
  appointments?: number
  attendances?: number
  adsets?: AdSet[]
  childCount?: number
  hasChildren?: boolean
  lastActiveDate?: string | null
}

export type CampaignPerformanceLevel = 'campaign' | 'adset' | 'ad'

export interface CampaignPerformanceItem extends Campaign {
  campaignId?: string | null
  campaignName?: string | null
  adSetId?: string | null
  adsetId?: string | null
  adSetName?: string | null
  adsetName?: string | null
  childCount?: number
  hasChildren?: boolean
  lastActiveDate?: string | null
  ads?: Ad[]
}

export interface CampaignPerformancePage {
  items: CampaignPerformanceItem[]
  pagination: {
    page: number
    pageSize: number
    totalItems: number
    totalPages: number
    hasMore: boolean
  }
  level: CampaignPerformanceLevel
  parentId: string | null
  limits: {
    pageSizeMax: number
    hierarchyLoadedLazily: boolean
  }
}

export interface CampaignPerformancePageParams {
  startDate: string
  endDate: string
  level?: CampaignPerformanceLevel
  page?: number
  pageSize?: number
  search?: string
  sortBy?: string | null
  sortOrder?: 'asc' | 'desc'
  campaignId?: string
  adsetId?: string
  includeVisitors?: boolean
  onlyWithResults?: boolean
}

export interface MetaTestCustomParameter {
  id?: string
  key: string
  value: string
}

export interface MetaTestEventParameters {
  value?: string
  predictedLtv?: string
  currency?: string
  contentName?: string
  contentCategory?: string
  contentIds?: string
  contentType?: string
  numItems?: string
  orderId?: string
  status?: string
  searchString?: string
  ctwaClid?: string
  messagingChannel?: string
  pageId?: string
  pageScopedUserId?: string
  igSid?: string
  instagramAccountId?: string
  custom?: MetaTestCustomParameter[]
}

export interface ConnectedSocialProfile {
  id: string
  platform: 'facebook' | 'instagram' | 'threads' | 'tiktok'
  sourceId: string
  pageId?: string
  pageName?: string
  name: string
  username?: string
  category?: string | null
  avatarUrl?: string | null
  followers?: number | null
  followersLabel?: string
  isConfiguredPage?: boolean
  isConfiguredInstagram?: boolean
  updatedAt?: string
}

export interface MetaAdsSyncSettings {
  intervalMinutes: number
  defaultIntervalMinutes: number
  minIntervalMinutes: number
  maxIntervalMinutes: number
  options: number[]
}

export interface AdSet {
  id: string
  name: string
  spend: number
  reach: number
  impressions: number
  clicks: number
  cpc: number
  cpm: number
  revenue?: number
  roas?: number
  sales?: number
  leads?: number
  appointments?: number
  attendances?: number
  ads?: Ad[]
}

interface Ad {
  id: string
  name: string
  creativeId?: string | null
  creativeType?: 'image' | 'video' | null
  creativeThumbnailUrl?: string | null
  creativeImageUrl?: string | null
  creativeVideoId?: string | null
  creativeVideoUrl?: string | null
  creativePreviewUrl?: string | null
  spend: number
  reach: number
  impressions: number
  clicks: number
  cpc: number
  cpm: number
  revenue?: number
  roas?: number
  sales?: number
  leads?: number
  appointments?: number
  attendances?: number
}

export interface CampaignContactPayment {
  id: string
  amount: number
  status: string
  date: string
}

export interface CampaignContactAppointment {
  id: string
  title: string
  start_time: string
  end_time: string
  status: string
}

export interface CampaignContactFirstSession {
  started_at: string
  page_url?: string
  referrer_url?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  utm_term?: string
  source_platform?: string
  site_source_name?: string
  campaign_name?: string
  ad_name?: string
  ad_id?: string
  device_type?: string
  browser?: string
  geo_city?: string
  geo_region?: string
  geo_country?: string
}

export interface CampaignContact {
  id: string
  name: string
  email: string
  phone: string
  created_at: string
  ltv: number
  ad_id?: string | null
  ad_name?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  source?: string | null
  is_sale: boolean
  payments?: CampaignContactPayment[]
  appointments?: CampaignContactAppointment[]
  firstSession?: CampaignContactFirstSession | null
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  customFields?: ContactCustomField[]
}

export interface CampaignContactsPage {
  contacts: CampaignContact[]
  summary: {
    pageCount: number
    pageLtv: number
  }
  pagination: {
    limit: number
    hasNext: boolean
    nextCursor: string | null
  }
  range?: {
    start: string | null
    end: string | null
    timezone: string
    filtered: boolean
  }
}

export interface CampaignContactsPageParams {
  type: 'interesados' | 'sales' | 'appointments' | 'attendances'
  startDate: string
  endDate: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  cursor?: string | null
  search?: string
  limit?: number
}

export interface CampaignVisitorListParams {
  startDate: string
  endDate: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  cursor?: string | null
  search?: string
  limit?: number
}

interface CreativePreviewResponse {
  success: boolean
  creativeId: string
  adFormat: string
  body: string
}

interface AdCreativeMediaResponse {
  success: boolean
  adId: string
  creative: Pick<Ad,
    'creativeId' |
    'creativeType' |
    'creativeThumbnailUrl' |
    'creativeImageUrl' |
    'creativeVideoId' |
    'creativeVideoUrl' |
    'creativePreviewUrl'
  >
}

export interface MetaTestEventResponse {
  success: boolean
  message?: string
  eventId?: string
  eventName?: string
  testEventCode?: string
  responsePayload?: unknown
  error?: string
}

class CampaignsService {
  async getCampaigns(startDate: string, endDate: string): Promise<Campaign[]> {
    try {
      const data = await apiClient.get<Campaign[]>('/meta/campaigns', {
        params: { startDate, endDate, pageSize: '80' }
      })

      // Return real data from Meta
      const campaigns = Array.isArray(data) ? data : []
      return campaigns.map((campaign: Campaign) => ({
        ...campaign,
        revenue: campaign.revenue || 0,
        roas: campaign.revenue && campaign.spend > 0 ? campaign.revenue / campaign.spend : 0,
        sales: campaign.sales || 0,
        leads: campaign.leads || 0,
        appointments: campaign.appointments || 0,
        attendances: campaign.attendances || 0
      }))
    } catch (error) {
      // Return empty array on error instead of crashing
      return []
    }
  }

  async getCampaignPerformancePage(params: CampaignPerformancePageParams): Promise<CampaignPerformancePage> {
    const query: Record<string, string> = {
      startDate: params.startDate,
      endDate: params.endDate,
      level: params.level || 'campaign',
      page: String(params.page || 1),
      pageSize: String(params.pageSize || 50),
      sortBy: params.sortBy || 'lastActiveDate',
      sortOrder: params.sortOrder || 'desc',
      includeVisitors: params.includeVisitors ? '1' : '0'
    }

    if (params.search?.trim()) query.search = params.search.trim()
    if (params.campaignId) query.campaignId = params.campaignId
    if (params.adsetId) query.adsetId = params.adsetId
    if (params.onlyWithResults) query.onlyWithResults = '1'

    return apiClient.get<CampaignPerformancePage>('/meta/campaigns/page', { params: query })
  }

  async getSyncStatus(): Promise<any> {
    try {
      const data = await apiClient.get<any>('/meta/sync/status')
      if (!data?.success) return null

      const details = data.details || {}
      const isRunning = data.status === 'syncing' || data.status === 'running'
      const isError = data.status === 'error'
      const total = Number(details.monthsTotal || 0)
      const processed = Number(details.monthsCurrent || 0)

      return {
        status: data.status,
        running: isRunning,
        error: isError,
        message: details.message || '',
        currentMonth: total > 0 && processed > 0 ? `${processed}/${total}` : '',
        processed,
        total,
        totalRecords: 0,
        progress: Number(data.progress || 0)
      }
    } catch (error) {
      return null
    }
  }

  async getCreativePreview(creativeId: string, adFormat = 'DESKTOP_FEED_STANDARD'): Promise<CreativePreviewResponse | null> {
    try {
      return await apiClient.get<CreativePreviewResponse>(`/meta/creative-preview/${encodeURIComponent(creativeId)}`, {
        params: { adFormat }
      })
    } catch (error) {
      return null
    }
  }

  async getAdCreativeMedia(adId: string): Promise<AdCreativeMediaResponse['creative'] | null> {
    try {
      const data = await apiClient.get<AdCreativeMediaResponse>(`/meta/ad-creative-media/${encodeURIComponent(adId)}`)
      return data?.creative || null
    } catch (error) {
      return null
    }
  }

  async startSync(): Promise<void> {
    await apiClient.post('/meta/sync', {})
  }

  async sendMetaTestEvent(payload: {
    testEventCode: string
    eventName?: string
    eventSourceUrl?: string
    eventParameters?: MetaTestEventParameters
  }): Promise<MetaTestEventResponse> {
    return apiClient.post<MetaTestEventResponse>('/meta/test-event', payload)
  }

  async createMetaPixelTestLink(payload: {
    testEventCode?: string
    eventName?: string
    eventParameters?: MetaTestEventParameters
  }): Promise<{ success: boolean; url: string }> {
    return apiClient.post<{ success: boolean; url: string }>('/meta/pixel-test/link', payload)
  }

  async getSpendOverTime(startDate: string, endDate: string): Promise<{ label: string; value: number; value2: number }[]> {
    try {
      const data = await apiClient.get<{ label: string; value: number; value2: number }[]>('/meta/spend-over-time', {
        params: { startDate, endDate }
      })
      return Array.isArray(data) ? data : []
    } catch (error) {
      return []
    }
  }

  async getContactsPage(params: CampaignContactsPageParams, signal?: AbortSignal): Promise<CampaignContactsPage> {
    const query: Record<string, string> = {
      type: params.type,
      startDate: params.startDate,
      endDate: params.endDate,
      paginated: 'true',
      limit: String(params.limit || 50)
    }
    if (params.campaign_id) query.campaign_id = params.campaign_id
    if (params.adset_id) query.adset_id = params.adset_id
    if (params.ad_id) query.ad_id = params.ad_id
    if (params.cursor) query.cursor = params.cursor
    if (params.search?.trim()) query.search = params.search.trim()

    const data = await apiClient.get<CampaignContactsPage>('/meta/contacts', { params: query, signal })
    const contacts = Array.isArray(data?.contacts) ? data.contacts : []
    return {
      ...data,
      contacts,
      summary: data?.summary || { pageCount: contacts.length, pageLtv: 0 },
      pagination: data?.pagination || {
        limit: params.limit || 50,
        hasNext: false,
        nextCursor: null
      }
    }
  }

  async getContactsByType(params: CampaignContactsPageParams): Promise<CampaignContact[]> {
    const data = await this.getContactsPage(params)
    return data.contacts
  }

  async verifyToken(): Promise<{
    success: boolean
    configured: boolean
    tokenStatus?: {
      valid: boolean
      message: string
      expiresAt?: string
      daysUntilExpiry?: number
      scopes?: string[]
    }
  }> {
    try {
      const data = await apiClient.get('/meta/verify-token') as {
        success: boolean
        configured: boolean
        tokenStatus?: {
          valid: boolean
          message: string
          expiresAt?: string
          daysUntilExpiry?: number
          scopes?: string[]
        }
      }
      return data
    } catch (error) {
      return { success: false, configured: false }
    }
  }

  async getLeadsOverTime(startDate: string, endDate: string): Promise<{ label: string; value: number; value2: number }[]> {
    try {
      const data = await apiClient.get<{ label: string; value: number; value2: number }[]>('/meta/leads-over-time', {
        params: { start: startDate, end: endDate }
      })
      return Array.isArray(data) ? data : []
    } catch (error) {
      return []
    }
  }

  async getAppointmentsOverTime(startDate: string, endDate: string): Promise<{ label: string; value: number; value2: number }[]> {
    try {
      const data = await apiClient.get<{ label: string; value: number; value2: number }[]>('/meta/appointments-over-time', {
        params: { start: startDate, end: endDate }
      })
      return Array.isArray(data) ? data : []
    } catch (error) {
      return []
    }
  }

  async getVisitorsOverTime(startDate: string, endDate: string): Promise<{ label: string; value: number; value2: number }[]> {
    try {
      const data = await apiClient.get<{ label: string; value: number; value2: number }[]>('/meta/visitors-over-time', {
        params: { start: startDate, end: endDate }
      })
      return Array.isArray(data) ? data : []
    } catch (error) {
      return []
    }
  }

  async getVisitorsPage(params: CampaignVisitorListParams): Promise<CursorPage<any>> {
    try {
      return await trackingService.getVisitorsPage({
        startDate: params.startDate,
        endDate: params.endDate,
        campaign_id: params.campaign_id,
        adset_id: params.adset_id,
        ad_id: params.ad_id,
        cursor: params.cursor,
        search: params.search,
        limit: params.limit
      })
    } catch (error) {
      return {
        items: [],
        pagination: { limit: Math.min(100, Math.max(1, params.limit ?? 50)), hasNext: false, hasMore: false, nextCursor: null }
      }
    }
  }

  async getVisitorsList(params: CampaignVisitorListParams): Promise<any[]> {
    return (await this.getVisitorsPage(params)).items
  }

  async getFunnelMetrics(startDate: string, endDate: string): Promise<{
    label: string
    visitors: number
    leads: number
    appointments: number
    sales: number
  }[]> {
    try {
      const data = await apiClient.get<{
        label: string
        visitors: number
        leads: number
        appointments: number
        sales: number
      }[]>('/meta/funnel-metrics', {
        params: { start: startDate, end: endDate }
      })
      return Array.isArray(data) ? data : []
    } catch (error) {
      return []
    }
  }

  async getMetaConfig(): Promise<{
    success: boolean
    configured: boolean
    config: {
      adAccountId: string
      accessToken: string
      pixelId: string | null
      pageId: string | null
      timezoneId: number | null
      timezoneName: string | null
      timezoneOffsetHoursUtc: number | null
    } | null
  }> {
    try {
      const data = await apiClient.get('/meta/config') as {
        success: boolean
        configured: boolean
        config: {
          adAccountId: string
          accessToken: string
          pageId: string | null
          instagramAccountId: string | null
          pixelId: string | null
          timezoneId: number | null
          timezoneName: string | null
          timezoneOffsetHoursUtc: number | null
        } | null
      }
      return data
    } catch (error) {
      return { success: false, configured: false, config: null }
    }
  }

  async getMetaAdsSyncSettings(): Promise<MetaAdsSyncSettings> {
    return apiClient.get<MetaAdsSyncSettings>('/meta/sync/settings')
  }

  async updateMetaAdsSyncSettings(intervalMinutes: number): Promise<{ intervalMinutes: number }> {
    return apiClient.put<{ intervalMinutes: number }>('/meta/sync/settings', { intervalMinutes })
  }

  async fetchAdAccounts(accessToken = ''): Promise<{
    success: boolean
    adAccounts: {
      id: string
      account_id: string
      name: string
      currency: string
      timezone_name: string
      account_status: number
    }[]
  }> {
    try {
      // (META-005) El accessToken viaja en un header custom, no en el query string,
      // para no exponerlo en logs/historial del navegador ni del servidor.
      const data = await apiClient.get('/meta/ad-accounts', accessToken ? {
        headers: { 'X-Meta-Access-Token': accessToken }
      } : undefined) as {
        adAccounts: {
          id: string
          account_id: string
          name: string
          currency: string
          timezone_name: string
          account_status: number
        }[]
      }

      // Normalizar la respuesta agregando success: true
      return {
        success: true,
        adAccounts: data.adAccounts || []
      }
    } catch (error) {
      return { success: false, adAccounts: [] }
    }
  }

  async fetchPixels(adAccountId: string, accessToken = ''): Promise<{
    success: boolean
    pixels: {
      id: string
      name: string
      creation_time: string
      last_fired_time: string
    }[]
  }> {
    try {
      // (META-005) adAccountId no es sensible y sigue en query; el accessToken viaja en header.
      const data = await apiClient.get('/meta/pixels', {
        params: { adAccountId },
        ...(accessToken ? { headers: { 'X-Meta-Access-Token': accessToken } } : {})
      }) as {
        pixels: {
          id: string
          name: string
          creation_time: string
          last_fired_time: string
        }[]
      }

      // Normalizar la respuesta agregando success: true
      return {
        success: true,
        pixels: data.pixels || []
      }
    } catch (error) {
      return { success: false, pixels: [] }
    }
  }

  async fetchPages(accessToken = ''): Promise<{
    success: boolean
    pages: {
      id: string
      name: string
      category: string | null
      pictureUrl: string | null
    }[]
  }> {
    try {
      // (META-005) accessToken en header custom en vez de query string.
      const data = await apiClient.get('/meta/pages', accessToken ? {
        headers: { 'X-Meta-Access-Token': accessToken }
      } : undefined) as {
        pages: {
          id: string
          name: string
          category: string | null
          pictureUrl: string | null
        }[]
      }

      return {
        success: true,
        pages: data.pages || []
      }
    } catch (error) {
      return { success: false, pages: [] }
    }
  }

  async getConnectedSocialProfiles(params: {
    accessToken?: string
    pageId?: string
    instagramAccountId?: string
  } = {}): Promise<{
    success: boolean
    connected: boolean
    updatedAt: string | null
    profiles: ConnectedSocialProfile[]
    error?: string
  }> {
    try {
      const { accessToken, ...profileParams } = params
      const cleanParams = Object.fromEntries(
        Object.entries(profileParams).filter(([, value]) => Boolean(value))
      ) as Record<string, string>
      const data = await apiClient.get('/meta/social-profiles', {
        params: cleanParams,
        ...(accessToken ? { headers: { 'X-Meta-Access-Token': accessToken } } : {})
      }) as {
        connected?: boolean
        updatedAt?: string
        profiles?: ConnectedSocialProfile[]
      }

      return {
        success: true,
        connected: Boolean(data.connected),
        updatedAt: data.updatedAt || null,
        profiles: Array.isArray(data.profiles) ? data.profiles : []
      }
    } catch (error) {
      return { success: false, connected: false, updatedAt: null, profiles: [] }
    }
  }

  async syncMetaAds(): Promise<{
    success: boolean
    message?: string
    count?: number
    error?: string
  }> {
    try {
      const data = await apiClient.post('/meta/update-recent') as {
        success: boolean
        message?: string
        count?: number
        error?: string
      }
      return data
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Error al sincronizar'
      }
    }
  }
}

export const campaignsService = new CampaignsService()
