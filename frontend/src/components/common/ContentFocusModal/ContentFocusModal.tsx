import React from 'react'
import { Download, ExternalLink, FileText, Image as ImageIcon, Link2, Video } from 'lucide-react'
import { Modal } from '../Modal'
import styles from './ContentFocusModal.module.css'

export type ContentFocusKind = 'image' | 'video' | 'document' | 'file' | 'link'

export interface ContentFocusItem {
  url: string
  title?: string
  caption?: string
  kind: ContentFocusKind
  mimeType?: string
  isGif?: boolean
}

interface ContentFocusModalProps {
  item: ContentFocusItem | null
  onClose: () => void
}

function getContentKindLabel(kind: ContentFocusKind) {
  if (kind === 'image') return 'Imagen'
  if (kind === 'video') return 'Video'
  if (kind === 'document') return 'Documento'
  if (kind === 'link') return 'Enlace'
  return 'Archivo'
}

function getContentIcon(kind: ContentFocusKind) {
  if (kind === 'image') return <ImageIcon size={18} />
  if (kind === 'video') return <Video size={18} />
  if (kind === 'link') return <Link2 size={18} />
  return <FileText size={18} />
}

function canEmbedInline(item: ContentFocusItem) {
  const value = `${item.mimeType || ''} ${item.url || ''} ${item.title || ''}`.toLowerCase()
  return (
    item.kind === 'link' ||
    value.includes('pdf') ||
    value.includes('text/') ||
    value.includes('.pdf') ||
    value.includes('.txt')
  )
}

export const ContentFocusModal: React.FC<ContentFocusModalProps> = ({ item, onClose }) => {
  const title = item?.title?.trim() || (item ? getContentKindLabel(item.kind) : 'Contenido')
  const kindLabel = item ? getContentKindLabel(item.kind) : ''

  return (
    <Modal
      isOpen={Boolean(item)}
      onClose={onClose}
      title={title}
      subtitle={item ? kindLabel : undefined}
      size="xl"
      type="custom"
      flushContent
      contentClassName={styles.content}
      className={styles.shell}
    >
      {item ? (
        <div className={styles.viewer}>
          <div className={styles.stage}>
            {item.kind === 'image' ? (
              <img className={styles.image} src={item.url} alt={title} />
            ) : item.kind === 'video' ? (
              <video
                className={styles.video}
                src={item.url}
                controls={!item.isGif}
                autoPlay={item.isGif}
                muted={item.isGif}
                loop={item.isGif}
                playsInline
                preload={item.isGif ? 'auto' : 'metadata'}
              />
            ) : canEmbedInline(item) ? (
              <iframe
                className={styles.frame}
                src={item.url}
                title={title}
                sandbox="allow-downloads allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              />
            ) : (
              <div className={styles.filePreview}>
                <span className={styles.fileIcon}>{getContentIcon(item.kind)}</span>
                <strong>{title}</strong>
                <small>{item.mimeType || kindLabel}</small>
              </div>
            )}
          </div>

          <div className={styles.details}>
            <span className={styles.kind}>
              {getContentIcon(item.kind)}
              {kindLabel}
            </span>
            {item.caption ? <p>{item.caption}</p> : null}
            <div className={styles.actions}>
              <a className={styles.actionButton} data-btn="" data-v="secondary" data-size="sm" href={item.url} download={item.kind !== 'link' ? title : undefined}>
                <Download size={15} />
                Descargar
              </a>
              <a className={styles.actionButton} data-btn="" data-v="ghost" data-size="sm" href={item.url} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
                Abrir fuera
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
