import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlignLeft,
  Clock,
  GripVertical,
  Loader2,
  Upload,
  X as XIcon,
  FileText,
  Image,
  Link2,
  Music,
  Plus,
  Trash2,
  Video,
  X
} from 'lucide-react'
import { CustomSelect } from './configPrimitives'
import {
  MAX_BUTTONS_PER_MESSAGE,
  MEDIA_BLOCK_TYPES,
  asMessageBlocks,
  type MessageBlock,
  type MessageBlockType,
  type MessageButton
} from '../nodeRegistry'
import { genId } from '../flowUtils'
import automationsService from '@/services/automationsService'
import { MessageComposer } from '../composer/MessageComposer'
import { CatalogSelect, TextInput, Toggle } from './configPrimitives'
import { WhatsAppTemplatePreview, templateInputs, useWhatsAppTemplate } from './WhatsAppTemplatePreview'
import { VariableTextInput } from '../composer/MessageComposer'
import styles from '../AutomationEditor.module.css'

/**
 * Editor de la secuencia de mensajes de un nodo de canal (estilo ManyChat):
 * globos de texto con botones dentro, retrasos con "escribiendo…", adjuntos
 * y la lista de bloques de contenido para agregar.
 */

interface MessageBlocksEditorProps {
  value: unknown
  onChange: (blocks: MessageBlock[]) => void
  supportsQuickReplies?: boolean
  /** 'chat' = globos normales; 'template' = secuencia de plantillas + retrasos */
  variant?: 'chat' | 'template'
}

interface ContentBlockOption {
  type: MessageBlockType
  title: string
  description: string
  icon: React.ComponentType<{ size?: number | string }>
}

// Bloques de contenido disponibles (los adjuntos usan URL: adaptador
// pendiente para subir archivos cuando exista backend de medios)
const CONTENT_BLOCKS: ContentBlockOption[] = [
  { type: 'text', title: 'Texto', description: 'Añadir texto y botones simples', icon: AlignLeft },
  { type: 'image', title: 'Imagen', description: 'Aumenta la participación con elementos visuales', icon: Image },
  { type: 'video', title: 'Video', description: 'Comparte un video con el contacto', icon: Video },
  { type: 'audio', title: 'Audio', description: 'Envía una nota de voz o audio', icon: Music },
  { type: 'file', title: 'Archivo', description: 'Adjunta un documento o archivo', icon: FileText },
  { type: 'delay', title: 'Retraso', description: 'Espera unos segundos entre los textos', icon: Clock }
]

// En modo plantilla solo se encadenan plantillas y tiempos de espera
const TEMPLATE_BLOCKS: ContentBlockOption[] = [
  { type: 'template', title: 'Plantilla', description: 'Envía otra plantilla aprobada de WhatsApp', icon: FileText },
  { type: 'delay', title: 'Retraso', description: 'Espera unos segundos entre plantillas', icon: Clock }
]

const MEDIA_ACCEPT: Record<string, string> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  file: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip'
}

const MEDIA_LABELS: Record<string, string> = {
  image: 'Imagen',
  video: 'Video',
  audio: 'Audio',
  file: 'Archivo'
}

function newBlock(type: MessageBlockType): MessageBlock {
  if (type === 'text') {
    return { id: genId('blk'), type, compiledText: '', buttons: [], quickReplies: [] }
  }
  if (type === 'delay') {
    return { id: genId('blk'), type, amount: 3, unit: 'seconds', showTyping: true }
  }
  if (type === 'template') {
    return { id: genId('blk'), type, templateId: '', templateName: '' }
  }
  return { id: genId('blk'), type, url: '', caption: '' }
}

/** Popover flotante para configurar el retraso (como ManyChat): se abre al
    lado de la pastilla, hacia donde haya espacio. */
