import type { HTMLAttributes, ReactNode } from 'react'
import {
  parseWhatsAppFormattedText,
  parseWhatsAppInlineText,
  type WhatsAppFormattedLine,
  type WhatsAppInlineSegment
} from '@/utils/whatsappTextFormatting'
import styles from './WhatsAppFormattedText.module.css'

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function renderInlineSegments(segments: WhatsAppInlineSegment[], keyPrefix: string): ReactNode[] {
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`

    if (segment.type === 'text') return segment.text
    if (segment.type === 'bold') return <strong key={key}>{renderInlineSegments(segment.children, key)}</strong>
    if (segment.type === 'italic') return <em key={key}>{renderInlineSegments(segment.children, key)}</em>
    if (segment.type === 'strikethrough') return <s key={key}>{renderInlineSegments(segment.children, key)}</s>
    if (segment.type === 'inlineCode') return <code key={key} className={styles.inlineCode}>{segment.text}</code>
    return <code key={key} className={styles.monospace}>{segment.text}</code>
  })
}

function renderLine(line: WhatsAppFormattedLine, index: number) {
  const content = line.segments.length
    ? renderInlineSegments(line.segments, `wa-line-${index}`)
    : '\u00a0'

  if (line.type === 'bullet') {
    return (
      <span key={`line-${index}`} className={classNames(styles.line, styles.listLine)}>
        <span className={styles.marker} aria-hidden="true">•</span>
        <span>{content}</span>
      </span>
    )
  }

  if (line.type === 'numbered') {
    return (
      <span key={`line-${index}`} className={classNames(styles.line, styles.listLine)}>
        <span className={styles.marker} aria-hidden="true">{line.marker}.</span>
        <span>{content}</span>
      </span>
    )
  }

  if (line.type === 'quote') {
    return (
      <span key={`line-${index}`} className={classNames(styles.line, styles.quoteLine)}>
        {content}
      </span>
    )
  }

  return (
    <span key={`line-${index}`} className={styles.line}>
      {content}
    </span>
  )
}

export interface WhatsAppFormattedTextProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  text: string
}

export function WhatsAppFormattedText({ text, className, ...props }: WhatsAppFormattedTextProps) {
  return (
    <div {...props} className={classNames(styles.formattedText, className)}>
      {parseWhatsAppFormattedText(text).map(renderLine)}
    </div>
  )
}

export interface WhatsAppFormattedInlineTextProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  text: string
}

export function WhatsAppFormattedInlineText({ text, className, ...props }: WhatsAppFormattedInlineTextProps) {
  return (
    <span {...props} className={classNames(styles.formattedInline, className)}>
      {renderInlineSegments(parseWhatsAppInlineText(text), 'wa-inline')}
    </span>
  )
}
