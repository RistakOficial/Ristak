import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, Clock, Copy, FileText, GitBranch, Image, Link2, Music, Plus, Trash2, Video, X, Zap } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { AutomationNode } from '@/services/automationsService'
import {
  asMessageBlocks,
  getNodeDefinition,
  validateNodeConfig,
  MAX_BRANCHES,
  type MessageBlock,
  type NodeDefinition
} from './nodeRegistry'
import { genId, getNodeOutputs, getStartTriggers, isStartNode, nodeHasInput } from './flowUtils'
import { compiledToReadable } from './composer/MessageComposer'
import styles from './AutomationEditor.module.css'

/** Posiciones locales (en px del nodo) de los conectores, para dibujar flechas */
export interface NodeHandleLayout {
  width: number
  height: number
  inputY: number
  outputs: Record<string, number>
}

interface AutomationNodeCardProps {
  node: AutomationNode
  selected: boolean
  dragging: boolean
  errors?: string[]
  /** Estado durante el arrastre de una conexión */
  dropState?: 'target' | 'forbidden' | null
  connectedOutputs: Set<string>
  zoom: number
  onMeasure: (nodeId: string, layout: NodeHandleLayout) => void
  /** Pointer down sobre la tarjeta (el canvas decide si inicia un arrastre) */
  onPointerDownCard: (event: React.PointerEvent, node: AutomationNode) => void
  onSelect: (node: AutomationNode, event?: React.PointerEvent) => void
  onOpenConfig: (node: AutomationNode) => void
  /** Parche directo de configuración desde la tarjeta (+ mensaje, + rama…) */
  onPatchConfig: (node: AutomationNode, patch: Record<string, unknown>, openConfig?: boolean) => void
  onDuplicate: (node: AutomationNode) => void
  onDelete: (node: AutomationNode) => void
  onStartConnection: (event: React.PointerEvent, node: AutomationNode, handleId: string) => void
  onAddTrigger: (node: AutomationNode, anchorRect: DOMRect) => void
  onEditTrigger: (node: AutomationNode, triggerId: string, anchorRect: DOMRect) => void
  onRemoveTrigger: (node: AutomationNode, triggerId: string) => void
}

function triggerSummary(definition: NodeDefinition | undefined, config: Record<string, unknown>): string {
  if (!definition) return 'Tipo desconocido'
  const summary = definition.summary(config || {})
  return summary.text || summary.box || definition.description || ''
}

