import apiClient from './apiClient'

export interface AccountCancellationReason {
  key: string
  label: string
}

export interface AccountCancellationStatus {
  success?: boolean
  enabled: boolean
  has_stripe_subscription: boolean
  retention_offer: {
    percent_off: number
    duration: 'one_month' | string
  }
  reasons: AccountCancellationReason[]
  latest?: {
    id: string
    status: string
    reason_key?: string | null
    reason_label?: string | null
    export_id?: string | null
    export_expires_at?: string | null
    resource_cleanup_started_at?: string | null
    resource_cleanup_finished_at?: string | null
    created_at?: string | null
  } | null
}

export interface AccountRetentionResult {
  success?: boolean
  status: 'retained'
  percent_off: number
  coupon_id?: string
  discount_id?: string | null
}

export interface AccountCancellationResult {
  success?: boolean
  status: 'cancelled'
  cancellation_id: string
  export: {
    id: string
    filename: string
    size_bytes: number
    table_count: number
    row_count: number
    expires_at: string
    download_url: string
  }
  stripe: {
    subscription_id: string
    status: string
  }
  resource_cleanup: {
    status: string
  }
}

export const accountCancellationService = {
  getStatus() {
    return apiClient.get<AccountCancellationStatus>('/license/account-cancellation/status')
  },

  acceptRetentionOffer() {
    return apiClient.post<AccountRetentionResult>('/license/account-cancellation/retention', {})
  },

  cancelAccount(payload: { reasonKey: string; reasonDetails?: string }) {
    return apiClient.post<AccountCancellationResult>('/license/account-cancellation/cancel', {
      reason_key: payload.reasonKey,
      reason_details: payload.reasonDetails || ''
    })
  }
}
