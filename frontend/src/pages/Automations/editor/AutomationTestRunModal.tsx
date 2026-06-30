import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Play, UserPlus } from 'lucide-react'
import { Button, ContactSearchInput, Modal, SegmentTabs } from '@/components/common'
import type { ContactSearchInputContact } from '@/components/common/ContactSearchInput/ContactSearchInput'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, { type AutomationTestRunResult } from '@/services/automationsService'
import styles from './AutomationEditor.module.css'

type TestContactMode = 'existing' | 'new'

interface AutomationTestRunModalProps {
  automationId: string
  automationName: string
  open: boolean
  onClose: () => void
  onTested?: (result: AutomationTestRunResult) => void
  onOpenRecords?: () => void
}

const EMPTY_TEST_CONTACT = {
  name: '',
  email: '',
  phone: ''
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
  const [mode, setMode] = useState<TestContactMode>('existing')
  const [selectedContact, setSelectedContact] = useState<ContactSearchInputContact | null>(null)
  const [draftContact, setDraftContact] = useState(EMPTY_TEST_CONTACT)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AutomationTestRunResult | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('existing')
    setSelectedContact(null)
    setDraftContact(EMPTY_TEST_CONTACT)
    setRunning(false)
    setError('')
    setResult(null)
  }, [automationId, open])

  const canRun = useMemo(() => {
    if (running) return false
    if (mode === 'existing') return Boolean(selectedContact)
    return Boolean(draftContact.email.trim() || draftContact.phone.trim())
  }, [draftContact.email, draftContact.phone, mode, running, selectedContact])

  const updateDraftContact = (field: keyof typeof EMPTY_TEST_CONTACT, value: string) => {
    setDraftContact((current) => ({ ...current, [field]: value }))
    setError('')
  }

  const buildTestPayload = () => {
    if (mode === 'existing') {
      if (!selectedContact) throw new Error('Elige un contacto para la prueba')
      return { contactId: selectedContact.id }
    }

    const name = draftContact.name.trim() || 'Contacto de prueba'
    const email = draftContact.email.trim()
    const phone = draftContact.phone.trim()

    if (!email && !phone) {
      throw new Error('Agrega al menos correo o teléfono para el contacto de prueba')
    }

    return {
      contact: {
        name,
        email: email || undefined,
        phone: phone || undefined
      }
    }
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
        Usa la versión publicada. Si el flujo envía mensajes, cambia etiquetas o ejecuta acciones,
        lo hará sobre el contacto elegido.
      </div>

      <SegmentTabs
        tabs={[
          { id: 'existing', label: 'Contacto existente' },
          { id: 'new', label: 'Contacto de prueba', icon: <UserPlus size={14} /> }
        ]}
        value={mode}
        onChange={(nextMode) => {
          setMode(nextMode as TestContactMode)
          setError('')
          setResult(null)
        }}
        aria-label="Tipo de contacto para prueba"
      />

      {mode === 'existing' ? (
        <div className={styles.testRunSection}>
          <ContactSearchInput
            value={selectedContact}
            onChange={(contact) => {
              setSelectedContact(contact)
              setError('')
              setResult(null)
            }}
            placeholder="Buscar/crear contacto"
            disabled={running}
          />
        </div>
      ) : (
        <div className={styles.testRunFields}>
          <label className={styles.testRunField}>
            <span>Nombre</span>
            <input
              value={draftContact.name}
              onChange={(event) => updateDraftContact('name', event.target.value)}
              placeholder="Contacto de prueba"
              disabled={running}
              autoComplete="off"
            />
          </label>
          <label className={styles.testRunField}>
            <span>Correo</span>
            <input
              type="email"
              value={draftContact.email}
              onChange={(event) => updateDraftContact('email', event.target.value)}
              placeholder="prueba@cliente.com"
              disabled={running}
              autoComplete="off"
            />
          </label>
          <label className={styles.testRunField}>
            <span>Teléfono</span>
            <input
              type="tel"
              value={draftContact.phone}
              onChange={(event) => updateDraftContact('phone', event.target.value)}
              placeholder="+52 656 000 0000"
              disabled={running}
              autoComplete="off"
            />
          </label>
        </div>
      )}

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
