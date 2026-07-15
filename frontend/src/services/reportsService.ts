import type { ContactMetaAttribution } from '@/types'
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

export interface ReportsSnapshotSummary {
  payments: Pick<PaymentsReport['summary'],
    | 'totalRevenue'
    | 'totalRevenuePrev'
    | 'completedPayments'
    | 'completedPaymentsPrev'
    | 'averageTicket'
    | 'averageTicketPrev'
  >
  campaigns: Pick<CampaignsReport['summary'],
    | 'spend'
    | 'spendPrev'
    | 'clicks'
    | 'clicksPrev'
    | 'reach'
    | 'reachPrev'
    | 'roas'
    | 'roasPrev'
  >
}

export interface ReportsSnapshot {
  metrics: ReportMetricRow[]
  range: ReportRange
  summary: ReportsSnapshotSummary
  cache: {
    stale: boolean
    exactAtBuiltAt: boolean
    builtAt: string
    builtSourceRevision: string
    currentSourceRevision: string
  }
}

export interface ReportMetricRow {
  date: string
  spend: number
  revenue: number
  leads: number
  customers: number
  appointments: number
  attendances: number
  sales: number
  clicks: number
  reach: number
  visitors: number
  new_customers: number
  roas: number
  profit: number
}

export interface ManualBusinessExpense {
  period_type: GroupBy
  period_start: string
  amount: number
}

export interface ManualBusinessExpenseInput extends ManualBusinessExpense {
  delete?: boolean
  reset_children?: boolean
  resetChildren?: boolean
}

export interface ContactPaymentDetail {
  id: string
  amount: number
  status: string
  date: string
  payment_mode?: 'live' | 'test'
  paymentMode?: 'live' | 'test'
}

export interface ContactAppointmentDetail {
  id: string
  title?: string | null
  status?: string | null
  start_time: string
}

export interface ContactFirstSessionDetail {
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
  appointmentsTotal?: number
  appointmentsTruncated?: boolean
  firstSession?: ContactFirstSessionDetail | null
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
  source?: string
  ad_name?: string
  ad_id?: string
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  metaAttribution?: ContactMetaAttribution | null
  lifetimeLtv?: number
  lifetimePurchases?: number
  isCustomer?: boolean
  hasAppointments?: boolean
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
}

export interface ReportContactsPagination {
  limit: number
  total: number
  totalIsCapped: boolean
  hasNext: boolean
  nextCursor: string | null
}

export interface ReportTransaction {
  id: string
  contact_id: string
  contact_name: string
  contact_email: string
  contact_phone: string
  amount: number
  currency?: string
  status: string
  date: string
  payment_method?: string
  payment_method_category?: string
  payment_type?: string
  payment_channel?: string
  description?: string
}

export interface ReportTransactionsPage {
  transactions: ReportTransaction[]
  range: ReportRange
  summary: {
    count: number
    totalAmount: number
  }
  pagination: {
    mode: 'cursor' | 'page'
    page: number | null
    limit: number
    total: number | null
    totalPages: number | null
    hasNext: boolean
    hasPrev: boolean
    nextCursor: string | null
  }
}