const DelayPopover: React.FC<{
  anchor: DOMRect
  amount: number
  unit: string
  showTyping: boolean
  onChange: (patch: Partial<MessageBlock>) => void
  onClose: () => void
}> = ({ anchor, amount, unit, showTyping, onChange, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const WIDTH = 260
  const openRight = window.innerWidth - anchor.right > WIDTH + 28
  const left = openRight ? anchor.right + 14 : Math.max(8, anchor.left - WIDTH - 14)
  const top = Math.max(8, Math.min(anchor.top - 8, window.innerHeight - 220))

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className={styles.delayPopover}
      style={{ left, top, width: WIDTH }}
      data-automation-interactive="true"
    >
      <div className={styles.delayPopoverHeader}>
        <span>Retraso</span>
        <button type="button" className={styles.configIconButtonPlain} title="Cerrar" onClick={onClose}>
          <XIcon size={13} />
        </button>
      </div>
      <div className={styles.delayPopoverLabel}>Duración del retraso</div>
      <div className={styles.configRow}>
        <TextInput
          type="number"
          min={1}
          style={{ width: 76 }}
          value={amount}
          onChange={(event) => onChange({ amount: Number(event.target.value) })}
        />
        <div className={styles.configRowGrow}>
          <CustomSelect
            options={[
              { value: 'seconds', label: 'Segundos' },
              { value: 'minutes', label: 'Minutos' }
            ]}
            value={unit}
            onValueChange={(next) => onChange({ unit: next === 'minutes' ? 'minutes' : 'seconds' })}
            aria-label="Unidad"
          />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Toggle
          checked={showTyping}
          onChange={(checked) => onChange({ showTyping: checked })}
          label='Mostrar "escribiendo…" durante el retraso'
        />
      </div>
    </div>,
    document.body
  )
}

