import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  FileText,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Smile,
  Trash2,
  Video
} from 'lucide-react'
import styles from './PhoneChatPreview.module.css'

export type PhoneChatPreviewMessageDirection = 'inbound' | 'outbound' | 'system'
export type PhoneChatPreviewAttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'pdf' | 'text' | 'file'

export interface PhoneChatPreviewAttachment {
  id?: string
  kind: PhoneChatPreviewAttachmentKind
  name: string
  mimeType?: string
  size?: number
  dataUrl?: string
  url?: string
  thumbnailDataUrl?: string
  durationMs?: number
}

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
  attachments?: PhoneChatPreviewAttachment[]
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
  inputRef?: React.Ref<HTMLInputElement>
  value?: string
  placeholder?: string
  disabled?: boolean
  sendDisabled?: boolean
  hasDraftContent?: boolean
  onChange?: (value: string) => void
  onSend?: () => void
  onAttach?: () => void
  onEmoji?: () => void
  onVoice?: () => void
  voicePanel?: React.ReactNode
  emojiOpen?: boolean
  recording?: boolean
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
}

export interface PhoneChatPreviewAttachmentMenuAction {
  id: string
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
}

interface PhoneChatPreviewAttachmentMenuProps {
  open?: boolean
  actions: PhoneChatPreviewAttachmentMenuAction[]
}

interface PhoneChatPreviewEmojiPickerProps {
  open?: boolean
  emojis?: string[]
  onSelect: (emoji: string) => void
}

interface PhoneChatPreviewDraftAttachmentsProps {
  attachments: PhoneChatPreviewAttachment[]
  onRemove?: (attachmentId: string) => void
}

interface PhoneChatPreviewVoiceComposerProps {
  recording?: boolean
  processing?: boolean
  playing?: boolean
  durationMs?: number
  audioSrc?: string
  bars?: number[]
  onCancel?: () => void
  onPrimary?: () => void
  onSend?: () => void
  onAudioEnded?: () => void
  onAudioPlay?: () => void
  onAudioPause?: () => void
  audioRef?: React.RefObject<HTMLAudioElement | null>
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

function formatPreviewDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatPreviewFileSize(size = 0) {
  if (!size) return ''
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function attachmentSource(attachment: PhoneChatPreviewAttachment) {
  return attachment.dataUrl || attachment.url || attachment.thumbnailDataUrl || ''
}

function attachmentKindLabel(kind: PhoneChatPreviewAttachmentKind) {
  if (kind === 'audio') return 'Nota de voz'
  if (kind === 'image') return 'Imagen'
  if (kind === 'video') return 'Video'
  if (kind === 'pdf') return 'PDF'
  if (kind === 'document') return 'Documento'
  if (kind === 'text') return 'Texto'
  return 'Archivo'
}

const AUDIO_WAVE_PATTERN = [8, 14, 19, 11, 17, 24, 13, 9, 21, 16, 10, 18, 25, 12, 15, 22, 9, 18, 13, 24, 16, 11, 20, 14]
const IPHONE_EMOJI_ROWS = [
  '😀', '😃', '😄', '😁', '😆', '🥹', '😂', '🤣',
  '🙂', '😉', '😊', '😍', '😘', '😎', '🤩', '🥳',
  '😌', '😔', '😅', '😮‍💨', '🤔', '🙌', '👏', '🙏',
  '👍', '👀', '🔥', '✨', '💯', '❤️', '💚', '💬',
  '📸', '🎥', '📍', '📅', '⏰', '✅', '💵', '🚀'
]

export const PhoneChatPreviewComposer: React.FC<PhoneChatPreviewComposerProps> = ({
  inputRef,
  value = '',
  placeholder = 'Mensaje',
  disabled = false,
  sendDisabled = false,
  hasDraftContent = false,
  onChange,
  onSend,
  onAttach,
  onEmoji,
  onVoice,
  voicePanel,
  emojiOpen = false,
  recording = false,
  onKeyDown
}) => {
  const hasContent = Boolean(value.trim())
  const shouldSend = hasContent || hasDraftContent

  if (voicePanel) {
    return (
      <div className={`${styles.composer} ${styles.composerVoiceMode}`}>
        {voicePanel}
      </div>
    )
  }

  return (
    <div className={`${styles.composer} ${shouldSend ? styles.composerHasContent : ''} ${recording ? styles.composerRecording : ''}`}>
      <button
        type="button"
        className={styles.composerPlus}
        aria-label="Abrir adjuntos"
        onClick={onAttach}
        disabled={disabled || !onAttach}
      >
        <Plus size={24} />
      </button>
      <div className={styles.messageInputWrap}>
        <input
          ref={inputRef}
          className={styles.composerInput}
          data-ristak-unstyled
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label={placeholder}
        />
        <button
          type="button"
          className={`${styles.composerIconButton} ${emojiOpen ? styles.composerIconButtonActive : ''}`}
          aria-label="Emojis"
          aria-pressed={emojiOpen}
          onClick={onEmoji}
          disabled={disabled || !onEmoji}
        >
          <Smile size={17} />
        </button>
      </div>
      <button
        type="button"
        className={styles.composerSendButton}
        onClick={shouldSend ? onSend : onVoice}
        disabled={disabled || (shouldSend ? sendDisabled : !onVoice)}
        aria-label={shouldSend ? 'Enviar mensaje' : recording ? 'Detener nota de voz' : 'Mensaje de voz'}
      >
        {shouldSend ? <Send size={17} /> : <Mic size={18} />}
      </button>
    </div>
  )
}

export const PhoneChatPreviewAttachmentMenu: React.FC<PhoneChatPreviewAttachmentMenuProps> = ({
  open = false,
  actions
}) => {
  if (!open) return null

  return (
    <div className={styles.attachmentMenu} role="menu" aria-label="Opciones de adjunto">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={styles.attachmentMenuButton}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          <span aria-hidden="true">{action.icon}</span>
          <strong>{action.label}</strong>
        </button>
      ))}
    </div>
  )
}

