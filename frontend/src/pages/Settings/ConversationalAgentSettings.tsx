import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Bot, Brain, ChevronDown, Clock, KeyRound, MessageCircle, Pause, Play, Plus, Power, RotateCcw, Send, Trash2, X } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, Modal, TagPicker } from '@/components/common'
import {
  conversationalAIProviderOptions,
  getConversationalAIProviderOption,
  getConversationalModelLabel,
  getDefaultConversationalModel,
  getKnownConversationalAIProvider,
  getKnownConversationalModel,
  type ConversationalAIProviderId
} from '@/constants/conversationalAIProviders'
import { useNotification } from '@/contexts/NotificationContext'
import { useAIAgentAvailability } from '@/hooks'
import {
  conversationalAgentService,
  type AgentFilterOptions,
  type AgentReplyDeliveryConfig,
  type AgentReplyDeliveryMode,
  type AgentResponseDelayConfig,
  type AgentResponseDelayMode,
  type AgentResponseDelayUnit,
  type AgentSuccessExtra,
  type ClosingStrategyMode,
  type ConversationalAIProviderStatus,
  type ConversationalBusinessPromptStatus,
  type ConversationalAgentConfig,
  type ConversationalAgentDef,
  type ConversationalAgentDefInput,
  type ConversationalAgentMetrics,
  type ConversationalAgentTestResult,
  type ConversationalObjective,
  type ConversationalSuccessAction,
  type SuccessExtraType
} from '@/services/conversationalAgentService'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { ConditionBuilder } from './ConditionBuilder'
import styles from './AIAgentSettings.module.css'

const AUTOSAVE_DELAY_MS = 900
const OMIT_ALL_CONFIRM_TEXT = 'OMITIR TODO'

const objectiveOptions: Array<{ value: ConversationalObjective; label: string; description: string }> = [
  { value: 'citas', label: 'Agendar citas', description: 'Lleva la plática hasta dejar una cita lista.' },
  { value: 'ventas', label: 'Cerrar ventas', description: 'Empuja la conversación hacia una compra real.' },
  { value: 'datos', label: 'Pedir datos', description: 'Pide lo que falta, sin repetir lo que ya sabe.' },
  { value: 'filtrar', label: 'Filtrar curiosos', description: 'Separa gente interesada de quien nomás anda viendo.' },
  { value: 'custom', label: 'Objetivo propio', description: 'Escribe una meta específica para este agente.' }
]

const successActionLabels: Record<ConversationalSuccessAction, { label: string; description: string }> = {
  book_appointment: { label: 'Que agende la IA', description: 'La IA revisa disponibilidad real y agenda cuando la persona confirma horario.' },
  ready_for_human: { label: 'Pasar a un humano', description: 'En el chat aparecerá como prioridad en rojo para que el equipo lo atienda.' },
  ready_to_buy: { label: 'Que mande link de pago', description: 'La IA confirma el cobro y crea el link de pago si el contacto acepta.' },
  internal_signal: { label: 'Pasar a un humano', description: 'En el chat aparecerá como prioridad en rojo para que el equipo lo atienda.' },
  none: { label: 'Pasar a un humano', description: 'En el chat aparecerá como prioridad en rojo para que el equipo lo atienda.' }
}

const actionsByObjective: Record<ConversationalObjective, ConversationalSuccessAction[]> = {
  citas: ['ready_for_human', 'book_appointment'],
  ventas: ['ready_for_human', 'ready_to_buy'],
  datos: ['ready_for_human'],
  filtrar: ['ready_for_human'],
  custom: ['ready_for_human']
}

const extraTypeOptions: Array<{ value: SuccessExtraType; label: string }> = [
  { value: 'add_tag', label: 'Agregar etiqueta' },
  { value: 'remove_tag', label: 'Quitar etiqueta' },
  { value: 'set_custom_field', label: 'Cambiar campo personalizado' }
]

const responseDelayModeOptions: Array<{ value: AgentResponseDelayMode; label: string }> = [
  { value: 'none', label: 'No esperar' },
  { value: 'fixed', label: 'Esperar tiempo fijo' },
  { value: 'random', label: 'Aleatorio en un rango' }
]

const responseDelayUnitOptions: Array<{ value: AgentResponseDelayUnit; label: string }> = [
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' }
]

const defaultResponseDelay: AgentResponseDelayConfig = {
  mode: 'none',
  fixedValue: 10,
  fixedUnit: 'seconds',
  minValue: 1,
  maxValue: 10,
  rangeUnit: 'minutes'
}

const defaultReplyDelivery: AgentReplyDeliveryConfig = {
  mode: 'single',
  splitMessagesEnabled: false,
  minMessageLengthToSplit: 120,
  maxBubbles: 6,
  minBubbleLength: 20,
  maxBubbleLength: 350,
  targetChars: 350,
  randomizeSplitting: true,
  delayBetweenBubblesEnabled: true,
  minDelaySeconds: 2,
  maxDelaySeconds: 7
}

const systemReplyDeliveryDefaults: Pick<
  AgentReplyDeliveryConfig,
  'minMessageLengthToSplit' | 'maxBubbles' | 'minBubbleLength' | 'maxBubbleLength' | 'targetChars' | 'randomizeSplitting' | 'delayBetweenBubblesEnabled'
> = {
  minMessageLengthToSplit: defaultReplyDelivery.minMessageLengthToSplit,
  maxBubbles: defaultReplyDelivery.maxBubbles,
  minBubbleLength: defaultReplyDelivery.minBubbleLength,
  maxBubbleLength: defaultReplyDelivery.maxBubbleLength,
  targetChars: defaultReplyDelivery.targetChars,
  randomizeSplitting: true,
  delayBetweenBubblesEnabled: true
}

type TestMessage = { role: 'user' | 'assistant'; content: string; internal?: boolean }

const MAX_TEST_REPLY_DELAY_MS = 60_000

function normalizeTestReplyDelay(value: unknown) {
  const delayMs = Number(value)
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.min(Math.round(delayMs), MAX_TEST_REPLY_DELAY_MS)
}

