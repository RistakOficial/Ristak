import apiClient from './apiClient'

export type EmailSmtpSecurity = 'starttls' | 'ssl' | 'none'

export interface EmailStatus {
  provider: 'smtp' | string
  providerLabel?: string
  connected: boolean
  configured: boolean
  smtp: {
    host: string
    port: number
    security: EmailSmtpSecurity
    usernameMasked: string
    hasPassword: boolean
  }
  sender: {
    fromName: string
    fromEmail: string
    replyTo: string
  }
  timestamps: {
    connectedAt?: string | null
    disconnectedAt?: string | null
    lastVerifiedAt?: string | null
    lastTestAt?: string | null
  }
  lastError?: string | null
}

export interface EmailConnectPayload {
  fromEmail: string
  password?: string
  fromName?: string
  replyTo?: string
  testTo?: string
  smtp?: {
    host: string
    port: number
    security: EmailSmtpSecurity
    username: string
  }
}

export interface EmailProviderDetection {
  email: string
  domain: string
  provider: {
    id: string
    label: string
    detectedBy: 'domain' | 'mx' | string
    confidence: 'high' | 'medium' | 'low' | string
  }
  smtp: {
    host: string
    port: number
    security: EmailSmtpSecurity
    username: string
    usernameMasked: string
  }
  mx: {
    checked: boolean
    found: boolean
    error?: string | null
    records: Array<{
      exchange: string
      priority: number
    }>
  }
}

export interface EmailTestResult {
  messageId?: string | null
  accepted: string[]
  rejected: string[]
}

export const emailService = {
  getStatus: () => apiClient.get<EmailStatus>('/email/status'),
  detect: (email: string) => apiClient.post<EmailProviderDetection>('/email/detect', { email }),
  connect: (payload: EmailConnectPayload) => apiClient.post<EmailStatus>('/email/connect', payload),
  sendTest: (to: string) => apiClient.post<EmailTestResult>('/email/test', { to }),
  disconnect: () => apiClient.post<EmailStatus>('/email/disconnect')
}
