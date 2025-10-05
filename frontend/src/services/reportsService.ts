import { dedupeContacts } from '@/utils/contactDedup'
import apiClient from './apiClient'

export type GroupBy = 'day' | 'month' | 'year'

export interface ReportRange {
  start: string | null
  end: string | null
  timezone: string
  filtered: boolean
}

export interface ContactsReport {
  range: ReportRange
  metrics: {
    total: number
    totalPrev: number
    withAppointments: number
    withAppointmentsPrev: number
    customers: number
    customersPrev: number
    ltvTotal: number
    ltvTotalPrev: number
    avgLtv: number
    avgLtvPrev: number
  }
  timeline: Array<{
    period: string
    contacts: number
    customers: number
  }>
}

export interface PaymentsReport {
  range: ReportRange
  stats: {
    total: {
      count: number
      amount: number
      average: number
    }
    byMethod: Array<{ payment_method: string; count: number; total: number }>
    byStatus: Array<{ status: string; count: number; total: number }>
  }
  summary: {
    totalRevenue: number
    totalRevenuePrev: number
    completedPayments: number
    completedPaymentsPrev: number
    averageTicket: number
    averageTicketPrev: number
    refunds: number
    refundsPrev: number
  }
}

export interface CampaignsReport {
  range: ReportRange
  summary: {
    spend: number
    spendPrev: number
    clicks: number
    clicksPrev: number
    reach: number
    reachPrev: number
    leads: number
    leadsPrev: number
    sales: number
    salesPrev: number
    revenue: number
    revenuePrev: number
    roas: number
    roasPrev: number
  }
}

export interface ReportsSummary {
  range: ReportRange
  contacts: ContactsReport['metrics']
  payments: PaymentsReport['summary']
  campaigns: CampaignsReport['summary']
}

export interface ReportMetricRow {
  date: string
  spend: number
  revenue: number
  leads: number
  customers: number
  appointments: number
  sales: number
  clicks: number
  reach: number
  visitors: number
  new_customers: number
  roas: number
  profit: number
}

export interface ContactPaymentDetail {
  id: string
  amount: number
  status: string
  date: string
}

export interface ContactAppointmentDetail {
  id: string
  title?: string | null
  status?: string | null
  start_time: string
}

export interface ContactListItem {
  id: string
  name: string
  email: string
  phone: string
  created_at: string
  ltv: number
  purchases: number
  attributed: boolean
  payments?: ContactPaymentDetail[]
  appointments?: ContactAppointmentDetail[]
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
}

class ReportsService {
  async getMetrics(params: { from?: string; to?: string; groupBy?: GroupBy; scope?: 'all' | 'campaigns' | 'attributed' }): Promise<{ metrics: ReportMetricRow[]; range: ReportRange }> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.groupBy) query.groupBy = params.groupBy
    if (params.scope) query.scope = params.scope

    return apiClient.get<{ metrics: ReportMetricRow[]; range: ReportRange }>('/reports/metrics', { params: query })
  }

  async getContactsReport(params: { from?: string; to?: string; groupBy?: GroupBy }): Promise<ContactsReport> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.groupBy) query.groupBy = params.groupBy

    return apiClient.get<ContactsReport>('/reports/contacts', { params: query })
  }

  async getContactsList(params: { from?: string; to?: string; type?: 'interesados' | 'customers' | 'sales' | 'appointments'; scope?: 'all' | 'campaigns' | 'attributed' }): Promise<{ contacts: ContactListItem[]; range: ReportRange }> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.type) query.type = params.type
    if (params.scope) query.scope = params.scope

    const response = await apiClient.get<{ contacts: ContactListItem[]; range: ReportRange }>(
      '/reports/contacts/list',
      { params: query }
    )

    const rawContacts = Array.isArray(response.contacts) ? response.contacts : []
    return {
      ...response,
      contacts: dedupeContacts<ContactListItem>(rawContacts)
    }
  }

  async getPaymentsReport(params: { from?: string; to?: string }): Promise<PaymentsReport> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to

    return apiClient.get<PaymentsReport>('/reports/payments', { params: query })
  }

  async getCampaignsReport(params: { from?: string; to?: string }): Promise<CampaignsReport> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to

    return apiClient.get<CampaignsReport>('/reports/campaigns', { params: query })
  }

  async getSummary(params: { from?: string; to?: string; scope?: 'all' | 'campaigns' | 'attributed' }): Promise<ReportsSummary> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.scope) query.scope = params.scope

    return apiClient.get<ReportsSummary>('/reports/summary', { params: query })
  }
}

export const reportsService = new ReportsService()
