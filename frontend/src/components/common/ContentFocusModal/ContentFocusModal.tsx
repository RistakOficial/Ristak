import React, { useCallback, useRef, useState } from 'react'
import { Download, ExternalLink, FileText, Image as ImageIcon, Link2, Video } from 'lucide-react'
import { Modal } from '../Modal'
import { Button } from '../Button'
import { DocumentPreview } from './DocumentPreview'
import { documentActionUrl } from './documentPreviewUtils'
import { useContentFocusSpace } from './useContentFocusSpace'
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
  onDownload?: () => void | Promise<void>
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

export const ContentFocusModal: React.FC<ContentFocusModalProps> = ({ item, onClose, onDownload }) => {
  const stageRef = useRef<HTMLDivElement>(null)
  const space = useContentFocusSpace(stageRef, Boolean(item))
  const [localFile, setLocalFile] = useState({ source: '', url: '' })
  const handleFileReady = useCallback((source: string, url: string) => setLocalFile({ source, url }), [])
  const title = item?.title?.trim() || (item ? getContentKindLabel(item.kind) : 'Contenido')
  const kindLabel = item ? getContentKindLabel(item.kind) : ''
  const sourceUrl = localFile.source === item?.url && localFile.url ? localFile.url : item?.url
  const fileUrl = item && (item.kind === 'document' || item.kind === 'file') && sourceUrl
    ? documentActionUrl(sourceUrl, location.origin) : sourceUrl

  return (
    <Modal
      isOpen={Boolean(item)}
      onClose={onClose}
      title={title}
      subtitle={item ? kindLabel : undefined}
      size="xl"
      type="custom"
      flushContent
      fitContent={item?.kind !== 'link'}
      contentClassName={styles.content}
      className={styles.shell}
    >
      {item ? (
        <div className={`${styles.viewer} ${item.kind === 'link' ? styles.linkViewer : ''}`}>
          <div className={styles.stage} data-content-focus-stage="" ref={stageRef}
            style={{ '--content-focus-media-height': `${space.height}px` } as React.CSSProperties}>
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
            ) : item.kind === 'document' || item.kind === 'file' ? (
              <DocumentPreview key={`${item.url}|${item.mimeType}|${title}`} url={item.url} title={title} mimeType={item.mimeType} onFileReady={handleFileReady} />
            ) : item.kind === 'link' ? (
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

          <div className={styles.details} data-content-focus-details="">
            <span className={styles.kind}>
              {getContentIcon(item.kind)}
              {kindLabel}
            </span>
            {item.caption ? <p>{item.caption}</p> : null}
            <div className={styles.actions}>
              {onDownload ? <Button variant="secondary" size="sm" onClick={() => void onDownload()} leftIcon={<Download size={15} />}>Descargar</Button> : !fileUrl ? <Button variant="secondary" size="sm" disabled leftIcon={<Download size={15} />}>Descargar</Button> : <a className={styles.actionButton} data-btn="" data-v="secondary" data-size="sm" href={fileUrl} download={item.kind !== 'link' ? title : undefined}>
                <Download size={15} />
                Descargar
              </a>}
              {!fileUrl || (onDownload && !(localFile.source === item.url && localFile.url)) ? <Button variant="ghost" size="sm" disabled leftIcon={<ExternalLink size={15} />}>Abrir fuera</Button> : <a className={styles.actionButton} data-btn="" data-v="ghost" data-size="sm" href={fileUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
                Abrir fuera
              </a>}
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
