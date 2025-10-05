import { dedupeContacts } from '@/utils/contactDedup'
import apiClient from './apiClient'

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
  adsets?: AdSet[]
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
  ads?: Ad[]
}

export interface Ad {
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
}

export interface CampaignContactPayment {
  id: string
  amount: number
  status: string
  date: string
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
  is_sale: boolean
  payments?: CampaignContactPayment[]
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
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
        leads: campaign.leads || 0
      }))
    } catch (error) {
      // Return empty array on error instead of crashing
      return []
    }
  }

  async getSyncStatus(): Promise<any> {
    try {
      const data = await apiClient.get<any>('/meta/sync/status')
      return data?.status || null
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
    type: 'interesados' | 'sales'
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
}

export const campaignsService = new CampaignsService()