function waitForTestReplyDelay(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
}

function agentToInput(agent: ConversationalAgentDef): ConversationalAgentDefInput {
  const { id: _id, createdAt: _c, updatedAt: _u, systemClosingStrategy: _s, ...rest } = agent
  return rest
}

function getAgentResponseDelay(agent: ConversationalAgentDef): AgentResponseDelayConfig {
  return { ...defaultResponseDelay, ...((agent.responseDelay || {}) as Partial<AgentResponseDelayConfig>) }
}

function getAgentReplyDelivery(agent: ConversationalAgentDef): AgentReplyDeliveryConfig {
  return { ...defaultReplyDelivery, ...((agent.replyDelivery || {}) as Partial<AgentReplyDeliveryConfig>) }
}

function getDelayUnitLabel(unit: AgentResponseDelayUnit, value: number) {
  if (unit === 'minutes') return Number(value) === 1 ? 'minuto' : 'minutos'
  return Number(value) === 1 ? 'segundo' : 'segundos'
}

function getResponseDelaySummary(delay: AgentResponseDelayConfig) {
  if (delay.mode === 'fixed') {
    return `${delay.fixedValue} ${getDelayUnitLabel(delay.fixedUnit, delay.fixedValue)}`
  }
  if (delay.mode === 'random') {
    return `${delay.minValue} a ${delay.maxValue} ${getDelayUnitLabel(delay.rangeUnit, delay.maxValue)}`
  }
  return ''
}

function getResponseDelayHelp(delay: AgentResponseDelayConfig) {
  if (delay.mode === 'fixed') {
    return `Espera ${getResponseDelaySummary(delay)} antes de enviar el mensaje.`
  }
  if (delay.mode === 'random') {
    return `Escoge un tiempo entre ${getResponseDelaySummary(delay)} para que las respuestas no salgan siempre igual.`
  }
  return 'Contesta en cuanto termina de preparar la respuesta y agrupar mensajes recientes.'
}

function getReplyDeliveryHelp(delivery: AgentReplyDeliveryConfig) {
  if (delivery.splitMessagesEnabled || delivery.mode === 'split') {
    return `El sistema decide cortes y cantidad de globos. Sólo ajusta la pausa entre globos: ${delivery.minDelaySeconds} a ${delivery.maxDelaySeconds} segundos.`
  }
  return 'Envía cada respuesta completa en un solo WhatsApp.'
}

function isBusinessPromptReady(status?: ConversationalBusinessPromptStatus | null) {
  return Boolean(status?.ready)
}

function getBusinessPromptStatusText(status?: ConversationalBusinessPromptStatus | null) {
  if (status?.ready) {
    const business = [status.businessName, status.industry].filter(Boolean).join(' · ')
    return business ? `Adaptada a ${business}` : 'Prompt interno listo'
  }
  if (!status || status.status === 'empty') return 'Falta describir el negocio'
  if (status.status === 'needs_more_context') return 'Falta más contexto del negocio'
  if (status.status === 'needs_openai') return 'Falta preparar el prompt con OpenAI'
  if (status.status === 'failed') return 'No se pudo preparar el prompt'
  return 'Preparando prompt interno'
}

function getBusinessPromptBlockerText(status?: ConversationalBusinessPromptStatus | null) {
  if (status?.ready) return ''
  if (status?.extractionError) return status.extractionError
  if (!status || status.status === 'empty') {
    return 'Antes de publicar agentes, describe el negocio en Agente AI para que Ristak parametrice el guión de fábrica.'
  }
  if (status.status === 'needs_more_context') {
    return 'Agrega más detalle del negocio: qué vende, a quién atiende, cómo opera y qué debe evitar.'
  }
  if (status.status === 'needs_openai') {
    return 'Conecta OpenAI y guarda la descripción del negocio para generar el prompt interno.'
  }
  if (status.status === 'failed') {
    return 'Vuelve a guardar la descripción del negocio para regenerar la estrategia interna.'
  }
  return 'Ristak está preparando el prompt interno. Espera a que quede listo antes de publicar.'
}

interface SelectionToggleProps {
  checked: boolean
  title: string
  description?: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}

const SelectionToggle: React.FC<SelectionToggleProps> = ({ checked, title, description, disabled, onChange }) => (
  <label className={`${styles.selectionToggle} ${checked ? styles.selectionToggleChecked : ''} ${disabled ? styles.selectionToggleDisabled : ''}`}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className={styles.selectionToggleCopy}>
      <strong>{title}</strong>
      {description && <small>{description}</small>}
    </span>
  </label>
)

interface AgentCardProps {
  agent: ConversationalAgentDef
  aiProviders: ConversationalAIProviderStatus[]
  calendars: Calendar[]
  filterOptions?: AgentFilterOptions
  systemStrategy: string
  businessPromptStatus?: ConversationalBusinessPromptStatus | null
  onConnectProvider: (providerId: ConversationalAIProviderId) => void
  onBack: () => void
  onChange: (patch: ConversationalAgentDefInput) => void
  onDelete: () => void
}

