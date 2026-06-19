import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Braces,
  Code2,
  Image,
  Italic,
  Link,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '../Button'
import { CustomSelect } from '../CustomSelect'
import styles from './EmailRichTextEditor.module.css'

export interface EmailRichTextVariable {
  value: string
  label: string
}

interface EmailRichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
  editorClassName?: string
  codePlaceholder?: string
  density?: 'regular' | 'modal'
  variables?: EmailRichTextVariable[]
  onWarning?: (title: string, message: string) => void
  onHtmlApplied?: () => void
}

const FONT_FAMILY_OPTIONS = [
  { value: 'Inter, Arial, sans-serif', label: 'Inter' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Verdana, sans-serif', label: 'Verdana' }
]

const FONT_SIZE_OPTIONS = [
  { value: '2', label: '12px' },
  { value: '3', label: '14px' },
  { value: '4', label: '16px' },
  { value: '5', label: '18px' },
  { value: '6', label: '24px' }
]

const LINE_HEIGHT_OPTIONS = [
  { value: '1.2', label: '1.2' },
  { value: '1.5', label: '1.5' },
  { value: '1.8', label: '1.8' }
]

const BLOCK_OPTIONS = [
  { value: 'p', label: 'Párrafo' },
  { value: 'div', label: 'Bloque' },
  { value: 'h3', label: 'Título' },
  { value: 'blockquote', label: 'Cita' }
]

const EMPTY_HTML = ''
const MAX_EDITOR_IMAGE_BYTES = 2 * 1024 * 1024
const CODE_LIMIT = 70000
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'font',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul'
])
const VOID_TAGS = new Set(['br', 'hr', 'img'])
const BLOCKED_TAGS = new Set([
  'base',
  'button',
  'embed',
  'form',
  'iframe',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'select',
  'style',
  'textarea'
])
const ALLOWED_STYLE_PROPS = new Set([
  'background-color',
  'border',
  'border-bottom',
  'border-left',
  'border-radius',
  'border-right',
  'border-top',
  'color',
  'display',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'height',
  'line-height',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-width',
  'min-width',
  'object-fit',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
  'width'
])

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
}

