import React, { useMemo } from 'react'
import { cn } from '@/utils/cn'
import { Icon } from '../Icon'
import {
  emailHtmlToPlainText,
  sanitizeEmailRichHtmlForEditor
} from '../EmailRichTextEditor'
import styles from './EmailChatMessageBubble.module.css'

export interface EmailChatMessageData {
  subject?: string
  fromEmail?: string
  toEmail?: string
  ccEmail?: string
  bccEmail?: string
  replyTo?: string
  bodyText?: string
  bodyHtml?: string
  direction?: 'inbound' | 'outbound' | 'system'
  status?: string
  errorReason?: string
  transport?: string
}

export interface EmailChatMessageBubbleProps {
  email: EmailChatMessageData
  className?: string
  defaultOpen?: boolean
  compact?: boolean
}

const EMPTY_VALUE = 'Sin dato'

const EMAIL_BODY_TEXT_KEYS = [
  'message_text',
  'messageText',
  'message',
  'body',
  'text',
  'message_body',
  'messageBody',
  'content'
]

const cleanEmailValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value
      .map(item => cleanEmailValue(item))
      .filter(Boolean)
      .join(', ')
  }
  if (value === null || value === undefined || typeof value === 'object') return ''
  return String(value).trim()
}

const pickEmailValue = (data: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = cleanEmailValue(data[key])
    if (value) return value
  }
  return ''
}

const normalizeEmailList = (value?: string): string =>
  cleanEmailValue(value)
    .split(/[,;]/)
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ')

const getEmailDirectionLabel = (direction?: EmailChatMessageData['direction']) => {
  if (direction === 'outbound') return 'Correo enviado'
  if (direction === 'inbound') return 'Correo recibido'
  return 'Correo electrónico'
}

const getEmailSummaryTarget = (email: EmailChatMessageData) => {
  if (email.direction === 'inbound') return cleanEmailValue(email.fromEmail)
  return normalizeEmailList(email.toEmail) || cleanEmailValue(email.fromEmail)
}

const getEmailBodyText = (email: EmailChatMessageData) => {
  const bodyText = cleanEmailValue(email.bodyText)
  if (bodyText) return bodyText
  const bodyHtml = cleanEmailValue(email.bodyHtml)
  return bodyHtml ? emailHtmlToPlainText(bodyHtml) : ''
}

export function buildEmailChatMessageData(
  data: Record<string, unknown>,
  options: Partial<Pick<EmailChatMessageData, 'bodyText' | 'direction' | 'status' | 'errorReason' | 'transport'>> = {}
): EmailChatMessageData {
  const bodyHtml = pickEmailValue(data, ['html_body', 'htmlBody', 'html', 'body_html', 'bodyHtml'])
  const bodyText = cleanEmailValue(options.bodyText) || pickEmailValue(data, EMAIL_BODY_TEXT_KEYS) || (bodyHtml ? emailHtmlToPlainText(bodyHtml) : '')

  return {
    subject: pickEmailValue(data, ['subject', 'asunto']),
    fromEmail: pickEmailValue(data, ['from_email', 'fromEmail', 'from', 'sender', 'sender_email', 'senderEmail']),
    toEmail: pickEmailValue(data, ['to_email', 'toEmail', 'to', 'recipient', 'recipients', 'recipient_email', 'recipientEmail']),
    ccEmail: pickEmailValue(data, ['cc_email', 'ccEmail', 'cc']),
    bccEmail: pickEmailValue(data, ['bcc_email', 'bccEmail', 'bcc']),
    replyTo: pickEmailValue(data, ['reply_to', 'replyTo']),
    bodyText,
    bodyHtml,
    direction: options.direction,
    status: cleanEmailValue(options.status) || pickEmailValue(data, ['status', 'message_status', 'messageStatus']),
    errorReason: cleanEmailValue(options.errorReason) || pickEmailValue(data, ['error_message', 'errorMessage', 'error_reason', 'errorReason']),
    transport: cleanEmailValue(options.transport) || pickEmailValue(data, ['transport', 'channel', 'provider'])
  }
}