function getProviderStatus(aiProviders: ConversationalAIProviderStatus[], providerId: ConversationalAIProviderId) {
  return aiProviders.find((provider) => provider.id === providerId) || null
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, aiProviders, calendars, filterOptions, systemStrategy, businessPromptStatus, onConnectProvider, onBack, onChange, onDelete }) => {
  const { showToast } = useNotification()
  const [testMessages, setTestMessages] = useState<TestMessage[]>([])
  const [testInput, setTestInput] = useState('')
  const [testing, setTesting] = useState(false)

  const allowedActions = actionsByObjective[agent.objective] || actionsByObjective.custom
  const selectedObjective = objectiveOptions.find((option) => option.value === agent.objective) || objectiveOptions[0]
  const selectedActionInfo = successActionLabels[agent.successAction] || successActionLabels.ready_for_human
  const selectedProviderId = getKnownConversationalAIProvider(agent.aiProvider)
  const selectedProvider = getConversationalAIProviderOption(selectedProviderId)
  const selectedProviderStatus = getProviderStatus(aiProviders, selectedProviderId)
  const selectedProviderConnected = Boolean(selectedProviderStatus?.connected)
  const selectedAgentModelValue = getKnownConversationalModel(selectedProviderId, agent.model)
  const selectedAgentModel = selectedProvider.modelGroups
    .flatMap((group) => group.options)
    .find((option) => option.value === selectedAgentModelValue)
  const strategyIsCustom = agent.closingStrategyMode === 'custom'
  const strategyText = strategyIsCustom ? agent.closingStrategyCustom : agent.systemClosingStrategy || systemStrategy
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptStatusText = getBusinessPromptStatusText(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)
  const entryCount = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
  const exitCount = agent.filters.exit.groups.reduce((total, group) => total + group.conditions.length, 0)
  const customFieldOptions = filterOptions?.customFields || []
  const responseDelay = getAgentResponseDelay(agent)
  const responseDelaySummary = getResponseDelaySummary(responseDelay)
  const replyDelivery = getAgentReplyDelivery(agent)
  const hasTestConversation = testMessages.length > 0 || Boolean(testInput.trim())

  const updateExtra = (index: number, patch: Partial<AgentSuccessExtra>) => {
    onChange({ successExtras: agent.successExtras.map((extra, i) => (i === index ? { ...extra, ...patch } : extra)) })
  }

  const updateResponseDelay = (patch: Partial<AgentResponseDelayConfig>) => {
    onChange({ responseDelay: { ...responseDelay, ...patch } })
  }

  const updateReplyDelivery = (patch: Partial<AgentReplyDeliveryConfig>) => {
    onChange({ replyDelivery: { ...replyDelivery, ...patch } })
  }

  const handleProviderSelect = (providerId: ConversationalAIProviderId) => {
    const status = getProviderStatus(aiProviders, providerId)
    if (!status?.connected) {
      onConnectProvider(providerId)
      return
    }

    const currentProvider = getKnownConversationalAIProvider(agent.aiProvider)
    onChange({
      aiProvider: providerId,
      model: getKnownConversationalModel(
        providerId,
        currentProvider === providerId ? agent.model : getDefaultConversationalModel(providerId)
      )
    })
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

      for (const action of result.actions || []) {
        setTestMessages((current) => [...current, { role: 'assistant', content: `⚙︎ Acción interna: ${action.type}`, internal: true }])
      }

      const visibleReplies = result.replyParts?.length ? result.replyParts : (result.reply ? [result.reply] : [])
      if (visibleReplies.length) {
        for (let index = 0; index < visibleReplies.length; index += 1) {
          const delayMs = normalizeTestReplyDelay(result.replyPartDelaysMs?.[index])
          if (index > 0 && delayMs > 0) {
            await waitForTestReplyDelay(delayMs)
          }
          setTestMessages((current) => [...current, { role: 'assistant', content: visibleReplies[index] }])
        }
      } else if (result.suppressed) {
        setTestMessages((current) => [...current, { role: 'assistant', content: '⚙︎ El agente decidió no responder (acción interna o silencio).', internal: true }])
      }
    } catch (error: any) {
      showToast('error', 'Prueba fallida', error?.message || 'No se pudo probar el agente')
    } finally {
      setTesting(false)
    }
  }

  const handleResetTestChat = () => {
    if (testing) return
    setTestMessages([])
    setTestInput('')
  }

  return (
    <Card padding="md" className={styles.conversationAgentCard}>
      <div className={styles.agentDetailTopbar}>
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={16} />
          Volver
        </Button>
        <div className={styles.agentStickyActions}>
          <Badge variant={agent.enabled ? 'success' : 'neutral'}>
            {agent.enabled ? 'Publicado' : 'En pausa'}
          </Badge>
          <Button
            variant={agent.enabled ? 'secondary' : 'primary'}
            onClick={() => onChange({ enabled: !agent.enabled })}
            disabled={!agent.enabled && !businessPromptReady}
            title={!agent.enabled && !businessPromptReady ? promptBlockerText : undefined}
          >
            {agent.enabled ? <Pause size={16} /> : <Play size={16} />}
            {agent.enabled ? 'Pausar' : 'Publicar'}
          </Button>
        </div>
      </div>

      <div className={styles.agentDetailLayout}>
        <div className={styles.agentConfigColumn}>
          <div className={styles.agentCardHeader}>
            <span className={`${styles.iconBox} ${agent.enabled ? '' : styles.iconBoxMuted}`}>
              <Bot size={20} />
            </span>
            <input
              className={styles.agentNameInput}
              value={agent.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Nombre del agente"
              aria-label="Nombre del agente"
            />
            <div className={styles.agentCardActions}>
              <button type="button" className={styles.iconButton} onClick={onDelete} aria-label={`Eliminar ${agent.name}`}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <p className={styles.agentCardSummary}>
            {selectedObjective.label} · {selectedActionInfo.label}
            {entryCount > 0
              ? ` · entra con ${entryCount} ${entryCount === 1 ? 'regla' : 'reglas'}`
              : ' · entra con cualquier chat'}
            {exitCount > 0 ? ` · se suelta con ${exitCount}` : ''}
            {responseDelaySummary ? ` · espera ${responseDelaySummary}` : ''}
            {replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split' ? ' · responde en partes' : ''}
          </p>
          {!businessPromptReady && (
            <div className={styles.promptReadinessNotice}>
              <strong>{promptStatusText}</strong>
              <span>{promptBlockerText}</span>
            </div>
          )}

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Modelo y orden del chat</h3>
            <div className={styles.agentOpsGrid}>
              <div className={styles.aiProviderSettings}>
                <div className={styles.field}>
                  <label className={styles.label}>IA que responde</label>
                  <CustomSelect
                    value={selectedProviderId}
                    onChange={(event) => handleProviderSelect(getKnownConversationalAIProvider(event.target.value))}
                    portal
                    aria-label="IA del agente"
                  >
                    {conversationalAIProviderOptions.map((provider) => {
                      const status = getProviderStatus(aiProviders, provider.id)
                      const connected = Boolean(status?.connected)
                      return (
                        <option key={provider.id} value={provider.id}>
                          {provider.label} · {connected ? 'Conectado' : 'Toca para conectar'}
                        </option>
                      )
                    })}
                  </CustomSelect>
                  <div className={styles.aiProviderSelectMeta}>
                    <Badge variant={selectedProviderConnected ? 'success' : 'neutral'}>
                      {selectedProviderConnected ? 'Conectado' : 'Toca para conectar'}
                    </Badge>
                    <span>{selectedProvider.description}</span>
                  </div>
                  {selectedProviderStatus?.needsReconnect && (
                    <p className={styles.helperWarning}>{selectedProviderStatus.connectionIssue || `${selectedProvider.label} necesita reconectarse.`}</p>
                  )}
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Modelo de {selectedProvider.label}</label>
                  <CustomSelect
                    value={selectedAgentModelValue}
                    onChange={(event) => onChange({ model: event.target.value })}
                    portal
                  >
                    {selectedProvider.modelGroups.map((group) => (
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
                    {(selectedAgentModel?.label || selectedAgentModelValue)} responde sólo para este agente.
                  </p>
                </div>
              </div>

              <div className={styles.agentOpsToggles}>
                <SelectionToggle
                  checked={agent.hideAttended}
                  title="Ocultar conversaciones atendidas"
                  description="Sólo aplica a conversaciones que este agente esté atendiendo."
                  onChange={(checked) => onChange({ hideAttended: checked })}
                />
                <SelectionToggle
                  checked={agent.hideAttendedNotifications}
                  title="Silenciar notificaciones atendidas"
                  description="Sin avisos mientras responde; si cumple el objetivo, manda push de prioridad."
                  onChange={(checked) => onChange({ hideAttendedNotifications: checked })}
                />
              </div>
            </div>
          </div>

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

            <div className={styles.agentNestedSection}>
              <div className={styles.agentSubsectionHeader}>
                <h4>Cuándo se sale</h4>
                <span>Opcional</span>
              </div>
              <p className={styles.agentSectionHint}>
                Úsalo si quieres que deje de contestar cuando pase algo, como cita agendada o etiqueta puesta.
              </p>
              <ConditionBuilder
                groups={agent.filters.exit.groups}
                mode="exit"
                calendars={calendars}
                options={filterOptions}
                emptyText="Opcional: si no agregas reglas, el agente no se suelta solo por filtros."
                onChange={(groups) => onChange({ filters: { ...agent.filters, exit: { groups } } })}
              />
            </div>
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>2. Qué tiene que lograr</h3>
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
                        <select
                          className={styles.ruleSelect}
                          value={extra.field || ''}
                          onChange={(event) => updateExtra(index, { field: event.target.value })}
                        >
                          <option value="">
                            {customFieldOptions.length ? 'Elige el campo' : 'No hay campos personalizados activos'}
                          </option>
                          {extra.field && !customFieldOptions.some((field) => field.key === extra.field) && (
                            <option value={extra.field}>{extra.field} · guardado</option>
                          )}
                          {customFieldOptions.map((field) => (
                            <option key={field.key} value={field.key}>{field.label}</option>
                          ))}
                        </select>
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
              <small>{strategyIsCustom ? 'Editada a mano' : promptStatusText}</small>
            </summary>
            <div className={styles.advancedContent}>
              <div className={styles.strategyHeaderRow}>
                <label className={styles.label}>Estrategia de cierre</label>
                <span className={`${styles.strategyBadge} ${strategyIsCustom ? styles.strategyBadgeCustom : businessPromptReady ? styles.strategyBadgeReady : styles.strategyBadgeLocked}`}>
                  {strategyIsCustom ? 'Editada' : businessPromptReady ? 'Adaptada' : 'Pendiente'}
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
              {!strategyIsCustom && (
                <div className={`${styles.strategyPromptState} ${businessPromptReady ? styles.strategyPromptStateReady : styles.strategyPromptStateLocked}`}>
                  <strong>{promptStatusText}</strong>
                  <span>
                    {businessPromptReady
                      ? 'La estrategia de fábrica ya cambió con los datos actuales del negocio.'
                      : promptBlockerText}
                  </span>
                </div>
              )}
              <textarea
                className={`${styles.textarea} ${styles.actionTextarea}`}
                value={strategyText}
                onChange={(event) => onChange({ closingStrategyMode: 'custom' as ClosingStrategyMode, closingStrategyCustom: event.target.value })}
                rows={7}
              />
              <p className={styles.helper}>
                {strategyIsCustom
                  ? 'Este agente usa tu versión editada.'
                  : businessPromptReady
                    ? 'Esta vista ya incluye el lenguaje, giro y encuadre actual del negocio. Si cambias la descripción en Agente AI, se vuelve a preparar.'
                    : 'Primero completa la descripción del negocio para ver el guión parametrizado.'}
              </p>
            </div>
          </details>

          <div className={styles.agentSection}>
            <div className={styles.sectionHeading}>
              <Clock size={17} />
              <h3 className={styles.sectionTitle}>3. Cuándo responde</h3>
            </div>
            <p className={styles.agentSectionHint}>
              Controla si responde al instante, espera un tiempo fijo o usa una pausa aleatoria para sentirse más natural.
            </p>
            <div className={styles.responseDelayGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Espera</label>
                <CustomSelect
                  value={responseDelay.mode}
                  onChange={(event) => updateResponseDelay({ mode: event.target.value as AgentResponseDelayMode })}
                  portal
                >
                  {responseDelayModeOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>

              {responseDelay.mode === 'fixed' && (
                <div className={styles.responseDelayControls}>
                  <div className={`${styles.field} ${styles.delayNumberField}`}>
                    <label className={styles.label}>Tiempo</label>
                    <input
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      type="number"
                      min={0}
                      step={1}
                      value={responseDelay.fixedValue}
                      onChange={(event) => updateResponseDelay({ fixedValue: Number(event.target.value) || 0 })}
                    />
                  </div>
                  <div className={`${styles.field} ${styles.delayUnitField}`}>
                    <label className={styles.label}>Unidad</label>
                    <CustomSelect
                      value={responseDelay.fixedUnit}
                      onChange={(event) => updateResponseDelay({ fixedUnit: event.target.value as AgentResponseDelayUnit })}
                      portal
                    >
                      {responseDelayUnitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                </div>
              )}

              {responseDelay.mode === 'random' && (
                <div className={styles.responseDelayControls}>
                  <div className={`${styles.field} ${styles.delayNumberField}`}>
                    <label className={styles.label}>Mínimo</label>
                    <input
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      type="number"
                      min={0}
                      step={1}
                      value={responseDelay.minValue}
                      onChange={(event) => updateResponseDelay({ minValue: Number(event.target.value) || 0 })}
                    />
                  </div>
                  <div className={`${styles.field} ${styles.delayNumberField}`}>
                    <label className={styles.label}>Máximo</label>
                    <input
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      type="number"
                      min={0}
                      step={1}
                      value={responseDelay.maxValue}
                      onChange={(event) => updateResponseDelay({ maxValue: Number(event.target.value) || 0 })}
                    />
                  </div>
                  <div className={`${styles.field} ${styles.delayUnitField}`}>
                    <label className={styles.label}>Unidad</label>
                    <CustomSelect
                      value={responseDelay.rangeUnit}
                      onChange={(event) => updateResponseDelay({ rangeUnit: event.target.value as AgentResponseDelayUnit })}
                      portal
                    >
                      {responseDelayUnitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                </div>
              )}

              <p className={`${styles.helper} ${styles.responseDelayHelp}`}>{getResponseDelayHelp(responseDelay)}</p>
            </div>
            <div className={styles.replyDeliveryGrid}>
              <SelectionToggle
                checked={replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split'}
                title="Modo mensajes humanos"
                description="Parte respuestas largas en varios globos."
                onChange={(enabled) => {
                  updateReplyDelivery({
                    mode: (enabled ? 'split' : 'single') as AgentReplyDeliveryMode,
                    splitMessagesEnabled: enabled,
                    ...systemReplyDeliveryDefaults
                  })
                }}
              />

              {(replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split') && (
                <div className={styles.replyDeliveryControls}>
                  <div className={`${styles.field} ${styles.delayNumberField}`}>
                    <label className={styles.label}>Pausa mín.</label>
                    <input
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={replyDelivery.minDelaySeconds}
                      onChange={(event) => updateReplyDelivery({ minDelaySeconds: Number(event.target.value) || 0 })}
                    />
                  </div>
                  <div className={`${styles.field} ${styles.delayNumberField}`}>
                    <label className={styles.label}>Pausa máx.</label>
                    <input
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={replyDelivery.maxDelaySeconds}
                      onChange={(event) => updateReplyDelivery({ maxDelaySeconds: Number(event.target.value) || 0 })}
                    />
                  </div>
                </div>
              )}

              <p className={`${styles.helper} ${styles.responseDelayHelp}`}>{getReplyDeliveryHelp(replyDelivery)}</p>
            </div>
          </div>

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
            <SelectionToggle
              checked={agent.allowEmojis}
              title="Puede usar emojis si se siente natural"
              description="Déjalo apagado si quieres un tono más serio."
              onChange={(checked) => onChange({ allowEmojis: checked })}
            />
          </div>

        </div>

        <aside className={styles.agentTestColumn}>
          <div className={styles.agentTestPanel}>
            <div className={styles.testPhoneFrame} aria-label="Vista previa de chat en celular">
              <span className={styles.testPhoneIsland} aria-hidden="true" />
              <div className={styles.testPhoneScreen}>
                <div className={styles.testChatTopbar}>
                  <div className={styles.agentTestHeader}>
                    <div className={styles.sectionHeading}>
                      <Play size={17} />
                      <h3 className={styles.sectionTitle}>Prueba del chat</h3>
                    </div>
                    <p className={styles.agentSectionHint}>
                      Es una prueba: no manda WhatsApp ni mueve contactos.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    leftIcon={<RotateCcw size={14} />}
                    className={styles.testChatResetButton}
                    onClick={handleResetTestChat}
                    disabled={testing || !hasTestConversation}
                    title="Reiniciar chat de prueba"
                    aria-label="Reiniciar chat de prueba"
                  >
                    Reiniciar
                  </Button>
                </div>

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
                  <Button
                    type="button"
                    variant="secondary"
                    className={styles.testChatSendButton}
                    onClick={handleSendTestMessage}
                    disabled={testing || !testInput.trim()}
                    title="Enviar mensaje de prueba"
                    aria-label="Enviar mensaje de prueba"
                  >
                    <Send size={14} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </Card>
  )
}

export const ConversationalAgentSettings: React.FC = () => {
  const navigate = useNavigate()
  const { showToast, showConfirm } = useNotification()
  const openAIAvailability = useAIAgentAvailability()
  const [config, setConfig] = useState<ConversationalAgentConfig | null>(null)
  const [agents, setAgents] = useState<ConversationalAgentDef[]>([])
  const [aiProviders, setAIProviders] = useState<ConversationalAIProviderStatus[]>([])
  const [metrics, setMetrics] = useState<ConversationalAgentMetrics | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [filterOptions, setFilterOptions] = useState<AgentFilterOptions | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [providerModalId, setProviderModalId] = useState<ConversationalAIProviderId | null>(null)
  const [aiProvidersExpanded, setAIProvidersExpanded] = useState(false)
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  const agentsRef = useRef<ConversationalAgentDef[]>([])
  const businessProfileVersion = [
    openAIAvailability.businessProfile?.updatedAt || '',
    openAIAvailability.businessProfile?.extractionStatus || openAIAvailability.businessProfile?.status || '',
    openAIAvailability.businessProfile?.businessName || '',
    openAIAvailability.businessProfile?.industry || ''
  ].join('|')
  agentsRef.current = agents

  const refreshMetrics = useCallback(async () => {
    try {
      const nextMetrics = await conversationalAgentService.getMetrics()
      setMetrics(nextMetrics)
    } catch {
      // La configuración sigue funcionando; las métricas se reintentan al recargar.
    }
  }, [])

  const refreshAgentData = useCallback(async () => {
    const [nextConfig, nextAgents, nextProviders] = await Promise.all([
      conversationalAgentService.getConfig(),
      conversationalAgentService.listAgents(),
      conversationalAgentService.listAIProviders()
    ])
    setConfig(nextConfig)
    setAgents(nextAgents)
    setAIProviders(nextConfig.aiProviders || nextProviders)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (openAIAvailability.loading) return
      if (!openAIAvailability.configured) {
        setConfig(null)
        setAgents([])
        setAIProviders([])
        setMetrics(null)
        setCalendars([])
        setFilterOptions(undefined)
        setSelectedAgentId(null)
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const [nextConfig, nextAgents, nextProviders, nextMetrics, calendarList, nextOptions] = await Promise.all([
          conversationalAgentService.getConfig(),
          conversationalAgentService.listAgents(),
          conversationalAgentService.listAIProviders(),
          conversationalAgentService.getMetrics().catch(() => null),
          calendarsService.getCalendars(),
          conversationalAgentService.getFilterOptions().catch(() => undefined)
        ])
        if (cancelled) return
        setConfig(nextConfig)
        setAgents(nextAgents)
        setAIProviders(nextConfig.aiProviders || nextProviders)
        setMetrics(nextMetrics)
        setCalendars(calendarList.filter((cal) => cal.isActive !== false))
        setFilterOptions(nextOptions)
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
  }, [businessProfileVersion, openAIAvailability.configured, openAIAvailability.loading, showToast])

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

  const businessPromptStatus = config?.businessPromptStatus || null
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptStatusText = getBusinessPromptStatusText(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)

  const handleAgentChange = (agentId: string, patch: ConversationalAgentDefInput) => {
    if (patch.enabled === true && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    setAgents((current) => current.map((agent) => (agent.id === agentId ? { ...agent, ...patch } as ConversationalAgentDef : agent)))
    scheduleAgentSave(agentId)
    if (patch.enabled === true && config && !config.enabled) {
      void handleGlobalChange({ enabled: true })
    }
  }

  const handleGlobalChange = async (patch: { enabled?: boolean }) => {
    if (patch.enabled === true && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    try {
      const next = await conversationalAgentService.saveConfig(patch)
      setConfig(next)
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración')
    }
  }

  const openProviderModal = (providerId: ConversationalAIProviderId) => {
    if (providerId === 'openai') {
      navigate('/ai-agent/general')
      return
    }
    setProviderModalId(providerId)
    setProviderApiKey('')
  }

  const closeProviderModal = () => {
    if (providerSaving) return
    setProviderModalId(null)
    setProviderApiKey('')
  }

  const handleSaveProviderKey = async () => {
    if (!providerModalId) return
    const cleanKey = providerApiKey.trim()
    if (!cleanKey) {
      showToast('warning', 'Falta la API key', 'Pega la llave para conectar esta IA.')
      return
    }
    setProviderSaving(true)
    try {
      const providers = await conversationalAgentService.connectAIProvider(providerModalId, cleanKey)
      setAIProviders(providers)
      const provider = getConversationalAIProviderOption(providerModalId)
      setProviderModalId(null)
      setProviderApiKey('')
      showToast('success', `${provider.label} conectado`, 'Ya puedes elegirlo en tus agentes conversacionales.')
    } catch (error: any) {
      showToast('error', 'No se pudo conectar', error?.message || 'Revisa la API key.')
    } finally {
      setProviderSaving(false)
    }
  }

  const handleDeleteProvider = (providerId: ConversationalAIProviderId) => {
    const provider = getConversationalAIProviderOption(providerId)
    showConfirm(
      `Eliminar ${provider.label}`,
      `Los agentes que usen ${provider.label} volverán a OpenAI para que no se queden sin responder.`,
      async () => {
        try {
          const providers = await conversationalAgentService.deleteAIProvider(providerId)
          setAIProviders(providers)
          await refreshAgentData()
          void refreshMetrics()
          showToast('success', `${provider.label} eliminado`, 'La conexión quedó borrada.')
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error?.message || 'Inténtalo otra vez.')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const handleCreateAgent = async () => {
    if (!businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    setCreating(true)
    try {
      const defaultProvider = getKnownConversationalAIProvider(config?.aiProvider)
      const agent = await conversationalAgentService.createAgent({
        name: `Agente ${agents.length + 1}`,
        aiProvider: defaultProvider,
        model: getKnownConversationalModel(defaultProvider, config?.model || getDefaultConversationalModel(defaultProvider))
      })
      if (config && !config.enabled) {
        const nextConfig = await conversationalAgentService.saveConfig({ enabled: true })
        setConfig(nextConfig)
      }
      setAgents((current) => [...current, agent])
      setSelectedAgentId(agent.id)
      void refreshMetrics()
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
          setSelectedAgentId((current) => (current === agent.id ? null : current))
          void refreshMetrics()
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error?.message || 'Error al eliminar el agente')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const handleOmitAll = () => {
    showConfirm(
      'Omitir todo',
      'Esto apaga el agente conversacional y desactiva todos los agentes configurados. Las conversaciones dejan de responderse por IA hasta que vuelvas a activar un agente.',
      async () => {
        try {
          saveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
          saveTimersRef.current.clear()
          const nextConfig = await conversationalAgentService.saveConfig({ enabled: false })
          const updatedAgents = await Promise.all(
            agentsRef.current.map((agent) => conversationalAgentService.updateAgent(agent.id, { enabled: false }))
          )
          setConfig(nextConfig)
          setAgents(updatedAgents)
          setSelectedAgentId(null)
          void refreshMetrics()
          showToast('success', 'Agente conversacional', 'Todo quedó omitido y apagado.')
        } catch (error: any) {
          showToast('error', 'No se pudo omitir todo', error?.message || 'Inténtalo otra vez.')
        }
      },
      'Omitir todo',
      'Cancelar',
      undefined,
      { typeToConfirm: OMIT_ALL_CONFIRM_TEXT }
    )
  }

  const systemStrategy = config?.systemClosingStrategy || ''
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) || null : null
  const activeAgentsCount = agents.filter((agent) => agent.enabled).length
  const metricsByAgentId = new Map((metrics?.byAgent || []).map((item) => [item.agentId, item]))
  const assignedConversations = metrics?.assignedConversations ?? 0
  const busyAgents = metrics?.agentsWithAssignedConversations ?? 0
  const completedConversations = metrics?.completedConversations ?? 0
  const errorEvents = metrics?.errorEvents ?? 0
  const successRate = metrics?.successRate ?? 0
  const connectedAIProviderCount = aiProviders.filter((provider) => provider.connected).length
  const connectedAIProviderLabel = connectedAIProviderCount === 1 ? '1 conectada' : `${connectedAIProviderCount} conectadas`
  const providerModalOption = providerModalId ? getConversationalAIProviderOption(providerModalId) : null
  const renderProviderModal = () => (
    <Modal
      isOpen={Boolean(providerModalOption)}
      onClose={closeProviderModal}
      title={providerModalOption ? `Conectar ${providerModalOption.label}` : 'Conectar IA'}
      size="md"
    >
      {providerModalOption && (
        <div className={styles.aiProviderModalBody}>
          <p className={styles.helper}>
            Pega la API key de {providerModalOption.label}. Se guarda cifrada y sólo se usa para el agente conversacional.
          </p>
          <div className={styles.field}>
            <label className={styles.label}>API key</label>
            <input
              className={styles.input}
              type="password"
              value={providerApiKey}
              placeholder={`API key de ${providerModalOption.label}`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setProviderApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSaveProviderKey()
                }
              }}
              disabled={providerSaving}
            />
          </div>
          <div className={styles.aiProviderModalActions}>
            <Button variant="secondary" onClick={closeProviderModal} disabled={providerSaving}>
              Cancelar
            </Button>
            <Button onClick={handleSaveProviderKey} loading={providerSaving} disabled={providerSaving || !providerApiKey.trim()}>
              <KeyRound size={16} />
              Conectar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )

  if (openAIAvailability.loading) {
    return (
      <div className={styles.container}>
        <Card>
          <p className={styles.helper}>Revisando OpenAI...</p>
        </Card>
      </div>
    )
  }

  if (!openAIAvailability.configured) {
    return (
      <div className={styles.container}>
        <Card padding="md" className={styles.conversationSettingsCard}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <div className={styles.iconBox}>
                <KeyRound size={22} />
              </div>
              <div>
                <h2 className={styles.title}>Conecta OpenAI primero</h2>
                <p className={styles.description}>
                  El agente conversacional, sus pruebas y sus respuestas quedan bloqueados hasta que guardes un token válido.
                </p>
              </div>
            </div>
            <div className={styles.headerActions}>
              <Button onClick={() => navigate('/ai-agent/general')}>
                <KeyRound size={16} />
                Configurar token
              </Button>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (selectedAgent) {
    return (
      <div className={styles.container}>
        <AgentCard
          agent={selectedAgent}
          aiProviders={aiProviders}
          calendars={calendars}
          filterOptions={filterOptions}
          systemStrategy={systemStrategy}
          businessPromptStatus={businessPromptStatus}
          onConnectProvider={openProviderModal}
          onBack={() => setSelectedAgentId(null)}
          onChange={(patch) => handleAgentChange(selectedAgent.id, patch)}
          onDelete={() => handleDeleteAgent(selectedAgent)}
        />
        {renderProviderModal()}
      </div>
    )
  }

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
                Crea agentes separados, cada uno con su modelo, objetivo y reglas de atención.
              </p>
            </div>
          </div>
          <div className={styles.headerActions}>
            {!config?.enabled && (
              <Button
                variant="secondary"
                onClick={() => handleGlobalChange({ enabled: true })}
                disabled={loading || !config || !businessPromptReady}
                title={!businessPromptReady ? promptBlockerText : undefined}
              >
                <Bot size={16} />
                Reactivar
              </Button>
            )}
            <Button variant="danger" onClick={handleOmitAll} disabled={loading || !config || (!agents.length && !config.enabled)}>
              <Power size={16} />
              Omitir todo
            </Button>
            <Button
              onClick={handleCreateAgent}
              loading={creating}
              disabled={loading || creating || !businessPromptReady}
              title={!businessPromptReady ? promptBlockerText : undefined}
            >
              <Plus size={16} />
              Nuevo agente
            </Button>
          </div>
        </div>

        <div className={`${styles.promptReadinessBanner} ${businessPromptReady ? styles.promptReadinessBannerReady : styles.promptReadinessBannerLocked}`}>
          <strong>{promptStatusText}</strong>
          <span>
            {businessPromptReady
              ? 'La estrategia avanzada de fábrica ya está parametrizada con la descripción actual del negocio.'
              : promptBlockerText}
          </span>
        </div>

        <div className={styles.aiProviderManager}>
          <div className={styles.aiProviderManagerHeader}>
            <div className={styles.sectionHeading}>
              <Brain size={17} />
              <h3 className={styles.sectionTitle}>IAs conectadas</h3>
            </div>
            <div className={styles.aiProviderManagerActions}>
              <span className={styles.aiProviderManagerSummary}>
                {conversationalAIProviderOptions.length} IAs disponibles · {connectedAIProviderLabel}
              </span>
              <Button
                variant="secondary"
                size="sm"
                className={styles.aiProviderManagerToggle}
                onClick={() => setAIProvidersExpanded((current) => !current)}
                aria-expanded={aiProvidersExpanded}
                aria-controls="conversational-ai-provider-list"
              >
                {aiProvidersExpanded ? 'Ocultar IAs' : 'Ver IAs'}
                <ChevronDown
                  size={15}
                  className={`${styles.aiProviderManagerToggleIcon} ${aiProvidersExpanded ? styles.aiProviderManagerToggleIconOpen : ''}`}
                />
              </Button>
            </div>
          </div>
          {aiProvidersExpanded && (
            <div id="conversational-ai-provider-list" className={styles.aiProviderManagerList}>
              {conversationalAIProviderOptions.map((provider) => {
                const status = getProviderStatus(aiProviders, provider.id)
                const connected = Boolean(status?.connected)
                const canDelete = Boolean(status?.canDelete && connected)
                return (
                  <div key={provider.id} className={styles.aiProviderManagerRow}>
                    <div className={styles.aiProviderManagerCopy}>
                      <strong>{provider.label}</strong>
                      <span>{connected ? (status?.tokenPreview || 'Conectado') : provider.description}</span>
                    </div>
                    <Badge variant={connected ? 'success' : 'neutral'}>
                      {connected ? 'Conectado' : 'Toca para conectar'}
                    </Badge>
                    {canDelete ? (
                      <Button variant="ghost" onClick={() => handleDeleteProvider(provider.id)}>
                        <Trash2 size={15} />
                        Eliminar
                      </Button>
                    ) : (
                      <Button variant={connected ? 'secondary' : 'primary'} onClick={() => openProviderModal(provider.id)}>
                        <KeyRound size={15} />
                        {connected ? 'Administrar' : 'Conectar'}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className={styles.agentDirectoryStats}>
          <div>
            <span>{agents.length}</span>
            <small>{agents.length === 1 ? 'agente creado' : 'agentes creados'}</small>
          </div>
          <div>
            <span>{activeAgentsCount}</span>
            <small>{activeAgentsCount === 1 ? 'activo' : 'activos'}</small>
          </div>
          <div>
            <span>{assignedConversations}</span>
            <small>chats atendiendo</small>
          </div>
          <div>
            <span>{busyAgents}</span>
            <small>agentes ocupados</small>
          </div>
          <div>
            <span>{completedConversations}</span>
            <small>objetivos cumplidos</small>
          </div>
          <div>
            <span>{successRate}%</span>
            <small>tasa de éxito</small>
          </div>
          <div className={errorEvents > 0 ? styles.agentDirectoryStatError : undefined}>
            <span>{errorEvents}</span>
            <small>errores registrados</small>
          </div>
          <div>
            <span>{config?.enabled ? 'Listo' : 'Omitido'}</span>
            <small>seguridad general</small>
          </div>
        </div>
      </Card>

      {loading && (
        <Card>
          <p className={styles.helper} role="status" aria-live="polite" aria-label="Cargando agentes">
            <RotateCcw size={16} className="animate-spin" aria-hidden="true" />
          </p>
        </Card>
      )}

      {!loading && agents.length === 0 && (
        <Card padding="md" className={styles.emptyAgentDirectory}>
          <div className={styles.iconBox}>
            <Bot size={22} />
          </div>
          <h3>Aún no tienes agentes</h3>
          <p>Crea uno y configura qué chats debe tomar, cómo debe responder y cuándo debe pedir ayuda.</p>
          <Button onClick={handleCreateAgent} loading={creating} disabled={creating}>
            <Plus size={16} />
            Nuevo agente
          </Button>
        </Card>
      )}

      {!loading && agents.length > 0 && (
        <div className={styles.agentDirectoryGrid}>
          {agents.map((agent) => {
            const objectiveLabel = objectiveOptions.find((option) => option.value === agent.objective)?.label || 'Objetivo'
            const actionLabel = successActionLabels[agent.successAction]?.label || 'Acción'
            const provider = getConversationalAIProviderOption(agent.aiProvider)
            const modelLabel = getConversationalModelLabel(agent.aiProvider, agent.model)
            const entryRules = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
            const agentMetrics = metricsByAgentId.get(agent.id)

            return (
              <div
                key={agent.id}
                className={`${styles.agentDirectoryCard} ${agent.enabled ? '' : styles.agentDirectoryCardMuted}`}
              >
                <button
                  type="button"
                  className={styles.agentDirectoryOpenButton}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <div className={styles.agentDirectoryCardTop}>
                    <span className={`${styles.iconBox} ${agent.enabled ? '' : styles.iconBoxMuted}`}>
                      <Bot size={20} />
                    </span>
                    <Badge variant={agent.enabled ? 'success' : 'neutral'}>
                      {agent.enabled ? 'Publicado' : 'En pausa'}
                    </Badge>
                  </div>
                  <div className={styles.agentDirectoryCardCopy}>
                    <h3>{agent.name || 'Agente sin nombre'}</h3>
                    <p>{objectiveLabel} · {actionLabel}</p>
                  </div>
                  <div className={styles.agentDirectoryMeta}>
                    <span>{provider.label} · {modelLabel}</span>
                    <span>{entryRules > 0 ? `${entryRules} ${entryRules === 1 ? 'regla' : 'reglas'}` : 'Cualquier chat'}</span>
                    <span>{agentMetrics?.assignedConversations ?? 0} atendiendo</span>
                    <span>{agentMetrics?.completedConversations ?? 0} cumplidos</span>
                    {agent.hideAttended && <span>Oculta atendidas</span>}
                    {agent.hideAttendedNotifications && <span>Silencia avisos</span>}
                  </div>
                </button>
                <div className={styles.agentDirectoryActions}>
                  <Button
                    variant={agent.enabled ? 'secondary' : 'primary'}
                    onClick={() => handleAgentChange(agent.id, { enabled: !agent.enabled })}
                    disabled={!agent.enabled && !businessPromptReady}
                    title={!agent.enabled && !businessPromptReady ? promptBlockerText : undefined}
                  >
                    {agent.enabled ? <Pause size={15} /> : <Play size={15} />}
                    {agent.enabled ? 'Pausar' : 'Publicar'}
                  </Button>
                  <Button variant="ghost" onClick={() => handleDeleteAgent(agent)}>
                    <Trash2 size={15} />
                    Eliminar
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {renderProviderModal()}
    </div>
  )
}
