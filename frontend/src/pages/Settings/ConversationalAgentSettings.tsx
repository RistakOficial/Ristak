import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, MessageCircle, Play, Plus, RotateCcw, Send, Trash2, X } from 'lucide-react'
import { Button, Card, CustomSelect, TagPicker } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import {
  conversationalAgentService,
  type AgentFilterOptions,
  type AgentSuccessExtra,
  type ClosingStrategyMode,
  type ConversationalAgentConfig,
  type ConversationalAgentDef,
  type ConversationalAgentDefInput,
  type ConversationalAgentTestResult,
  type ConversationalObjective,
  type ConversationalSuccessAction,
  type SuccessExtraType
} from '@/services/conversationalAgentService'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { ConditionBuilder } from './ConditionBuilder'
import styles from './AIAgentSettings.module.css'

const AUTOSAVE_DELAY_MS = 900

const objectiveOptions: Array<{ value: ConversationalObjective; label: string; description: string }> = [
  { value: 'citas', label: 'Cerrar citas', description: 'Lleva la conversación a agendar una cita.' },
  { value: 'ventas', label: 'Cerrar ventas', description: 'Lleva la conversación hacia la compra.' },
  { value: 'datos', label: 'Conseguir datos específicos', description: 'Obtiene los datos clave del prospecto.' },
  { value: 'filtrar', label: 'Filtrar curiosos', description: 'Separa curiosos de prospectos con intención real.' },
  { value: 'detectar', label: 'Detectar prospectos listos', description: 'Identifica quién ya está listo para comprar o agendar.' },
  { value: 'custom', label: 'Objetivo personalizado', description: 'Define tú mismo el objetivo del agente.' }
]

const successActionLabels: Record<ConversationalSuccessAction, { label: string; description: string }> = {
  book_appointment: { label: 'Agendar directamente', description: 'Usa los calendarios y la disponibilidad real para crear la cita.' },
  ready_for_human: { label: 'Mandar a humano', description: 'Crea la señal interna y mueve el chat a prioridad para que lo tome una persona.' },
  ready_to_buy: { label: 'Marcar lista para comprar', description: 'Crea la señal interna de compra y mueve el chat a prioridad.' },
  internal_signal: { label: 'Solo señal interna', description: 'Crea la señal según el objetivo, sin mensajes finales largos.' },
  none: { label: 'No hacer nada', description: 'Solo registra que se cumplió; la conversación no se mueve a prioridad.' }
}

const actionsByObjective: Record<ConversationalObjective, ConversationalSuccessAction[]> = {
  citas: ['book_appointment', 'ready_for_human', 'internal_signal', 'none'],
  ventas: ['ready_to_buy', 'ready_for_human', 'internal_signal', 'none'],
  datos: ['ready_for_human', 'internal_signal', 'none'],
  filtrar: ['ready_for_human', 'internal_signal', 'none'],
  detectar: ['ready_to_buy', 'ready_for_human', 'internal_signal', 'none'],
  custom: ['book_appointment', 'ready_to_buy', 'ready_for_human', 'internal_signal', 'none']
}

const extraTypeOptions: Array<{ value: SuccessExtraType; label: string }> = [
  { value: 'add_tag', label: 'Agregar etiqueta' },
  { value: 'remove_tag', label: 'Quitar etiqueta' },
  { value: 'set_custom_field', label: 'Cambiar campo personalizado' }
]

type TestMessage = { role: 'user' | 'assistant'; content: string; internal?: boolean }

function agentToInput(agent: ConversationalAgentDef): ConversationalAgentDefInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = agent
  return rest
}

