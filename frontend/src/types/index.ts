export interface ContactPayment {
  id: string
  amount: number
  status?: string | null
  date: string
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
  ad_name?: string
  ad_id?: string
  notes?: string
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
  firstAppointmentDate?: string | null
  nextAppointmentDate?: string | null
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  payments?: ContactPayment[]
  appointments?: ContactAppointment[]
}

// Transaction type
export interface Transaction {
  id: string
  date: string
  contactId?: string
  contactName: string
  email: string
  amount: number
  method: 'card' | 'transfer' | 'cash' | 'paypal'
  status: 'paid' | 'pending' | 'failed' | 'refunded'
  description?: string
}

// Campaign types
export interface Campaign {
  id: string
  name: string
  platform: string
  status: string
  investment: number
  clicks: number
  visitors: number
  leads: number
  sales: number
  revenue: number
  roas: number
  adsets?: AdSet[]
  ads?: Ad[]
  level?: 'campaign' | 'adset' | 'ad'
  isExpanded?: boolean
}

export interface AdSet {
  id: string
  campaignId: string
  name: string
  investment: number
  clicks: number
  visitors: number
  leads: number
  sales: number
  revenue: number
  roas: number
  ads?: Ad[]
}

export interface Ad {
  id: string
  adsetId: string
  name: string
  investment: number
  clicks: number
  visitors: number
  leads: number
  sales: number
  revenue: number
  roas: number
}
