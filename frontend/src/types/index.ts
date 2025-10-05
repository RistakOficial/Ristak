// Contact type
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
  notes?: string
  normalizedPhone?: string | null
  duplicateCount?: number
  mergedContactIds?: string[]
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
