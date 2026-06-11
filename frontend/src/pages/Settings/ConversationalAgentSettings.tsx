import React, { useEffect, useRef, useState } from 'react'
import { Bot, MessageCircle, Play, Send, Trash2 } from 'lucide-react'
import { Card, CustomSelect } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  conversationalAgentService,
  type ClosingStrategyMode,
  type ConversationalAgentConfig,
  type ConversationalAgentConfigInput,
  type ConversationalAgentTestResult,
  type ConversationalObjective,
  type ConversationalSuccessAction
} from '@/services/conversationalAgentService'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import styles from './AIAgentSettings.module.css'

const AUTOSAVE_DELAY_MS = 900

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const objectiveOptions: Array<{ value: ConversationalObjective; label: string; description: string }> = [
  { value: 'citas', label: 'Cerrar citas', description: 'Lleva la conversación a agendar una cita.' },
  { value: 'ventas', label: 'Cerrar ventas', description: 'Lleva la conversación hacia la compra.' },
  { value: 'datos', label: 'Conseguir datos específicos', description: 'Obtiene los datos clave del prospecto.' },
  { value: 'filtrar', label: 'Filtrar curiosos', description: 'Separa curiosos de prospectos con intención real.' },
  { value: 'detectar', label: 'Detectar prospectos listos', description: 'Identifica quién ya está listo para comprar o agendar.' },
  { value: 'custom', label: 'Objetivo personalizado', description: 'Define tú mismo el objetivo del agente.' }
]

const successActionOptions: Array<{ value: ConversationalSuccessAction; label: string; description: string }> = [
  { value: 'book_appointment', label: 'Agendar directamente', description: 'Usa los calendarios y la disponibilidad real para crear la cita.' },
  { value: 'ready_for_human', label: 'Marcar lista para humano', description: 'Crea la señal interna y mueve el chat a prioridad para que lo tome una persona.' },
  { value: 'ready_to_buy', label: 'Marcar lista para comprar', description: 'Crea la señal interna de compra y mueve el chat a prioridad.' },
  { value: 'internal_signal', label: 'Solo señal interna', description: 'Crea la señal según el objetivo, sin mensajes finales largos.' }
]

const emptyConfig: ConversationalAgentConfig = {
  enabled: false,
  objective: 'citas',
  customObjective: '',
  successAction: 'ready_for_human',
  requiredData: '',
  handoffRules: '',
  extraInstructions: '',
  allowEmojis: false,
  hideAttended: false,
  defaultCalendarId: null,
  closingStrategyMode: 'system',
  closingStrategyCustom: '',
  updatedAt: null
}

type TestMessage = { role: 'user' | 'assistant'; content: string; internal?: boolean }

function formToInput(form: ConversationalAgentConfig): ConversationalAgentConfigInput {
  return {
    enabled: form.enabled,
    objective: form.objective,
    customObjective: form.customObjective,
    successAction: form.successAction,
    requiredData: form.requiredData,
    handoffRules: form.handoffRules,
    extraInstructions: form.extraInstructions,
    allowEmojis: form.allowEmojis,
    hideAttended: form.hideAttended,
    defaultCalendarId: form.defaultCalendarId,
    closingStrategyMode: form.closingStrategyMode,
    closingStrategyCustom: form.closingStrategyCustom
  }
}

function getSignature(form: ConversationalAgentConfig) {
  return JSON.stringify(formToInput(form))
}

