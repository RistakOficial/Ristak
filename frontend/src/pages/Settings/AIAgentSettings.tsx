import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle, Eye, EyeOff, Globe2, ListChecks, Trash2, XCircle } from 'lucide-react'
import { Button, Card, CustomSelect } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { aiAgentService, type AIAgentConfigStatus, type AIAgentRecommendationMode, type AIAgentResponseStyle } from '@/services/aiAgentService'
import styles from './AIAgentSettings.module.css'

const DEFAULT_AI_MODEL = 'gpt-5.5'
const AUTOSAVE_DELAY_MS = 900

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

const emptyStatus: AIAgentConfigStatus = {
  configured: false,
  model: DEFAULT_AI_MODEL,
  tokenPreview: null,
  credentialStatus: 'missing',
  needsReconnect: false,
  connectionIssue: null,
  connectionIssueCode: null,
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  actionCustomizations: '',
  researchDomains: '',
  responseStyle: 'advisor',
  recommendationMode: 'when_useful',
  webSearchEnabled: false,
  updatedAt: null
}

const emptyForm = {
  model: DEFAULT_AI_MODEL,
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  actionCustomizations: '',
  researchDomains: '',
  responseStyle: 'advisor' as AIAgentResponseStyle,
  recommendationMode: 'when_useful' as AIAgentRecommendationMode,
  webSearchEnabled: false
}

const legacyBusinessContextFields = [
  { label: 'Mercado o nicho', key: 'marketContext' },
  { label: 'Cliente ideal', key: 'idealCustomer' },
  { label: 'Zona geográfica', key: 'locationContext' },
  { label: 'Competidores o referencias', key: 'competitorsContext' },
  { label: 'Tono, prioridades y reglas', key: 'brandVoice' }
] as const

function getUnifiedBusinessContext(status: AIAgentConfigStatus) {
  const primaryContext = (status.businessContext || '').trim()
  const legacyContext = legacyBusinessContextFields
    .map(({ label, key }) => {
      const value = String(status[key] || '').trim()
      return value ? `${label}: ${value}` : ''
    })
    .filter(Boolean)

  return [primaryContext, ...legacyContext].filter(Boolean).join('\n\n')
}

function prepareConfigForSave(form: typeof emptyForm) {
  return {
    ...form,
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: ''
  }
}

