import { dedupeContacts } from '@/utils/contactDedup'
import apiClient from './apiClient'
import type { ContactCustomField } from '@/types'

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

export interface CampaignVisitorListParams {
  startDate: string
  endDate: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
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

class CampaignsService {
  async getCampaigns(startDate: string, endDate: string): Promise<Campaign[]> {
    try {
      const data = await apiClient.get<Campaign[]>('/meta/campaigns', {
        params: { startDate, endDate }
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

  async getContactsByType(params: {
    type: 'interesados' | 'sales' | 'appointments' | 'attendances'
    startDate: string
    endDate: string
    campaign_id?: string
    adset_id?: string
    ad_id?: string
  }): Promise<CampaignContact[]> {
    try {
      const data = await apiClient.get<CampaignContact[]>('/meta/contacts', { params })
      const contacts = Array.isArray(data) ? data : []
      return dedupeContacts<CampaignContact>(contacts)
    } catch (error) {
      return []
    }
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

  async getVisitorsList(params: CampaignVisitorListParams): Promise<any[]> {
    try {
      const queryParams: Record<string, string> = {
        startDate: params.startDate,
        endDate: params.endDate,
        ...(params.campaign_id ? { campaign_id: params.campaign_id } : {}),
        ...(params.adset_id ? { adset_id: params.adset_id } : {}),
        ...(params.ad_id ? { ad_id: params.ad_id } : {})
      }
      const data = await apiClient.get<{ data?: any[] } | any[]>('/tracking/visitors', { params: queryParams })
      if (Array.isArray(data)) return data
      return Array.isArray(data?.data) ? data.data : []
    } catch (error) {
      return []
    }
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
      pixelApiToken: string | null
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
          pixelApiToken: string | null
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

  async fetchAdAccounts(accessToken: string): Promise<{
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
      // apiClient extrae automáticamente el campo "data" de la respuesta
      const data = await apiClient.get('/meta/ad-accounts', {
        params: { accessToken }
      }) as {
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

  async fetchPixels(adAccountId: string, accessToken: string): Promise<{
    success: boolean
    pixels: {
      id: string
      name: string
      creation_time: string
      last_fired_time: string
    }[]
  }> {
    try {
      // apiClient extrae automáticamente el campo "data" de la respuesta
      const data = await apiClient.get('/meta/pixels', {
        params: { adAccountId, accessToken }
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

  async fetchPages(accessToken: string): Promise<{
    success: boolean
    pages: {
      id: string
      name: string
      category: string | null
      pictureUrl: string | null
    }[]
  }> {
    try {
      const data = await apiClient.get('/meta/pages', {
        params: { accessToken }
      }) as {
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
      const data = await apiClient.get('/meta/social-profiles', {
        params
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
