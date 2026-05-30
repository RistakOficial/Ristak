import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, Eraser, KeyRound, MessageCircle, SendHorizonal, Sparkles, X } from 'lucide-react'
import { aiAgentService, type AIAgentConfigInput, type AIAgentConfigStatus, type AIAgentMessage, type AIAgentViewContext } from '@/services/aiAgentService'
import styles from './AIAgentPanel.module.css'

const AI_AGENT_FLOATING_OPEN_KEY = 'ristak.aiAgentFloating.open'
const AI_AGENT_MESSAGES_KEY = 'ristak.aiAgentFloating.messages'
const MAX_STORED_MESSAGES = 80

const suggestions = [
  'Dime que debería revisar hoy del negocio.',
  'Explícame esta vista y detecta algo importante.',
  'Qué oportunidades ves para vender más?',
  'Qué riesgos ves en pagos, citas o campañas?'
]

const routeLabels: Record<string, string> = {
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

function getStoredMessages(): AIAgentMessage[] {
  try {
    const rawMessages = window.localStorage.getItem(AI_AGENT_MESSAGES_KEY)
    if (!rawMessages) return []

    const parsedMessages = JSON.parse(rawMessages)
    if (!Array.isArray(parsedMessages)) return []

    return parsedMessages
      .filter((message) => (
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim()
      ))
      .slice(-MAX_STORED_MESSAGES)
      .map((message) => ({
        id: typeof message.id === 'string' ? message.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: message.content,
        sources: Array.isArray(message.sources) ? message.sources : undefined,
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString()
      }))
  } catch {
    return []
  }
}

function saveMessages(messages: AIAgentMessage[]) {
  try {
    const messagesToStore = messages.slice(-MAX_STORED_MESSAGES)
    window.localStorage.setItem(AI_AGENT_MESSAGES_KEY, JSON.stringify(messagesToStore))
  } catch {
    // localStorage can fail in private or restricted browser contexts.
  }
}

function createMessage(role: AIAgentMessage['role'], content: string, sources?: AIAgentMessage['sources']): AIAgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    sources,
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

function getNextOnboardingQuestion(form: AIAgentConfigInput) {
  return onboardingQuestions.find((item) => !String(form[item.field] || '').trim()) || null
}

export const AIAgentPanel: React.FC = () => {
  const location = useLocation()
  const [open, setOpen] = useState(getStoredOpenState)
  const [status, setStatus] = useState<AIAgentConfigStatus>(emptyStatus)
  const [form, setForm] = useState<AIAgentConfigInput>(emptyForm)
  const [messages, setMessages] = useState<AIAgentMessage[]>(getStoredMessages)
  const [input, setInput] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [sending, setSending] = useState(false)
  const askedOnboardingRef = useRef(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const nextOnboardingQuestion = useMemo(() => getNextOnboardingQuestion(form), [form])
  const businessContextLoaded = hasBusinessContext(form)

  const emitConfigChange = (nextStatus: AIAgentConfigStatus) => {
    window.dispatchEvent(new CustomEvent('ai-agent-config-changed', {
      detail: nextStatus
    }))
  }

  const setOpenState = (nextOpen: boolean) => {
    setOpen(nextOpen)
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

  useEffect(() => {
    loadStatus()

    const handleConfigChange = (event: Event) => {
      const customEvent = event as CustomEvent<AIAgentConfigStatus>
      if (customEvent.detail) {
        applyStatus(customEvent.detail)
      } else {
        loadStatus()
      }
    }

    window.addEventListener('ai-agent-config-changed', handleConfigChange)

    return () => {
      window.removeEventListener('ai-agent-config-changed', handleConfigChange)
    }
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending, savingConfig, open])

  useEffect(() => {
    saveMessages(messages)
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

    const nextMessages = [...messages, userMessage]

    setMessages(nextMessages)
    setSending(true)

    try {
      const result = await aiAgentService.sendMessage(nextMessages, getViewContext())
      setMessages((current) => [
        ...current,
        createMessage('assistant', result.reply, result.sources)
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

  return (
    <div className={styles.floatingRoot}>
      {open && (
        <section className={styles.window} aria-label="Agente AI">
          <header className={styles.header}>
            <div className={styles.identity}>
              <div className={styles.avatar}>
                <Bot size={19} />
              </div>
              <div className={styles.titleBlock}>
                <h2 className={styles.title}>Agente AI</h2>
                <div className={styles.subtitle}>
                  <span className={status.configured ? styles.statusDot : styles.statusDotMuted} />
                  {status.configured ? 'Conectado a OpenAI' : 'Configúralo aquí mismo'}
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
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setOpenState(false)}
                aria-label="Cerrar chat"
                title="Cerrar chat"
              >
                <X size={17} />
              </button>
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
                    <div className={styles.bubble}>{message.content}</div>
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
              <SendHorizonal size={17} />
            </button>
          </footer>
        </section>
      )}

      <button
        type="button"
        className={open ? styles.floatingButtonOpen : styles.floatingButton}
        onClick={() => setOpenState(!open)}
        aria-label={open ? 'Cerrar agente AI' : 'Abrir agente AI'}
      >
        {open ? <X size={18} /> : (
          <>
            <MessageCircle size={18} />
            <span className={styles.floatingButtonLabel}>Chat AI</span>
          </>
        )}
      </button>
    </div>
  )
}
