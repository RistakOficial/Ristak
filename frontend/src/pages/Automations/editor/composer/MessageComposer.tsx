import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, ChevronDown, ChevronRight, Search, Smile, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  BASE_VARIABLES,
  FlowVariablesContext,
  TOKEN_PATTERN,
  VARIABLE_CATEGORIES,
  isDynamicToken,
  loadAllVariables,
  tokenFor,
  type FlowVariable
} from '../variablesCatalog'
import styles from '../AutomationEditor.module.css'

/**
 * Editor de texto con variables como chips visuales (sin llaves ni corchetes
 * en la interfaz) y emoji picker opcional. Internamente el valor se guarda
 * como texto compilado con tokens: "Hola {{contact.first_name}}".
 *
 * - MessageComposer: multilínea (mensajes, prompts, bodies).
 * - VariableTextInput: una línea (valores dinámicos, campos de contacto).
 */

interface MessageComposerProps {
  value: string
  onChange: (compiled: string) => void
  placeholder?: string
  multiline?: boolean
  /** Mostrar emoji picker (solo editores de mensaje conversacional) */
  showEmoji?: boolean
  /** Mostrar selector de variables (por defecto sí) */
  showVariables?: boolean
  'aria-label'?: string
}

// Emojis frecuentes para mensajes (picker ligero, sin dependencias)
const EMOJIS = [
  '😀', '😄', '😁', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎',
  '🤗', '🤔', '😅', '😂', '🤣', '😢', '😭', '😡', '🙏', '👏',
  '👍', '👎', '👌', '🤝', '💪', '👋', '🙌', '✌️', '🤞', '💯',
  '🔥', '✨', '⭐', '🎉', '🎊', '🎁', '❤️', '💙', '💚', '💛',
  '💜', '🧡', '💬', '📞', '📲', '📍', '📅', '⏰', '✅', '❌',
  '⚠️', '❓', '❗', '💰', '💳', '🛒', '📦', '🚀', '🏆', '🎯'
]

interface PickerTreeNode {
  id: string
  label: string
  variable?: FlowVariable
  children: PickerTreeNode[]
}