function isSafeEditorUrl(value: string, type: 'href' | 'src' = 'href') {
  const url = value.trim()
  if (!url || /[\u0000-\u001f<>"`]/.test(url)) return false
  if (type === 'src' && /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) {
    return url.length <= MAX_EDITOR_IMAGE_BYTES * 2
  }
  if (type === 'href' && /^(mailto:|tel:|#)/i.test(url)) return true
  return /^https?:\/\//i.test(url)
}

function normalizeLinkUrl(value: string) {
  const url = value.trim()
  if (!url) return ''
  if (url.includes('@') && !/^(mailto:|https?:\/\/)/i.test(url)) return `mailto:${url}`
  if (/^www\./i.test(url)) return `https://${url}`
  return url
}

function sanitizeEditorStyle(value: string) {
  return value
    .split(';')
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => {
      const separatorIndex = rule.indexOf(':')
      if (separatorIndex <= 0) return ''
      const property = rule.slice(0, separatorIndex).trim().toLowerCase()
      const propertyValue = rule.slice(separatorIndex + 1).trim()
      if (!ALLOWED_STYLE_PROPS.has(property)) return ''
      if (!propertyValue || /url\s*\(|expression\s*\(|javascript:|@import|[{}<>]/i.test(propertyValue)) return ''
      return `${property}: ${propertyValue}`
    })
    .filter(Boolean)
    .join('; ')
}

function legacyFontSizeToCss(value: string) {
  const sizes: Record<string, string> = {
    '1': '10px',
    '2': '12px',
    '3': '14px',
    '4': '16px',
    '5': '18px',
    '6': '24px',
    '7': '32px'
  }
  return sizes[value.trim()] || ''
}

export function sanitizeEmailRichHtmlForEditor(rawHtml: string) {
  const raw = String(rawHtml || '').slice(0, CODE_LIMIT).trim()
  if (!raw) return EMPTY_HTML

  if (!raw.includes('<')) {
    return escapeHtml(raw).replace(/\r?\n/g, '<br>')
  }

  if (typeof window === 'undefined') return raw

  const documentRef = window.document.implementation.createHTMLDocument('email-editor')
  documentRef.body.innerHTML = raw

  const sanitizeNode = (node: Node): Node | null => {
    if (node.nodeType === window.Node.TEXT_NODE) {
      return window.document.createTextNode(node.textContent || '')
    }

    if (node.nodeType !== window.Node.ELEMENT_NODE) return null

    const sourceElement = node as HTMLElement
    const tagName = sourceElement.tagName.toLowerCase()
    if (BLOCKED_TAGS.has(tagName)) return null

    if (!ALLOWED_TAGS.has(tagName)) {
      const fragment = window.document.createDocumentFragment()
      sourceElement.childNodes.forEach(child => {
        const cleanChild = sanitizeNode(child)
        if (cleanChild) fragment.appendChild(cleanChild)
      })
      return fragment
    }

    const outputTagName = tagName === 'font' ? 'span' : tagName
    const cleanElement = window.document.createElement(outputTagName)
    const legacyStyles = []
    if (tagName === 'font') {
      const face = sourceElement.getAttribute('face') || ''
      const size = legacyFontSizeToCss(sourceElement.getAttribute('size') || '')
      const color = sourceElement.getAttribute('color') || ''
      if (face) legacyStyles.push(`font-family: ${face}`)
      if (size) legacyStyles.push(`font-size: ${size}`)
      if (color) legacyStyles.push(`color: ${color}`)
    }
    const style = sanitizeEditorStyle([...legacyStyles, sourceElement.getAttribute('style') || ''].join('; '))
    if (style) cleanElement.setAttribute('style', style)

    const title = sourceElement.getAttribute('title') || ''
    if (title) cleanElement.setAttribute('title', title.slice(0, 160))

    if (tagName === 'a') {
      const href = sourceElement.getAttribute('href') || ''
      if (isSafeEditorUrl(href, 'href')) {
        cleanElement.setAttribute('href', href)
        cleanElement.setAttribute('target', '_blank')
        cleanElement.setAttribute('rel', 'noreferrer')
      }
    }

    if (tagName === 'img') {
      const src = sourceElement.getAttribute('src') || ''
      const alt = sourceElement.getAttribute('alt') || ''
      if (isSafeEditorUrl(src, 'src')) cleanElement.setAttribute('src', src)
      if (alt) cleanElement.setAttribute('alt', alt.slice(0, 160))

      for (const attributeName of ['width', 'height']) {
        const numericValue = Math.max(1, Math.min(Number(sourceElement.getAttribute(attributeName)) || 0, 800))
        if (numericValue) cleanElement.setAttribute(attributeName, String(numericValue))
      }
    }

    if (!VOID_TAGS.has(tagName)) {
      sourceElement.childNodes.forEach(child => {
        const cleanChild = sanitizeNode(child)
        if (cleanChild) cleanElement.appendChild(cleanChild)
      })
    }

    return cleanElement
  }

  const fragment = window.document.createDocumentFragment()
  documentRef.body.childNodes.forEach(child => {
    const cleanChild = sanitizeNode(child)
    if (cleanChild) fragment.appendChild(cleanChild)
  })

  const wrapper = window.document.createElement('div')
  wrapper.appendChild(fragment)
  return wrapper.innerHTML.trim()
}

export function plainTextToEmailHtml(value: string) {
  const text = String(value || '').trim()
  if (!text) return EMPTY_HTML
  return text
    .split(/\n{2,}/)
    .map(paragraph => paragraph.split(/\n/).map(escapeHtml).join('<br>'))
    .filter(Boolean)
    .map(paragraph => `<p>${paragraph}</p>`)
    .join('')
}

export function emailHtmlToPlainText(html: string) {
  const cleanHtml = sanitizeEmailRichHtmlForEditor(html)
  if (!cleanHtml) return ''
  if (typeof window !== 'undefined') {
    const documentRef = window.document.implementation.createHTMLDocument('email-plain-text')
    documentRef.body.innerHTML = cleanHtml
    return (documentRef.body.innerText || documentRef.body.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  return decodeHtmlEntities(
    cleanHtml
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*hr\s*\/?>/gi, '\n---\n')
      .replace(/<\s*\/\s*(p|div|tr|li|blockquote|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
  ).trim()
}

export const EmailRichTextEditor: React.FC<EmailRichTextEditorProps> = ({
  value,
  onChange,
  placeholder = 'Escribe o pega el contenido del correo...',
  className,
  editorClassName,
  codePlaceholder = '<table><tr><td>Contenido del correo...</td></tr></table>',
  density = 'regular',
  variables = [],
  onWarning,
  onHtmlApplied
}) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const savedRangeRef = useRef<Range | null>(null)
  const htmlRef = useRef(EMPTY_HTML)
  const lastEmittedRef = useRef(EMPTY_HTML)
  const [codeOpen, setCodeOpen] = useState(false)
  const [htmlCode, setHtmlCode] = useState(EMPTY_HTML)
  const [fontFamily, setFontFamily] = useState(FONT_FAMILY_OPTIONS[0].value)
  const [fontSize, setFontSize] = useState(FONT_SIZE_OPTIONS[1].value)
  const [lineHeight, setLineHeight] = useState(LINE_HEIGHT_OPTIONS[1].value)
  const [block, setBlock] = useState(BLOCK_OPTIONS[0].value)
  const [selectedVariable, setSelectedVariable] = useState('')

  const variableOptions = useMemo(
    () => variables.map(variable => ({
      value: variable.value,
      label: variable.label
    })),
    [variables]
  )

  const emit = useCallback((html: string) => {
    htmlRef.current = html
    lastEmittedRef.current = html
    onChange(html)
  }, [onChange])

  const setEditorHtml = useCallback((html: string, notify = true) => {
    const nextHtml = sanitizeEmailRichHtmlForEditor(html)
    htmlRef.current = nextHtml
    lastEmittedRef.current = nextHtml
    setHtmlCode(nextHtml)
    window.requestAnimationFrame(() => {
      if (editorRef.current && editorRef.current.innerHTML !== nextHtml) {
        editorRef.current.innerHTML = nextHtml
      }
    })
    if (notify) onChange(nextHtml)
  }, [onChange])

  useEffect(() => {
    const nextHtml = sanitizeEmailRichHtmlForEditor(value || EMPTY_HTML)
    if (nextHtml === lastEmittedRef.current) return
    setEditorHtml(nextHtml, false)
  }, [setEditorHtml, value])

  const syncFromEditor = useCallback(() => {
    const html = editorRef.current?.innerHTML || EMPTY_HTML
    emit(html)
  }, [emit])

  const rememberCursor = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editorRef.current?.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange()
    }
  }, [])

  const restoreCursor = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return null

    editor.focus()
    const selection = window.getSelection()
    let range = savedRangeRef.current
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }

    selection?.removeAllRanges()
    selection?.addRange(range)
    return range
  }, [])

  const runEditorCommand = useCallback((command: string, commandValue?: string) => {
    restoreCursor()
    document.execCommand(command, false, commandValue)
    syncFromEditor()
    rememberCursor()
  }, [rememberCursor, restoreCursor, syncFromEditor])

  const wrapSelectionWithStyle = useCallback((style: string) => {
    const range = restoreCursor()
    if (!range) return

    const span = document.createElement('span')
    span.setAttribute('style', style)

    try {
      range.surroundContents(span)
    } catch {
      const fragment = range.extractContents()
      span.appendChild(fragment)
      range.insertNode(span)
    }

    const selection = window.getSelection()
    selection?.removeAllRanges()
    const nextRange = document.createRange()
    nextRange.selectNodeContents(span)
    nextRange.collapse(false)
    selection?.addRange(nextRange)
    savedRangeRef.current = nextRange.cloneRange()
    syncFromEditor()
  }, [restoreCursor, syncFromEditor])

  const insertHtmlAtCursor = useCallback((html: string) => {
    const editor = editorRef.current
    if (!editor) return

    const range = restoreCursor()
    if (!range) return

    const template = document.createElement('template')
    template.innerHTML = html
    const fragment = template.content
    const lastNode = fragment.lastChild
    range.deleteContents()
    range.insertNode(fragment)

    const selection = window.getSelection()
    const nextRange = document.createRange()
    if (lastNode) nextRange.setStartAfter(lastNode)
    else nextRange.selectNodeContents(editor)
    nextRange.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(nextRange)
    savedRangeRef.current = nextRange.cloneRange()
    syncFromEditor()
  }, [restoreCursor, syncFromEditor])

  const applyFontFamily = (nextValue: string) => {
    setFontFamily(nextValue)
    runEditorCommand('fontName', nextValue)
  }

  const applyFontSize = (nextValue: string) => {
    setFontSize(nextValue)
    runEditorCommand('fontSize', nextValue)
  }

  const applyLineHeight = (nextValue: string) => {
    setLineHeight(nextValue)
    wrapSelectionWithStyle(`line-height: ${nextValue}`)
  }

  const applyBlock = (nextValue: string) => {
    setBlock(nextValue)
    runEditorCommand('formatBlock', nextValue)
  }

  const applyLink = () => {
    const url = normalizeLinkUrl(window.prompt('Pega la URL o correo del enlace') || '')
    if (!url) return
    if (!isSafeEditorUrl(url, 'href')) {
      onWarning?.('Enlace inválido', 'Usa una URL https://, mailto:, tel: o un correo válido.')
      return
    }
    runEditorCommand('createLink', url)
  }

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      onWarning?.('Archivo inválido', 'Sube una imagen PNG, JPG, GIF o WebP.')
      return
    }

    if (file.size > MAX_EDITOR_IMAGE_BYTES) {
      onWarning?.('Imagen muy pesada', 'Usa una imagen menor a 2 MB para que el correo no salga gigante.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) return
      insertHtmlAtCursor(`<img src="${dataUrl}" alt="" style="max-width: 180px; height: auto; border-radius: 8px;">`)
    }
    reader.readAsDataURL(file)
  }

  const toggleCodePanel = () => {
    setCodeOpen(open => {
      const nextOpen = !open
      if (nextOpen) setHtmlCode(htmlRef.current || editorRef.current?.innerHTML || EMPTY_HTML)
      return nextOpen
    })
  }

  const refreshCodeFromEditor = () => {
    syncFromEditor()
    setHtmlCode(editorRef.current?.innerHTML || htmlRef.current || EMPTY_HTML)
  }

  const applyHtmlCode = () => {
    setEditorHtml(htmlCode)
    onHtmlApplied?.()
  }

  const insertVariable = (nextValue: string) => {
    if (!nextValue) return
    insertHtmlAtCursor(escapeHtml(`{{${nextValue}}}`))
    setSelectedVariable('')
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const pastedHtml = event.clipboardData.getData('text/html')
    const pastedText = event.clipboardData.getData('text/plain')
    const html = pastedHtml
      ? sanitizeEmailRichHtmlForEditor(pastedHtml)
      : plainTextToEmailHtml(pastedText)
    insertHtmlAtCursor(html)
  }

  return (
    <div className={cn(styles.shell, className)} data-density={density}>
      <div className={styles.toolbar} aria-label="Herramientas de formato de correo">
        <CustomSelect
          value={fontFamily}
          options={FONT_FAMILY_OPTIONS}
          onValueChange={applyFontFamily}
          className={styles.toolbarSelect}
          portal
          dropdownMinWidth={180}
          aria-label="Fuente"
        />
        <CustomSelect
          value={fontSize}
          options={FONT_SIZE_OPTIONS}
          onValueChange={applyFontSize}
          className={styles.toolbarSelectSmall}
          portal
          dropdownMinWidth={112}
          aria-label="Tamaño"
        />
        <CustomSelect
          value={lineHeight}
          options={LINE_HEIGHT_OPTIONS}
          onValueChange={applyLineHeight}
          className={styles.toolbarSelectSmall}
          portal
          dropdownMinWidth={112}
          aria-label="Interlineado"
        />
        <CustomSelect
          value={block}
          options={BLOCK_OPTIONS}
          onValueChange={applyBlock}
          className={styles.toolbarSelect}
          portal
          dropdownMinWidth={180}
          aria-label="Bloque"
        />
        {variableOptions.length > 0 && (
          <>
            <span className={styles.toolbarDivider} />
            <CustomSelect
              value={selectedVariable}
              options={variableOptions}
              onValueChange={insertVariable}
              className={styles.variableSelect}
              placeholder="Variables"
              portal
              dropdownMinWidth={220}
              aria-label="Insertar variable"
            />
          </>
        )}
        <span className={styles.toolbarDivider} />
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Negrita" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('bold')}>
          <Bold size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Cursiva" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('italic')}>
          <Italic size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Subrayado" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('underline')}>
          <Underline size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Tachado" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('strikeThrough')}>
          <Strikethrough size={16} />
        </Button>
        <span className={styles.toolbarDivider} />
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Alinear izquierda" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('justifyLeft')}>
          <AlignLeft size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Centrar" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('justifyCenter')}>
          <AlignCenter size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Alinear derecha" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('justifyRight')}>
          <AlignRight size={16} />
        </Button>
        <span className={styles.toolbarDivider} />
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Lista" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('insertUnorderedList')}>
          <List size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Lista numerada" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('insertOrderedList')}>
          <ListOrdered size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Cita" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('formatBlock', 'blockquote')}>
          <Quote size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Superíndice" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('superscript')}>
          <Superscript size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Subíndice" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('subscript')}>
          <Subscript size={16} />
        </Button>
        <span className={styles.toolbarDivider} />
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Agregar enlace" onPointerDown={(event) => event.preventDefault()} onClick={applyLink}>
          <Link size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Agregar imagen" onPointerDown={(event) => event.preventDefault()} onClick={() => imageInputRef.current?.click()}>
          <Image size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.toolButton}
          title="Código HTML"
          aria-pressed={codeOpen}
          data-on={codeOpen ? 'true' : undefined}
          onPointerDown={(event) => event.preventDefault()}
          onClick={toggleCodePanel}
        >
          <Code2 size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Deshacer" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('undo')}>
          <Undo2 size={16} />
        </Button>
        <Button type="button" variant="ghost" size="sm" className={styles.toolButton} title="Rehacer" onPointerDown={(event) => event.preventDefault()} onClick={() => runEditorCommand('redo')}>
          <Redo2 size={16} />
        </Button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className={styles.hiddenFileInput}
          onChange={handleImageUpload}
        />
      </div>

      {codeOpen && (
        <div className={styles.codePanel}>
          <div className={styles.codeHeader}>
            <strong>Código HTML</strong>
            <div className={styles.codeActions}>
              <Button type="button" variant="secondary" size="sm" onClick={refreshCodeFromEditor}>
                Tomar del editor
              </Button>
              <Button type="button" size="sm" onClick={applyHtmlCode}>
                Aplicar HTML
              </Button>
            </div>
          </div>
          <textarea
            value={htmlCode}
            onChange={(event) => setHtmlCode(event.target.value)}
            placeholder={codePlaceholder}
            spellCheck={false}
            rows={7}
          />
        </div>
      )}

      <div
        ref={editorRef}
        className={cn(styles.editor, editorClassName)}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={() => {
          rememberCursor()
          syncFromEditor()
        }}
        onKeyUp={rememberCursor}
        onMouseUp={rememberCursor}
        onBlur={() => {
          rememberCursor()
          syncFromEditor()
        }}
        onPaste={handlePaste}
      />
      {variableOptions.length > 0 && (
        <span className={styles.variableHint}>
          <Braces size={13} />
          Puedes insertar variables del flujo dentro del correo.
        </span>
      )}
    </div>
  )
}
