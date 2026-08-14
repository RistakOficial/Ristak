import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Save } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  ExpandableTextareaField,
  Loading,
  PageHeader
} from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import {
  aiRuntimeService,
  type AIRuntimeConfigStatus
} from '@/services/aiRuntimeService'
import { hasModuleAccess } from '@/utils/accessControl'
import styles from './ChatbotBusinessSettings.module.css'

const BUSINESS_DESCRIPTION_LIMIT = 50_000

type ProfileState = {
  label: string
  variant: 'neutral' | 'success' | 'warning' | 'info'
  help: string
}

function getProfileState(status: AIRuntimeConfigStatus | null): ProfileState {
  const profile = status?.businessProfile
  const extractionStatus = profile?.extractionStatus || profile?.status || 'empty'
  const hasBusinessDescription = Boolean(profile?.configured || status?.businessContext?.trim())

  if (!hasBusinessDescription) {
    return {
      label: 'Sin descripción',
      variant: 'neutral',
      help: 'Agrega información para que tus chatbots conozcan el negocio.'
    }
  }

  if (extractionStatus === 'needs_more_context') {
    return {
      label: 'Falta contexto',
      variant: 'warning',
      help: 'La descripción ya se guarda, pero conviene agregar productos, clientes, horarios, precios y reglas importantes.'
    }
  }

  if (!profile?.configured || extractionStatus === 'empty' || extractionStatus === 'needs_openai') {
    return {
      label: 'Descripción activa',
      variant: 'info',
      help: 'Tus agentes ya pueden usar el texto directo. Con OpenAI conectado, Ristak también organiza sus datos automáticamente.'
    }
  }

  return {
    label: 'Perfil listo',
    variant: 'success',
    help: 'Ristak organizó la descripción para recuperar la información más útil en cada conversación.'
  }
}

export const ChatbotBusinessSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast } = useNotification()
  const [status, setStatus] = useState<AIRuntimeConfigStatus | null>(null)
  const [businessContext, setBusinessContext] = useState('')
  const [savedBusinessContext, setSavedBusinessContext] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const canWrite = hasModuleAccess(user, 'ai_agent', 'write')
  const dirty = businessContext !== savedBusinessContext
  const overLimit = businessContext.length > BUSINESS_DESCRIPTION_LIMIT
  const profileState = useMemo(() => getProfileState(status), [status])

  const loadProfile = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setLoadError('')
    try {
      const nextStatus = await aiRuntimeService.getConfig({ signal })
      const nextBusinessContext = nextStatus.businessContext || ''
      setStatus(nextStatus)
      setBusinessContext(nextBusinessContext)
      setSavedBusinessContext(nextBusinessContext)
    } catch (error: any) {
      if (error?.name === 'AbortError') return
      const message = error?.message || 'No se pudo cargar la descripción del negocio.'
      setLoadError(message)
      showToast('error', 'No se pudo abrir la configuración', message)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    const controller = new AbortController()
    void loadProfile(controller.signal)
    return () => controller.abort()
  }, [loadProfile])

  const saveProfile = async () => {
    if (!canWrite || !dirty || saving) return
    if (overLimit) {
      showToast(
        'warning',
        'Descripción demasiado larga',
        `Reduce el texto a ${BUSINESS_DESCRIPTION_LIMIT.toLocaleString('es-MX')} caracteres para guardarlo.`
      )
      return
    }

    setSaving(true)
    try {
      const nextStatus = await aiRuntimeService.saveBusinessProfile(businessContext)
      const nextBusinessContext = nextStatus.businessContext || businessContext.trim()
      setStatus(nextStatus)
      setBusinessContext(nextBusinessContext)
      setSavedBusinessContext(nextBusinessContext)
      showToast(
        'success',
        businessContext.trim() ? 'Descripción guardada' : 'Descripción eliminada',
        businessContext.trim()
          ? 'Los chatbots que tengan activada esta memoria ya pueden usarla.'
          : 'Los chatbots dejarán de recibir una descripción global del negocio.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Inténtalo otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const headerStatus = dirty
    ? { label: 'Cambios sin guardar', variant: 'warning' as const }
    : { label: profileState.label, variant: profileState.variant }

  return (
    <div className={styles.container}>
      <PageHeader
        title="Configuración del Chatbot"
        subtitle="Define la información general que tus agentes pueden compartir como memoria del negocio."
        actions={(
          <Button
            onClick={() => void saveProfile()}
            loading={saving}
            disabled={!canWrite || !dirty || overLimit || Boolean(loadError)}
          >
            <Save size={16} />
            Guardar descripción
          </Button>
        )}
      />

      {loading ? (
        <Loading message="Cargando configuración del Chatbot…" page="ai-agent" />
      ) : loadError ? (
        <Card className={styles.errorState}>
          <div>
            <h2>No pudimos cargar la descripción</h2>
            <p>{loadError}</p>
          </div>
          <Button variant="secondary" onClick={() => void loadProfile()}>
            Reintentar
          </Button>
        </Card>
      ) : (
        <Card className={styles.profileCard}>
          <div className={styles.profileIntro}>
            <div>
              <h2>Descripción general del negocio</h2>
              <p>
                Escribe qué vendes, a quién atiendes, dónde operas, horarios, precios, condiciones,
                diferenciadores y cualquier dato que el chatbot deba conocer.
              </p>
            </div>
            <Badge variant={headerStatus.variant}>{headerStatus.label}</Badge>
          </div>

          <ExpandableTextareaField
            id="chatbot-business-description"
            label="Información compartida"
            description="Esta descripción es global. La estrategia y personalidad siguen configurándose por separado dentro de cada agente."
            value={businessContext}
            rows={12}
            placeholder="Ejemplo: Somos una clínica de fisioterapia en Ciudad Juárez. Atendemos de lunes a sábado…"
            characterLimit={BUSINESS_DESCRIPTION_LIMIT}
            disabled={!canWrite || saving}
            spellCheck
            onChange={setBusinessContext}
          />

          <div className={styles.profileStatus}>
            <p>{profileState.help}</p>
          </div>

          {status?.businessProfile?.summary ? (
            <div className={styles.profileSummary}>
              <h3>Resumen que Ristak reconoce</h3>
              <p>{status.businessProfile.summary}</p>
            </div>
          ) : null}

          <div className={styles.usageNote}>
            <h3>Cómo decide cada agente si la usa</h3>
            <p>
              Entra a un agente y abre “Capacitación y personalidad”. Ahí elige Sí o No en
              “Usar la descripción del negocio”. Si eliges No, ese agente trabajará únicamente
              con su estrategia propia y sus capacidades configuradas.
            </p>
          </div>

          {!canWrite ? (
            <p className={styles.readOnlyNote}>
              Tu acceso es de lectura. Un administrador o usuario con permiso de escritura puede cambiar esta descripción.
            </p>
          ) : null}
        </Card>
      )}
    </div>
  )
}
