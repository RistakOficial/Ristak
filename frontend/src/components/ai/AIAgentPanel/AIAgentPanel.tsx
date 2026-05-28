import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, Eraser, SendHorizonal, Sparkles } from 'lucide-react'
import { aiAgentService, type AIAgentMessage, type AIAgentViewContext } from '@/services/aiAgentService'
import styles from './AIAgentPanel.module.css'

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

function createMessage(role: AIAgentMessage['role'], content: string): AIAgentMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
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

export const AIAgentPanel: React.FC = () => {
  const location = useLocation()
  const [messages, setMessages] = useState<AIAgentMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  const getViewContext = (): AIAgentViewContext => ({
    path: location.pathname,
    title: document.title || 'Ristak',
    routeLabel: getRouteLabel(location.pathname),
    visibleText: collectVisibleText()
  })

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()

    if (!text || sending) return

    const userMessage = createMessage('user', text)
    const nextMessages = [...messages, userMessage]

    setMessages(nextMessages)
    setInput('')
    setSending(true)

    try {
      const result = await aiAgentService.sendMessage(nextMessages, getViewContext())
      setMessages((current) => [
        ...current,
        createMessage('assistant', result.reply)
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

  return (
    <section className={styles.panel} aria-label="Agente AI">
      <header className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.avatar}>
            <Bot size={19} />
          </div>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>Agente AI</h2>
            <div className={styles.subtitle}>
              <span className={styles.statusDot} />
              Con datos del negocio
            </div>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setMessages([])}
            disabled={!messages.length || sending}
            aria-label="Limpiar chat"
            title="Limpiar chat"
          >
            <Eraser size={16} />
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyText}>
              Pregúntame por ventas, citas, campañas, contactos o por lo que estás viendo en esta pantalla.
            </p>
            <div className={styles.suggestions}>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={styles.suggestionButton}
                  onClick={() => sendMessage(suggestion)}
                  disabled={sending}
                >
                  <Sparkles size={13} /> {suggestion}
                </button>
              ))}
            </div>
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
              </div>
            ))}

            {sending && (
              <div className={styles.loading}>
                <span className={styles.spinner} />
                Analizando datos...
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
          placeholder="Pregunta algo del negocio..."
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          rows={1}
        />
        <button
          type="button"
          className={styles.sendButton}
          onClick={() => sendMessage()}
          disabled={!input.trim() || sending}
          aria-label="Enviar mensaje"
        >
          <SendHorizonal size={17} />
        </button>
      </footer>
    </section>
  )
}
