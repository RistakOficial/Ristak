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
import { MessageComposer } from '../composer/MessageComposer'
import { TextInput, Toggle } from './configPrimitives'
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
  supportsQuickReplies = false
}) => {
  const blocks = asMessageBlocks(value)

  const updateBlock = (index: number, patch: Partial<MessageBlock>) => {
    onChange(blocks.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)))
  }

  const removeBlock = (index: number) => onChange(blocks.filter((_, candidate) => candidate !== index))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Retraso abierto en popover: id del bloque + rect de su pastilla
  const [delayEditor, setDelayEditor] = useState<{ id: string; anchor: DOMRect } | null>(null)

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

        // Adjuntos: imagen, video, audio, archivo
        const MediaIcon = CONTENT_BLOCKS.find((option) => option.type === block.type)?.icon || Link2
        return (
          <SortableBlock key={block.id} id={block.id} onRemove={() => removeBlock(index)}>
          <div className={styles.panelBubble}>
            <div className={styles.panelDelayTitle}>
              <MediaIcon size={13} />
              {MEDIA_LABELS[block.type] || 'Adjunto'}
            </div>
            <TextInput
              value={block.url || ''}
              placeholder="URL del archivo (https://…)"
              onChange={(event) => updateBlock(index, { url: event.target.value })}
            />
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
      <div className={styles.contentBlocksTitle}>Añade uno de los bloques de contenido:</div>
      {CONTENT_BLOCKS.map((option) => (
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
