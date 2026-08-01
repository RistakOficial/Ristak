import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import {
  registerMediaStorageQuotaPromptHandler,
  type MediaStorageQuotaDecision,
  type MediaStorageQuotaPrompt as MediaStorageQuotaPromptState
} from '@/services/mediaStorageQuotaGuard'
import { hasModuleAccess } from '@/utils/accessControl'
import { isPhoneAppPath } from '@/utils/phoneAccess'
import { Modal } from '../Modal'

type ActivePrompt = {
  prompt: MediaStorageQuotaPromptState
  resolve: (decision: MediaStorageQuotaDecision) => void
}

function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return 'sin límite interno'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.max(0, Math.round(bytes))} B`
}

export const MediaStorageQuotaPrompt: React.FC = () => {
  const [active, setActive] = useState<ActivePrompt | null>(null)
  const resolverRef = useRef<ActivePrompt['resolve'] | null>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const { isAuthenticated, isLoading, user } = useAuth()
  const canConnectBunny = !isLoading && isAuthenticated && user?.role === 'admin' &&
    hasModuleAccess(user, 'settings_integrations', 'write')

  useEffect(() => registerMediaStorageQuotaPromptHandler((prompt) => new Promise((resolve) => {
    resolverRef.current = resolve
    setActive({ prompt, resolve })
  })), [])

  useEffect(() => () => {
    resolverRef.current?.('cancel')
    resolverRef.current = null
  }, [])

  if (!active) return null

  const { prompt } = active
  const blocked = !prompt.allowed
  const usedIncludingReservations = prompt.usedBytes + prompt.reservedBytes
  const usageLabel = `${formatBytes(usedIncludingReservations)} de ${formatBytes(prompt.quotaBytes)}`
  const percent = Math.max(
    0,
    Math.round(Math.max(prompt.usagePercent ?? 0, prompt.projectedUsagePercent ?? 0))
  )
  const projectedNotice = (prompt.projectedUsagePercent ?? 0) > (prompt.usagePercent ?? 0)
    ? ` Esta subida llevaría el uso a ${Math.round(prompt.projectedUsagePercent || 0)}%.`
    : ''
  const finish = (decision: MediaStorageQuotaDecision) => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setActive(null)
    resolve?.(decision)
  }
  const openBunnySettings = () => {
    finish('connect')
    navigate(prompt.connectPath || '/settings/bunny')
  }

  const title = blocked ? 'Tu almacenamiento está lleno' : 'Tu almacenamiento ya casi se acaba'
  const message = blocked
    ? canConnectBunny
      ? `Ya no cabe esta subida dentro del GB incluido. Crea una cuenta en Bunny.net y conéctala para que las cargas nuevas usen tu propio almacenamiento.`
      : `Ya no cabe esta subida dentro del GB incluido. Pídele al administrador de la cuenta que conecte una cuenta de Bunny.net para recuperar las cargas.`
    : canConnectBunny
      ? `Estás usando ${usageLabel}.${projectedNotice} Este aviso aparecerá en cada intento de subida mientras quede 10% o menos. Puedes continuar con el espacio restante o conectar tu propia cuenta de Bunny.net.`
      : `Estás usando ${usageLabel}.${projectedNotice} Este aviso aparecerá en cada intento de subida mientras quede 10% o menos. Puedes continuar por ahora; pídele al administrador que conecte Bunny.net.`

  if (blocked && !canConnectBunny) {
    return (
      <Modal
        isOpen
        onClose={() => finish('cancel')}
        title={title}
        subtitle={`${percent}% utilizado`}
        message={message}
        type="info"
        confirmText="Entendido"
        showCloseButton={false}
        closeOnBackdropClick={false}
        closeOnEscape={false}
        draggableSheet={isPhoneAppPath(location.pathname)}
      />
    )
  }

  return (
    <Modal
      isOpen
      onClose={() => finish('cancel')}
      title={title}
      subtitle={`${percent}% utilizado`}
      message={message}
      type="confirm"
      confirmText={canConnectBunny ? 'Conectar Bunny.net' : 'Continuar subida'}
      cancelText={blocked ? 'Cerrar' : 'Cancelar subida'}
      secondaryActionText={!blocked && canConnectBunny ? 'Continuar subida' : undefined}
      secondaryActionVariant="secondary"
      onConfirm={() => {
        if (canConnectBunny) openBunnySettings()
        else finish('continue')
      }}
      onSecondaryAction={!blocked && canConnectBunny ? () => finish('continue') : undefined}
      showCloseButton={false}
      closeOnBackdropClick={false}
      closeOnEscape={false}
      draggableSheet={isPhoneAppPath(location.pathname)}
    />
  )
}

export default MediaStorageQuotaPrompt
