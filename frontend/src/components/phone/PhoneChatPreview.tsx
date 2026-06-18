import React, { useEffect, useMemo, useRef } from 'react'
import {
  ChevronLeft,
  MessageCircle,
  Mic,
  MoreVertical,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Smile
} from 'lucide-react'
import styles from './PhoneChatPreview.module.css'

export type PhoneChatPreviewMessageDirection = 'inbound' | 'outbound' | 'system'

export interface PhoneChatPreviewButton {
  id?: string
  label: string
  icon?: React.ReactNode
}

export interface PhoneChatPreviewMessage {
  id: string
  direction: PhoneChatPreviewMessageDirection
  body: React.ReactNode
  header?: React.ReactNode
  footer?: React.ReactNode
  time?: string
  buttons?: PhoneChatPreviewButton[]
  internal?: boolean
}

export interface PhoneChatPreviewHeaderAction {
  id?: string
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  onClick?: () => void
}

interface PhoneChatPreviewProps {
  title: string
  subtitle?: string
  avatarLabel?: string
  messages: PhoneChatPreviewMessage[]
  emptyText?: string
  typing?: boolean
  headerActions?: PhoneChatPreviewHeaderAction[]
  composer?: React.ReactNode
  hideComposer?: boolean
  className?: string
  screenClassName?: string
  chatClassName?: string
  ariaLabel?: string
}

interface PhoneChatPreviewComposerProps {
  value?: string
  placeholder?: string
  disabled?: boolean
  sendDisabled?: boolean
  onChange?: (value: string) => void
  onSend?: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
}

const directionClass: Record<PhoneChatPreviewMessageDirection, string> = {
  inbound: styles.messageRowInbound,
  outbound: styles.messageRowOutbound,
  system: styles.messageRowSystem
}

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'WA'
}

export const PhoneChatPreviewComposer: React.FC<PhoneChatPreviewComposerProps> = ({
  value = '',
  placeholder = 'Mensaje',
  disabled = false,
  sendDisabled = false,
  onChange,
  onSend,
  onKeyDown
}) => {
  const hasContent = Boolean(value.trim())

  return (
    <div className={`${styles.composer} ${hasContent ? styles.composerHasContent : ''}`}>
      <button type="button" className={styles.composerPlus} aria-label="Abrir adjuntos" disabled>
        <Plus size={24} />
      </button>
      <div className={styles.messageInputWrap}>
        <input
          className={styles.composerInput}
          data-ristak-unstyled
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label={placeholder}
        />
        <button type="button" className={styles.composerIconButton} aria-label="Emojis" disabled>
          <Smile size={17} />
        </button>
        <button type="button" className={styles.composerIconButton} aria-label="Adjuntar" disabled>
          <Paperclip size={17} />
        </button>
      </div>
      <button
        type="button"
        className={styles.composerSendButton}
        onClick={onSend}
        disabled={disabled || sendDisabled}
        aria-label={hasContent ? 'Enviar mensaje' : 'Mensaje de voz'}
      >
        {hasContent ? <Send size={17} /> : <Mic size={18} />}
      </button>
    </div>
  )
}

export const PhoneChatPreview: React.FC<PhoneChatPreviewProps> = ({
  title,
  subtitle = 'WhatsApp',
  avatarLabel,
  messages,
  emptyText,
  typing = false,
  headerActions,
  composer,
  hideComposer = false,
  className = '',
  screenClassName = '',
  chatClassName = '',
  ariaLabel = 'Vista previa de chat en celular'
}) => {
  const initials = getInitials(avatarLabel || title)
  const chatSurfaceRef = useRef<HTMLDivElement | null>(null)
  const messageScrollKey = useMemo(
    () => messages.map((message) => message.id).join('|'),
    [messages]
  )

  useEffect(() => {
    const surface = chatSurfaceRef.current
    if (!surface) return

    const scrollToBottom = () => {
      surface.scrollTo({
        top: surface.scrollHeight,
        behavior: 'smooth'
      })
    }

    const frame = window.requestAnimationFrame(scrollToBottom)
    return () => window.cancelAnimationFrame(frame)
  }, [messageScrollKey, messages.length, typing])

  return (
    <div className={`${styles.phoneMockup} ${className}`.trim()} aria-label={ariaLabel}>
      <span className={styles.phoneIsland} aria-hidden="true" />
      <div className={`${styles.phoneScreen} ${screenClassName}`.trim()}>
        <header className={styles.chatHeader}>
          <button type="button" className={styles.headerIconButton} aria-label="Volver" disabled>
            <ChevronLeft size={22} />
          </button>
          <span className={styles.avatar} aria-hidden="true">
            {initials}
            <span className={styles.avatarBadge}>
              <MessageCircle size={11} />
            </span>
          </span>
          <div className={styles.headerIdentity}>
            <strong>{title}</strong>
            <span>{subtitle}</span>
          </div>
          <div className={styles.headerActions}>
            {headerActions?.map((action) => (
              <button
                key={action.id || action.label}
                type="button"
                className={styles.headerIconButton}
                onClick={action.onClick}
                disabled={action.disabled}
                aria-label={action.label}
                title={action.label}
              >
                {action.icon || <RotateCcw size={17} />}
              </button>
            ))}
            <button type="button" className={styles.headerIconButton} aria-label="Más opciones" disabled>
              <MoreVertical size={19} />
            </button>
          </div>
        </header>

        <div ref={chatSurfaceRef} className={`${styles.chatSurface} ${chatClassName}`.trim()} data-phone-chat-scrollable="true">
          <div className={styles.messagesContent}>
            <div className={styles.daySeparator}>
              <span>Hoy</span>
            </div>

            {messages.length === 0 && emptyText ? (
              <p className={styles.emptyText}>{emptyText}</p>
            ) : null}

            {messages.map((message) => {
              const messageClassName = [
                styles.messageRow,
                directionClass[message.direction],
                message.internal ? styles.messageRowInternal : ''
              ].filter(Boolean).join(' ')

              return (
                <div key={message.id} className={messageClassName}>
                  <div className={styles.messageStack}>
                    <div className={styles.messageBubble}>
                      {message.header ? <div className={styles.messageHeader}>{message.header}</div> : null}
                      <div className={styles.messageBody}>
                        {typeof message.body === 'string' ? <p>{message.body}</p> : message.body}
                      </div>
                      {(message.footer || message.time) && (
                        <div className={styles.messageMeta}>
                          {message.footer ? <span>{message.footer}</span> : null}
                          {message.time ? <time>{message.time}</time> : null}
                        </div>
                      )}
                    </div>

                    {message.buttons?.length ? (
                      <div className={styles.templateButtons}>
                        {message.buttons.map((button, index) => (
                          <span key={button.id || `${button.label}-${index}`}>
                            {button.icon}
                            {button.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}

            {typing ? (
              <div className={`${styles.messageRow} ${styles.messageRowInbound}`}>
                <div className={styles.messageStack}>
                  <div className={styles.typingBubble} aria-label="Escribiendo">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {!hideComposer && (
          <div className={styles.composerShell} data-phone-chat-composer="true">
            {composer || <PhoneChatPreviewComposer disabled />}
          </div>
        )}
      </div>
    </div>
  )
}