/** Lo que la plantilla pide llenar: variables {{n}} y archivo del encabezado */
const TemplateBlockInputs: React.FC<{
  block: MessageBlock
  onPatch: (patch: Partial<MessageBlock>) => void
  onUploadHeader: (file: File) => void
  uploading: boolean
}> = ({ block, onPatch, onUploadHeader, uploading }) => {
  const template = useWhatsAppTemplate(block.templateId || '')
  const { variables, headerFormat } = templateInputs(template)
  const values = block.templateVariables || {}

  if (!template) return null
  return (
    <div style={{ marginTop: 8 }}>
      {headerFormat && (
        <>
          <div className={styles.delayPopoverLabel}>
            {headerFormat === 'IMAGE' ? 'Imagen' : headerFormat === 'VIDEO' ? 'Video' : 'Documento'} del encabezado
          </div>
          {block.headerMediaUrl && headerFormat === 'IMAGE' && (
            <img src={block.headerMediaUrl} alt="Encabezado" className={styles.mediaPreviewImage} />
          )}
          {block.headerMediaUrl && headerFormat !== 'IMAGE' && (
            <a href={block.headerMediaUrl} target="_blank" rel="noreferrer" className={styles.mediaPreviewFile}>
              <Link2 size={12} /> Ver archivo del encabezado
            </a>
          )}
          <label className={styles.mediaUploadButton}>
            {uploading ? <Loader2 size={13} className={styles.mediaUploadSpinner} /> : <Upload size={13} />}
            {uploading ? 'Subiendo…' : block.headerMediaUrl ? 'Cambiar archivo' : 'Cargar archivo del encabezado'}
            <input
              type="file"
              accept={headerFormat === 'IMAGE' ? 'image/*' : headerFormat === 'VIDEO' ? 'video/*' : '.pdf,.doc,.docx'}
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onUploadHeader(file)
                event.target.value = ''
              }}
            />
          </label>
        </>
      )}

      {variables.length > 0 && (
        <div style={{ marginTop: headerFormat ? 8 : 0 }}>
          <div className={styles.delayPopoverLabel}>Valores de las variables</div>
          {variables.map((number) => (
            <div key={number} style={{ marginBottom: 6 }}>
              <VariableTextInput
                value={values[number] || ''}
                onChange={(compiled) =>
                  onPatch({ templateVariables: { ...values, [number]: compiled } })
                }
                placeholder={`Variable ${number} (texto o variable del contacto)`}
                aria-label={`Variable ${number}`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Envoltorio arrastrable de un bloque: asa + basura al hover, animación dnd-kit */
const SortableBlock: React.FC<{
  id: string
  onRemove: () => void
  children: React.ReactNode
}> = ({ id, onRemove, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 5 : undefined }}
      className={isDragging ? styles.blockDragging : undefined}
    >
      <div className={styles.blockSortWrap}>
        <span className={styles.blockHoverActions}>
          <span
            className={styles.blockDragHandle}
            title="Arrastra para reordenar"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={12} />
          </span>
          <button type="button" className={styles.configIconButton} title="Quitar bloque" onClick={onRemove}>
            <Trash2 size={11} />
          </button>
        </span>
        {children}
      </div>
    </div>
  )
}

export const MessageBlocksEditor: React.FC<MessageBlocksEditorProps> = ({
  value,
  onChange,
  supportsQuickReplies = false,
  variant = 'chat'
}) => {
  const blocks = asMessageBlocks(value)

  const updateBlock = (index: number, patch: Partial<MessageBlock>) => {
    onChange(blocks.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)))
  }

  const removeBlock = (index: number) => onChange(blocks.filter((_, candidate) => candidate !== index))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Retraso abierto en popover: id del bloque + rect de su pastilla
  const [delayEditor, setDelayEditor] = useState<{ id: string; anchor: DOMRect } | null>(null)

  // Subidas en curso (id del bloque) y errores por bloque
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({})

  /** Reduce imágenes en el navegador (máx. 1600px, WebP/JPEG) antes de subir.
      El backend además convierte audio→Ogg Opus (nota de voz) y video→MP4. */
  const compressImageInBrowser = (file: File): Promise<File> =>
    new Promise((resolve) => {
      if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml' || file.size < 150 * 1024) {
        resolve(file)
        return
      }
      const url = URL.createObjectURL(file)
      const image = new window.Image()
      image.onload = () => {
        URL.revokeObjectURL(url)
        const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.width * scale)
        canvas.height = Math.round(image.height * scale)
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(file)
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(
          (blob) => {
            if (blob && blob.size < file.size) {
              resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' }))
            } else {
              resolve(file)
            }
          },
          'image/webp',
          0.82
        )
      }
      image.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(file)
      }
      image.src = url
    })

  const uploadFile = (index: number, blockId: string, file: File, target: 'url' | 'headerMediaUrl' = 'url') => {
    setUploading((current) => ({ ...current, [blockId]: true }))
    setUploadErrors((current) => ({ ...current, [blockId]: '' }))
    void compressImageInBrowser(file).then((prepared) => {
      const reader = new FileReader()
      reader.onload = () => {
        void automationsService
          .uploadAsset(String(reader.result), prepared.name)
          .then((asset) => updateBlock(index, { [target]: asset.url }))
          .catch((error: Error) => {
            setUploadErrors((current) => ({ ...current, [blockId]: error.message || 'No se pudo subir el archivo' }))
          })
          .finally(() => setUploading((current) => ({ ...current, [blockId]: false })))
      }
      reader.readAsDataURL(prepared)
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = blocks.findIndex((block) => block.id === active.id)
    const to = blocks.findIndex((block) => block.id === over.id)
    if (from === -1 || to === -1) return
    onChange(arrayMove(blocks, from, to))
  }

  // ------------------------------------------------------------------
  // Botones dentro de un globo de texto
  // ------------------------------------------------------------------
  const renderButtons = (block: MessageBlock, index: number, key: 'buttons' | 'quickReplies') => {
    const list = (block[key] || []) as MessageButton[]
    const update = (buttonIndex: number, patch: Partial<MessageButton>) => {
      updateBlock(index, {
        [key]: list.map((button, candidate) => (candidate === buttonIndex ? { ...button, ...patch } : button))
      })
    }
    return list.map((button, buttonIndex) => (
      <div key={button.id} className={styles.bubbleButtonEditor}>
        <TextInput
          className={styles.configRowGrow}
          value={button.label}
          maxLength={40}
          placeholder="Texto del botón"
          onChange={(event) => update(buttonIndex, { label: event.target.value })}
        />
        <div style={{ width: 118, flexShrink: 0 }}>
          <CustomSelect
            options={[
              { value: 'branch', label: 'Crear salida' },
              { value: 'url', label: 'Abrir URL' }
            ]}
            value={button.action}
            onValueChange={(next) => update(buttonIndex, { action: next === 'url' ? 'url' : 'branch' })}
            aria-label="Acción del botón"
          />
        </div>
        <button
          type="button"
          className={styles.configIconButton}
          title="Quitar botón"
          onClick={() => updateBlock(index, { [key]: list.filter((_, candidate) => candidate !== buttonIndex) })}
        >
          <X size={11} />
        </button>
        {button.action === 'url' && (
          <TextInput
            style={{ width: '100%' }}
            value={button.url || ''}
            placeholder="https://…"
            onChange={(event) => update(buttonIndex, { url: event.target.value })}
          />
        )}
      </div>
    ))
  }

  return (
    <div>
      {/* ------- Secuencia de bloques (arrastra el asa para reordenar) ------- */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          const buttons = block.buttons || []
          return (
            <SortableBlock key={block.id} id={block.id} onRemove={() => removeBlock(index)}>
            <div className={styles.panelBubble}>
              <MessageComposer
                value={block.compiledText || ''}
                onChange={(compiled) => updateBlock(index, { compiledText: compiled })}
                placeholder="Escribe el mensaje…"
                showEmoji
                aria-label="Texto del mensaje"
              />
              {renderButtons(block, index, 'buttons')}
              <button
                type="button"
                className={styles.addButtonInBubble}
                disabled={buttons.length >= MAX_BUTTONS_PER_MESSAGE}
                onClick={() =>
                  updateBlock(index, {
                    buttons: [...buttons, { id: genId('btn'), label: '', action: 'branch' }]
                  })
                }
              >
                <Plus size={11} />
                Añadir botón{buttons.length >= MAX_BUTTONS_PER_MESSAGE ? ' (máx. 3)' : ''}
              </button>
            </div>
            </SortableBlock>
          )
        }

        if (block.type === 'delay') {
          const unitLabel = block.unit === 'minutes' ? 'min' : 'seg'
          return (
            <SortableBlock key={block.id} id={block.id} onRemove={() => removeBlock(index)}>
              {/* Pastilla compacta: la configuración vive en un popover lateral */}
              <button
                type="button"
                className={styles.delayPill}
                title="Configurar el retraso"
                onClick={(event) =>
                  setDelayEditor({ id: block.id, anchor: (event.currentTarget as HTMLElement).getBoundingClientRect() })
                }
              >
                {block.showTyping !== false ? 'Escribiendo' : 'Espera'}
                <Clock size={12} />
                {Number(block.amount) || 0} {unitLabel}
              </button>
              {delayEditor?.id === block.id && (
                <DelayPopover
                  anchor={delayEditor.anchor}
                  amount={Number(block.amount) || 0}
                  unit={block.unit || 'seconds'}
                  showTyping={block.showTyping !== false}
                  onChange={(patch) => updateBlock(index, patch)}
                  onClose={() => setDelayEditor(null)}
                />
              )}
            </SortableBlock>
          )
        }

        if (block.type === 'template') {
          return (
            <SortableBlock key={block.id} id={block.id} onRemove={() => removeBlock(index)}>
              <div className={styles.panelBubble}>
                <div className={styles.panelDelayTitle}>
                  <FileText size={13} />
                  Plantilla de WhatsApp
                </div>
                <CatalogSelect
                  catalog="whatsappTemplates"
                  value={block.templateId || ''}
                  onChange={(templateId, templateName) => updateBlock(index, { templateId, templateName })}
                  placeholder="Selecciona la plantilla aprobada"
                  aria-label="Plantilla"
                />
                {/* Lo que la plantilla envía de verdad: texto, variables y botones */}
                {block.templateId && <WhatsAppTemplatePreview templateId={block.templateId} />}
                {block.templateId && (
                  <TemplateBlockInputs
                    block={block}
                    onPatch={(patch) => updateBlock(index, patch)}
                    uploading={Boolean(uploading[block.id])}
                    onUploadHeader={(file) => uploadFile(index, block.id, file, 'headerMediaUrl')}
                  />
                )}
              </div>
            </SortableBlock>
          )
        }

        // Adjuntos: imagen, video, audio, archivo (subir a Ristak o pegar URL)
        const MediaIcon = CONTENT_BLOCKS.find((option) => option.type === block.type)?.icon || Link2
        const isUploading = Boolean(uploading[block.id])
        const uploadError = uploadErrors[block.id]
        return (
          <SortableBlock key={block.id} id={block.id} onRemove={() => removeBlock(index)}>
          <div className={styles.panelBubble}>
            <div className={styles.panelDelayTitle}>
              <MediaIcon size={13} />
              {MEDIA_LABELS[block.type] || 'Adjunto'}
            </div>

            {/* Previsualización del archivo ya subido */}
            {block.url && block.type === 'image' && (
              <img src={block.url} alt={block.caption || 'Imagen'} className={styles.mediaPreviewImage} />
            )}
            {block.url && block.type === 'video' && (
              <video src={block.url} controls className={styles.mediaPreviewImage} />
            )}
            {block.url && block.type === 'audio' && (
              <audio src={block.url} controls className={styles.mediaPreviewAudio} />
            )}
            {block.type === 'audio' && (
              <div style={{ marginBottom: 8 }}>
                <Toggle
                  checked={block.voiceNote !== false}
                  onChange={(checked) => updateBlock(index, { voiceNote: checked })}
                  label="Enviar como nota de voz de WhatsApp"
                />
              </div>
            )}
            {block.url && block.type === 'file' && (
              <a href={block.url} target="_blank" rel="noreferrer" className={styles.mediaPreviewFile}>
                <Link2 size={12} />
                {block.url.startsWith('/api/automations/assets/') ? 'Ver archivo subido' : block.url}
              </a>
            )}

            <label className={styles.mediaUploadButton}>
              {isUploading ? <Loader2 size={13} className={styles.mediaUploadSpinner} /> : <Upload size={13} />}
              {isUploading ? 'Subiendo…' : block.url ? 'Cambiar archivo' : `Cargar ${MEDIA_LABELS[block.type]?.toLowerCase() || 'archivo'}`}
              <input
                type="file"
                accept={MEDIA_ACCEPT[block.type]}
                style={{ display: 'none' }}
                disabled={isUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) uploadFile(index, block.id, file)
                  event.target.value = ''
                }}
              />
            </label>
            {uploadError && <div className={styles.mediaUploadError}>{uploadError}</div>}

            {block.type === 'file' && (
              <div style={{ marginTop: 6 }}>
                <TextInput
                  value={block.url || ''}
                  placeholder="…o pega una URL (https://…)"
                  onChange={(event) => updateBlock(index, { url: event.target.value })}
                />
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <TextInput
                value={block.caption || ''}
                placeholder="Texto opcional que acompaña al adjunto"
                onChange={(event) => updateBlock(index, { caption: event.target.value })}
              />
            </div>
          </div>
          </SortableBlock>
        )
      })}
        </SortableContext>
      </DndContext>

      {/* --------------------- Respuestas rápidas (pill) -------------------- */}
      {supportsQuickReplies && (
        <div className={styles.quickRepliesArea}>
          {blocks.map((block, index) =>
            block.type === 'text' && (block.quickReplies || []).length > 0 ? (
              <React.Fragment key={block.id}>{renderButtons(block, index, 'quickReplies')}</React.Fragment>
            ) : null
          )}
          {(() => {
            const lastTextIndex = blocks.map((block) => block.type).lastIndexOf('text')
            if (lastTextIndex === -1) return null
            const list = blocks[lastTextIndex].quickReplies || []
            return (
              <button
                type="button"
                className={styles.quickReplyPill}
                onClick={() =>
                  updateBlock(lastTextIndex, {
                    quickReplies: [...list, { id: genId('qr'), label: '', action: 'branch' }]
                  })
                }
              >
                <Plus size={11} />
                Respuesta inmediata
              </button>
            )
          })()}
        </div>
      )}

      {/* ---------------------- Bloques de contenido ------------------------ */}
      <div className={styles.contentBlocksTitle}>
        {variant === 'template' ? 'Encadena plantillas y tiempos de espera:' : 'Añade uno de los bloques de contenido:'}
      </div>
      {(variant === 'template' ? TEMPLATE_BLOCKS : CONTENT_BLOCKS).map((option) => (
        <button
          key={option.type}
          type="button"
          className={styles.contentBlockCard}
          onClick={() => onChange([...blocks, newBlock(option.type)])}
        >
          <span className={styles.contentBlockIcon}>
            <option.icon size={15} />
          </span>
          <span className={styles.contentBlockText}>
            <span className={styles.contentBlockTitle}>{option.title}</span>
            <span className={styles.contentBlockDescription}>{option.description}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export const messageBlockHelpers = { newBlock }
