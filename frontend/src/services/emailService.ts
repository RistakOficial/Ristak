import apiClient from './apiClient'

export interface EmailStatus {
  provider: 'smtp' | string
  connected: boolean
  configured: boolean
  smtp: {
    host: string
    port: number
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
  host: string
  port: number
  username: string
  password?: string
  fromName?: string
  fromEmail?: string
  replyTo?: string
}

export interface EmailTestResult {
  messageId?: string | null
  accepted: string[]
  rejected: string[]
}

export const emailService = {
  getStatus: () => apiClient.get<EmailStatus>('/email/status'),
  connect: (payload: EmailConnectPayload) => apiClient.post<EmailStatus>('/email/connect', payload),
  sendTest: (to: string) => apiClient.post<EmailTestResult>('/email/test', { to }),
  disconnect: () => apiClient.post<EmailStatus>('/email/disconnect')
}