export const ConversationalAgentSettings: React.FC = () => {
  const { showToast } = useNotification()
  const [form, setForm] = useState<ConversationalAgentConfig>(emptyConfig)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [calendars, setCalendars] = useState<Calendar[]>([])

  const [testMessages, setTestMessages] = useState<TestMessage[]>([])
  const [testInput, setTestInput] = useState('')
  const [testing, setTesting] = useState(false)

  const hydratedRef = useRef(false)
  const autosaveTimerRef = useRef<number | null>(null)
  const activeSaveIdRef = useRef(0)
  const lastSavedSignatureRef = useRef(getSignature(emptyConfig))

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [config, calendarList] = await Promise.all([
          conversationalAgentService.getConfig(),
          calendarsService.getCalendars()
        ])
        if (cancelled) return
        setForm({ ...emptyConfig, ...config })
        setCalendars(calendarList.filter((cal) => cal.isActive !== false))
        lastSavedSignatureRef.current = getSignature({ ...emptyConfig, ...config })
        setSaveState('saved')
      } catch (error: any) {
        if (!cancelled) {
          showToast('error', 'Error', error?.message || 'No se pudo cargar el agente conversacional')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
          hydratedRef.current = true
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [showToast])

  useEffect(() => {
    if (!hydratedRef.current || loading) return

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }

    const signature = getSignature(form)
    if (signature === lastSavedSignatureRef.current) {
      setSaveState('saved')
      setSaveError('')
      return
    }

    const saveId = activeSaveIdRef.current + 1
    activeSaveIdRef.current = saveId
    setSaveState('pending')
    setSaveError('')

    autosaveTimerRef.current = window.setTimeout(async () => {
      setSaveState('saving')
      try {
        const next = await conversationalAgentService.saveConfig(formToInput(form))
        if (activeSaveIdRef.current !== saveId) return
        lastSavedSignatureRef.current = getSignature({ ...emptyConfig, ...next })
        setSaveState('saved')
      } catch (error: any) {
        if (activeSaveIdRef.current !== saveId) return
        const message = error?.message || 'No se pudo guardar la configuración'
        setSaveState('error')
        setSaveError(message)
        showToast('error', 'No se pudo guardar', message)
      }
    }, AUTOSAVE_DELAY_MS)

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  }, [form, loading, showToast])

  const updateField = <K extends keyof ConversationalAgentConfig>(field: K, value: ConversationalAgentConfig[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const selectedObjective = objectiveOptions.find((option) => option.value === form.objective) || objectiveOptions[0]
  const selectedAction = successActionOptions.find((option) => option.value === form.successAction) || successActionOptions[1]

  const saveStatusText = loading
    ? 'Cargando...'
    : saveState === 'saving' || saveState === 'pending'
      ? 'Guardando en automático...'
      : saveState === 'error'
        ? saveError || 'No se pudo guardar'
        : 'Guardado automático'

  const handleSendTestMessage = async () => {
    const content = testInput.trim()
    if (!content || testing) return

    const nextMessages: TestMessage[] = [...testMessages.filter((m) => !m.internal), { role: 'user' as const, content }]
    setTestMessages([...testMessages, { role: 'user', content }])
    setTestInput('')
    setTesting(true)

    try {
      const result: ConversationalAgentTestResult = await conversationalAgentService.testAgent(
        nextMessages.map(({ role, content: text }) => ({ role, content: text })),
        formToInput(form)
      )

      setTestMessages((current) => {
        const updated = [...current]
        for (const action of result.actions || []) {
          updated.push({ role: 'assistant', content: `⚙︎ Acción interna: ${action.type}`, internal: true })
        }
        if (result.reply) {
          updated.push({ role: 'assistant', content: result.reply })
        } else if (result.suppressed) {
          updated.push({ role: 'assistant', content: '⚙︎ El agente decidió no responder (acción interna o silencio).', internal: true })
        }
        return updated
      })
    } catch (error: any) {
      showToast('error', 'Prueba fallida', error?.message || 'No se pudo probar el agente')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBox}>
              <MessageCircle size={22} />
            </div>
            <div>
              <h2 className={styles.title}>Agente conversacional</h2>
              <p className={styles.description}>
                Atiende los chats de WhatsApp con datos reales del negocio y lleva al prospecto al objetivo.
              </p>
            </div>
          </div>
          <div className={styles.headerActions}>
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => updateField('enabled', event.target.checked)}
                disabled={loading}
              />
              <span>
                <Bot size={16} />
                {form.enabled ? 'Agente activado' : 'Agente desactivado'}
              </span>
            </label>
          </div>
        </div>

        <div className={`${styles.saveStatus} ${saveState === 'error' ? styles.saveStatusError : saveState === 'pending' || saveState === 'saving' ? styles.saveStatusWorking : styles.saveStatusSaved}`}>
          <span className={styles.saveDot} />
          {saveStatusText}
        </div>

        <div className={styles.settingsGrid}>
          <div className={styles.field}>
            <label className={styles.label}>Objetivo principal</label>
            <CustomSelect
              value={form.objective}
              onChange={(event) => updateField('objective', event.target.value as ConversationalObjective)}
              disabled={loading}
            >
              {objectiveOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </CustomSelect>
            <p className={styles.helper}>{selectedObjective.description}</p>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Cuando cumpla el objetivo</label>
            <CustomSelect
              value={form.successAction}
              onChange={(event) => updateField('successAction', event.target.value as ConversationalSuccessAction)}
              disabled={loading}
            >
              {successActionOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </CustomSelect>
            <p className={styles.helper}>{selectedAction.description}</p>
          </div>

          {form.successAction === 'book_appointment' && (
            <div className={styles.field}>
              <label className={styles.label}>Calendario preferido</label>
              <CustomSelect
                value={form.defaultCalendarId || ''}
                onChange={(event) => updateField('defaultCalendarId', event.target.value || null)}
                disabled={loading}
              >
                <option value="">El agente elige entre los calendarios activos</option>
                {calendars.map((calendar) => (
                  <option key={calendar.id} value={calendar.id}>
                    {calendar.name}
                  </option>
                ))}
              </CustomSelect>
              <p className={styles.helper}>
                Solo agenda con la disponibilidad real de tus calendarios; nunca inventa horarios.
              </p>
            </div>
          )}
        </div>

        {form.objective === 'custom' && (
          <div className={styles.section}>
            <h3 className={styles.sectionTitle}>Objetivo personalizado</h3>
            <textarea
              className={styles.textarea}
              value={form.customObjective}
              placeholder="Ejemplo: que la persona pida una propuesta formal para su empresa."
              onChange={(event) => updateField('customObjective', event.target.value)}
              disabled={loading}
              rows={3}
            />
          </div>
        )}

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Estrategia de cierre</h3>
          <p className={styles.helper}>
            El paso a paso que el agente sigue para llevar la conversación al objetivo y manejar objeciones.
          </p>
          <div className={styles.field}>
            <CustomSelect
              value={form.closingStrategyMode}
              onChange={(event) => updateField('closingStrategyMode', event.target.value as ClosingStrategyMode)}
              disabled={loading}
            >
              <option value="system">Predeterminada del sistema</option>
              <option value="custom">Personalizada</option>
            </CustomSelect>
          </div>
          {form.closingStrategyMode === 'system' ? (
            <>
              <pre className={styles.systemPromptBox}>{form.systemClosingStrategy || 'Cargando estrategia del sistema...'}</pre>
              <p className={styles.helper}>
                Esta es la estrategia exacta que usa el agente. Para cambiarla, elige "Personalizada" y escribe la tuya.
              </p>
            </>
          ) : (
            <>
              <textarea
                className={`${styles.textarea} ${styles.actionTextarea}`}
                value={form.closingStrategyCustom}
                placeholder={'Escribe el paso a paso que debe seguir el agente. Ejemplo:\n\n1. Pregunta qué busca resolver la persona.\n2. Si pregunta el valor, dáselo y pregunta qué resultado espera.\n3. Aporta una recomendación breve según su caso.\n4. Si muestra intención real, ejecuta la acción de avance.\n\nManejo de objeciones:\n- "Está caro" → pregunta qué le hace más ruido, el valor o no saber si le sirve.'}
                onChange={(event) => updateField('closingStrategyCustom', event.target.value)}
                disabled={loading}
                rows={10}
              />
              <p className={styles.helper}>
                {form.closingStrategyCustom.trim()
                  ? 'El agente seguirá esta estrategia en lugar de la predeterminada.'
                  : 'Si la dejas vacía, el agente usará la estrategia predeterminada del sistema.'}
              </p>
            </>
          )}
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Datos mínimos antes de cumplir el objetivo</h3>
          <textarea
            className={styles.textarea}
            value={form.requiredData}
            placeholder={'Opcional. Ejemplo:\n- Nombre completo\n- Qué servicio le interesa\n- Para cuándo lo necesita'}
            onChange={(event) => updateField('requiredData', event.target.value)}
            disabled={loading}
            rows={4}
          />
          <p className={styles.helper}>
            El agente los pide de uno en uno y los guarda en el contacto. No pidas datos que ya existen: el agente los lee solo.
          </p>
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Casos que siempre van con un humano</h3>
          <textarea
            className={styles.textarea}
            value={form.handoffRules}
            placeholder={'Opcional. Además de quejas, temas delicados, confusión fuerte e insultos (ya incluidos), agrega los tuyos:\n- Preguntas de facturación\n- Urgencias médicas'}
            onChange={(event) => updateField('handoffRules', event.target.value)}
            disabled={loading}
            rows={4}
          />
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Instrucciones extra del negocio</h3>
          <textarea
            className={styles.textarea}
            value={form.extraInstructions}
            placeholder="Opcional. Reglas, promociones vigentes con justificante real, formas de hablar del negocio, etc."
            onChange={(event) => updateField('extraInstructions', event.target.value)}
            disabled={loading}
            rows={5}
          />
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Comportamiento</h3>
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={form.allowEmojis}
              onChange={(event) => updateField('allowEmojis', event.target.checked)}
              disabled={loading}
            />
            <span>Permitir emojis en las respuestas</span>
          </label>
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={form.hideAttended}
              onChange={(event) => updateField('hideAttended', event.target.checked)}
              disabled={loading}
            />
            <span>Ocultar conversaciones atendidas por el agente (reaparecen al cumplir el objetivo o al necesitar humano)</span>
          </label>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeading}>
            <Play size={17} />
            <h3 className={styles.sectionTitle}>Probar el agente</h3>
          </div>
          <p className={styles.helper}>
            Conversación simulada con la configuración de arriba. No envía WhatsApp, no crea citas ni cambia estados:
            las acciones internas se muestran marcadas con ⚙︎.
          </p>

          <div className={styles.testChatBox}>
            {testMessages.length === 0 && (
              <p className={styles.testChatEmpty}>Escribe como si fueras un prospecto para ver cómo responde.</p>
            )}
            {testMessages.map((message, index) => (
              <div
                key={index}
                className={`${styles.testChatMessage} ${message.role === 'user' ? styles.testChatUser : styles.testChatAssistant} ${message.internal ? styles.testChatInternal : ''}`}
              >
                {message.content}
              </div>
            ))}
            {testing && <div className={`${styles.testChatMessage} ${styles.testChatAssistant}`}>Escribiendo…</div>}
          </div>

          <div className={styles.testChatComposer}>
            <input
              className={styles.input}
              value={testInput}
              placeholder="Mensaje del prospecto..."
              onChange={(event) => setTestInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  handleSendTestMessage()
                }
              }}
              disabled={loading || testing}
            />
            <button
              type="button"
              className={styles.inlineActionButton}
              onClick={handleSendTestMessage}
              disabled={loading || testing || !testInput.trim()}
            >
              <Send size={14} />
              Enviar
            </button>
            {testMessages.length > 0 && (
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => setTestMessages([])}
                aria-label="Limpiar conversación de prueba"
                disabled={testing}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
      </div>
    </Card>
  )
}
