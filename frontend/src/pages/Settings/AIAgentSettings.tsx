import React, { useEffect, useState } from 'react'
import { Bot, CheckCircle, Database, Eye, EyeOff, Globe2, KeyRound, MessageCircle, Save, Sparkles, Trash2, XCircle } from 'lucide-react'
import { Button, Card } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { aiAgentService, type AIAgentConfigStatus, type AIAgentRecommendationMode, type AIAgentResponseStyle } from '@/services/aiAgentService'
import styles from './AIAgentSettings.module.css'

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

const emptyForm = {
  businessContext: '',
  marketContext: '',
  idealCustomer: '',
  locationContext: '',
  competitorsContext: '',
  brandVoice: '',
  researchDomains: '',
  responseStyle: 'direct' as AIAgentResponseStyle,
  recommendationMode: 'on_request' as AIAgentRecommendationMode,
  webSearchEnabled: false
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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const emitConfigChange = (nextStatus: AIAgentConfigStatus) => {
    window.dispatchEvent(new CustomEvent('ai-agent-config-changed', {
      detail: nextStatus
    }))
  }

  const loadStatus = async () => {
    setLoading(true)
    try {
      const nextStatus = await aiAgentService.getConfig()
      setStatus(nextStatus)
      setForm({
        businessContext: nextStatus.businessContext || '',
        marketContext: nextStatus.marketContext || '',
        idealCustomer: nextStatus.idealCustomer || '',
        locationContext: nextStatus.locationContext || '',
        competitorsContext: nextStatus.competitorsContext || '',
        brandVoice: nextStatus.brandVoice || '',
        researchDomains: nextStatus.researchDomains || '',
        responseStyle: nextStatus.responseStyle || 'direct',
        recommendationMode: nextStatus.recommendationMode || 'on_request',
        webSearchEnabled: Boolean(nextStatus.webSearchEnabled)
      })
    } catch (error: any) {
      showToast('error', 'Error', error?.message || 'No se pudo cargar el estado del agente AI')
    } finally {
      setLoading(false)
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

  const handleSave = async () => {
    setSaving(true)
    try {
      const nextStatus = await aiAgentService.saveConfig({
        apiKey: apiKey.trim() || undefined,
        ...form
      })
      setStatus(nextStatus)
      setApiKey('')
      setShowApiKey(false)
      emitConfigChange(nextStatus)
      showToast(
        'success',
        'Agente AI actualizado',
        nextStatus.configured ? 'El agente ya usará el contexto del negocio.' : 'Contexto guardado. Agrega el token para activar el chat con IA.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      await aiAgentService.deleteConfig()
      setStatus(emptyStatus)
      setForm(emptyForm)
      setApiKey('')
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
                Conecta OpenAI para activar el chat flotante con acceso de solo lectura al contexto del negocio y a la vista actual de la interfaz.
              </p>
            </div>
          </div>

          {status.configured ? (
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
        </div>

        <div className={styles.section} style={{ marginTop: 20 }}>
          <h3 className={styles.sectionTitle}>Credenciales de OpenAI</h3>
          <div className={styles.field}>
            <label className={styles.label}>API Token</label>
            <div className={styles.inputRow}>
              <div className={styles.inputWrap}>
                <input
                  className={styles.input}
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder={status.configured ? 'Pega una nueva key para reemplazar la actual' : 'sk-...'}
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={saving || loading}
                />
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setShowApiKey((current) => !current)}
                  aria-label={showApiKey ? 'Ocultar token' : 'Mostrar token'}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <Button onClick={handleSave} loading={saving} disabled={loading || saving}>
                <KeyRound size={16} />
                Guardar configuración
              </Button>
            </div>
            <p className={styles.helper}>
              El token se valida con OpenAI y se guarda cifrado en el backend. Nunca se manda de regreso al navegador.
            </p>
          </div>
        </div>

        <div className={styles.section} style={{ marginTop: 22 }}>
          <h3 className={styles.sectionTitle}>Contexto del negocio</h3>
          <div className={styles.contextGrid}>
            <div className={styles.fieldWide}>
              <label className={styles.label}>Detalles del negocio</label>
              <textarea
                className={styles.textarea}
                value={form.businessContext}
                placeholder="Qué vendes, cómo operas, ticket promedio, promesas, diferenciadores, restricciones importantes..."
                onChange={(event) => updateField('businessContext', event.target.value)}
                disabled={saving || loading}
                rows={4}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Mercado o nicho</label>
              <textarea
                className={styles.textarea}
                value={form.marketContext}
                placeholder="Ej. clínica estética, educación, real estate, consultoría, servicios locales..."
                onChange={(event) => updateField('marketContext', event.target.value)}
                disabled={saving || loading}
                rows={3}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Cliente ideal</label>
              <textarea
                className={styles.textarea}
                value={form.idealCustomer}
                placeholder="Quién compra, qué le duele, objeciones, nivel económico, edad, ubicación, motivaciones..."
                onChange={(event) => updateField('idealCustomer', event.target.value)}
                disabled={saving || loading}
                rows={3}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Zona geográfica</label>
              <textarea
                className={styles.textarea}
                value={form.locationContext}
                placeholder="Ciudad, país, colonias, contexto local, temporadas, cultura, limitaciones geográficas..."
                onChange={(event) => updateField('locationContext', event.target.value)}
                disabled={saving || loading}
                rows={3}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Competidores o referencias</label>
              <textarea
                className={styles.textarea}
                value={form.competitorsContext}
                placeholder="Competidores, marcas de referencia, sitios, cuentas, ventajas o desventajas que conozcas..."
                onChange={(event) => updateField('competitorsContext', event.target.value)}
                disabled={saving || loading}
                rows={3}
              />
            </div>

            <div className={styles.fieldWide}>
              <label className={styles.label}>Tono, prioridades y reglas</label>
              <textarea
                className={styles.textarea}
                value={form.brandVoice}
                placeholder="Cómo quieres que recomiende: agresivo, conservador, premium, familiar; qué evitar; qué metas importan más..."
                onChange={(event) => updateField('brandVoice', event.target.value)}
                disabled={saving || loading}
                rows={3}
              />
            </div>
          </div>
        </div>

        <div className={styles.section} style={{ marginTop: 22 }}>
          <h3 className={styles.sectionTitle}>Comportamiento de respuestas</h3>
          <div className={styles.behaviorGrid}>
            <div className={styles.field}>
              <label className={styles.label}>Estilo por defecto</label>
              <div className={styles.optionGroup}>
                {responseStyleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`${styles.optionButton} ${form.responseStyle === option.value ? styles.optionButtonActive : ''}`}
                    onClick={() => updateField('responseStyle', option.value)}
                    disabled={saving || loading}
                  >
                    <span className={styles.optionLabel}>{option.label}</span>
                    <span className={styles.optionDescription}>{option.description}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label}>Recomendaciones</label>
              <div className={styles.optionGroup}>
                {recommendationModeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`${styles.optionButton} ${form.recommendationMode === option.value ? styles.optionButtonActive : ''}`}
                    onClick={() => updateField('recommendationMode', option.value)}
                    disabled={saving || loading}
                  >
                    <span className={styles.optionLabel}>{option.label}</span>
                    <span className={styles.optionDescription}>{option.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className={styles.helper}>
            En modo directo, si preguntas “cuál campaña es más rentable”, el agente responde el dato y las métricas necesarias. Sólo se pone consultor si se lo pides.
          </p>
        </div>

        <div className={styles.section} style={{ marginTop: 22 }}>
          <h3 className={styles.sectionTitle}>Investigación online</h3>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={form.webSearchEnabled}
              onChange={(event) => updateField('webSearchEnabled', event.target.checked)}
              disabled={saving || loading}
            />
            <span>
              <Globe2 size={16} />
              Permitir que la IA investigue en internet cuando el contexto externo pueda mejorar la recomendación.
            </span>
          </label>

          <div className={styles.field}>
            <label className={styles.label}>Dominios preferidos u obligatorios</label>
            <textarea
              className={styles.textarea}
              value={form.researchDomains}
              placeholder="Opcional. Un dominio por línea o separados por coma. Ej. inegi.org.mx, statista.com, gob.mx"
              onChange={(event) => updateField('researchDomains', event.target.value)}
              disabled={saving || loading || !form.webSearchEnabled}
              rows={3}
            />
            <p className={styles.helper}>
              Si lo dejas vacío, la IA podrá buscar abierto. Si pones dominios, se limitará a esas fuentes.
            </p>
          </div>

          <div className={styles.actions}>
            <Button onClick={handleSave} loading={saving} disabled={loading || saving}>
              <Save size={16} />
              Guardar contexto
            </Button>
          </div>
        </div>

        {status.configured && (
          <div className={styles.section} style={{ marginTop: 22 }}>
            <h3 className={styles.sectionTitle}>Configuración actual</h3>
            <div className={styles.detailsGrid}>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Token</span>
                <span className={styles.detailValue}>{status.tokenPreview || 'Configurado'}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Modelo</span>
                <span className={styles.detailValue}>{status.model}</span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Chat</span>
                <span className={styles.detailValue}>
                  <MessageCircle size={15} />
                  Visible en la app
                </span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Investigación online</span>
                <span className={styles.detailValue}>
                  <Globe2 size={15} />
                  {status.webSearchEnabled ? 'Activada' : 'Desactivada'}
                </span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Respuesta</span>
                <span className={styles.detailValue}>
                  {status.responseStyle === 'advisor' ? 'Asesor' : status.responseStyle === 'balanced' ? 'Balanceado' : 'Directo'}
                </span>
              </div>
              <div className={styles.detailItem}>
                <span className={styles.detailLabel}>Recomendaciones</span>
                <span className={styles.detailValue}>
                  {status.recommendationMode === 'proactive' ? 'Proactivas' : status.recommendationMode === 'when_useful' ? 'Si son importantes' : 'Sólo si las pides'}
                </span>
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Qué puede hacer</h3>
          <div className={styles.capabilities}>
            <div className={styles.capability}>
              <Database size={16} />
              Lee un resumen seguro de contactos, pagos, citas, campañas, sesiones web y fuentes de tráfico.
            </div>
            <div className={styles.capability}>
              <MessageCircle size={16} />
              Usa la ruta y el texto visible de la pantalla actual para explicar lo que estás viendo.
            </div>
            <div className={styles.capability}>
              <Sparkles size={16} />
              Combina los números internos con el contexto del mercado, cliente ideal y zona geográfica.
            </div>
            <div className={styles.capability}>
              <Globe2 size={16} />
              Puede investigar online para traer contexto social, cultural, político, histórico o competitivo cuando aporte valor.
            </div>
            <div className={styles.capability}>
              <CheckCircle size={16} />
              Funciona como asesor de negocio, no como editor de datos: el acceso a la DB es de solo lectura.
            </div>
          </div>

          {status.configured && (
            <div className={styles.actions}>
              <Button
                variant="danger"
                onClick={handleDisconnect}
                loading={disconnecting}
                disabled={disconnecting}
              >
                <Trash2 size={16} />
                Desconectar
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
