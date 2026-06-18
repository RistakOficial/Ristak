import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle, Eye, EyeOff, Globe2, XCircle } from 'lucide-react'
import { Card, CustomSelect } from '@/components/common'
import { Badge } from '@/components/common/Badge'
import { DEFAULT_AI_MODEL, aiModelOptionGroups, aiModelOptions, getKnownAIModel } from '@/constants/aiModels'
import { useNotification } from '@/contexts/NotificationContext'
import { aiAgentService, type AIAgentConfigStatus, type AIAgentRecommendationMode, type AIAgentResponseStyle } from '@/services/aiAgentService'
import styles from './AIAgentSettings.module.css'

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
    actionCustomizations: '',
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: ''
  }
}

function statusToForm(status: AIAgentConfigStatus) {
  return {
    model: getKnownAIModel(status.model),
    businessContext: getUnifiedBusinessContext(status),
    marketContext: '',
    idealCustomer: '',
    locationContext: '',
    competitorsContext: '',
    brandVoice: '',
    actionCustomizations: '',
    researchDomains: status.researchDomains || '',
    responseStyle: status.responseStyle || 'advisor',
    recommendationMode: status.recommendationMode || 'when_useful',
    webSearchEnabled: Boolean(status.webSearchEnabled)
  }
}

function normalizeStatus(status: AIAgentConfigStatus): AIAgentConfigStatus {
  return {
    ...status,
    model: getKnownAIModel(status.model)
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

  const selectedModel = aiModelOptions.find((option) => option.value === form.model) || aiModelOptions[0]
  const needsReconnect = Boolean(status.needsReconnect)
  const canDeleteToken = Boolean(status.configured || needsReconnect)
  const apiKeyNeedsMore = isEditingApiKey && Boolean(apiKey.trim() && !isApiKeyReady(apiKey))
  const saveStatusText = loading
    ? ''
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
            : !status.configured && !needsReconnect
              ? 'Sin token guardado'
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

  const deleteToken = async () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }

    const saveId = activeSaveIdRef.current + 1
    activeSaveIdRef.current = saveId
    setDisconnecting(true)
    setSaveState('saving')
    setSaveError('')

    try {
      const nextStatus = normalizeStatus(await aiAgentService.deleteToken())
      if (activeSaveIdRef.current !== saveId) return

      const nextForm = statusToForm(nextStatus)
      setStatus(nextStatus)
      setForm(nextForm)
      setApiKey('')
      setShowApiKey(false)
      setIsEditingApiKey(false)
      emitConfigChange(nextStatus)
      lastSavedSignatureRef.current = getConfigSignature(nextForm)
      setSaveState('saved')
      showToast('success', 'Token eliminado', 'El agente AI dejó de usar el token guardado. Tu contexto del negocio se conserva.')
    } catch (error: any) {
      if (activeSaveIdRef.current !== saveId) return

      const message = error?.message || 'No se pudo eliminar el token del agente'
      setSaveState('error')
      setSaveError(message)
      showToast('error', 'No se pudo eliminar', message)
    } finally {
      if (activeSaveIdRef.current === saveId) {
        setDisconnecting(false)
      }
    }
  }

  const handleDeleteToken = () => {
    showConfirm(
      'Eliminar token',
      'Se borrará sólo el token de OpenAI. El modelo y la descripción del negocio se quedan guardados.',
      deleteToken,
      'Eliminar',
      'Cancelar'
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
              <Badge variant="warning">
                <AlertTriangle size={15} />
                Reconectar
              </Badge>
            ) : status.configured ? (
              <Badge variant="success">
                <CheckCircle size={15} />
                Conectado
              </Badge>
            ) : (
              <Badge variant="error">
                <XCircle size={15} />
                No configurado
              </Badge>
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
            <div className={`${styles.inputWrap} ${canDeleteToken ? styles.inputWrapStackable : ''}`}>
              <input
                className={`${styles.input} ${styles.tokenInput} ${canDeleteToken ? styles.tokenInputWithDelete : ''} ${!isEditingApiKey ? styles.inputReadOnly : ''}`}
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
                {canDeleteToken && (
                  <button
                    type="button"
                    className={`${styles.inlineActionButton} ${styles.inlineDeleteButton}`}
                    onClick={handleDeleteToken}
                    disabled={loading || disconnecting || savingApiKey}
                  >
                    Eliminar
                  </button>
                )}
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