function buildVariableTree(items: FlowVariable[]): PickerTreeNode[] {
  const root: PickerTreeNode[] = []
  const findOrCreate = (siblings: PickerTreeNode[], id: string, label: string) => {
    let node = siblings.find((candidate) => candidate.id === id)
    if (!node) {
      node = { id, label, children: [] }
      siblings.push(node)
    }
    return node
  }
  const pathParts = (path: string) => path.match(/[^[.\]]+|\[\d+\]/g) || []

  items.forEach((variable) => {
    const labels = variable.pathLabels && variable.pathLabels.length > 0
      ? variable.pathLabels
      : [variable.label]
    const segments = pathParts(variable.path || variable.fieldId)
    let siblings = root
    labels.forEach((label, index) => {
      const id = segments.length === labels.length
        ? segments.slice(0, index + 1).join('')
        : labels.slice(0, index + 1).join('/')
      const node = findOrCreate(siblings, id, label)
      if (index === labels.length - 1) {
        node.variable = variable
      }
      siblings = node.children
    })
  })

  return root
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Categorías de variables relevantes según los disparadores del flujo:
 * si el flujo arranca con una cita, aparecen las variables de Citas; si
 * arranca con un pago, las de Pagos, etc. (null = mostrar todas)
 */
export const VariableCategoriesContext = React.createContext<string[] | null>(null)

export const MessageComposer: React.FC<MessageComposerProps> = ({
  value,
  onChange,
  placeholder,
  multiline = true,
  showEmoji = false,
  showVariables = true,
  ...rest
}) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string>('')
  // Último rango del cursor dentro del editor (se pierde al hacer clic en
  // los pickers, así que lo recordamos para insertar donde estaba escribiendo)
  const savedRangeRef = useRef<Range | null>(null)
  const [variables, setVariables] = useState<FlowVariable[]>(BASE_VARIABLES)
  const [pickerOpen, setPickerOpen] = useState<'variables' | 'emoji' | null>(null)
  const [query, setQuery] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => new Set())
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set())
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
    transform?: string
  } | null>(null)
  const flowVariables = React.useContext(FlowVariablesContext)

  useEffect(() => {
    let cancelled = false
    void loadAllVariables().then((loaded) => {
      if (!cancelled) setVariables(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const allowedCategories = React.useContext(VariableCategoriesContext)
  const allVariables = useMemo(
    () => [...variables, ...flowVariables.variables],
    [flowVariables.variables, variables]
  )
  const variablesById = useMemo(
    () => new Map(allVariables.map((variable) => [variable.fieldId, variable])),
    [allVariables]
  )

  // ------------------------------------------------------------------
  // DOM ↔ texto compilado
  // ------------------------------------------------------------------
  const buildChip = useCallback((fieldId: string, label: string, missing = false) => {
    const chip = document.createElement('span')
    chip.contentEditable = 'false'
    chip.dataset.variable = fieldId
    chip.className = missing
      ? `${styles.variableTokenChip} ${styles.variableTokenChipMissing}`
      : styles.variableTokenChip
    if (missing) {
      chip.title = 'Esta variable ya no está disponible'
      chip.dataset.variableMissing = 'true'
    }
    chip.textContent = label
    return chip
  }, [])

  const renderValueToDom = useCallback(
    (compiled: string) => {
      const editor = editorRef.current
      if (!editor) return
      editor.textContent = ''
      let lastIndex = 0
      const text = compiled || ''
      for (const match of text.matchAll(TOKEN_PATTERN)) {
        const index = match.index ?? 0
        if (index > lastIndex) {
          editor.appendChild(document.createTextNode(text.slice(lastIndex, index)))
        }
        const fieldId = match[1]
        const known = variablesById.get(fieldId)
        editor.appendChild(buildChip(fieldId, known?.label || fieldId, !known && isDynamicToken(fieldId)))
        lastIndex = index + match[0].length
      }
      if (lastIndex < text.length) {
        editor.appendChild(document.createTextNode(text.slice(lastIndex)))
      }
    },
    [buildChip, variablesById]
  )

  const serializeDom = useCallback((): string => {
    const editor = editorRef.current
    if (!editor) return ''
    let result = ''
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent || ''
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const element = node as HTMLElement
      if (element.dataset.variable) {
        result += `{{${element.dataset.variable}}}`
        return
      }
      if (element.tagName === 'BR') {
        result += '\n'
        return
      }
      // Algunos navegadores insertan <div> por línea
      const isBlock = element.tagName === 'DIV' || element.tagName === 'P'
      if (isBlock && result && !result.endsWith('\n')) result += '\n'
      element.childNodes.forEach(walk)
    }
    editor.childNodes.forEach(walk)
    return result
  }, [])

  // Sincroniza el valor externo → DOM (solo si cambió desde fuera)
  useEffect(() => {
    if (value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    renderValueToDom(value)
  }, [value, renderValueToDom])

  // Cuando cargan los campos personalizados, refresca etiquetas de chips
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.querySelectorAll<HTMLElement>('[data-variable]').forEach((chip) => {
      const known = variablesById.get(chip.dataset.variable || '')
      if (known && chip.textContent !== known.label) chip.textContent = known.label
      if (known && chip.dataset.variableMissing) {
        chip.className = styles.variableTokenChip
        delete chip.dataset.variableMissing
        chip.removeAttribute('title')
      }
    })
  }, [variablesById])

  const emit = useCallback(() => {
    const compiled = serializeDom()
    lastEmittedRef.current = compiled
    onChange(compiled)
  }, [onChange, serializeDom])

  const rememberCursor = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editorRef.current?.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange()
    }
  }, [])

  // ------------------------------------------------------------------
  // Inserción en la posición del cursor
  // ------------------------------------------------------------------
  const insertNodeAtCursor = useCallback(
    (node: Node) => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      const selection = window.getSelection()
      let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      // Si el clic en el picker movió el foco, usa el último cursor recordado
      if (savedRangeRef.current && editor.contains(savedRangeRef.current.commonAncestorContainer)) {
        range = savedRangeRef.current
      }
      if (!range || !editor.contains(range.commonAncestorContainer)) {
        range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
      }
      range.deleteContents()
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      savedRangeRef.current = range.cloneRange()
      emit()
    },
    [emit]
  )

  const insertVariable = (variable: FlowVariable) => {
    insertNodeAtCursor(buildChip(variable.fieldId, variable.label))
    closePicker()
  }

  const insertEmoji = (emoji: string) => {
    insertNodeAtCursor(document.createTextNode(emoji))
  }

  // ------------------------------------------------------------------
  // Picker de variables (búsqueda + categorías)
  // ------------------------------------------------------------------
  const filteredByCategory = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    // Solo categorías congruentes con los disparadores, en su orden
    const staticCategories = allowedCategories
      ? allowedCategories
          .map((id) => VARIABLE_CATEGORIES.find((category) => category.id === id))
          .filter((category): category is (typeof VARIABLE_CATEGORIES)[number] => Boolean(category))
      : VARIABLE_CATEGORIES
    const categories = [...staticCategories, ...flowVariables.categories]
    return categories
      .map((category) => ({
        category,
        items: allVariables.filter(
          (variable) =>
            variable.category === category.id &&
            (!normalized ||
              variable.label.toLowerCase().includes(normalized) ||
              (variable.pathLabels || []).join(' ').toLowerCase().includes(normalized) ||
              variable.fieldId.toLowerCase().includes(normalized) ||
              tokenFor(variable).toLowerCase().includes(normalized) ||
              (variable.categoryLabel || category.label).toLowerCase().includes(normalized))
        )
      }))
      .filter((group) => group.items.length > 0 || Boolean(group.category.unavailableReason))
  }, [allVariables, flowVariables.categories, query, allowedCategories])

  const isSearchingVariables = query.trim().length > 0

  const closePicker = useCallback(() => {
    setPickerOpen(null)
    setQuery('')
    setExpandedCategories(new Set())
    setExpandedNodes(new Set())
    setPopoverPosition(null)
  }, [])

  const togglePicker = (nextPicker: 'variables' | 'emoji') => {
    if (pickerOpen === nextPicker) {
      closePicker()
      return
    }
    setPickerOpen(nextPicker)
    setQuery('')
    setExpandedCategories(new Set())
    setExpandedNodes(new Set())
  }

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const toggleNode = (nodeId: string) => {
    setExpandedNodes((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const renderVariableTree = (nodes: PickerTreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      if (node.variable) {
        return (
          <button
            key={node.id}
            type="button"
            className={styles.composerPopoverItem}
            style={{ paddingLeft: 22 + depth * 14 }}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => node.variable && insertVariable(node.variable)}
          >
            <span className={styles.variableTokenChip}>{node.label}</span>
          </button>
        )
      }
      const expanded = isSearchingVariables || expandedNodes.has(node.id)
      return (
        <div key={node.id}>
          <button
            type="button"
            className={styles.composerPopoverSubcategory}
            style={{ paddingLeft: 6 + depth * 14 }}
            aria-expanded={expanded}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => toggleNode(node.id)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{node.label}</span>
          </button>
          {expanded && renderVariableTree(node.children, depth + 1)}
        </div>
      )
    })

  const popoverRef = useRef<HTMLDivElement>(null)
  const updatePopoverPosition = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || !pickerOpen) return

    const rect = wrap.getBoundingClientRect()
    const margin = 12
    const gap = 8
    const preferredWidth = pickerOpen === 'variables' ? 430 : 292
    const width = Math.min(preferredWidth, window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const openBelow = spaceBelow >= 260 || spaceBelow > spaceAbove
    const availableHeight = Math.max(220, (openBelow ? spaceBelow : spaceAbove) - gap)
    const maxHeight = Math.min(pickerOpen === 'variables' ? 420 : 300, availableHeight)
    const top = openBelow ? rect.bottom + gap : rect.top - gap

    setPopoverPosition({
      top,
      left,
      width,
      maxHeight,
      ...(openBelow ? {} : { transform: 'translateY(-100%)' })
    })
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    updatePopoverPosition()
    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)
    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
    }
  }, [pickerOpen, updatePopoverPosition])

  useEffect(() => {
    if (!pickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const wrap = wrapRef.current
      const popover = popoverRef.current
      if (!wrap?.contains(target) && !popover?.contains(target)) {
        closePicker()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [closePicker, pickerOpen])

  const isEmpty = !value || !value.replace(new RegExp(escapeRegExp('​'), 'g'), '').trim()

  const variablePopover = pickerOpen === 'variables' && popoverPosition && (
    <div
      ref={popoverRef}
      className={styles.composerPopover}
      role="dialog"
      aria-label="Insertar variable"
      style={popoverPosition}
    >
      <div className={styles.composerPopoverSearch}>
        <Search size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
        <input
          autoFocus
          value={query}
          placeholder="Buscar variable o ruta…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closePicker()
            }
          }}
        />
        <button type="button" className={styles.composerToolButton} onClick={closePicker} title="Cerrar">
          <X size={12} />
        </button>
      </div>
      <div className={styles.composerPopoverBody}>
        {filteredByCategory.length === 0 && (
          <p className={styles.pickerEmpty}>Sin variables que coincidan</p>
        )}
        {filteredByCategory.map(({ category, items }) => {
          const expanded = isSearchingVariables || expandedCategories.has(category.id)
          return (
            <div key={category.id}>
              <button
                type="button"
                className={styles.composerPopoverCategory}
                aria-expanded={expanded}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => toggleCategory(category.id)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{category.label}</span>
                {items.length > 0 && <span className={styles.composerPopoverCategoryCount}>{items.length}</span>}
              </button>
              {expanded && (
                category.unavailableReason ? (
                  <p className={styles.pickerWarning}>{category.unavailableReason}</p>
                ) : (
                  renderVariableTree(buildVariableTree(items))
                )
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const emojiPopover = pickerOpen === 'emoji' && popoverPosition && (
    <div
      ref={popoverRef}
      className={styles.composerPopover}
      role="dialog"
      aria-label="Insertar emoji"
      style={popoverPosition}
    >
      <div className={styles.composerEmojiGrid}>
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={styles.composerEmojiButton}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => insertEmoji(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div ref={wrapRef} className={styles.composerWrap} data-automation-interactive="true">
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        aria-label={rest['aria-label']}
        data-placeholder={placeholder || ''}
        className={cn(
          styles.composerEditor,
          !multiline && styles.composerSingleLine,
          isEmpty && styles.composerEmpty
        )}
        onInput={() => {
          rememberCursor()
          emit()
        }}
        onKeyUp={rememberCursor}
        onMouseUp={rememberCursor}
        onBlur={rememberCursor}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && pickerOpen) {
            event.preventDefault()
            event.stopPropagation()
            setPickerOpen(null)
            return
          }
          if (event.key === 'Enter') {
            if (!multiline) {
              event.preventDefault()
              return
            }
            event.preventDefault()
            insertNodeAtCursor(document.createTextNode('\n'))
          }
        }}
        onPaste={(event) => {
          // Pegar siempre como texto plano
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          insertNodeAtCursor(document.createTextNode(text))
        }}
      />

      <div className={styles.composerToolbar}>
        {showVariables && (
          <button
            type="button"
            className={cn(styles.composerToolButton, pickerOpen === 'variables' && styles.composerToolButtonActive)}
            title="Insertar variable"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => togglePicker('variables')}
          >
            <Braces size={13} />
          </button>
        )}
        {showEmoji && (
          <button
            type="button"
            className={cn(styles.composerToolButton, pickerOpen === 'emoji' && styles.composerToolButtonActive)}
            title="Insertar emoji"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => togglePicker('emoji')}
          >
            <Smile size={13} />
          </button>
        )}
      </div>

      {typeof document !== 'undefined' && variablePopover ? createPortal(variablePopover, document.body) : null}
      {typeof document !== 'undefined' && emojiPopover ? createPortal(emojiPopover, document.body) : null}
    </div>
  )
}

/** Variante de una línea para valores dinámicos y campos de contacto */
export const VariableTextInput: React.FC<Omit<MessageComposerProps, 'multiline' | 'showEmoji'>> = (props) => (
  <MessageComposer {...props} multiline={false} showEmoji={false} />
)

/** Útil para mostrar texto compilado de forma legible en resúmenes */
export function compiledToReadable(compiled: string, variables: FlowVariable[] = BASE_VARIABLES): string {
  const byId = new Map(variables.map((variable) => [variable.fieldId, variable.label]))
  return (compiled || '').replace(TOKEN_PATTERN, (_, fieldId) => byId.get(fieldId) || fieldId)
}

export { tokenFor }
