import {
  Copy,
  ExternalLink,
  FileText,
  MapPin,
  Phone,
  PhoneCall,
  Reply
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { WhatsAppFormattedText } from '../WhatsAppFormattedText'
import type {
  WhatsAppMessageButtonType,
  WhatsAppMessagePresentation
} from './presentation'
import styles from './WhatsAppMessageContent.module.css'

export interface WhatsAppMessageContentProps {
  presentation: WhatsAppMessagePresentation
  fallbackText?: string
  className?: string
}

function MessageActionIcon({ type }: { type: WhatsAppMessageButtonType }) {
  if (type === 'url') return <ExternalLink size={15} aria-hidden="true" />
  if (type === 'phone') return <Phone size={15} aria-hidden="true" />
  if (type === 'copy_code') return <Copy size={15} aria-hidden="true" />
  if (type === 'voice_call') return <PhoneCall size={15} aria-hidden="true" />
  return <Reply size={15} aria-hidden="true" />
}

function MessageHeader({ header }: { header: NonNullable<WhatsAppMessagePresentation['header']> }) {
  if (header.kind === 'image' && header.mediaUrl) {
    return (
      <img
        src={header.mediaUrl}
        alt={header.text || 'Imagen del encabezado de WhatsApp'}
        className={styles.headerImage}
        loading="lazy"
        decoding="async"
      />
    )
  }

  if (header.kind === 'video' && header.mediaUrl) {
    return (
      <video
        src={header.mediaUrl}
        className={styles.headerVideo}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (header.kind === 'document') {
    return (
      <span className={styles.headerAsset}>
        <FileText size={18} aria-hidden="true" />
        <span>{header.fileName || header.text || 'Documento adjunto'}</span>
      </span>
    )
  }

  if (header.kind === 'location') {
    return (
      <span className={styles.headerAsset}>
        <MapPin size={18} aria-hidden="true" />
        <span>{header.text || 'Ubicación compartida'}</span>
      </span>
    )
  }

  return header.text
    ? <WhatsAppFormattedText text={header.text} className={styles.headerText} />
    : null
}

export function WhatsAppMessageContent({
  presentation,
  fallbackText = '',
  className
}: WhatsAppMessageContentProps) {
  const body = presentation.body || fallbackText

  return (
    <div className={cn(styles.content, className)} data-whatsapp-message-content={presentation.kind}>
      {presentation.header ? <MessageHeader header={presentation.header} /> : null}
      {body ? <WhatsAppFormattedText text={body} className={styles.body} /> : null}
      {presentation.footer ? (
        <WhatsAppFormattedText text={presentation.footer} className={styles.footer} />
      ) : null}
      {presentation.buttons.length ? (
        <div className={styles.actions} aria-label="Opciones mostradas en WhatsApp">
          {presentation.buttons.map((button, index) => (
            <span
              key={`${button.type}-${button.label}-${index}`}
              className={styles.action}
              title="Vista del botón enviado; no se ejecuta desde Ristak"
            >
              <MessageActionIcon type={button.type} />
              <span>{button.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default WhatsAppMessageContent
