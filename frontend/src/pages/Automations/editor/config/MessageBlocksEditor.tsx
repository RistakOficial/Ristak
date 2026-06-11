import React from 'react'
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Clock,
  FileText,
  Image,
  Link2,
  Music,
  Plus,
  Trash2,
  Video,
  X
} from 'lucide-react'
import { CustomSelect } from '@/components/common'
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

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = blocks.slice()
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  const blockHoverActions = (index: number) => (
    <span className={styles.blockHoverActions}>
      <button type="button" className={styles.configIconButtonPlain} title="Subir" disabled={index === 0} onClick={() => moveBlock(index, -1)}>
        <ArrowUp size={11} />
      </button>
      <button
        type="button"
        className={styles.configIconButtonPlain}
        title="Bajar"
        disabled={index === blocks.length - 1}
        onClick={() => moveBlock(index, 1)}
      >
        <ArrowDown size={11} />
      </button>
      <button type="button" className={styles.configIconButton} title="Quitar bloque" onClick={() => removeBlock(index)}>
        <Trash2 size={11} />
      </button>
    </span>
  )

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
      {/* ----------------------- Secuencia de bloques ----------------------- */}
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          const buttons = block.buttons || []
          return (
            <div key={block.id} className={styles.panelBubble}>
              {blockHoverActions(index)}
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
          )
        }

        if (block.type === 'delay') {
          return (
            <div key={block.id} className={styles.panelDelay}>
              {blockHoverActions(index)}
              <div className={styles.panelDelayTitle}>
                <Clock size={13} />
                Retraso
              </div>
              <div className={styles.configRow}>
                <TextInput
                  type="number"
                  min={1}
                  style={{ width: 80 }}
                  value={Number(block.amount) || 0}
                  onChange={(event) => updateBlock(index, { amount: Number(event.target.value) })}
                />
                <div className={styles.configRowGrow}>
                  <CustomSelect
                    options={[
                      { value: 'seconds', label: 'Segundos' },
                      { value: 'minutes', label: 'Minutos' }
                    ]}
                    value={block.unit || 'seconds'}
                    onValueChange={(next) => updateBlock(index, { unit: next === 'minutes' ? 'minutes' : 'seconds' })}
                    aria-label="Unidad"
                  />
                </div>
              </div>
              <Toggle
                checked={block.showTyping !== false}
                onChange={(checked) => updateBlock(index, { showTyping: checked })}
                label='Mostrar "escribiendo…" durante el retraso'
              />
            </div>
          )
        }

        // Adjuntos: imagen, video, audio, archivo
        const MediaIcon = CONTENT_BLOCKS.find((option) => option.type === block.type)?.icon || Link2
        return (
          <div key={block.id} className={styles.panelBubble}>
            {blockHoverActions(index)}
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
        )
      })}

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
