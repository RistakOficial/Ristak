import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Play } from 'lucide-react'
import { Button, ContactSearchInput, Modal } from '@/components/common'
import type { ContactSearchInputContact } from '@/components/common/ContactSearchInput/ContactSearchInput'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, { type AutomationTestRunResult } from '@/services/automationsService'
import styles from './AutomationEditor.module.css'

interface AutomationTestRunModalProps {
  automationId: string
  automationName: string
  open: boolean
  onClose: () => void
  onTested?: (result: AutomationTestRunResult) => void
  onOpenRecords?: () => void
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'No se pudo probar la automatización'
}

export const AutomationTestRunModal: React.FC<AutomationTestRunModalProps> = ({
  automationId,
  automationName,
  open,
  onClose,
  onTested,
  onOpenRecords
}) => {
  const { showToast } = useNotification()
  const [selectedContact, setSelectedContact] = useState<ContactSearchInputContact | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AutomationTestRunResult | null>(null)

  useEffect(() => {
    if (!open) return
    setSelectedContact(null)
    setRunning(false)
    setError('')
    setResult(null)
  }, [automationId, open])

  const canRun = useMemo(() => {
    if (running) return false
    return Boolean(selectedContact)
  }, [running, selectedContact])

  const buildTestPayload = () => {
    if (!selectedContact) throw new Error('Elige un contacto para la prueba')
    return { contactId: selectedContact.id }
  }

  const runTest = async () => {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const nextResult = await automationsService.testAutomation(automationId, buildTestPayload())
      setResult(nextResult)
      onTested?.(nextResult)
      showToast('success', 'Prueba iniciada', `${nextResult.contactName} entró a ${automationName}`)
    } catch (runError) {
      setError(getErrorMessage(runError))
    } finally {
      setRunning(false)
    }
  }

  const recentLog = result?.enrollment.log?.slice(-4) || []

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Probar automatización"
      subtitle={automationName}
      size="md"
      contentClassName={styles.testRunContent}
    >
      <div className={styles.testRunNotice}>
        Usa la última versión guardada. Si el flujo envía mensajes, cambia etiquetas o ejecuta acciones,
        lo hará sobre el contacto elegido.
      </div>

      <div className={styles.testRunSection}>
        <ContactSearchInput
          value={selectedContact}
          onChange={(contact) => {
            setSelectedContact(contact)
            setError('')
            setResult(null)
          }}
          placeholder="Buscar o crear contacto"
          disabled={running}
          portal
        />
      </div>

      {error && <p className={styles.testRunError}>{error}</p>}

      {result && (
        <div className={styles.testRunResult} role="status" aria-live="polite">
          <div className={styles.testRunResultHeader}>
            <CheckCircle2 size={16} />
            <div>
              <strong>Prueba disparada</strong>
              <p>{result.contactName} entró a la automatización.</p>
            </div>
          </div>

          {recentLog.length > 0 && (
            <ol className={styles.testRunLog}>
              {recentLog.map((entry, index) => (
                <li key={`${entry.nodeId}-${entry.at || index}`}>
                  <span>{entry.label || entry.nodeId}</span>
                  <p>{entry.detail || entry.status || 'Ejecutado'}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className={styles.testRunActions}>
        <Button type="button" variant="secondary" onClick={onClose} disabled={running}>
          Cerrar
        </Button>
        {result && onOpenRecords && (
          <Button type="button" variant="secondary" onClick={onOpenRecords} disabled={running}>
            Ver registros
          </Button>
        )}
        <Button
          type="button"
          leftIcon={<Play size={15} />}
          loading={running}
          disabled={!canRun}
          onClick={() => void runTest()}
        >
          Probar
        </Button>
      </div>
    </Modal>
  )
}