export const PhoneChatPreviewEmojiPicker: React.FC<PhoneChatPreviewEmojiPickerProps> = ({
  open = false,
  emojis = IPHONE_EMOJI_ROWS,
  onSelect
}) => {
  if (!open) return null

  return (
    <div className={styles.emojiPicker} aria-label="Selector de emojis">
      <div className={styles.emojiPickerHeader}>
        <span>Frecuentes</span>
      </div>
      <div className={styles.emojiGrid}>
        {emojis.map((emoji, index) => (
          <button
            key={`${emoji}-${index}`}
            type="button"
            className={styles.emojiButton}
            onClick={() => onSelect(emoji)}
            aria-label={`Insertar ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}

export const PhoneChatPreviewDraftAttachments: React.FC<PhoneChatPreviewDraftAttachmentsProps> = ({
  attachments,
  onRemove
}) => {
  if (!attachments.length) return null

  return (
    <div className={styles.draftAttachments}>
      {attachments.map((attachment) => {
        const source = attachmentSource(attachment)
        const label = attachment.name || attachmentKindLabel(attachment.kind)

        return (
          <figure key={attachment.id || label} className={`${styles.draftAttachment} ${attachment.kind !== 'image' ? styles.draftAttachmentFile : ''}`}>
            {attachment.kind === 'image' && source ? (
              <img src={source} alt={label} />
            ) : (
              <span className={styles.draftAttachmentFileContent}>
                {attachment.kind === 'audio' ? <Mic size={21} /> : attachment.kind === 'video' ? <Video size={21} /> : <FileText size={21} />}
                <strong>{label}</strong>
                <small>{formatPreviewFileSize(attachment.size || 0) || attachmentKindLabel(attachment.kind)}</small>
              </span>
            )}
            {onRemove && attachment.id ? (
              <button type="button" onClick={() => onRemove(attachment.id || '')} aria-label={`Quitar ${label}`}>
                <Trash2 size={15} />
              </button>
            ) : null}
          </figure>
        )
      })}
    </div>
  )
}

export const PhoneChatPreviewVoiceComposer: React.FC<PhoneChatPreviewVoiceComposerProps> = ({
  recording = false,
  processing = false,
  playing = false,
  durationMs = 0,
  audioSrc = '',
  bars = AUDIO_WAVE_PATTERN,
  onCancel,
  onPrimary,
  onSend,
  onAudioEnded,
  onAudioPlay,
  onAudioPause,
  audioRef
}) => {
  const PrimaryIcon = recording || playing ? Pause : Play

  return (
    <div className={`${styles.voiceComposerPanel} ${recording ? styles.voiceComposerPanelRecording : ''} ${processing ? styles.voiceComposerPanelProcessing : ''}`}>
      <div className={styles.voiceComposerTrack}>
        <span className={styles.voiceComposerTime}>{formatPreviewDuration(durationMs)}</span>
        <div className={`${styles.voiceComposerWaveform} ${recording ? styles.voiceComposerWaveformRecording : ''} ${playing ? styles.voiceComposerWaveformPlaying : ''}`} aria-hidden="true">
          {bars.map((height, index) => (
            <span
              key={`voice-composer-bar-${index}`}
              className={styles.voiceComposerWaveBar}
              style={{ '--voice-bar-height': `${height}px` } as React.CSSProperties}
            />
          ))}
        </div>
        {audioSrc ? (
          <audio
            ref={audioRef}
            className={styles.voicePreviewAudio}
            preload="metadata"
            src={audioSrc}
            onEnded={onAudioEnded}
            onPause={onAudioPause}
            onPlay={onAudioPlay}
          />
        ) : null}
      </div>
      <div className={styles.voiceComposerActions}>
        <button type="button" className={`${styles.voiceComposerButton} ${styles.voiceDeleteButton}`} onClick={onCancel} disabled={processing} aria-label="Eliminar audio">
          <Trash2 size={23} />
        </button>
        <button type="button" className={`${styles.voiceComposerButton} ${styles.voicePauseButton}`} onClick={onPrimary} disabled={processing} aria-label={recording ? 'Pausar grabación' : playing ? 'Pausar audio' : 'Escuchar audio'}>
          <PrimaryIcon size={recording || playing ? 21 : 19} />
        </button>
        <button type="button" className={`${styles.voiceComposerButton} ${styles.voiceSendAudioButton}`} onClick={onSend} disabled={processing} aria-label="Enviar audio">
          <Send size={18} />
        </button>
      </div>
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
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [audioProgressById, setAudioProgressById] = useState<Record<string, number>>({})
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

  const toggleAudioAttachment = (attachmentKey: string) => {
    const audio = audioRefs.current[attachmentKey]
    if (!audio) return

    if (playingAudioId === attachmentKey && !audio.paused) {
      audio.pause()
      return
    }

    Object.entries(audioRefs.current).forEach(([key, currentAudio]) => {
      if (key !== attachmentKey) currentAudio?.pause()
    })
    audio.play().catch(() => {
      setPlayingAudioId(null)
    })
  }

  const renderAttachment = (
    attachment: PhoneChatPreviewAttachment,
    message: PhoneChatPreviewMessage,
    index: number
  ) => {
    const attachmentKey = `${message.id}-${attachment.id || index}`
    const source = attachmentSource(attachment)
    const label = attachment.name || attachmentKindLabel(attachment.kind)

    if (attachment.kind === 'image' && source) {
      return (
        <img
          key={attachmentKey}
          className={styles.messageImage}
          src={source}
          alt={label}
        />
      )
    }

    if (attachment.kind === 'video' && source) {
      return (
        <video
          key={attachmentKey}
          className={styles.messageVideo}
          src={source}
          controls
          playsInline
          preload="metadata"
          aria-label={label}
        />
      )
    }

    if (attachment.kind === 'audio' && source) {
      const isPlaying = playingAudioId === attachmentKey
      const progress = audioProgressById[attachmentKey] || 0

      return (
        <div key={attachmentKey} className={styles.messageAudio}>
          <audio
            ref={(node) => {
              audioRefs.current[attachmentKey] = node
            }}
            className={styles.messageAudioNative}
            preload="metadata"
            src={source}
            onTimeUpdate={(event) => {
              const audio = event.currentTarget
              const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
              setAudioProgressById((current) => ({
                ...current,
                [attachmentKey]: duration ? Math.min(100, (audio.currentTime / duration) * 100) : 0
              }))
            }}
            onLoadedMetadata={(event) => {
              const audio = event.currentTarget
              const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : attachment.durationMs || 0
              setAudioProgressById((current) => ({
                ...current,
                [attachmentKey]: durationMs ? current[attachmentKey] || 0 : 0
              }))
            }}
            onPlay={() => setPlayingAudioId(attachmentKey)}
            onPause={() => setPlayingAudioId((current) => current === attachmentKey ? null : current)}
            onEnded={() => {
              setPlayingAudioId((current) => current === attachmentKey ? null : current)
              setAudioProgressById((current) => ({ ...current, [attachmentKey]: 0 }))
            }}
          />
          <button
            type="button"
            className={styles.messageAudioPlayButton}
            onClick={() => toggleAudioAttachment(attachmentKey)}
            aria-label={isPlaying ? 'Pausar audio' : 'Reproducir audio'}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={19} />}
          </button>
          <div
            className={styles.messageAudioWaveform}
            style={{ '--audio-progress': `${progress}%` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className={styles.messageAudioProgressDot} />
            {AUDIO_WAVE_PATTERN.map((height, barIndex) => (
              <span
                key={`bar-${barIndex}`}
                className={styles.messageAudioWaveBar}
                style={{ '--bar-height': `${height}px` } as React.CSSProperties}
              />
            ))}
          </div>
          <span className={styles.messageAudioDuration}>{formatPreviewDuration(attachment.durationMs || 0)}</span>
        </div>
      )
    }

    const FileIcon = attachment.kind === 'image' ? ImageIcon : attachment.kind === 'video' ? Video : FileText
    const fileHref = source || undefined

    const content = (
      <>
        <span className={styles.messageFileIcon} aria-hidden="true">
          <FileIcon size={19} />
        </span>
        <span className={styles.messageFileText}>
          <strong>{label}</strong>
          <small>{formatPreviewFileSize(attachment.size || 0) || attachment.mimeType || attachmentKindLabel(attachment.kind)}</small>
        </span>
      </>
    )

    return fileHref ? (
      <a key={attachmentKey} className={styles.messageFile} href={fileHref} target="_blank" rel="noreferrer">
        {content}
      </a>
    ) : (
      <span key={attachmentKey} className={styles.messageFile}>
        {content}
      </span>
    )
  }

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
              const hasTextBody = typeof message.body === 'string'
                ? Boolean(message.body.trim())
                : message.body !== null && message.body !== undefined
              const attachments = Array.isArray(message.attachments) ? message.attachments : []

              return (
                <div key={message.id} className={messageClassName}>
                  <div className={styles.messageStack}>
                    <div className={`${styles.messageBubble} ${attachments.some((attachment) => attachment.kind === 'audio') ? styles.messageBubbleAudio : ''} ${attachments.some((attachment) => ['document', 'pdf', 'text', 'file'].includes(attachment.kind)) ? styles.messageBubbleFile : ''}`}>
                      {message.header ? <div className={styles.messageHeader}>{message.header}</div> : null}
                      {attachments.length ? (
                        <div className={styles.messageAttachments}>
                          {attachments.map((attachment, index) => renderAttachment(attachment, message, index))}
                        </div>
                      ) : null}
                      {hasTextBody ? (
                        <div className={styles.messageBody}>
                          {typeof message.body === 'string' ? <p>{message.body}</p> : message.body}
                        </div>
                      ) : null}
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
