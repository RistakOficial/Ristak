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
  inbound: {
    enabled: boolean
    connected: boolean
    configured: boolean
    host: string
    port: number
    security: EmailSmtpSecurity
    usernameMasked: string
    mailbox: string
    lastSeenUid?: number | null
    lastSyncAt?: string | null
    lastVerifiedAt?: string | null
    lastMessageAt?: string | null
    lastError?: string | null
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
  inbound?: {
    enabled: boolean
    host?: string
    port?: number
    security?: EmailSmtpSecurity
    username?: string
    mailbox?: string
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
  imap: {
    host: string
    port: number
    security: EmailSmtpSecurity
    username: string
    usernameMasked: string
    mailbox: string
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

export interface EmailInboundTestResult {
  connected: boolean
  host: string
  port: number
  security: EmailSmtpSecurity
  mailbox: string
  exists: number
  uidNext?: number | null
  testedAt?: string | null
}

export interface EmailInboundSyncResult {
  skipped: boolean
  reason: string
  imported: number
  seen?: number
  lastSeenUid?: number | null
  lastSyncAt?: string | null
}

export interface EmailSendPayload {
  contactId?: string
  to?: string
  subject: string
  text: string
  html?: string
  replyTo?: string
  externalId?: string
  includeSignature?: boolean
}

export interface EmailSendResult extends EmailTestResult {
  localMessageId?: string
  status?: string
  to?: string
  subject?: string
  sentAt?: string
}

export interface EmailSignatureConfig {
  enabled: boolean
  html: string
  text?: string
  includeBeforeQuotedText: boolean
  updatedAt?: string | null
  generatedAt?: string | null
}

export const emailService = {
  getStatus: () => apiClient.get<EmailStatus>('/email/status'),
  detect: (email: string) => apiClient.post<EmailProviderDetection>('/email/detect', { email }),
  connect: (payload: EmailConnectPayload) => apiClient.post<EmailStatus>('/email/connect', payload),
  send: (payload: EmailSendPayload) => apiClient.post<EmailSendResult>('/email/send', payload),
  sendTest: (to: string) => apiClient.post<EmailTestResult>('/email/test', { to }),
  testInbound: () => apiClient.post<EmailInboundTestResult>('/email/inbound/test'),
  syncInbound: () => apiClient.post<EmailInboundSyncResult>('/email/inbound/sync'),
  getSignature: () => apiClient.get<EmailSignatureConfig>('/email/signature'),
  saveSignature: (payload: EmailSignatureConfig) => apiClient.post<EmailSignatureConfig>('/email/signature', payload),
  disconnect: () => apiClient.post<EmailStatus>('/email/disconnect')
}