export const AutomationNodeCard: React.FC<AutomationNodeCardProps> = ({
  node,
  selected,
  dragging,
  errors,
  dropState,
  connectedOutputs,
  zoom,
  onMeasure,
  onPointerDownCard,
  onSelect,
  onOpenConfig,
  onPatchConfig,
  onDuplicate,
  onDelete,
  onStartConnection,
  onAddTrigger,
  onEditTrigger,
  onRemoveTrigger
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const isStart = isStartNode(node)
  const definition = isStart ? undefined : getNodeDefinition(node.type)
  const outputs = getNodeOutputs(node)
  const hasInput = nodeHasInput(node)
  const triggers = isStart ? getStartTriggers(node) : []

  // Reporta la posición de cada conector relativa a la tarjeta (independiente
  // del zoom) para que el canvas pueda dibujar las flechas con precisión.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    const safeZoom = zoom || 1
    const layout: NodeHandleLayout = {
      width: rootRect.width / safeZoom,
      height: rootRect.height / safeZoom,
      inputY: 24,
      outputs: {}
    }

    const inputEl = root.querySelector<HTMLElement>('[data-handle-in]')
    if (inputEl) {
      const rect = inputEl.getBoundingClientRect()
      layout.inputY = (rect.top - rootRect.top + rect.height / 2) / safeZoom
    }

    root.querySelectorAll<HTMLElement>('[data-handle-out]').forEach((handleEl) => {
      const handleId = handleEl.dataset.handleOut as string
      const rect = handleEl.getBoundingClientRect()
      layout.outputs[handleId] = (rect.top - rootRect.top + rect.height / 2) / safeZoom
    })

    onMeasure(node.id, layout)
  })

  const accent = isStart ? 'blue' : definition?.accent || 'blue'
  const Icon = isStart ? Zap : definition?.icon || Zap
  const config = node.config || {}
  const summary = !isStart && definition ? definition.summary(config) : undefined
  const configErrors = !isStart && definition ? validateNodeConfig(definition, config) : []
  const configured = configErrors.length === 0
  const hasErrors = Boolean(errors && errors.length > 0)

  // ------------------------------------------------------------------
  // Título editable (doble clic · máx. 80 caracteres · vacío = default)
  // ------------------------------------------------------------------
  const customTitle =
    (typeof config.customTitle === 'string' && config.customTitle.trim()) ||
    (typeof config.name === 'string' && config.name.trim()) ||
    ''
  const defaultTitle = isStart ? 'Cuando...' : definition?.label || node.label || node.type
  const title = customTitle || defaultTitle

  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingTitle) {
      setDraftTitle(customTitle || '')
      window.setTimeout(() => titleInputRef.current?.focus(), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTitle])

  const commitTitle = () => {
    setEditingTitle(false)
    const trimmed = draftTitle.trim().slice(0, 80)
    // Vacío → regresa al nombre por defecto
    const patch: Record<string, unknown> = { customTitle: trimmed }
    if (typeof config.name === 'string' && node.type === 'logic-wait') {
      patch.name = trimmed || 'Esperar'
      patch.customTitle = ''
    }
    onPatchConfig(node, patch)
  }

  // ------------------------------------------------------------------
  // Bloques de mensaje (globos tipo chat dentro de la cajita)
  // ------------------------------------------------------------------
  const isTemplateMode = node.type === 'channel-whatsapp' && config.messageType === 'template'
  const showBlocks = Boolean(definition?.supportsMessageBlocks) && !isTemplateMode
  const blocks = showBlocks ? asMessageBlocks(config.messageBlocks) : []

  const addMessageBlock = () => {
    const block: MessageBlock = { id: genId('blk'), type: 'text', compiledText: '', buttons: [], quickReplies: [] }
    onPatchConfig(node, { messageBlocks: [...asMessageBlocks(config.messageBlocks), block] }, true)
  }


  return (
    <div
      ref={rootRef}
      data-automation-node={node.id}
      data-accent={accent}
      className={cn(
        styles.node,
        isStart && styles.startCard,
        selected && styles.nodeSelected,
        hasErrors && styles.nodeError,
        dragging && styles.nodeDragging,
        dropState === 'target' && styles.nodeDropTarget,
        dropState === 'forbidden' && styles.nodeDropForbidden
      )}
      style={{ left: node.position.x, top: node.position.y }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onSelect(node, event)
        onPointerDownCard(event, node)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (!isStart) onOpenConfig(node)
      }}
    >
      {/* Conector de entrada */}
      {hasInput && (
        <span data-handle-in className={cn(styles.handle, styles.handleIn)} title="Entrada" />
      )}

      {/* Encabezado */}
      <div className={cn(styles.nodeHeader, definition?.tintedHeader && styles.nodeHeaderTinted)}>
        <span className={styles.nodeHeaderIcon}>
          <Icon size={15} />
        </span>
        <span className={styles.nodeHeaderText}>
          {!isStart && definition?.brand && <span className={styles.nodeBrand}>{definition.brand}</span>}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className={styles.nodeTitleInput}
              value={draftTitle}
              maxLength={80}
              placeholder={defaultTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') commitTitle()
                if (event.key === 'Escape') setEditingTitle(false)
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          ) : (
            <span
              className={styles.nodeTitle}
              title="Doble clic para renombrar"
              onDoubleClick={(event) => {
                event.stopPropagation()
                if (!isStart) setEditingTitle(true)
              }}
            >
              {title}
            </span>
          )}
        </span>
        {!isStart && (
          <span className={styles.nodeQuickActions}>
            <button
              type="button"
              className={styles.nodeQuickButton}
              title="Duplicar paso"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onDuplicate(node)
              }}
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              className={cn(styles.nodeQuickButton, styles.nodeQuickButtonDanger)}
              title="Eliminar paso"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onDelete(node)
              }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>

      {/* Cuerpo */}
      <div className={styles.nodeBody}>
        {isStart ? (
          <>
            {triggers.length === 0 && (
              <p className={styles.startIntro}>
                Un disparador es un evento que inicia tu Automatización. Haz clic para añadir un
                disparador.
              </p>
            )}
            {triggers.map((trigger) => {
              const triggerDefinition = getNodeDefinition(trigger.type)
              const TriggerIcon = triggerDefinition?.icon || Zap
              const triggerErrors = triggerDefinition
                ? validateNodeConfig(triggerDefinition, trigger.config || {})
                : ['Tipo desconocido']
              return (
                <button
                  key={trigger.id}
                  type="button"
                  data-accent={triggerDefinition?.accent || 'green'}
                  className={cn(styles.triggerChip, triggerErrors.length > 0 && styles.triggerChipError)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onEditTrigger(node, trigger.id, event.currentTarget.getBoundingClientRect())
                  }}
                >
                  <span className={styles.triggerChipIcon}>
                    <TriggerIcon size={13} />
                  </span>
                  <span className={styles.triggerChipText}>
                    <span className={styles.triggerChipTitle}>{triggerDefinition?.label || trigger.type}</span>
                    <span className={styles.triggerChipDetail}>
                      {triggerErrors.length > 0
                        ? 'Falta configurar'
                        : triggerSummary(triggerDefinition, trigger.config)}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    className={styles.triggerChipRemove}
                    title="Quitar disparador"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemoveTrigger(node, trigger.id)
                    }}
                  >
                    <X size={11} />
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className={styles.addTriggerButton}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onAddTrigger(node, event.currentTarget.getBoundingClientRect())
              }}
            >
              <Plus size={13} />
              Nuevo disparador
            </button>
          </>
        ) : showBlocks ? (
          <>
            {/* Mini-secuencia de globos tipo chat: clic en un globo = editar */}
            {blocks.map((block) =>
              block.type === 'text' ? (
                <button
                  key={block.id}
                  type="button"
                  className={styles.chatBubble}
                  title="Editar este mensaje"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenConfig(node)
                  }}
                >
                  <span className={styles.chatBubbleText}>
                    {compiledToReadable(block.compiledText || '') || 'Mensaje vacío…'}
                  </span>
                  {[...(block.buttons || []), ...(block.quickReplies || [])].length > 0 && (
                    <span className={styles.chatBubbleButtons}>
                      {[...(block.buttons || []), ...(block.quickReplies || [])].map((button) => (
                        <span key={button.id} className={styles.chatBubbleButtonPill}>
                          {button.action === 'url' ? <Link2 size={9} /> : <GitBranch size={9} />}
                          {button.label || 'Botón'}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              ) : block.type === 'delay' ? (
                <button
                  key={block.id}
                  type="button"
                  className={styles.chatDelayRow}
                  title="Editar el retraso"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenConfig(node)
                  }}
                >
                  <Clock size={11} />
                  {block.showTyping !== false ? 'Escribiendo' : 'Espera'} {Number(block.amount) || 0}{' '}
                  {block.unit === 'minutes' ? 'min' : 'seg'}
                </button>
              ) : (
                <button
                  key={block.id}
                  type="button"
                  className={styles.chatBubble}
                  title="Editar el adjunto"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenConfig(node)
                  }}
                >
                  <span className={styles.chatBubbleText}>
                    {block.type === 'image' ? <Image size={11} /> : block.type === 'video' ? <Video size={11} /> : block.type === 'audio' ? <Music size={11} /> : <FileText size={11} />}{' '}
                    {block.caption || block.url || 'Adjunto sin URL'}
                  </span>
                </button>
              )
            )}

            {summary?.text && <p className={styles.nodeSummaryText}>{summary.text}</p>}

            <button
              type="button"
              className={styles.nodeCtaButton}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                addMessageBlock()
              }}
            >
              <Plus size={12} />
              {definition?.addButtonLabel || 'Agregar mensaje'}
            </button>

            {hasErrors && (
              <span className={styles.nodeErrorHint}>
                <AlertCircle size={12} />
                {errors?.[0]}
              </span>
            )}
          </>
        ) : (
          <>
            {/* Clic en el contenido configurado abre la configuración directa */}
            {summary?.text && (
              <button
                type="button"
                className={styles.nodeSummaryClickable}
                title="Editar configuración"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenConfig(node)
                }}
              >
                <p className={styles.nodeSummaryText}>{summary.text}</p>
              </button>
            )}
            {summary?.box && (
              <button
                type="button"
                className={cn(styles.nodeSummaryClickable, styles.nodeSummaryBox)}
                title="Editar contenido"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenConfig(node)
                }}
              >
                {compiledToReadable(summary.box)}
              </button>
            )}

            {!configured && definition && (
              <button
                type="button"
                className={styles.nodeCtaButton}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenConfig(node)
                }}
              >
                <Plus size={12} />
                {definition.addButtonLabel || 'Configurar paso'}
              </button>
            )}
            {configured && !summary?.text && !summary?.box && (
              <p className={styles.nodeEmpty}>{summary?.empty || 'Doble clic para editar'}</p>
            )}

            {hasErrors && (
              <span className={styles.nodeErrorHint}>
                <AlertCircle size={12} />
                {errors?.[0]}
              </span>
            )}
          </>
        )}

      </div>

      {/* Salidas (Entonces / Siguiente paso / ramas) */}
      {outputs.length > 0 && (
        <div className={styles.nodeOutputs}>
          {outputs.map((output) => (
            <div key={output.id} className={styles.nodeOutputRow}>
              <span className={styles.nodeOutputLabel}>{output.label || 'Siguiente paso'}</span>
              <span
                data-handle-out={output.id}
                className={cn(
                  styles.handle,
                  styles.handleOut,
                  connectedOutputs.has(output.id) && styles.handleConnected
                )}
                title="Arrastra para conectar o haz clic para elegir el siguiente paso"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  event.preventDefault()
                  onStartConnection(event, node, output.id)
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
