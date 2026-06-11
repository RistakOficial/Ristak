import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Search, Smile, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  BASE_VARIABLES,
  VARIABLE_CATEGORIES,
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
  const lastEmittedRef = useRef<string>('')
  // Último rango del cursor dentro del editor (se pierde al hacer clic en
  // los pickers, así que lo recordamos para insertar donde estaba escribiendo)
  const savedRangeRef = useRef<Range | null>(null)
  const [variables, setVariables] = useState<FlowVariable[]>(BASE_VARIABLES)
  const [pickerOpen, setPickerOpen] = useState<'variables' | 'emoji' | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    void loadAllVariables().then((loaded) => {
      if (!cancelled) setVariables(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const variablesById = useMemo(
    () => new Map(variables.map((variable) => [variable.fieldId, variable])),
    [variables]
  )

  const allowedCategories = React.useContext(VariableCategoriesContext)

  // ------------------------------------------------------------------
  // DOM ↔ texto compilado
  // ------------------------------------------------------------------
  const buildChip = useCallback((fieldId: string, label: string) => {
    const chip = document.createElement('span')
    chip.contentEditable = 'false'
    chip.dataset.variable = fieldId
    chip.className = styles.variableTokenChip
    chip.textContent = label
    return chip
  }, [])

  const renderValueToDom = useCallback(
    (compiled: string) => {
      const editor = editorRef.current
      if (!editor) return
      editor.textContent = ''
      const pattern = /\{\{\s*([\w.-]+)\s*\}\}/g
      let lastIndex = 0
      const text = compiled || ''
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0
        if (index > lastIndex) {
          editor.appendChild(document.createTextNode(text.slice(lastIndex, index)))
        }
        const fieldId = match[1]
        editor.appendChild(buildChip(fieldId, variablesById.get(fieldId)?.label || fieldId))
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
    setPickerOpen(null)
    setQuery('')
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
    const categories = allowedCategories
      ? allowedCategories
          .map((id) => VARIABLE_CATEGORIES.find((category) => category.id === id))
          .filter((category): category is (typeof VARIABLE_CATEGORIES)[number] => Boolean(category))
      : VARIABLE_CATEGORIES
    return categories
      .map((category) => ({
        category,
        items: variables.filter(
          (variable) =>
            variable.category === category.id &&
            (!normalized || variable.label.toLowerCase().includes(normalized))
        )
      }))
      .filter((group) => group.items.length > 0)
  }, [variables, query, allowedCategories])

  const popoverRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const root = popoverRef.current?.parentElement
      if (root && !root.contains(event.target as Node)) {
        setPickerOpen(null)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [pickerOpen])

  const isEmpty = !value || !value.replace(new RegExp(escapeRegExp('​'), 'g'), '').trim()

  return (
    <div className={styles.composerWrap} data-automation-interactive="true">
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
            onClick={() => setPickerOpen(pickerOpen === 'variables' ? null : 'variables')}
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
            onClick={() => setPickerOpen(pickerOpen === 'emoji' ? null : 'emoji')}
          >
            <Smile size={13} />
          </button>
        )}
      </div>

      {pickerOpen === 'variables' && (
        <div ref={popoverRef} className={styles.composerPopover} role="dialog" aria-label="Insertar variable">
          <div className={styles.composerPopoverSearch}>
            <Search size={12} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            <input
              autoFocus
              value={query}
              placeholder="Buscar variable…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setPickerOpen(null)
                  setQuery('')
                }
              }}
            />
            <button type="button" className={styles.composerToolButton} onClick={() => setPickerOpen(null)} title="Cerrar">
              <X size={12} />
            </button>
          </div>
          <div className={styles.composerPopoverBody}>
            {filteredByCategory.length === 0 && (
              <p className={styles.pickerEmpty}>Sin variables que coincidan</p>
            )}
            {filteredByCategory.map(({ category, items }) => (
              <div key={category.id}>
                <div className={styles.composerPopoverCategory}>{category.label}</div>
                {items.map((variable) => (
                  <button
                    key={variable.fieldId}
                    type="button"
                    className={styles.composerPopoverItem}
                    onClick={() => insertVariable(variable)}
                  >
                    <span className={styles.variableTokenChip}>{variable.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {pickerOpen === 'emoji' && (
        <div ref={popoverRef} className={styles.composerPopover} role="dialog" aria-label="Insertar emoji">
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
      )}
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
  return (compiled || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, fieldId) => byId.get(fieldId) || fieldId)
}

export { tokenFor }
