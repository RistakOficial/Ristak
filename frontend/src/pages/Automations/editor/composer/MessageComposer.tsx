import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, Smile } from 'lucide-react'
import { CategorizedVariablePicker } from '@/components/common'
import { cn } from '@/utils/cn'
import {
  BASE_VARIABLES,
  FlowVariablesContext,
  TOKEN_PATTERN,
  fallbackLabelForFieldId,
  getVariablePickerCategories,
  isDynamicToken,
  loadAllVariables,
  tokenFor,
  type FlowVariable
} from '../variablesCatalog'
import { useAnchoredPortal } from '@/hooks/useAnchoredPortal'
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
  const wrapRef = useRef<HTMLDivElement>(null)
  const emojiPopoverRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string>('')
  // Último rango del cursor dentro del editor (se pierde al hacer clic en
  // los pickers, así que lo recordamos para insertar donde estaba escribiendo)
  const savedRangeRef = useRef<Range | null>(null)
  const [variables, setVariables] = useState<FlowVariable[]>(BASE_VARIABLES)
  const [pickerOpen, setPickerOpen] = useState<'variables' | 'emoji' | null>(null)
  const {
    style: popoverPosition,
    placement: popoverPlacement
  } = useAnchoredPortal(wrapRef, pickerOpen === 'emoji', {
    align: 'end',
    gap: 8,
    matchWidth: false,
    minWidth: 292,
    maxWidth: 292,
    maxHeight: 300,
    panelRef: emojiPopoverRef
  })
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
  const variablePickerOptions = useMemo(
    () => allVariables.map(variable => ({
      value: variable.fieldId,
      label: variable.label,
      category: variable.category,
      categoryLabel: variable.categoryLabel,
      pathLabels: variable.pathLabels,
      path: variable.path,
      hiddenFromPicker: variable.hiddenFromPicker
    })),
    [allVariables]
  )
  const variablePickerCategories = useMemo(
    () => getVariablePickerCategories(allowedCategories, flowVariables.categories),
    [allowedCategories, flowVariables.categories]
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
        editor.appendChild(buildChip(fieldId, known?.label || fallbackLabelForFieldId(fieldId), !known && isDynamicToken(fieldId)))
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

  const closePicker = useCallback(() => {
    setPickerOpen(null)
  }, [])

  const togglePicker = (nextPicker: 'variables' | 'emoji') => {
    if (pickerOpen === nextPicker) {
      closePicker()
      return
    }
    setPickerOpen(nextPicker)
  }

  useEffect(() => {
    if (pickerOpen !== 'emoji') return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      const wrap = wrapRef.current
      const popover = emojiPopoverRef.current
      if (!wrap?.contains(target) && !popover?.contains(target)) {
        closePicker()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [closePicker, pickerOpen])

  const isEmpty = !value || !value.replace(new RegExp(escapeRegExp('​'), 'g'), '').trim()

  const emojiPopover = pickerOpen === 'emoji' && (
    <div
      ref={emojiPopoverRef}
      className={styles.composerPopover}
      role="dialog"
      aria-label="Insertar emoji"
      style={popoverPosition}
      data-placement={popoverPlacement}
      data-ristak-dropdown-panel
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
    <div
      ref={wrapRef}
      className={styles.composerWrap}
      data-automation-interactive="true"
      data-composer-mode={multiline ? 'multiline' : 'singleline'}
    >
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        aria-label={rest['aria-label']}
        data-ristak-unstyled
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

      <div className={styles.composerToolbar} data-composer-toolbar="">
        {showVariables && (
          <CategorizedVariablePicker
            variables={variablePickerOptions}
            categories={variablePickerCategories}
            anchorRef={wrapRef}
            align="end"
            open={pickerOpen === 'variables'}
            onOpenChange={open => setPickerOpen(open ? 'variables' : null)}
            onSelect={value => {
              const variable = variablesById.get(value)
              if (variable) insertVariable(variable)
            }}
            renderTrigger={({ open, triggerProps }) => (
              <button
                {...triggerProps}
                className={cn(styles.composerToolButton, open && styles.composerToolButtonActive)}
                data-composer-tool-button=""
                title="Insertar variable"
              >
                <Braces size={13} />
              </button>
            )}
          />
        )}
        {showEmoji && (
          <button
            type="button"
            className={cn(styles.composerToolButton, pickerOpen === 'emoji' && styles.composerToolButtonActive)}
            data-composer-tool-button=""
            title="Insertar emoji"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => togglePicker('emoji')}
          >
            <Smile size={13} />
          </button>
        )}
      </div>

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
  return (compiled || '').replace(TOKEN_PATTERN, (_, fieldId) => byId.get(fieldId) || fallbackLabelForFieldId(fieldId))
}

export { tokenFor }
