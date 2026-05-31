import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowUp, Bot, Eraser, KeyRound, MessageCircle, Mic, Pause, SendHorizonal, Sparkles, X } from 'lucide-react'
import { aiAgentService, type AIAgentClarificationOption, type AIAgentConfigInput, type AIAgentConfigStatus, type AIAgentMessage, type AIAgentViewContext } from '@/services/aiAgentService'
import { highLevelService } from '@/services/highLevelService'
import styles from './AIAgentPanel.module.css'

const AI_AGENT_FLOATING_OPEN_KEY = 'ristak.aiAgentFloating.open'
const LEGACY_AI_AGENT_MESSAGES_KEY = 'ristak.aiAgentFloating.messages'
const PAYMENT_CONFIG_CHANGED_EVENT = 'ristak-payment-config-changed'
const VOICE_WAVE_BAR_COUNT = 128
const VOICE_WAVE_MIN_HEIGHT = 4
const VOICE_WAVE_MAX_HEIGHT = 30

type VoiceCaptureState = 'idle' | 'recording' | 'finalizing'
type VoiceEndAction = 'draft' | 'send'

const suggestions = [
  'Dime que debería revisar hoy del negocio.',
  'Explícame esta vista y detecta algo importante.',
  'Qué oportunidades ves para vender más?',
  'Qué riesgos ves en pagos, citas o campañas?'
]

const routeLabels: Record<string, string> = {
  '/phone/agent-chat': 'Agente AI movil',
  '/dashboard': 'Dashboard',
  '/reports': 'Reportes',
  '/campaigns': 'Publicidad',
  '/transactions': 'Pagos',
  '/contacts': 'Contactos',
  '/appointments': 'Citas',
  '/analytics': 'Analíticas',
  '/settings': 'Configuración'
}

const emptyStatus: AIAgentConfigStatus = {
  configured: false,
  model: 'gpt-5.2',
  tokenPreview: null,
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  researchDomains: '',
  responseStyle: 'direct',
  recommendationMode: 'on_request',
  webSearchEnabled: false,
  updatedAt: null
}

const emptyForm: AIAgentConfigInput = {
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  researchDomains: '',
  responseStyle: 'direct',
  recommendationMode: 'on_request',
  webSearchEnabled: false
}

const onboardingQuestions: Array<{
  field: keyof Pick<AIAgentConfigInput, 'businessContext' | 'marketContext' | 'idealCustomer' | 'locationContext' | 'competitorsContext' | 'brandVoice'>
  question: string
}> = [
  {
    field: 'businessContext',
    question: 'Para darte recomendaciones con criterio, primero cuéntame qué vende tu negocio, cómo gana dinero y qué lo hace diferente.'
  },
  {
    field: 'marketContext',
    question: '¿En qué mercado o nicho compites? Por ejemplo: clínica estética, educación, real estate, servicios locales, consultoría, etc.'
  },
  {
    field: 'idealCustomer',
    question: '¿Quién es tu cliente ideal y qué problema quiere resolver cuando te compra?'
  },
  {
    field: 'locationContext',
    question: '¿En qué ciudad o zona vendes y qué detalles locales importan para el negocio?'
  },
  {
    field: 'competitorsContext',
    question: '¿Qué competidores, marcas de referencia o alternativas compara tu cliente antes de decidir?'
  },
  {
    field: 'brandVoice',
    question: '¿Cómo quieres que te recomiende la IA: agresivo, conservador, premium, directo, familiar? ¿Qué metas o reglas debe respetar?'
  }
]

type VisualChartType = 'bar' | 'line'

type VisualChartItem = {
  label: string
  value: number
  rawValue: string
  highlighted: boolean
}

type VisualChart = {
  type: VisualChartType
  title: string
  items: VisualChartItem[]
}

type AIAgentPanelProps = {
  variant?: 'floating' | 'embedded'
}