class ReportsService {
  async getSnapshot(
    params: {
      from?: string
      to?: string
      groupBy?: GroupBy
      scope?: 'all' | 'attribution' | 'campaigns' | 'attributed'
      waitForFresh?: boolean
    },
    signal?: AbortSignal
  ): Promise<ReportsSnapshot> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.groupBy) query.groupBy = params.groupBy
    if (params.scope) query.scope = params.scope
    if (params.waitForFresh) query.waitForFresh = '1'

    return apiClient.get<ReportsSnapshot>('/reports/snapshot', { params: query, signal })
  }

  async getMetrics(params: { from?: string; to?: string; groupBy?: GroupBy; scope?: 'all' | 'attribution' | 'campaigns' | 'attributed' }): Promise<{ metrics: ReportMetricRow[]; range: ReportRange }> {
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

  async getContactsList(params: {
    from?: string
    to?: string
    type?: 'interesados' | 'customers' | 'sales' | 'appointments' | 'attendances'
    scope?: 'all' | 'attribution' | 'campaigns' | 'attributed'
    dedupe?: 'person' | 'record'
    search?: string
    cursor?: string
    limit?: number
  }): Promise<{ contacts: ContactListItem[]; range: ReportRange; pagination: ReportContactsPagination }> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.type) query.type = params.type
    if (params.scope) query.scope = params.scope
    // (MET-CONSIST) dedupe='person' pide al backend colapsar por email/teléfono para que el
    // modal empate el número mostrado. Reports lo usa; Dashboard lo omite (cuenta por registro).
    if (params.dedupe) query.dedupe = params.dedupe
    if (params.search?.trim()) query.search = params.search.trim()
    if (params.cursor) query.cursor = params.cursor
    if (params.limit) query.limit = String(params.limit)

    const response = await apiClient.get<{ contacts: ContactListItem[]; range: ReportRange; pagination: ReportContactsPagination }>(
      '/reports/contacts/list',
      { params: query }
    )

    const rawContacts = Array.isArray(response.contacts) ? response.contacts : []
    return {
      ...response,
      contacts: rawContacts,
      pagination: response.pagination || {
        limit: params.limit || 50,
        total: rawContacts.length,
        totalIsCapped: false,
        hasNext: false,
        nextCursor: null
      }
    }
  }

  async getPaymentsReport(params: { from?: string; to?: string }): Promise<PaymentsReport> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to

    return apiClient.get<PaymentsReport>('/reports/payments', { params: query })
  }

  async getTransactionsPage(params: {
    from?: string
    to?: string
    search?: string
    cursor?: string | null
    page?: number
    limit?: number
  }, signal?: AbortSignal): Promise<ReportTransactionsPage> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.search?.trim()) query.search = params.search.trim()
    if (params.cursor) query.cursor = params.cursor
    if (params.page) query.page = String(params.page)
    if (params.limit) query.limit = String(params.limit)

    const response = await apiClient.get<ReportTransactionsPage>('/reports/transactions', {
      params: query,
      signal
    })
    const transactions = Array.isArray(response?.transactions) ? response.transactions : []
    return {
      ...response,
      transactions,
      summary: response?.summary || { count: transactions.length, totalAmount: 0 },
      pagination: response?.pagination || {
        mode: 'cursor',
        page: null,
        limit: params.limit || 50,
        total: transactions.length,
        totalPages: transactions.length > 0 ? 1 : 0,
        hasNext: false,
        hasPrev: false,
        nextCursor: null
      }
    }
  }

  async getCampaignsReport(params: { from?: string; to?: string }): Promise<CampaignsReport> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to

    return apiClient.get<CampaignsReport>('/reports/campaigns', { params: query })
  }

  async getSummary(
    params: { from?: string; to?: string; scope?: 'all' | 'attribution' | 'campaigns' | 'attributed' },
    signal?: AbortSignal
  ): Promise<ReportsSummary> {
    const query: Record<string, string> = {}
    if (params.from) query.from = params.from
    if (params.to) query.to = params.to
    if (params.scope) query.scope = params.scope

    return apiClient.get<ReportsSummary>('/reports/summary', { params: query, signal })
  }

  async getManualBusinessExpenses(): Promise<ManualBusinessExpense[]> {
    const response = await apiClient.get<{ expenses: ManualBusinessExpense[] }>('/reports/manual-business-expenses')
    return response.expenses || []
  }

  async saveManualBusinessExpense(input: ManualBusinessExpenseInput): Promise<{ expense: ManualBusinessExpense | null }> {
    return apiClient.put<{ expense: ManualBusinessExpense | null }>('/reports/manual-business-expenses', input)
  }
}

export const reportsService = new ReportsService()