interface AgentCardProps {
  agent: ConversationalAgentDef
  calendars: Calendar[]
  filterOptions?: AgentFilterOptions
  systemStrategy: string
  expanded: boolean
  onToggleExpanded: () => void
  onChange: (patch: ConversationalAgentDefInput) => void
  onDelete: () => void
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, calendars, filterOptions, systemStrategy, expanded, onToggleExpanded, onChange, onDelete }) => {
  const { showToast } = useNotification()
  const [testMessages, setTestMessages] = useState<TestMessage[]>([])
  const [testInput, setTestInput] = useState('')
  const [testing, setTesting] = useState(false)

  const allowedActions = actionsByObjective[agent.objective] || actionsByObjective.custom
  const selectedObjective = objectiveOptions.find((option) => option.value === agent.objective) || objectiveOptions[0]
  const selectedActionInfo = successActionLabels[agent.successAction] || successActionLabels.ready_for_human
  const strategyIsCustom = agent.closingStrategyMode === 'custom'
  const strategyText = strategyIsCustom ? agent.closingStrategyCustom : systemStrategy
  const entryCount = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
  const exitCount = agent.filters.exit.groups.reduce((total, group) => total + group.conditions.length, 0)

  const updateExtra = (index: number, patch: Partial<AgentSuccessExtra>) => {
    onChange({ successExtras: agent.successExtras.map((extra, i) => (i === index ? { ...extra, ...patch } : extra)) })
  }

  const handleObjectiveChange = (objective: ConversationalObjective) => {
    const allowed = actionsByObjective[objective] || actionsByObjective.custom
    const patch: ConversationalAgentDefInput = { objective }
    if (!allowed.includes(agent.successAction)) {
      patch.successAction = allowed[0]
    }
    onChange(patch)
  }

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
        { config: agentToInput(agent) }
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
      <div className={styles.agentCardHeader}>
        <button type="button" className={styles.agentCardToggle} onClick={onToggleExpanded} aria-expanded={expanded}>
          <span className={`${styles.iconBox} ${agent.enabled ? '' : styles.iconBoxMuted}`}>
            <Bot size={20} />
          </span>
          <ChevronDown size={17} className={`${styles.agentCardChevron} ${expanded ? styles.agentCardChevronOpen : ''}`} />
        </button>
        <input
          className={styles.agentNameInput}
          value={agent.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="Nombre del agente"
          aria-label="Nombre del agente"
        />
        <div className={styles.agentCardActions}>
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={agent.enabled}
              onChange={(event) => onChange({ enabled: event.target.checked })}
            />
            <span>{agent.enabled ? 'Activo' : 'Apagado'}</span>
          </label>
          <button type="button" className={styles.iconButton} onClick={onDelete} aria-label={`Eliminar ${agent.name}`}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {!expanded && (
        <p className={styles.agentCardSummary}>
          {selectedObjective.label} · {selectedActionInfo.label}
          {entryCount > 0
            ? ` · ${entryCount} ${entryCount === 1 ? 'condición de inicio' : 'condiciones de inicio'}`
            : ' · atiende todas las conversaciones'}
          {exitCount > 0 ? ` · ${exitCount} de salida` : ''}
        </p>
      )}

      {expanded && (
        <>
          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Inicio del agente</h3>
            <p className={styles.agentSectionHint}>
              El agente inicia cuando un grupo cumple todas sus condiciones; los grupos se unen con "O".
              Si hay varios agentes, gana el primero (de arriba hacia abajo) que coincida.
            </p>
            <ConditionBuilder
              groups={agent.filters.entry.groups}
              mode="entry"
              calendars={calendars}
              options={filterOptions}
              emptyText="Sin condiciones: este agente atiende cualquier conversación nueva."
              onChange={(groups) => onChange({ filters: { ...agent.filters, entry: { groups } } })}
            />
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Soltar la conversación</h3>
            <p className={styles.agentSectionHint}>
              El agente suelta el contacto cuando algún grupo se cumple completo (por ejemplo, al agendar su cita o
              al recibir cierta etiqueta). Otro agente que coincida puede tomarla.
            </p>
            <ConditionBuilder
              groups={agent.filters.exit.groups}
              mode="exit"
              calendars={calendars}
              options={filterOptions}
              emptyText="Sin condiciones: el agente no suelta la conversación por reglas."
              onChange={(groups) => onChange({ filters: { ...agent.filters, exit: { groups } } })}
            />
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Objetivo</h3>
            <div className={styles.settingsGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Objetivo principal</label>
                <CustomSelect
                  value={agent.objective}
                  onChange={(event) => handleObjectiveChange(event.target.value as ConversationalObjective)}
                >
                  {objectiveOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
                <p className={styles.helper}>{selectedObjective.description}</p>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Cuando cumpla el objetivo</label>
                <CustomSelect
                  value={agent.successAction}
                  onChange={(event) => onChange({ successAction: event.target.value as ConversationalSuccessAction })}
                >
                  {allowedActions.map((action) => (
                    <option key={action} value={action}>{successActionLabels[action].label}</option>
                  ))}
                </CustomSelect>
                <p className={styles.helper}>{selectedActionInfo.description}</p>
              </div>

              {agent.successAction === 'book_appointment' && (
                <div className={styles.field}>
                  <label className={styles.label}>Calendario preferido</label>
                  <CustomSelect
                    value={agent.defaultCalendarId || ''}
                    onChange={(event) => onChange({ defaultCalendarId: event.target.value || null })}
                  >
                    <option value="">El agente elige entre los calendarios activos</option>
                    {calendars.map((calendar) => (
                      <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
                    ))}
                  </CustomSelect>
                  <p className={styles.helper}>Solo agenda con la disponibilidad real; nunca inventa horarios.</p>
                </div>
              )}
            </div>

            {agent.objective === 'custom' && (
              <div className={styles.fieldWide}>
                <label className={styles.label}>Describe el objetivo personalizado</label>
                <textarea
                  className={styles.textarea}
                  value={agent.customObjective}
                  placeholder="Ejemplo: que la persona pida una propuesta formal para su empresa."
                  onChange={(event) => onChange({ customObjective: event.target.value })}
                  rows={3}
                />
              </div>
            )}

            <div className={styles.fieldWide}>
              <label className={styles.label}>Acciones adicionales al cumplir</label>
              {agent.successExtras.map((extra, index) => (
                <div key={index} className={styles.extraRow}>
                  <select
                    className={styles.ruleSelect}
                    value={extra.type}
                    onChange={(event) => updateExtra(index, { type: event.target.value as SuccessExtraType })}
                  >
                    {extraTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  {extra.type === 'set_custom_field' ? (
                    <>
                      <input
                        className={styles.ruleInput}
                        value={extra.field || ''}
                        placeholder="Campo"
                        onChange={(event) => updateExtra(index, { field: event.target.value })}
                      />
                      <input
                        className={styles.ruleInput}
                        value={extra.value || ''}
                        placeholder="Valor"
                        onChange={(event) => updateExtra(index, { value: event.target.value })}
                      />
                    </>
                  ) : (
                    <div className={styles.conditionTagPicker}>
                      <TagPicker
                        value={extra.tag || ''}
                        onValueChange={(tagId) => updateExtra(index, { tag: tagId })}
                        allowCreate
                        portal
                        placeholder="Elige una etiqueta"
                        aria-label="Etiqueta de la acción"
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    className={styles.ruleDelete}
                    onClick={() => onChange({ successExtras: agent.successExtras.filter((_, i) => i !== index) })}
                    aria-label="Quitar acción"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.ruleAddButton}
                onClick={() => onChange({ successExtras: [...agent.successExtras, { type: 'add_tag', tag: '' }] })}
              >
                <Plus size={14} />
                Añadir acción
              </button>
              <p className={styles.helper}>
                Se ejecutan en automático al cumplirse el objetivo: etiquetas y campos personalizados del contacto.
              </p>
            </div>
          </div>

          <div className={styles.agentSection}>
            <div className={styles.strategyHeaderRow}>
              <h3 className={styles.sectionTitle}>Estrategia de cierre</h3>
              <span className={`${styles.strategyBadge} ${strategyIsCustom ? styles.strategyBadgeCustom : ''}`}>
                {strategyIsCustom ? 'Personalizada' : 'Predeterminada del sistema'}
              </span>
              {strategyIsCustom && (
                <button
                  type="button"
                  className={styles.resetStrategyButton}
                  onClick={() => onChange({ closingStrategyMode: 'system', closingStrategyCustom: '' })}
                >
                  <RotateCcw size={13} />
                  Volver al preestablecido
                </button>
              )}
            </div>
            <textarea
              className={`${styles.textarea} ${styles.actionTextarea}`}
              value={strategyText}
              onChange={(event) => onChange({ closingStrategyMode: 'custom' as ClosingStrategyMode, closingStrategyCustom: event.target.value })}
              rows={11}
            />
            <p className={styles.helper}>
              {strategyIsCustom
                ? 'El agente sigue esta estrategia editada. Con "Volver al preestablecido" recuperas la del sistema.'
                : 'Esta es la estrategia exacta del sistema. Puedes editarla directamente: al cambiar cualquier letra se vuelve personalizada.'}
            </p>
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Reglas del negocio</h3>
            <div className={styles.fieldWide}>
              <label className={styles.label}>Datos mínimos antes de cumplir el objetivo</label>
              <textarea
                className={styles.textarea}
                value={agent.requiredData}
                placeholder={'Opcional. Ejemplo:\n- Nombre completo\n- Qué servicio le interesa\n- Para cuándo lo necesita'}
                onChange={(event) => onChange({ requiredData: event.target.value })}
                rows={4}
              />
              <p className={styles.helper}>
                El agente los pide de uno en uno y los guarda en el contacto. No pidas datos que ya existen: los lee solo.
              </p>
            </div>
            <div className={styles.fieldWide}>
              <label className={styles.label}>Casos que siempre van con un humano</label>
              <textarea
                className={styles.textarea}
                value={agent.handoffRules}
                placeholder={'Opcional. Además de quejas, temas delicados, confusión fuerte e insultos (ya incluidos), agrega los tuyos:\n- Preguntas de facturación\n- Urgencias médicas'}
                onChange={(event) => onChange({ handoffRules: event.target.value })}
                rows={4}
              />
            </div>
            <div className={styles.fieldWide}>
              <label className={styles.label}>Instrucciones extra del negocio</label>
              <textarea
                className={styles.textarea}
                value={agent.extraInstructions}
                placeholder="Opcional. Reglas, promociones vigentes con justificante real, formas de hablar del negocio, etc."
                onChange={(event) => onChange({ extraInstructions: event.target.value })}
                rows={5}
              />
            </div>
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={agent.allowEmojis}
                onChange={(event) => onChange({ allowEmojis: event.target.checked })}
              />
              <span>Permitir emojis en las respuestas</span>
            </label>
          </div>

          <div className={styles.agentSection}>
            <div className={styles.sectionHeading}>
              <Play size={17} />
              <h3 className={styles.sectionTitle}>Probar este agente</h3>
            </div>
            <p className={styles.agentSectionHint}>
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
                disabled={testing}
              />
              <button
                type="button"
                className={styles.inlineActionButton}
                onClick={handleSendTestMessage}
                disabled={testing || !testInput.trim()}
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
        </>
      )}
    </Card>
  )
}

export const ConversationalAgentSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [config, setConfig] = useState<ConversationalAgentConfig | null>(null)
  const [agents, setAgents] = useState<ConversationalAgentDef[]>([])
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [filterOptions, setFilterOptions] = useState<AgentFilterOptions | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  const agentsRef = useRef<ConversationalAgentDef[]>([])
  agentsRef.current = agents

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [nextConfig, nextAgents, calendarList, nextOptions] = await Promise.all([
          conversationalAgentService.getConfig(),
          conversationalAgentService.listAgents(),
          calendarsService.getCalendars(),
          conversationalAgentService.getFilterOptions().catch(() => undefined)
        ])
        if (cancelled) return
        setConfig(nextConfig)
        setAgents(nextAgents)
        setCalendars(calendarList.filter((cal) => cal.isActive !== false))
        setFilterOptions(nextOptions)
        if (nextAgents.length === 1) {
          setExpandedIds(new Set([nextAgents[0].id]))
        }
      } catch (error: any) {
        if (!cancelled) {
          showToast('error', 'Error', error?.message || 'No se pudo cargar el agente conversacional')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [showToast])

  useEffect(() => {
    const timers = saveTimersRef.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  const scheduleAgentSave = useCallback((agentId: string) => {
    const timers = saveTimersRef.current
    const existing = timers.get(agentId)
    if (existing) window.clearTimeout(existing)
    timers.set(agentId, window.setTimeout(async () => {
      timers.delete(agentId)
      const agent = agentsRef.current.find((item) => item.id === agentId)
      if (!agent) return
      try {
        await conversationalAgentService.updateAgent(agentId, agentToInput(agent))
      } catch (error: any) {
        showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
      }
    }, AUTOSAVE_DELAY_MS))
  }, [showToast])

  const handleAgentChange = (agentId: string, patch: ConversationalAgentDefInput) => {
    setAgents((current) => current.map((agent) => (agent.id === agentId ? { ...agent, ...patch } as ConversationalAgentDef : agent)))
    scheduleAgentSave(agentId)
  }

  const handleGlobalChange = async (patch: { enabled?: boolean; hideAttended?: boolean }) => {
    try {
      const next = await conversationalAgentService.saveConfig(patch)
      setConfig(next)
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración')
    }
  }

  const handleCreateAgent = async () => {
    setCreating(true)
    try {
      const agent = await conversationalAgentService.createAgent({ name: `Agente ${agents.length + 1}` })
      setAgents((current) => [...current, agent])
      setExpandedIds((current) => new Set([...current, agent.id]))
    } catch (error: any) {
      showToast('error', 'No se pudo crear', error?.message || 'Error al crear el agente')
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteAgent = (agent: ConversationalAgentDef) => {
    showConfirm(
      `Eliminar "${agent.name}"`,
      'Las conversaciones que atendía quedarán libres para que otro agente (o un humano) las tome.',
      async () => {
        try {
          await conversationalAgentService.deleteAgent(agent.id)
          setAgents((current) => current.filter((item) => item.id !== agent.id))
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error?.message || 'Error al eliminar el agente')
        }
      },
      'Eliminar',
      'Cancelar'
    )
  }

  const systemStrategy = config?.systemClosingStrategy || ''

  return (
    <div className={styles.container}>
      <Card>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBox}>
              <MessageCircle size={22} />
            </div>
            <div>
              <h2 className={styles.title}>Agente conversacional</h2>
              <p className={styles.description}>
                Atiende los chats con datos reales del negocio. Crea varios agentes con objetivos y filtros distintos.
              </p>
            </div>
          </div>
          <div className={styles.headerActions}>
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={Boolean(config?.enabled)}
                disabled={loading || !config}
                onChange={(event) => handleGlobalChange({ enabled: event.target.checked })}
              />
              <span>
                <Bot size={16} />
                {config?.enabled ? 'Activado' : 'Desactivado'}
              </span>
            </label>
            <Button onClick={handleCreateAgent} loading={creating} disabled={loading || creating}>
              <Plus size={16} />
              Nuevo agente
            </Button>
          </div>
        </div>

        <label className={styles.inlineToggle}>
          <input
            type="checkbox"
            checked={Boolean(config?.hideAttended)}
            disabled={loading || !config}
            onChange={(event) => handleGlobalChange({ hideAttended: event.target.checked })}
          />
          <span>Ocultar conversaciones atendidas por el agente (reaparecen al cumplir el objetivo o al necesitar humano)</span>
        </label>
      </Card>

      {loading && (
        <Card>
          <p className={styles.helper}>Cargando agentes...</p>
        </Card>
      )}

      {!loading && agents.length === 0 && (
        <Card>
          <p className={styles.helper}>
            Aún no tienes agentes conversacionales. Crea el primero con "Nuevo agente": cada uno es un contenedor con su
            objetivo, estrategia y filtros de inicio y salida.
          </p>
        </Card>
      )}

      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          calendars={calendars}
          filterOptions={filterOptions}
          systemStrategy={systemStrategy}
          expanded={expandedIds.has(agent.id)}
          onToggleExpanded={() => {
            setExpandedIds((current) => {
              const next = new Set(current)
              if (next.has(agent.id)) next.delete(agent.id)
              else next.add(agent.id)
              return next
            })
          }}
          onChange={(patch) => handleAgentChange(agent.id, patch)}
          onDelete={() => handleDeleteAgent(agent)}
        />
      ))}
    </div>
  )
}
