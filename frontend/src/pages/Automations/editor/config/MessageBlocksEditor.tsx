import React from 'react'
import { ArrowDown, ArrowUp, Clock, MessageSquareText, Plus, Trash2 } from 'lucide-react'
import { CustomSelect } from '@/components/common'
import {
  MAX_BUTTONS_PER_MESSAGE,
  asMessageBlocks,
  type MessageBlock,
  type MessageButton
} from '../nodeRegistry'
import { genId } from '../flowUtils'
import { MessageComposer } from '../composer/MessageComposer'
import { Field, TextInput } from './configPrimitives'
import styles from '../AutomationEditor.module.css'

/**
 * Editor de la mini-secuencia de mensajes de un nodo de canal (tipo
 * ManyChat): globos de texto con variables/emoji, botones con rama propia,
 * respuestas rápidas (Messenger/Instagram) y esperas internas entre globos.
 */

interface MessageBlocksEditorProps {
  value: unknown
  onChange: (blocks: MessageBlock[]) => void
  supportsQuickReplies?: boolean
  /** Texto del CTA de mensajes ("+ Agregar mensaje" / "+ Agregar DM") */
  addMessageLabel?: string
}

function newTextBlock(): MessageBlock {
  return { id: genId('blk'), type: 'text', compiledText: '', buttons: [], quickReplies: [] }
}

function newDelayBlock(): MessageBlock {
  return { id: genId('blk'), type: 'delay', amount: 5, unit: 'seconds' }
}

function newButton(): MessageButton {
  return { id: genId('btn'), label: '', action: 'branch' }
}

export const MessageBlocksEditor: React.FC<MessageBlocksEditorProps> = ({
  value,
  onChange,
  supportsQuickReplies = false,
  addMessageLabel = 'Agregar mensaje'
}) => {
  const blocks = asMessageBlocks(value)

  const updateBlock = (index: number, patch: Partial<MessageBlock>) => {
    onChange(blocks.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)))
  }

  const moveBlock = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= blocks.length) return
    const next = blocks.slice()
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  const renderButtonsList = (
    block: MessageBlock,
    index: number,
    key: 'buttons' | 'quickReplies',
    title: string,
    addLabel: string
  ) => {
    const list = (block[key] || []) as MessageButton[]
    const update = (buttonIndex: number, patch: Partial<MessageButton>) => {
      updateBlock(index, {
        [key]: list.map((button, candidate) => (candidate === buttonIndex ? { ...button, ...patch } : button))
      })
    }
    return (
      <div className={styles.blockButtonsSection}>
        <div className={styles.configSectionTitle}>{title}</div>
        {list.map((button, buttonIndex) => (
          <div key={button.id} className={styles.blockButtonRow}>
            <TextInput
              className={styles.configRowGrow}
              value={button.label}
              maxLength={40}
              placeholder="Texto del botón"
              onChange={(event) => update(buttonIndex, { label: event.target.value })}
            />
            <div style={{ width: 130, flexShrink: 0 }}>
              <CustomSelect
                options={[
                  { value: 'branch', label: 'Crear rama' },
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
              <Trash2 size={12} />
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
        ))}
        <button
          type="button"
          className={styles.configSmallButton}
          disabled={list.length >= MAX_BUTTONS_PER_MESSAGE}
          onClick={() => updateBlock(index, { [key]: [...list, newButton()] })}
        >
          <Plus size={11} />
          {addLabel}
          {list.length >= MAX_BUTTONS_PER_MESSAGE ? ' (máximo 3)' : ''}
        </button>
      </div>
    )
  }

  return (
    <div>
      {blocks.length === 0 && (
        <p className={styles.configHelp} style={{ marginBottom: 10 }}>
          Crea una secuencia de mensajes: globos de texto, esperas internas y botones que abren ramas.
        </p>
      )}

      {blocks.map((block, index) => (
        <div key={block.id} className={styles.messageBlockCard}>
          <div className={styles.messageBlockHeader}>
            <span className={styles.messageBlockType}>
              {block.type === 'text' ? <MessageSquareText size={12} /> : <Clock size={12} />}
              {block.type === 'text' ? `Mensaje ${blocks.slice(0, index + 1).filter((b) => b.type === 'text').length}` : 'Espera interna'}
            </span>
            <span className={styles.messageBlockActions}>
              <button type="button" className={styles.configIconButtonPlain} title="Subir" disabled={index === 0} onClick={() => moveBlock(index, -1)}>
                <ArrowUp size={12} />
              </button>
              <button type="button" className={styles.configIconButtonPlain} title="Bajar" disabled={index === blocks.length - 1} onClick={() => moveBlock(index, 1)}>
                <ArrowDown size={12} />
              </button>
              <button
                type="button"
                className={styles.configIconButton}
                title="Quitar bloque"
                onClick={() => onChange(blocks.filter((_, candidate) => candidate !== index))}
              >
                <Trash2 size={12} />
              </button>
            </span>
          </div>

          {block.type === 'text' ? (
            <>
              <MessageComposer
                value={block.compiledText || ''}
                onChange={(compiled) => updateBlock(index, { compiledText: compiled })}
                placeholder="Escribe el mensaje…"
                showEmoji
                aria-label="Texto del mensaje"
              />
              {renderButtonsList(block, index, 'buttons', 'Botones', 'Agregar botón')}
              {supportsQuickReplies &&
                renderButtonsList(block, index, 'quickReplies', 'Respuestas rápidas', 'Agregar respuesta rápida')}
            </>
          ) : (
            <Field label="Esperar entre mensajes">
              <div className={styles.configRow}>
                <TextInput
                  type="number"
                  min={1}
                  className={styles.configRowGrow}
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
            </Field>
          )}
        </div>
      ))}

      <div className={styles.configRow} style={{ marginTop: 4 }}>
        <button type="button" className={styles.configSmallButton} onClick={() => onChange([...blocks, newTextBlock()])}>
          <Plus size={11} />
          {addMessageLabel}
        </button>
        <button type="button" className={styles.configSmallButton} onClick={() => onChange([...blocks, newDelayBlock()])}>
          <Plus size={11} />
          Agregar espera
        </button>
      </div>
    </div>
  )
}
