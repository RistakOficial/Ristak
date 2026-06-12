import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, MessageCircle, Play, Plus, RotateCcw, Send, Trash2, X } from 'lucide-react'
import { Button, Card, CustomSelect, TagPicker } from '@/components/common'
import { DEFAULT_AI_MODEL, aiModelOptionGroups, aiModelOptions, getKnownAIModel } from '@/constants/aiModels'
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
  { value: 'citas', label: 'Agendar citas', description: 'Lleva la plática hasta dejar una cita lista.' },
  { value: 'ventas', label: 'Cerrar ventas', description: 'Empuja la conversación hacia una compra real.' },
  { value: 'datos', label: 'Pedir datos', description: 'Pide lo que falta, sin repetir lo que ya sabe.' },
  { value: 'filtrar', label: 'Filtrar curiosos', description: 'Separa gente interesada de quien nomás anda viendo.' },
  { value: 'detectar', label: 'Detectar listos', description: 'Avísale al equipo cuando alguien ya trae intención.' },
  { value: 'custom', label: 'Objetivo propio', description: 'Escribe una meta específica para este agente.' }
]

const successActionLabels: Record<ConversationalSuccessAction, { label: string; description: string }> = {
  book_appointment: { label: 'Agendar solo', description: 'Crea la cita con horarios reales. Nada de inventar.' },
  ready_for_human: { label: 'Pasarlo al equipo', description: 'Lo deja en prioridad para que alguien lo tome.' },
  ready_to_buy: { label: 'Marcar listo para comprar', description: 'Lo manda a prioridad como oportunidad caliente.' },
  internal_signal: { label: 'Sólo avisar', description: 'Guarda la señal interna y sigue tranquilo.' },
  none: { label: 'No mover nada', description: 'Sólo conversa; no cambia prioridades.' }
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
    <Card padding="md" className={styles.conversationAgentCard}>
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
            ? ` · entra con ${entryCount} ${entryCount === 1 ? 'regla' : 'reglas'}`
            : ' · entra con cualquier chat'}
          {exitCount > 0 ? ` · se suelta con ${exitCount}` : ''}
        </p>
      )}

      {expanded && (
        <>
          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>1. Cuándo contesta</h3>
            <p className={styles.agentSectionHint}>
              Sin reglas, contesta cualquier chat nuevo. Si pones reglas, sólo entra cuando se cumplan.
            </p>
            <ConditionBuilder
              groups={agent.filters.entry.groups}
              mode="entry"
              calendars={calendars}
              options={filterOptions}
              emptyText="Sin reglas: este agente puede contestar cualquier chat nuevo."
              onChange={(groups) => onChange({ filters: { ...agent.filters, entry: { groups } } })}
            />
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>2. Cuándo se sale</h3>
            <p className={styles.agentSectionHint}>
              Úsalo si quieres que deje de contestar cuando pase algo, como cita agendada o etiqueta puesta.
            </p>
            <ConditionBuilder
              groups={agent.filters.exit.groups}
              mode="exit"
              calendars={calendars}
              options={filterOptions}
              emptyText="Sin reglas: no se suelta solo por filtros."
              onChange={(groups) => onChange({ filters: { ...agent.filters, exit: { groups } } })}
            />
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>3. Qué tiene que lograr</h3>
            <div className={styles.compactSettingsGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Meta</label>
                <CustomSelect
                  value={agent.objective}
                  onChange={(event) => handleObjectiveChange(event.target.value as ConversationalObjective)}
                  portal
                >
                  {objectiveOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
                <p className={styles.helper}>{selectedObjective.description}</p>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Al lograrlo</label>
                <CustomSelect
                  value={agent.successAction}
                  onChange={(event) => onChange({ successAction: event.target.value as ConversationalSuccessAction })}
                  portal
                >
                  {allowedActions.map((action) => (
                    <option key={action} value={action}>{successActionLabels[action].label}</option>
                  ))}
                </CustomSelect>
                <p className={styles.helper}>{selectedActionInfo.description}</p>
              </div>

              {agent.successAction === 'book_appointment' && (
                <div className={styles.field}>
                  <label className={styles.label}>Calendario</label>
                  <CustomSelect
                    value={agent.defaultCalendarId || ''}
                    onChange={(event) => onChange({ defaultCalendarId: event.target.value || null })}
                    portal
                  >
                    <option value="">Que elija entre calendarios activos</option>
                    {calendars.map((calendar) => (
                      <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
                    ))}
                  </CustomSelect>
                  <p className={styles.helper}>Sólo agenda con horarios reales.</p>
                </div>
              )}
            </div>

            {agent.objective === 'custom' && (
              <div className={styles.fieldWide}>
                <label className={styles.label}>Meta escrita a mano</label>
                <textarea
                  className={styles.textarea}
                  value={agent.customObjective}
                  placeholder="Ejemplo: que pida una propuesta formal para su empresa."
                  onChange={(event) => onChange({ customObjective: event.target.value })}
                  rows={2}
                />
              </div>
            )}

            <details className={styles.advancedDetails} open={agent.successExtras.length > 0 || undefined}>
              <summary>
                <span>Acciones extra</span>
                <small>Etiquetas o campos cuando cierre.</small>
              </summary>
              <div className={styles.advancedContent}>
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
                  Se ejecutan cuando el agente logra su meta.
                </p>
              </div>
            </details>
          </div>

          <details className={styles.advancedDetails} open={strategyIsCustom || undefined}>
            <summary>
              <span>Estrategia avanzada</span>
              <small>Cómo insiste, pregunta y cierra.</small>
            </summary>
            <div className={styles.advancedContent}>
              <div className={styles.strategyHeaderRow}>
                <label className={styles.label}>Estrategia de cierre</label>
                <span className={`${styles.strategyBadge} ${strategyIsCustom ? styles.strategyBadgeCustom : ''}`}>
                  {strategyIsCustom ? 'Editada' : 'De fábrica'}
                </span>
                {strategyIsCustom && (
                  <button
                    type="button"
                    className={styles.resetStrategyButton}
                    onClick={() => onChange({ closingStrategyMode: 'system', closingStrategyCustom: '' })}
                  >
                    <RotateCcw size={13} />
                    Usar la normal
                  </button>
                )}
              </div>
              <textarea
                className={`${styles.textarea} ${styles.actionTextarea}`}
                value={strategyText}
                onChange={(event) => onChange({ closingStrategyMode: 'custom' as ClosingStrategyMode, closingStrategyCustom: event.target.value })}
                rows={7}
              />
              <p className={styles.helper}>
                {strategyIsCustom
                  ? 'Este agente usa tu versión editada.'
                  : 'Toca aquí sólo si quieres cambiar cómo conversa para cerrar.'}
              </p>
            </div>
          </details>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>4. Qué debe cuidar</h3>
            <div className={styles.agentTextGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Datos que debe pedir</label>
                <textarea
                  className={styles.textarea}
                  value={agent.requiredData}
                  placeholder={'Ejemplo:\n- Nombre completo\n- Servicio que le interesa'}
                  onChange={(event) => onChange({ requiredData: event.target.value })}
                  rows={3}
                />
                <p className={styles.helper}>
                  Si ya lo tiene el contacto, no lo repite.
                </p>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Cuándo pasar al equipo</label>
                <textarea
                  className={styles.textarea}
                  value={agent.handoffRules}
                  placeholder={'Ejemplo:\n- Se enojó\n- Pregunta por facturación'}
                  onChange={(event) => onChange({ handoffRules: event.target.value })}
                  rows={3}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Tips del negocio</label>
                <textarea
                  className={styles.textarea}
                  value={agent.extraInstructions}
                  placeholder="Ejemplo: menciona la promo de junio sólo si preguntan por precio."
                  onChange={(event) => onChange({ extraInstructions: event.target.value })}
                  rows={3}
                />
              </div>
            </div>
            <label className={styles.inlineToggle}>
              <input
                type="checkbox"
                checked={agent.allowEmojis}
                onChange={(event) => onChange({ allowEmojis: event.target.checked })}
              />
              <span>Puede usar emojis si se siente natural</span>
            </label>
          </div>

          <div className={styles.agentSection}>
            <div className={styles.sectionHeading}>
              <Play size={17} />
              <h3 className={styles.sectionTitle}>5. Pruébalo rápido</h3>
            </div>
            <p className={styles.agentSectionHint}>
              Es una prueba: no manda WhatsApp ni mueve contactos.
            </p>

            <div className={styles.testChatBox}>
              {testMessages.length === 0 && (
                <p className={styles.testChatEmpty}>Escribe como prospecto y revisa si contesta como debe.</p>
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
                placeholder="Ejemplo: Hola, quiero agendar"
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

  const handleGlobalChange = async (patch: { enabled?: boolean; hideAttended?: boolean; model?: string }) => {
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
  const selectedModelValue = getKnownAIModel(config?.model || DEFAULT_AI_MODEL)
  const selectedModel = aiModelOptions.find((option) => option.value === selectedModelValue) || aiModelOptions[0]

  return (
    <div className={styles.container}>
      <Card padding="md" className={styles.conversationSettingsCard}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBox}>
              <MessageCircle size={22} />
            </div>
            <div>
              <h2 className={styles.title}>Agente conversacional</h2>
              <p className={styles.description}>
                Decide qué chats contesta, qué debe lograr y cuándo pasarle la bola al equipo.
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

        <div className={styles.conversationSetupGrid}>
          <div className={styles.field}>
            <label className={styles.label}>Modelo para responder</label>
            <CustomSelect
              value={selectedModelValue}
              onChange={(event) => handleGlobalChange({ model: event.target.value })}
              disabled={loading || !config}
              portal
            >
              {aiModelOptionGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </CustomSelect>
            <p className={styles.helper}>
              Usa {selectedModel.label} sólo para chats. El Agente AI general queda aparte.
            </p>
          </div>

          <div className={styles.globalToggleGroup}>
            <label className={`${styles.inlineToggle} ${styles.compactToggle}`}>
              <input
                type="checkbox"
                checked={Boolean(config?.hideAttended)}
                disabled={loading || !config}
                onChange={(event) => handleGlobalChange({ hideAttended: event.target.checked })}
              />
              <span>Ocultar chats que el agente ya está atendiendo</span>
            </label>
            <p className={styles.helper}>Vuelven a aparecer si necesita ayuda o ya cumplió su meta.</p>
          </div>
        </div>
      </Card>

      {loading && (
        <Card>
          <p className={styles.helper}>Cargando agentes...</p>
        </Card>
      )}

      {!loading && agents.length === 0 && (
        <Card>
          <p className={styles.helper}>
            Aún no tienes agentes. Crea uno y dile qué chats debe atender.
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