function getStoredOpenState() {
  try {
    return window.localStorage.getItem(AI_AGENT_FLOATING_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

function saveOpenState(open: boolean) {
  try {
    window.localStorage.setItem(AI_AGENT_FLOATING_OPEN_KEY, String(open))
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

function clearLegacyStoredMessages() {
  try {
    window.localStorage.removeItem(LEGACY_AI_AGENT_MESSAGES_KEY)
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

function createMessage(
  role: AIAgentMessage['role'],
  content: string,
  sources?: AIAgentMessage['sources'],
  clarificationOptions?: AIAgentClarificationOption[]
): AIAgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    sources,
    clarificationOptions,
    createdAt: new Date().toISOString()
  }
}

function getRouteLabel(pathname: string) {
  const match = Object.entries(routeLabels).find(([path]) => pathname.startsWith(path))
  return match?.[1] || pathname
}

function collectVisibleText() {
  const main = document.querySelector('main')
  const source = main instanceof HTMLElement ? main.innerText : document.body.innerText

  return source
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000)
}

function statusToForm(status: AIAgentConfigStatus): AIAgentConfigInput {
  return {
    businessContext: status.businessContext || '',
    marketContext: status.marketContext || '',
    idealCustomer: status.idealCustomer || '',
    locationContext: status.locationContext || '',
    competitorsContext: status.competitorsContext || '',
    brandVoice: status.brandVoice || '',
    researchDomains: status.researchDomains || '',
    responseStyle: status.responseStyle || 'direct',
    recommendationMode: status.recommendationMode || 'on_request',
    webSearchEnabled: Boolean(status.webSearchEnabled)
  }
}

function hasBusinessContext(form: AIAgentConfigInput) {
  return Boolean(
    form.businessContext.trim() ||
    form.marketContext.trim() ||
    form.idealCustomer.trim() ||
    form.locationContext.trim() ||
    form.competitorsContext.trim() ||
    form.brandVoice.trim()
  )
}

function createInitialVoiceBars() {
  return Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => {
    const wave = Math.sin(index * 0.75) * 0.5 + 0.5
    return Math.round(VOICE_WAVE_MIN_HEIGHT + wave * 8)
  })
}

function formatVoiceDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function getAudioContextConstructor() {
  const audioWindow = window as Window & {
    webkitAudioContext?: typeof AudioContext
  }

  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null
}

function getVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return ''
  }

  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg'
  ].find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

function getNextOnboardingQuestion(form: AIAgentConfigInput) {
  return onboardingQuestions.find((item) => !String(form[item.field] || '').trim()) || null
}

function renderInlineMarkdown(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-strong-${index}`} className={styles.inlineStrong}>
          {part.slice(2, -2)}
        </strong>
      )
    }

    return <React.Fragment key={`${keyPrefix}-text-${index}`}>{part}</React.Fragment>
  })
}

function isMarkdownTableLine(line: string) {
  return /^\s*\|.+\|\s*$/.test(line)
}

function isMarkdownTableDivider(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function parseTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function renderMarkdownTable(lines: string[], keyPrefix: string) {
  const rows = lines.filter((line) => !isMarkdownTableDivider(line)).map(parseTableRow)
  const [header = [], ...bodyRows] = rows

  if (!header.length || !bodyRows.length) return null

  return (
    <div className={styles.metricTableWrap} key={keyPrefix}>
      <table className={styles.metricTable}>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={`${keyPrefix}-head-${index}`}>
                {renderInlineMarkdown(cell, `${keyPrefix}-head-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={`${keyPrefix}-row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${keyPrefix}-cell-${rowIndex}-${cellIndex}`}>
                  {renderInlineMarkdown(cell, `${keyPrefix}-cell-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function parseChartNumber(value: string) {
  const normalized = value.replace(/,/g, '').replace(/\$/g, '')
  const match = normalized.match(/-?\d+(?:\.\d+)?/)

  return match ? Number(match[0]) : Number.NaN
}

function parseVisualChart(lines: string[]): VisualChart | null {
  let type: VisualChartType = 'bar'
  let title = ''
  const items: VisualChartItem[] = []

  lines.forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    const configMatch = trimmed.match(/^(type|title):\s*(.+)$/i)

    if (configMatch) {
      const key = configMatch[1].toLowerCase()
      const value = configMatch[2].trim()

      if (key === 'type' && /^(bar|line)$/i.test(value)) {
        type = value.toLowerCase() as VisualChartType
      }

      if (key === 'title') {
        title = value
      }

      return
    }

    const parts = trimmed.split('|').map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return

    const numericValue = parseChartNumber(parts[1])
    if (!Number.isFinite(numericValue)) return

    items.push({
      label: parts[0],
      value: numericValue,
      rawValue: parts[1],
      highlighted: parts.slice(2).some((part) => /^(highlight|destacar|clave)$/i.test(part))
    })
  })

  if (items.length < 2) return null

  return {
    type,
    title,
    items: items.slice(0, 8)
  }
}

function renderVisualChart(chart: VisualChart, keyPrefix: string) {
  const values = chart.items.map((item) => item.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const spread = maxValue - minValue || 1

  if (chart.type === 'line') {
    const width = 320
    const height = 138
    const paddingX = 22
    const paddingY = 18
    const pointGap = chart.items.length > 1 ? (width - paddingX * 2) / (chart.items.length - 1) : 0
    const points = chart.items.map((item, index) => {
      const x = paddingX + pointGap * index
      const y = height - paddingY - ((item.value - minValue) / spread) * (height - paddingY * 2)

      return { ...item, x, y }
    })
    const path = points.map((point) => `${point.x},${point.y}`).join(' ')

    return (
      <div className={styles.visualChart} key={keyPrefix}>
        {chart.title && <div className={styles.visualChartTitle}>{chart.title}</div>}
        <svg className={styles.lineChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.title || 'Gráfica lineal'}>
          <polyline className={styles.lineChartPath} points={path} />
          {points.map((point, index) => (
            <g key={`${keyPrefix}-point-${index}`}>
              <circle
                className={point.highlighted ? styles.lineChartPointHighlight : styles.lineChartPoint}
                cx={point.x}
                cy={point.y}
                r={point.highlighted ? 6 : 4}
              />
              {point.highlighted && (
                <text className={styles.lineChartValue} x={point.x} y={Math.max(12, point.y - 12)} textAnchor="middle">
                  {point.rawValue}
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className={styles.chartLabels}>
          {chart.items.map((item, index) => (
            <span className={item.highlighted ? styles.chartLabelHighlight : styles.chartLabel} key={`${keyPrefix}-label-${index}`}>
              {item.label}
            </span>
          ))}
        </div>
      </div>
    )
  }

  const maxAbsValue = Math.max(...chart.items.map((item) => Math.abs(item.value)), 1)

  return (
    <div className={styles.visualChart} key={keyPrefix}>
      {chart.title && <div className={styles.visualChartTitle}>{chart.title}</div>}
      <div className={styles.barChart}>
        {chart.items.map((item, index) => {
          const width = `${Math.max(6, (Math.abs(item.value) / maxAbsValue) * 100)}%`

          return (
            <div className={`${styles.barChartRow} ${item.highlighted ? styles.barChartRowHighlight : ''}`} key={`${keyPrefix}-bar-${index}`}>
              <div className={styles.barChartMeta}>
                <span className={styles.barChartLabel}>{item.label}</span>
                <span className={styles.barChartValue}>{item.rawValue}</span>
              </div>
              <div className={styles.barTrack}>
                <span className={styles.barFill} style={{ width }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getKeyValueParts(line: string) {
  const match = line.match(/^\s*(?:\*\*)?([^:*|\n]{2,54})(?::\*\*|\*\*:|:)\s+(.+)$/)
  if (!match) return null

  return {
    label: match[1].trim(),
    value: match[2].trim()
  }
}

function isOrderedListLine(line: string) {
  return /^\d+[\.)]\s+/.test(line.trim())
}

function normalizeOrderedListLine(line: string) {
  return line.trim().replace(/^\d+[\.)]\s+/, '')
}

function isSectionTitle(line: string) {
  const trimmed = line.trim()
  const plainTitle = trimmed.replace(/^\*\*/, '').replace(/\*\*$/, '')

  return (
    plainTitle.length <= 72 &&
    !plainTitle.includes(':') &&
    (
      /^🏆/.test(plainTitle) ||
      /^(ranking|resumen|ganadora|ganador|métricas|metricas|detalle|comparativo|periodo|resultado)/i.test(plainTitle)
    )
  )
}

function isInsightLabel(label: string) {
  return /^(conclusión|conclusion|qué significa|que significa|qué significa para el negocio|que significa para el negocio|lectura de negocio|siguiente acción|siguiente accion|acción recomendada|accion recomendada)$/i.test(label.replace(/\*/g, '').trim())
}

function renderMessageContent(content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const nodes: React.ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (/^```ristak-chart\s*$/i.test(trimmed)) {
      const chartLines: string[] = []
      index += 1

      while (index < lines.length && lines[index].trim() !== '```') {
        chartLines.push(lines[index])
        index += 1
      }

      if (index < lines.length && lines[index].trim() === '```') {
        index += 1
      }

      const chart = parseVisualChart(chartLines)
      if (chart) {
        nodes.push(renderVisualChart(chart, `chart-${index}`))
      }
      continue
    }

    if (isMarkdownTableLine(line) && lines[index + 1] && isMarkdownTableDivider(lines[index + 1])) {
      const tableLines: string[] = []

      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        tableLines.push(lines[index])
        index += 1
      }

      const tableNode = renderMarkdownTable(tableLines, `table-${index}`)
      if (tableNode) nodes.push(tableNode)
      continue
    }

    if (isSectionTitle(trimmed)) {
      const titleClassName = /^🏆/.test(trimmed) ? styles.winnerTitle : styles.sectionTitle

      nodes.push(
        <div className={titleClassName} key={`section-${index}`}>
          {renderInlineMarkdown(trimmed, `section-${index}`)}
        </div>
      )
      index += 1
      continue
    }

    const insightParts = getKeyValueParts(line)

    if (insightParts && isInsightLabel(insightParts.label)) {
      nodes.push(
        <div className={styles.insightBlock} key={`insight-${index}`}>
          <span className={styles.insightTitle}>{insightParts.label}</span>
          <span className={styles.insightText}>
            {renderInlineMarkdown(insightParts.value, `insight-${index}`)}
          </span>
        </div>
      )
      index += 1
      continue
    }

    if (isOrderedListLine(trimmed)) {
      const items: string[] = []

      while (index < lines.length && isOrderedListLine(lines[index])) {
        items.push(normalizeOrderedListLine(lines[index]))
        index += 1
      }

      nodes.push(
        <ol className={styles.orderedList} key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ol-${index}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      )
      continue
    }

    if (/^[-•]\s+/.test(trimmed)) {
      const items: string[] = []

      while (index < lines.length && /^[-•]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-•]\s+/, ''))
        index += 1
      }

      nodes.push(
        <ul className={styles.bulletList} key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`ul-${index}-${itemIndex}`}>
              {renderInlineMarkdown(item, `ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      )
      continue
    }

    const keyValueRows: Array<{ label: string; value: string }> = []
    let keyValueIndex = index

    while (keyValueIndex < lines.length) {
      if (!lines[keyValueIndex].trim() && keyValueRows.length > 0) {
        const nextParts = lines[keyValueIndex + 1] ? getKeyValueParts(lines[keyValueIndex + 1]) : null
        if (nextParts && !isInsightLabel(nextParts.label)) {
          keyValueIndex += 1
          continue
        }
        break
      }

      const parts = getKeyValueParts(lines[keyValueIndex])
      if (!parts || isInsightLabel(parts.label)) break

      keyValueRows.push(parts)
      keyValueIndex += 1
    }

    if (keyValueRows.length >= 2) {
      nodes.push(
        <div className={styles.kvGrid} key={`kv-${index}`}>
          {keyValueRows.map((row, rowIndex) => (
            <div className={styles.kvRow} key={`kv-${index}-${rowIndex}`}>
              <span className={styles.kvKey}>{row.label}</span>
              <span className={styles.kvValue}>{renderInlineMarkdown(row.value, `kv-${index}-${rowIndex}`)}</span>
            </div>
          ))}
        </div>
      )
      index = keyValueIndex
      continue
    }

    if (keyValueRows.length === 1) {
      const row = keyValueRows[0]

      nodes.push(
        <p className={nodes.length === 0 ? styles.contentLead : styles.richParagraph} key={`kv-single-${index}`}>
          <strong className={styles.inlineStrong}>{row.label}:</strong>{' '}
          {renderInlineMarkdown(row.value, `kv-single-${index}`)}
        </p>
      )
      index = keyValueIndex
      continue
    }

    nodes.push(
      <p className={nodes.length === 0 ? styles.contentLead : styles.richParagraph} key={`p-${index}`}>
        {renderInlineMarkdown(trimmed, `p-${index}`)}
      </p>
    )
    index += 1
  }

  return <div className={styles.richContent}>{nodes}</div>
}

export const AIAgentPanel: React.FC<AIAgentPanelProps> = ({ variant = 'floating' }) => {
  const location = useLocation()
  const embedded = variant === 'embedded'
  const [open, setOpen] = useState(() => embedded || getStoredOpenState())
  const [status, setStatus] = useState<AIAgentConfigStatus>(emptyStatus)
  const [paymentMode, setPaymentMode] = useState<'live' | 'test'>('live')
  const [form, setForm] = useState<AIAgentConfigInput>(emptyForm)
  const [messages, setMessages] = useState<AIAgentMessage[]>([])
  const [input, setInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [sending, setSending] = useState(false)
  const [unreadReplies, setUnreadReplies] = useState(0)
  const [voiceState, setVoiceState] = useState<VoiceCaptureState>('idle')
  const [voiceBars, setVoiceBars] = useState<number[]>(createInitialVoiceBars)
  const [voiceElapsed, setVoiceElapsed] = useState(0)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const askedOnboardingRef = useRef(false)
  const messagesRef = useRef(messages)
  const previousMessageCountRef = useRef(messages.length)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const voiceAnimationFrameRef = useRef<number | null>(null)
  const voiceAudioChunksRef = useRef<Blob[]>([])
  const voiceEndActionRef = useRef<VoiceEndAction | null>(null)
  const voiceHadErrorRef = useRef(false)
  const voiceIgnoreEndRef = useRef(false)
  const lastVoiceWaveUpdateRef = useRef(0)

  const nextOnboardingQuestion = useMemo(() => getNextOnboardingQuestion(form), [form])
  const businessContextLoaded = hasBusinessContext(form)
  const voiceIsActive = voiceState !== 'idle'
  const formattedVoiceElapsed = useMemo(() => formatVoiceDuration(voiceElapsed), [voiceElapsed])
  const visible = embedded || open
  const paymentTestMode = paymentMode === 'test'

  const emitConfigChange = (nextStatus: AIAgentConfigStatus) => {
    window.dispatchEvent(new CustomEvent('ai-agent-config-changed', {
      detail: nextStatus
    }))
  }

  const setOpenState = (nextOpen: boolean) => {
    if (embedded) {
      setOpen(true)
      setUnreadReplies(0)
      return
    }

    setOpen(nextOpen)
    if (nextOpen) {
      setUnreadReplies(0)
    }
    saveOpenState(nextOpen)
  }

  const applyStatus = (nextStatus: AIAgentConfigStatus) => {
    setStatus(nextStatus)
    setForm(statusToForm(nextStatus))
  }

  const loadStatus = async () => {
    setLoadingConfig(true)
    try {
      const nextStatus = await aiAgentService.getConfig()
      applyStatus(nextStatus)
    } catch {
      applyStatus(emptyStatus)
    } finally {
      setLoadingConfig(false)
    }
  }

  const loadPaymentMode = async () => {
    try {
      const config = await highLevelService.getConfig()
      setPaymentMode(config.ghlInvoiceMode === 'test' ? 'test' : 'live')
    } catch {
      setPaymentMode('live')
    }
  }

  useEffect(() => {
    clearLegacyStoredMessages()
    loadStatus()
    loadPaymentMode()

    const handleConfigChange = (event: Event) => {
      const customEvent = event as CustomEvent<AIAgentConfigStatus>
      if (customEvent.detail) {
        applyStatus(customEvent.detail)
      } else {
        loadStatus()
      }
    }

    window.addEventListener('ai-agent-config-changed', handleConfigChange)
    window.addEventListener(PAYMENT_CONFIG_CHANGED_EVENT, loadPaymentMode)

    return () => {
      window.removeEventListener('ai-agent-config-changed', handleConfigChange)
      window.removeEventListener(PAYMENT_CONFIG_CHANGED_EVENT, loadPaymentMode)
    }
  }, [])

  useEffect(() => {
    if (visible) {
      loadPaymentMode()
    }
  }, [visible])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending, savingConfig, visible])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, embedded ? 132 : 160)}px`
  }, [embedded, input, nextOnboardingQuestion, status.configured])

  useEffect(() => {
    if (embedded) {
      setUnreadReplies(0)
      previousMessageCountRef.current = messages.length
      return
    }

    if (open) {
      setUnreadReplies(0)
      previousMessageCountRef.current = messages.length
      return
    }

    if (messages.length > previousMessageCountRef.current) {
      const newMessages = messages.slice(previousMessageCountRef.current)
      const newAssistantReplies = newMessages.filter((message) => message.role === 'assistant').length

      if (newAssistantReplies > 0) {
        setUnreadReplies((current) => Math.min(current + newAssistantReplies, 9))
      }
    }

    previousMessageCountRef.current = messages.length
  }, [embedded, messages, open])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    if (loadingConfig || askedOnboardingRef.current || businessContextLoaded) return

    askedOnboardingRef.current = true
    const firstQuestion = getNextOnboardingQuestion(form)
    if (!firstQuestion) return

    setMessages((current) => {
      if (current.length) return current
      return [
        createMessage('assistant', 'Antes de que me des detalles sobre tu negocio, necesito hacerte unas preguntas para guardarlas en el sistema. Con esa base podré darte mejores consejos y recomendaciones, apoyándome tanto en tu data como en el contexto general del mercado y el mundo.'),
        createMessage('assistant', firstQuestion.question)
      ]
    })
  }, [businessContextLoaded, form, loadingConfig])

  const getViewContext = (): AIAgentViewContext => ({
    path: location.pathname,
    title: document.title || 'Ristak',
    routeLabel: getRouteLabel(location.pathname),
    visibleText: collectVisibleText()
  })

  const saveAgentConfig = async (nextConfig: AIAgentConfigInput, apiKey?: string) => {
    const nextStatus = await aiAgentService.saveConfig({
      ...nextConfig,
      apiKey: apiKey?.trim() || undefined
    })
    applyStatus(nextStatus)
    emitConfigChange(nextStatus)
    return nextStatus
  }

  const saveTokenFromChat = async () => {
    const apiKey = apiKeyInput.trim()

    if (!apiKey) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', 'Pega tu API key de OpenAI para activar el agente.')
      ])
      return
    }

    setSavingConfig(true)
    try {
      const nextStatus = await saveAgentConfig(form, apiKey)
      setApiKeyInput('')
      setMessages((current) => [
        ...current,
        createMessage('assistant', nextStatus.configured ? 'Listo, ya conecté OpenAI. Ahora puedo analizar tus datos y contexto desde este chat.' : 'Guardé la configuración, pero todavía no quedó activo el token.')
      ])
    } catch (error: any) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude guardar el token. ${error?.message || 'Revisa que sea una API key válida.'}`)
      ])
    } finally {
      setSavingConfig(false)
      textareaRef.current?.focus()
    }
  }

  const saveOnboardingAnswer = async (text: string, userMessage: AIAgentMessage) => {
    const currentQuestion = getNextOnboardingQuestion(form)
    if (!currentQuestion) return false

    const nextForm = {
      ...form,
      [currentQuestion.field]: text
    }

    setForm(nextForm)
    setMessages((current) => [...current, userMessage])
    setSending(true)

    try {
      await saveAgentConfig(nextForm)
      const followingQuestion = getNextOnboardingQuestion(nextForm)

      setMessages((current) => [
        ...current,
        createMessage(
          'assistant',
          followingQuestion
            ? followingQuestion.question
            : status.configured
              ? 'Perfecto, ya guardé el contexto del negocio. Ahora sí puedo darte recomendaciones con más criterio.'
              : 'Perfecto, ya guardé el contexto del negocio. Para activar análisis con IA, pega tu API key de OpenAI en la tarjeta de arriba.'
        )
      ])
    } catch (error: any) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude guardar esta respuesta. ${error?.message || 'Inténtalo otra vez.'}`)
      ])
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }

    return true
  }

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()

    if (!text || sending || savingConfig) return

    const userMessage = createMessage('user', text)
    setInput('')

    if (nextOnboardingQuestion) {
      await saveOnboardingAnswer(text, userMessage)
      return
    }

    if (!status.configured) {
      setMessages((current) => [
        ...current,
        userMessage,
        createMessage('assistant', 'Ya puedo guardar contexto del negocio, pero para responder con IA necesito que pegues tu API key de OpenAI en la tarjeta de configuración.')
      ])
      return
    }

    const nextMessages = [...messagesRef.current, userMessage]

    setMessages(nextMessages)
    setSending(true)

    try {
      const result = await aiAgentService.sendMessage(nextMessages, getViewContext())
      setMessages((current) => [
        ...current,
        createMessage('assistant', result.reply, result.sources, result.clarificationOptions)
      ])
    } catch (error: any) {
      setMessages((current) => [
        ...current,
        createMessage('assistant', `No pude responder ahorita. ${error?.message || 'Revisa la configuración del Agente AI.'}`)
      ])
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const stopVoiceMeter = () => {
    if (voiceAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceAnimationFrameRef.current)
      voiceAnimationFrameRef.current = null
    }

    audioSourceRef.current?.disconnect()
    audioSourceRef.current = null
    analyserRef.current = null

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined)
      audioContextRef.current = null
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    mediaStreamRef.current = null
  }

  const startVoiceMeter = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Tu navegador no permite usar el micrófono desde esta pantalla.')
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaStreamRef.current = stream

    const AudioContextConstructor = getAudioContextConstructor()
    if (!AudioContextConstructor) return stream

    const audioContext = new AudioContextConstructor()
    const analyser = audioContext.createAnalyser()
    const source = audioContext.createMediaStreamSource(stream)

    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.72
    const samples = new Uint8Array(analyser.fftSize)
    source.connect(analyser)

    audioContextRef.current = audioContext
    audioSourceRef.current = source
    analyserRef.current = analyser

    const drawWave = (timestamp: number) => {
      if (!analyserRef.current) return

      if (timestamp - lastVoiceWaveUpdateRef.current > 55) {
        analyserRef.current.getByteTimeDomainData(samples)
        const average = samples.reduce((sum, value) => sum + Math.abs(value - 128), 0) / samples.length
        const normalized = Math.min(1, average / 34)
        const nextHeight = Math.round(VOICE_WAVE_MIN_HEIGHT + normalized * (VOICE_WAVE_MAX_HEIGHT - VOICE_WAVE_MIN_HEIGHT))

        setVoiceBars((current) => [...current.slice(1), nextHeight])
        lastVoiceWaveUpdateRef.current = timestamp
      }

      voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
    }

    voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)

    return stream
  }

  const setVoiceErrorMessage = (message: string) => {
    voiceHadErrorRef.current = Boolean(message)
    setVoiceError(message)
  }

  const resetVoiceCapture = () => {
    mediaRecorderRef.current = null
    voiceEndActionRef.current = null
    stopVoiceMeter()
    setVoiceState('idle')
    setVoiceElapsed(0)
    setVoiceTranscript('')
    setVoiceBars(createInitialVoiceBars())
  }

  const completeVoiceCapture = async (audioBlob: Blob, action: VoiceEndAction) => {
    setVoiceTranscript('Transcribiendo audio...')
    stopVoiceMeter()

    if (!audioBlob.size) {
      resetVoiceCapture()
      if (!voiceHadErrorRef.current) {
        setVoiceErrorMessage('No alcancé a grabar audio. Inténtalo otra vez.')
      }
      textareaRef.current?.focus()
      return
    }

    let transcript = ''

    try {
      const result = await aiAgentService.transcribeVoice(audioBlob)
      transcript = result.text.trim()
    } catch (error: any) {
      resetVoiceCapture()
      setVoiceErrorMessage(error?.message || 'No pude transcribir el audio.')
      textareaRef.current?.focus()
      return
    }

    resetVoiceCapture()

    if (!transcript) {
      if (!voiceHadErrorRef.current) {
        setVoiceErrorMessage('No alcancé a transcribir audio. Inténtalo otra vez.')
      }
      textareaRef.current?.focus()
      return
    }

    setVoiceErrorMessage('')

    if (action === 'send') {
      sendMessage(transcript)
      return
    }

    setInput((current) => {
      if (!current.trim()) return transcript
      return `${current}${/\s$/.test(current) ? '' : ' '}${transcript}`
    })

    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const startVoiceRecording = async () => {
    if (voiceIsActive || sending || savingConfig) return

    if (!status.configured) {
      setVoiceErrorMessage('Conecta OpenAI para transcribir mensajes de voz.')
      return
    }

    if (typeof MediaRecorder === 'undefined') {
      setVoiceErrorMessage('Tu navegador no permite grabar audio desde esta pantalla.')
      return
    }

    voiceAudioChunksRef.current = []
    voiceEndActionRef.current = 'draft'
    voiceHadErrorRef.current = false
    voiceIgnoreEndRef.current = false
    setVoiceError('')
    setVoiceTranscript('')
    setVoiceElapsed(0)
    setVoiceBars(createInitialVoiceBars())

    try {
      const stream = await startVoiceMeter()
      const mimeType = getVoiceMimeType()
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceAudioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onerror = () => {
        setVoiceErrorMessage('No pude grabar el audio del micrófono.')
      }

      mediaRecorder.onstop = () => {
        if (voiceIgnoreEndRef.current) return

        const audioType = mediaRecorder.mimeType || mimeType || 'audio/webm'
        const audioBlob = new Blob(voiceAudioChunksRef.current, { type: audioType })
        completeVoiceCapture(audioBlob, voiceEndActionRef.current || 'draft')
      }

      mediaRecorderRef.current = mediaRecorder
      setVoiceState('recording')
      setVoiceTranscript('Grabando audio...')
      mediaRecorder.start()
    } catch (error: any) {
      mediaRecorderRef.current = null
      voiceEndActionRef.current = null
      stopVoiceMeter()
      setVoiceState('idle')
      setVoiceErrorMessage(error?.message || 'No pude acceder al micrófono.')
    }
  }

  const finishVoiceRecording = (action: 'draft' | 'send') => {
    if (!voiceIsActive || voiceState === 'finalizing') return

    voiceEndActionRef.current = action
    setVoiceState('finalizing')
    setVoiceTranscript('Preparando transcripción...')

    try {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      } else {
        const audioBlob = new Blob(voiceAudioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' })
        completeVoiceCapture(audioBlob, action)
      }
    } catch {
      const audioBlob = new Blob(voiceAudioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' })
      completeVoiceCapture(audioBlob, action)
    }
  }

  useEffect(() => {
    if (voiceState !== 'recording') return

    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 250)

    return () => window.clearInterval(timer)
  }, [voiceState])

  useEffect(() => {
    return () => {
      voiceIgnoreEndRef.current = true
      voiceEndActionRef.current = null
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current = null
      stopVoiceMeter()
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  const clearChat = () => {
    askedOnboardingRef.current = businessContextLoaded
    setMessages([])
  }

  const floatingButtonClassName = `${styles.floatingButton} ${unreadReplies ? styles.floatingButtonUnread : ''}`
  const closedButtonBaseLabel = unreadReplies
    ? `Abrir agente AI, ${unreadReplies} respuesta nueva`
    : 'Abrir agente AI'
  const closedButtonLabel = paymentTestMode
    ? `${closedButtonBaseLabel}. Modo prueba activo para pagos`
    : closedButtonBaseLabel
  const rootClassName = embedded ? styles.embeddedRoot : styles.floatingRoot
  const windowClassName = embedded ? `${styles.window} ${styles.embeddedWindow}` : styles.window

  return (
    <div className={rootClassName}>
      {visible && (
        <section className={windowClassName} aria-label="Agente AI">
          <header className={styles.header}>
            <div className={styles.identity}>
              <div className={styles.avatar}>
                <Bot size={19} />
              </div>
              <div className={styles.titleBlock}>
                <h2 className={styles.title}>Agente AI</h2>
                <div className={styles.subtitle}>
                  <span className={status.configured ? styles.statusDot : styles.statusDotMuted} />
                  <span>{status.configured ? 'Conectado a OpenAI' : 'Configúralo aquí mismo'}</span>
                  {paymentTestMode && (
                    <span className={styles.paymentModeBadge} title="Los pagos del agente se ejecutan en modo prueba">
                      <span className={styles.paymentModeBadgeDot} />
                      Modo prueba
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.headerActions}>
              <button
                type="button"
                className={styles.iconButton}
                onClick={clearChat}
                disabled={!messages.length || sending || savingConfig}
                aria-label="Limpiar chat"
                title="Limpiar chat"
              >
                <Eraser size={16} />
              </button>
              {!embedded && (
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setOpenState(false)}
                  aria-label="Cerrar chat"
                  title="Cerrar chat"
                >
                  <X size={17} />
                </button>
              )}
            </div>
          </header>

          {!status.configured && (
            <div className={styles.setupCard}>
              <div className={styles.setupTitle}>
                <KeyRound size={16} />
                Conectar OpenAI
              </div>
              <div className={styles.setupForm}>
                <input
                  className={styles.setupInput}
                  type="password"
                  value={apiKeyInput}
                  placeholder="Pega tu API key sk-..."
                  autoComplete="off"
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  disabled={savingConfig || loadingConfig}
                />
                <button
                  type="button"
                  className={styles.setupButton}
                  onClick={saveTokenFromChat}
                  disabled={savingConfig || loadingConfig || !apiKeyInput.trim()}
                >
                  {savingConfig ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          )}

          {!businessContextLoaded && !loadingConfig && (
            <div className={styles.contextNotice}>
              <Sparkles size={15} />
              Falta contexto del negocio. Respóndeme estas preguntas y lo guardaré automáticamente en Configuración.
            </div>
          )}

          {status.configured && paymentTestMode && (
            <div className={styles.paymentModeNotice} role="status">
              <span className={styles.paymentModeNoticeDot} />
              Modo prueba activo. Si registras pagos desde aquí, el agente los hará en prueba.
            </div>
          )}

          <div className={styles.body}>
            {messages.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>
                  Pregúntame por ventas, citas, campañas, contactos o por lo que estás viendo en esta pantalla.
                </p>
                {status.configured && (
                  <div className={styles.suggestions}>
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className={styles.suggestionButton}
                        onClick={() => sendMessage(suggestion)}
                        disabled={sending || savingConfig}
                      >
                        <Sparkles size={13} /> {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.messages}>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`${styles.message} ${message.role === 'user' ? styles.messageUser : styles.messageAssistant}`}
                  >
                    <span className={styles.messageLabel}>
                      {message.role === 'user' ? 'Tú' : 'Agente'}
                    </span>
                    <div className={styles.bubble}>{renderMessageContent(message.content)}</div>
                    {message.role === 'assistant' && Boolean(message.clarificationOptions?.length) && (
                      <div className={styles.optionButtons} aria-label="Opciones para aclarar la pregunta">
                        {message.clarificationOptions?.map((option) => (
                          <button
                            key={`${message.id}-${option.value}`}
                            type="button"
                            className={styles.optionButton}
                            onClick={() => sendMessage(option.value)}
                            disabled={sending || savingConfig}
                          >
                            <span className={styles.optionLabel}>{option.label}</span>
                            {option.description && (
                              <span className={styles.optionDescription}>{option.description}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {message.role === 'assistant' && Boolean(message.sources?.length) && (
                      <div className={styles.sources}>
                        <span className={styles.sourcesLabel}>Fuentes</span>
                        {message.sources?.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.sourceLink}
                          >
                            {source.title || source.url}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {(sending || savingConfig) && (
                  <div className={styles.loading}>
                    <span className={styles.spinner} />
                    {savingConfig ? 'Guardando configuración...' : 'Analizando datos...'}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <footer className={styles.composer}>
            {voiceIsActive ? (
              <div className={styles.voiceComposer} aria-label="Grabación de voz en curso">
                <div className={styles.voiceWaveArea}>
                  <div className={styles.voiceWaveform} aria-hidden="true">
                    {voiceBars.map((height, index) => (
                      <span
                        key={`voice-bar-${index}`}
                        className={styles.voiceBar}
                        style={{ '--voice-bar-height': `${height}px` } as React.CSSProperties}
                      />
                    ))}
                  </div>
                  <span className={styles.voiceTranscriptPreview} aria-live="polite">
                    {voiceTranscript || (voiceState === 'finalizing' ? 'Terminando transcripción...' : 'Escuchando...')}
                  </span>
                </div>
                <span className={styles.voiceTimer}>{formattedVoiceElapsed}</span>
                <button
                  type="button"
                  className={styles.voicePauseButton}
                  onClick={() => finishVoiceRecording('draft')}
                  disabled={voiceState === 'finalizing'}
                  aria-label="Pausar y pasar texto al mensaje"
                  title="Pausar y editar texto"
                >
                  <Pause size={15} />
                </button>
                <button
                  type="button"
                  className={styles.voiceSendButton}
                  onClick={() => finishVoiceRecording('send')}
                  disabled={voiceState === 'finalizing'}
                  aria-label="Enviar transcripción al agente"
                  title="Enviar transcripción"
                >
                  <SendHorizonal size={17} />
                </button>
              </div>
            ) : (
              <div className={styles.textComposer}>
                <button
                  type="button"
                  className={styles.micButton}
                  onClick={startVoiceRecording}
                  disabled={sending || savingConfig}
                  aria-label="Dictar mensaje por voz"
                  title="Dictar mensaje por voz"
                >
                  <Mic size={17} />
                </button>
                <textarea
                  ref={textareaRef}
                  className={styles.textarea}
                  value={input}
                  placeholder={nextOnboardingQuestion ? 'Responde para guardar contexto...' : status.configured ? 'Pregunta algo del negocio...' : 'Pega el token arriba o cuéntame del negocio...'}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending || savingConfig}
                  rows={1}
                />
                <button
                  type="button"
                  className={styles.sendButton}
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || sending || savingConfig}
                  aria-label="Enviar mensaje"
                >
                  {embedded ? <ArrowUp size={20} /> : <SendHorizonal size={17} />}
                </button>
              </div>
            )}
            {voiceError && (
              <div className={styles.voiceError} role="status">
                {voiceError}
              </div>
            )}
          </footer>
        </section>
      )}

      {!embedded && !open && (
        <button
          type="button"
          className={floatingButtonClassName}
          onClick={() => setOpenState(true)}
          aria-label={closedButtonLabel}
        >
          <>
            <MessageCircle size={18} />
            <span className={styles.floatingButtonLabel}>Chat AI</span>
            {paymentTestMode && (
              <span
                className={styles.floatingPaymentModeDot}
                title="Modo prueba activo para pagos"
                aria-hidden="true"
              />
            )}
            {unreadReplies > 0 && (
              <span className={styles.unreadIndicator} aria-hidden="true">
                <span className={styles.unreadDot} />
                <span className={styles.unreadBadge}>{unreadReplies}</span>
              </span>
            )}
          </>
        </button>
      )}
    </div>
  )
}