const modelOptionGroups = [
  {
    label: 'GPT-5.5 y GPT-5.4',
    options: [
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'El más nuevo para análisis complejo, criterio y trabajo profesional.' },
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 pro', description: 'Más cómputo para respuestas más precisas; puede tardar más.' },
      { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Frontier fuerte con mejor balance de costo.' },
      { value: 'gpt-5.4-pro', label: 'GPT-5.4 pro', description: 'Versión pro de GPT-5.4 para más precisión.' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Rápido y más barato para alto volumen.' },
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'El más económico de la familia GPT-5.4.' }
    ]
  },
  {
    label: 'GPT-5 anteriores',
    options: [
      { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Modelo frontier anterior para trabajo profesional.' },
      { value: 'gpt-5.2-pro', label: 'GPT-5.2 pro', description: 'Versión pro anterior con más precisión.' },
      { value: 'gpt-5.1', label: 'GPT-5.1', description: 'Modelo anterior para tareas de agente y código.' },
      { value: 'gpt-5', label: 'GPT-5', description: 'Modelo GPT-5 original.' },
      { value: 'gpt-5-pro', label: 'GPT-5 pro', description: 'Versión pro de GPT-5.' },
      { value: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Más rápido y económico que GPT-5.' },
      { value: 'gpt-5-nano', label: 'GPT-5 nano', description: 'Más barato y rápido para tareas simples.' }
    ]
  },
  {
    label: 'Modelos usados en ChatGPT',
    options: [
      { value: 'chat-latest', label: 'chat-latest', description: 'Modelo instantáneo actual usado en ChatGPT; OpenAI lo puede actualizar.' },
      { value: 'gpt-5.3-chat-latest', label: 'GPT-5.3 Chat', description: 'Snapshot instantáneo GPT-5.3 usado en ChatGPT.' },
      { value: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat', description: 'Snapshot GPT-5.2 usado en ChatGPT.' },
      { value: 'gpt-5.1-chat-latest', label: 'GPT-5.1 Chat', description: 'Versión ChatGPT anterior.' },
      { value: 'gpt-5-chat-latest', label: 'GPT-5 Chat', description: 'Versión GPT-5 usada antes en ChatGPT.' },
      { value: 'chatgpt-4o-latest', label: 'ChatGPT-4o', description: 'Alias anterior de GPT-4o usado en ChatGPT.' }
    ]
  },
  {
    label: 'GPT-4 y legacy',
    options: [
      { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Modelo no razonador fuerte.' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Versión más rápida de GPT-4.1.' },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano', description: 'Versión más económica de GPT-4.1.' },
      { value: 'gpt-4o', label: 'GPT-4o', description: 'Modelo rápido y flexible anterior.' },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Modelo económico para tareas enfocadas.' },
      { value: 'gpt-4.5-preview', label: 'GPT-4.5 Preview', description: 'Modelo preview legacy.' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', description: 'Modelo GPT-4 Turbo legacy.' },
      { value: 'gpt-4-turbo-preview', label: 'GPT-4 Turbo Preview', description: 'Preview legacy de GPT-4 Turbo.' },
      { value: 'gpt-4', label: 'GPT-4', description: 'Modelo GPT-4 original.' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', description: 'Modelo legacy barato para chat.' }
    ]
  },
  {
    label: 'Razonamiento y búsqueda',
    options: [
      { value: 'o3-pro', label: 'o3-pro', description: 'Razonamiento con más cómputo.' },
      { value: 'o3', label: 'o3', description: 'Modelo de razonamiento anterior.' },
      { value: 'o4-mini', label: 'o4-mini', description: 'Razonamiento rápido y económico.' },
      { value: 'o3-mini', label: 'o3-mini', description: 'Modelo de razonamiento pequeño legacy.' },
      { value: 'o1-pro', label: 'o1-pro', description: 'Razonamiento o1 con más cómputo.' },
      { value: 'o1', label: 'o1', description: 'Modelo o-series anterior.' },
      { value: 'o1-mini', label: 'o1-mini', description: 'Versión pequeña legacy de o1.' },
      { value: 'o1-preview', label: 'o1 preview', description: 'Preview legacy de o1.' },
      { value: 'gpt-4o-search-preview', label: 'GPT-4o Search Preview', description: 'Modelo legacy orientado a búsqueda.' },
      { value: 'gpt-4o-mini-search-preview', label: 'GPT-4o mini Search Preview', description: 'Modelo pequeño legacy orientado a búsqueda.' }
    ]
  },
  {
    label: 'Codex, deep research y open-weight',
    options: [
      { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Modelo optimizado para programación/agentes de código.' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'Codex anterior para tareas largas de código.' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex GPT-5.1 legacy.' },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', description: 'Codex para tareas largas legacy.' },
      { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex mini', description: 'Codex mini legacy.' },
      { value: 'gpt-5-codex', label: 'GPT-5-Codex', description: 'Codex GPT-5 legacy.' },
      { value: 'codex-mini-latest', label: 'codex-mini-latest', description: 'Codex mini legacy.' },
      { value: 'o3-deep-research', label: 'o3-deep-research', description: 'Modelo especializado en investigación profunda.' },
      { value: 'o4-mini-deep-research', label: 'o4-mini-deep-research', description: 'Investigación profunda más rápida/económica.' },
      { value: 'gpt-oss-120b', label: 'gpt-oss-120b', description: 'Modelo open-weight grande.' },
      { value: 'gpt-oss-20b', label: 'gpt-oss-20b', description: 'Modelo open-weight más ligero.' }
    ]
  }
]

const modelOptions = modelOptionGroups.flatMap((group) => group.options)

function getKnownModel(value?: string | null) {
  return modelOptions.some((option) => option.value === value) ? String(value) : DEFAULT_AI_MODEL
}

function statusToForm(status: AIAgentConfigStatus) {
  return {
    model: getKnownModel(status.model),
    businessContext: getUnifiedBusinessContext(status),
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: '',
    actionCustomizations: status.actionCustomizations || '',
    researchDomains: status.researchDomains || '',
    responseStyle: status.responseStyle || 'advisor',
    recommendationMode: status.recommendationMode || 'when_useful',
    webSearchEnabled: Boolean(status.webSearchEnabled)
  }
}

function normalizeStatus(status: AIAgentConfigStatus): AIAgentConfigStatus {
  return {
    ...status,
    model: getKnownModel(status.model)
  }
}

function getConfigSignature(form: typeof emptyForm) {
  return JSON.stringify(form)
}

function isApiKeyReady(apiKey: string) {
  const trimmed = apiKey.trim()
  return !trimmed || (trimmed.startsWith('sk-') && trimmed.length >= 30)
}

const responseStyleOptions: Array<{
  value: AIAgentResponseStyle
  label: string
  description: string
}> = [
  {
    value: 'direct',
    label: 'Directo al dato',
    description: 'Contesta exactamente lo preguntado y no se extiende.'
  },
  {
    value: 'balanced',
    label: 'Balanceado',
    description: 'Dato primero, con una lectura breve cuando aporte.'
  },
  {
    value: 'advisor',
    label: 'Asesor',
    description: 'Más contexto y criterio estratégico por defecto.'
  }
]

const recommendationModeOptions: Array<{
  value: AIAgentRecommendationMode
  label: string
  description: string
}> = [
  {
    value: 'on_request',
    label: 'Sólo si las pido',
    description: 'No da acciones ni consejos si sólo pediste un dato.'
  },
  {
    value: 'when_useful',
    label: 'Si hay algo importante',
    description: 'Recomienda sólo ante riesgos u oportunidades claras.'
  },
  {
    value: 'proactive',
    label: 'Proactivas',
    description: 'Puede sugerir acciones aunque no las pidas.'
  }
]

export const AIAgentSettings: React.FC = () => {
  const { showToast, showConfirm } = useNotification()
  const [status, setStatus] = useState<AIAgentConfigStatus>(emptyStatus)
  const [form, setForm] = useState(emptyForm)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isEditingApiKey, setIsEditingApiKey] = useState(false)
  const [savingApiKey, setSavingApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const hydratedRef = useRef(false)
  const autosaveTimerRef = useRef<number | null>(null)
  const activeSaveIdRef = useRef(0)
  const lastSavedSignatureRef = useRef(getConfigSignature(emptyForm))

  const emitConfigChange = (nextStatus: AIAgentConfigStatus) => {
    window.dispatchEvent(new CustomEvent('ai-agent-config-changed', {
      detail: nextStatus
    }))
  }

  const loadStatus = async () => {
    hydratedRef.current = false
    setLoading(true)
    try {
      const nextStatus = normalizeStatus(await aiAgentService.getConfig())
      const nextForm = statusToForm(nextStatus)
      setStatus(nextStatus)
      setForm(nextForm)
      setApiKey('')
      setShowApiKey(false)
      setIsEditingApiKey(false)
      lastSavedSignatureRef.current = getConfigSignature(nextForm)
      setSaveState('saved')
      setSaveError('')
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo cargar el estado del agente AI')
    } finally {
      setLoading(false)
      hydratedRef.current = true
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  const updateField = (field: keyof typeof emptyForm, value: string | boolean) => {
    setForm((current) => ({
      ...current,
      [field]: value
    }))
  }

  const selectedModel = modelOptions.find((option) => option.value === form.model) || modelOptions[0]
  const needsReconnect = Boolean(status.needsReconnect)
  const apiKeyNeedsMore = isEditingApiKey && Boolean(apiKey.trim() && !isApiKeyReady(apiKey))
  const saveStatusText = loading
    ? 'Cargando...'
    : savingApiKey
      ? 'Guardando token...'
      : saveState === 'saving'
      ? 'Guardando...'
      : apiKeyNeedsMore
        ? 'Completa el token para guardarlo'
        : needsReconnect && !isEditingApiKey
          ? 'Reconecta OpenAI para usar voz y chat'
        : saveState === 'pending'
          ? 'Guardando en automático...'
          : saveState === 'error'
            ? saveError || 'No se pudo guardar'
            : 'Guardado automático'

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!hydratedRef.current || loading || disconnecting) return

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }

    const signature = getConfigSignature(form)

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
      setSaving(true)
      setSaveState('saving')

      try {
        const nextStatus = normalizeStatus(await aiAgentService.saveConfig({
          ...prepareConfigForSave(form)
        }))

        if (activeSaveIdRef.current !== saveId) return

        const nextForm = statusToForm(nextStatus)
        setStatus(nextStatus)
        emitConfigChange(nextStatus)
        lastSavedSignatureRef.current = getConfigSignature(nextForm)
        setSaveState('saved')
      } catch (error: any) {
        if (activeSaveIdRef.current !== saveId) return

        const message = error?.message || 'Revisa la configuración del agente'
        setSaveState('error')
        setSaveError(message)
        showToast('error', 'No se pudo guardar', message)
      } finally {
        if (activeSaveIdRef.current === saveId) {
          setSaving(false)
        }
      }
    }, AUTOSAVE_DELAY_MS)

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  }, [form, loading, disconnecting, showToast])

  const handleStartApiKeyEdit = () => {
    setApiKey('')
    setShowApiKey(false)
    setIsEditingApiKey(true)
    setSaveError('')
  }

  const handleSaveApiKey = async () => {
    const trimmedApiKey = apiKey.trim()

    if (!trimmedApiKey) {
      showToast('error', 'Token requerido', 'Pega el API token completo para reemplazarlo.')
      return
    }

    if (!isApiKeyReady(trimmedApiKey)) {
      showToast('error', 'Token incompleto', 'El token debe iniciar con sk- y tener el largo completo.')
      return
    }

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }

    const saveId = activeSaveIdRef.current + 1
    activeSaveIdRef.current = saveId
    setSaving(true)
    setSavingApiKey(true)
    setSaveState('saving')
    setSaveError('')

    try {
      const nextStatus = normalizeStatus(await aiAgentService.saveConfig({
        apiKey: trimmedApiKey,
        ...prepareConfigForSave(form)
      }))

      if (activeSaveIdRef.current !== saveId) return

      const nextForm = statusToForm(nextStatus)
      setStatus(nextStatus)
      setForm(nextForm)
      emitConfigChange(nextStatus)
      lastSavedSignatureRef.current = getConfigSignature(nextForm)
      setApiKey('')
      setShowApiKey(false)
      setIsEditingApiKey(false)
      setSaveState('saved')
      showToast('success', 'Token actualizado', 'El agente AI ya quedó usando el token nuevo.')
    } catch (error: any) {
      if (activeSaveIdRef.current !== saveId) return

      const message = error?.message || 'No se pudo actualizar el token del agente'
      setSaveState('error')
      setSaveError(message)
      showToast('error', 'No se pudo guardar', message)
    } finally {
      if (activeSaveIdRef.current === saveId) {
        setSaving(false)
        setSavingApiKey(false)
      }
    }
  }

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      await aiAgentService.deleteConfig()
      setStatus(emptyStatus)
      setForm(emptyForm)
      setApiKey('')
      setShowApiKey(false)
      setIsEditingApiKey(false)
      lastSavedSignatureRef.current = getConfigSignature(emptyForm)
      setSaveState('saved')
      setSaveError('')
      emitConfigChange(emptyStatus)
      showToast('success', 'Agente AI desconectado', 'El chat seguirá visible para volver a configurarlo cuando quieras.')
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo desconectar el agente AI')
    } finally {
      setDisconnecting(false)
    }
  }

  const handleDisconnect = () => {
    showConfirm(
      'Desconectar Agente AI',
      'Se eliminará el token guardado. El chat seguirá visible, pero quedará en modo configuración.',
      disconnect,
      'Desconectar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'DESCONECTAR' }
    )
  }

  return (
    <div className={styles.container}>
      <Card>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.iconBox}>
              <Bot size={22} />
            </div>
            <div>
              <h2 className={styles.title}>Agente AI</h2>
              <p className={styles.description}>
                Token, modelo y contexto del negocio. Todo se guarda solo.
              </p>
            </div>
          </div>

          <div className={styles.headerActions}>
            {needsReconnect ? (
              <div className={styles.statusWarning}>
                <AlertTriangle size={15} />
                Reconectar
              </div>
            ) : status.configured ? (
              <div className={styles.statusConnected}>
                <CheckCircle size={15} />
                Conectado
              </div>
            ) : (
              <div className={styles.statusDisconnected}>
                <XCircle size={15} />
                No configurado
              </div>
            )}

            {(status.configured || needsReconnect) && (
              <Button
                variant="danger"
                onClick={handleDisconnect}
                loading={disconnecting}
                disabled={disconnecting}
              >
                <Trash2 size={16} />
                Desconectar
              </Button>
            )}
          </div>
        </div>

        <div className={`${styles.saveStatus} ${saveState === 'error' ? styles.saveStatusError : saving || saveState === 'pending' || apiKeyNeedsMore ? styles.saveStatusWorking : styles.saveStatusSaved}`}>
          <span className={styles.saveDot} />
          {saveStatusText}
        </div>

        <div className={styles.settingsGrid}>
          <div className={styles.field}>
            <label className={styles.label}>API Token</label>
            <div className={styles.inputWrap}>
              <input
                className={`${styles.input} ${styles.tokenInput} ${!isEditingApiKey ? styles.inputReadOnly : ''}`}
                type={isEditingApiKey && showApiKey ? 'text' : 'password'}
                value={isEditingApiKey ? apiKey : status.configured ? 'token-configurado' : needsReconnect ? 'token-no-disponible' : ''}
                placeholder={status.configured ? 'Token configurado' : needsReconnect ? 'Token requiere reconexión' : 'Sin token configurado'}
                autoComplete="off"
                onChange={(event) => {
                  if (isEditingApiKey) {
                    setApiKey(event.target.value)
                  }
                }}
                readOnly={!isEditingApiKey}
                disabled={loading || disconnecting}
              />
              <div className={styles.inputActions}>
                {isEditingApiKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={() => setShowApiKey((current) => !current)}
                    aria-label={showApiKey ? 'Ocultar token' : 'Mostrar token'}
                    disabled={loading || disconnecting || savingApiKey}
                  >
                    {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.inlineActionButton}
                  onClick={isEditingApiKey ? handleSaveApiKey : handleStartApiKeyEdit}
                  disabled={
                    loading ||
                    disconnecting ||
                    savingApiKey ||
                    (isEditingApiKey && (!apiKey.trim() || !isApiKeyReady(apiKey)))
                  }
                >
                  {isEditingApiKey ? 'Guardar' : needsReconnect ? 'Reconectar' : 'Cambiar'}
                </button>
              </div>
            </div>
            <p className={`${styles.helper} ${needsReconnect && !isEditingApiKey ? styles.helperWarning : ''}`}>
              {isEditingApiKey
                ? apiKeyNeedsMore
                  ? 'El token debe iniciar con sk- y estar completo.'
                  : 'Pega el token nuevo y guárdalo manualmente.'
                : needsReconnect
                  ? 'El token guardado ya no se puede leer. Pega tu token de OpenAI otra vez para activar voz y chat.'
                : status.tokenPreview
                  ? `Actual: ${status.tokenPreview}`
                  : 'Pulsa Cambiar para configurar el token.'}
            </p>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Modelo</label>
            <CustomSelect
              value={form.model}
              onChange={(event) => updateField('model', event.target.value)}
              disabled={loading || disconnecting}
            >
              {modelOptionGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </CustomSelect>
            <p className={styles.helper}>{selectedModel.description}</p>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Respuesta</label>
            <CustomSelect
              value={form.responseStyle}
              onChange={(event) => updateField('responseStyle', event.target.value as AIAgentResponseStyle)}
              disabled={loading || disconnecting}
            >
              {responseStyleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </CustomSelect>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Recomendaciones</label>
            <CustomSelect
              value={form.recommendationMode}
              onChange={(event) => updateField('recommendationMode', event.target.value as AIAgentRecommendationMode)}
              disabled={loading || disconnecting}
            >
              {recommendationModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </CustomSelect>
          </div>
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Contexto del negocio</h3>
          <textarea
            className={`${styles.textarea} ${styles.businessContextTextarea}`}
            value={form.businessContext}
            aria-label="Contexto del negocio"
            placeholder="Dime qué vendes, a quién le vendes, dónde operas, quién compite contigo, qué tono quieres y qué reglas debe respetar el agente."
            onChange={(event) => updateField('businessContext', event.target.value)}
            disabled={loading || disconnecting}
            rows={8}
          />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeading}>
            <ListChecks size={17} />
            <h3 className={styles.sectionTitle}>Personalización de acciones</h3>
          </div>
          <div className={styles.fieldWide}>
            <label className={styles.label}>Instrucciones para ejecuciones</label>
            <textarea
              className={`${styles.textarea} ${styles.actionTextarea}`}
              value={form.actionCustomizations}
              placeholder={'Ejemplo: Cuando pidan darle tiempo extra a un contacto, busca el campo {{contact.tiempo_extra_en_el_programa}}, guarda sólo el número de meses y agrégalo al workflow "Tiempo extra".'}
              onChange={(event) => updateField('actionCustomizations', event.target.value)}
              disabled={loading || disconnecting}
              rows={7}
            />
            <p className={styles.helper}>
              El agente usa estas reglas cuando detecta una acción operativa antes de llamar herramientas.
            </p>
          </div>
        </div>

        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Investigación online</h3>
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={form.webSearchEnabled}
              onChange={(event) => updateField('webSearchEnabled', event.target.checked)}
              disabled={loading || disconnecting}
            />
            <span>
              <Globe2 size={16} />
              Permitir búsqueda web cuando aporte contexto.
            </span>
          </label>

          {form.webSearchEnabled && (
            <div className={styles.field}>
              <label className={styles.label}>Dominios preferidos</label>
              <textarea
                className={styles.textarea}
                value={form.researchDomains}
                placeholder="Opcional: inegi.org.mx, gob.mx, statista.com..."
                onChange={(event) => updateField('researchDomains', event.target.value)}
                disabled={loading || disconnecting}
                rows={3}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