export function hasEmailChatMessageContent(email?: EmailChatMessageData | null) {
  if (!email) return false
  return Boolean(
    cleanEmailValue(email.subject) ||
    cleanEmailValue(email.fromEmail) ||
    cleanEmailValue(email.toEmail) ||
    cleanEmailValue(email.replyTo) ||
    cleanEmailValue(email.bodyText) ||
    cleanEmailValue(email.bodyHtml)
  )
}

export const EmailChatMessageBubble: React.FC<EmailChatMessageBubbleProps> = ({
  email,
  className,
  defaultOpen = false,
  compact = false
}) => {
  const subject = cleanEmailValue(email.subject) || 'Sin asunto'
  const fromEmail = cleanEmailValue(email.fromEmail)
  const toEmail = normalizeEmailList(email.toEmail)
  const ccEmail = normalizeEmailList(email.ccEmail)
  const bccEmail = normalizeEmailList(email.bccEmail)
  const replyTo = cleanEmailValue(email.replyTo)
  const bodyText = getEmailBodyText(email)
  const safeBodyHtml = useMemo(() => {
    const html = cleanEmailValue(email.bodyHtml)
    return html ? sanitizeEmailRichHtmlForEditor(html) : ''
  }, [email.bodyHtml])
  const summaryTarget = getEmailSummaryTarget(email)
  const directionLabel = getEmailDirectionLabel(email.direction)
  const status = cleanEmailValue(email.status)
  const transport = cleanEmailValue(email.transport)
  const errorReason = cleanEmailValue(email.errorReason)

  return (
    <details
      className={cn(styles.emailBubble, className)}
      data-compact={compact ? 'true' : undefined}
      data-direction={email.direction || undefined}
      open={defaultOpen ? true : undefined}
    >
      <summary className={styles.summary}>
        <span className={styles.iconWrap} aria-hidden="true">
          <Icon name="mail" size={15} />
        </span>
        <span className={styles.summaryCopy}>
          <span className={styles.eyebrow}>{directionLabel}</span>
          <strong>{subject}</strong>
          {summaryTarget ? <small>{summaryTarget}</small> : null}
        </span>
        <Icon name="chevron-down" size={15} className={styles.chevron} aria-hidden="true" />
      </summary>

      <div className={styles.content}>
        <dl className={styles.fieldList}>
          <div className={styles.fieldRow}>
            <dt>Asunto:</dt>
            <dd>{subject}</dd>
          </div>
          {fromEmail ? (
            <div className={styles.fieldRow}>
              <dt>Remitente:</dt>
              <dd>{fromEmail}</dd>
            </div>
          ) : null}
          <div className={styles.fieldRow}>
            <dt>Destinatarios:</dt>
            <dd>{toEmail || EMPTY_VALUE}</dd>
          </div>
          {ccEmail ? (
            <div className={styles.fieldRow}>
              <dt>CC:</dt>
              <dd>{ccEmail}</dd>
            </div>
          ) : null}
          {bccEmail ? (
            <div className={styles.fieldRow}>
              <dt>BCC:</dt>
              <dd>{bccEmail}</dd>
            </div>
          ) : null}
          {replyTo ? (
            <div className={styles.fieldRow}>
              <dt>Responder a:</dt>
              <dd>{replyTo}</dd>
            </div>
          ) : null}
          {status ? (
            <div className={styles.fieldRow}>
              <dt>Estado:</dt>
              <dd>{status}</dd>
            </div>
          ) : null}
          {transport ? (
            <div className={styles.fieldRow}>
              <dt>Transporte:</dt>
              <dd>{transport}</dd>
            </div>
          ) : null}
        </dl>

        <section className={styles.bodySection}>
          <span className={styles.bodyLabel}>Cuerpo:</span>
          {safeBodyHtml ? (
            <div className={styles.bodyHtml} dangerouslySetInnerHTML={{ __html: safeBodyHtml }} />
          ) : (
            <div className={styles.bodyText}>{bodyText || 'Sin cuerpo'}</div>
          )}
        </section>

        {errorReason ? <p className={styles.errorText}>{errorReason}</p> : null}
      </div>
    </details>
  )
}

export default EmailChatMessageBubble
