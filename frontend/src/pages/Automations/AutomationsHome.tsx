import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutTemplate, Play, Plus, Sparkles } from 'lucide-react'
import { Button, ContactSearchInput, CustomSelect } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService, {
  AUTOMATION_STATUS_LABELS,
  automationsCache,
  type AutomationSummary,
  type AutomationTestRunResult
} from '@/services/automationsService'
import type { Contact } from '@/types'
import { createRistakId } from '@/utils/idGenerator'
import { AutomationLibrary } from './AutomationLibrary'
import styles from './editor/AutomationEditor.module.css'

// Generador local de ids (mismo formato que el editor, sin importar su grafo)
const genId = (prefix: string) => createRistakId(prefix)

/**
 * Página principal de Automatizaciones: librería de archivos a la izquierda
 * (carpetas y flujos, como un explorador) y un lanzador simple para crear
 * una automatización desde cero, plantilla o con IA.
 */

/** Flujo de la plantilla "Bienvenida": mensaje de WhatsApp → WhatsApp */
function welcomeTemplateFlow() {
  const whatsappId = genId('node')
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 200 },
        config: {
          triggers: [
            {
              id: genId('trig'),
              type: 'trigger-whatsapp-message',
              config: { filters: [] }
            }
          ]
        }
      },
      {
        id: whatsappId,
        type: 'channel-whatsapp',
        label: 'WhatsApp',
        position: { x: 560, y: 184 },
        config: {
          sender: 'default',
          messageType: 'text',
          messageBlocks: [
            {
              id: genId('blk'),
              type: 'text',
              compiledText: '¡Hola {{contact.first_name}}! 👋 Gracias por escribirnos. ¿En qué podemos ayudarte?',
              buttons: [],
              quickReplies: []
            }
          ],
          extraBranches: []
        }
      }
    ],
    edges: [
      {
        id: genId('edge'),
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: whatsappId,
        targetHandle: 'in',
        animated: true
      }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  }
}

function enrollmentStatusLabel(status?: string | null) {
  switch (status) {
    case 'active':
      return 'Activa'
    case 'waiting':
      return 'Esperando'
    case 'completed':
      return 'Completada'
    case 'exited':
      return 'Detenida'
    case 'goal_met':
      return 'Meta cumplida'
    default:
      return status || 'Sin estado'
  }
}

export const AutomationsHome: React.FC = () => {
  const navigate = useNavigate()
  const { showToast } = useNotification()
  const [creating, setCreating] = useState<'blank' | 'template' | null>(null)
  const [automations, setAutomations] = useState<AutomationSummary[]>(
    automationsCache.overview?.automations || []
  )
  const [loadingAutomations, setLoadingAutomations] = useState(!automationsCache.overview)
  const [selectedAutomationId, setSelectedAutomationId] = useState('')
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<AutomationTestRunResult | null>(null)

  useEffect(() => {
    let active = true

    automationsService
      .getOverview()
      .then((overview) => {
        if (!active) return
        setAutomations(overview.automations)
      })
      .catch(() => {
        if (active) showToast('error', 'No se pudieron cargar las automatizaciones')
      })
      .finally(() => {
        if (active) setLoadingAutomations(false)
      })

    return () => {
      active = false
    }
  }, [showToast])

  const publishedAutomations = useMemo(
    () => automations.filter((automation) => automation.status === 'published'),
    [automations]
  )

  const automationOptions = useMemo(
    () =>
      automations.map((automation) => ({
        value: automation.id,
        label: `${automation.name} · ${AUTOMATION_STATUS_LABELS[automation.status]}`,
        disabled: automation.status !== 'published'
      })),
    [automations]
  )

  useEffect(() => {
    if (selectedAutomationId) {
      const selected = automations.find((automation) => automation.id === selectedAutomationId)
      if (selected?.status === 'published') return
    }
    setSelectedAutomationId(publishedAutomations[0]?.id || '')
  }, [automations, publishedAutomations, selectedAutomationId])

  const createBlank = async () => {
    setCreating('blank')
    try {
      const automation = await automationsService.createAutomation({ name: 'Automatización sin título' })
      navigate(`/automations/${automation.id}`)
    } catch {
      showToast('error', 'No se pudo crear la automatización')
      setCreating(null)
    }
  }

  const createFromTemplate = async () => {
    setCreating('template')
    try {
      const automation = await automationsService.createAutomation({ name: 'Bienvenida automática' })
      await automationsService.updateAutomation(automation.id, { flow: welcomeTemplateFlow() })
      showToast('success', 'Plantilla creada', 'Personaliza el mensaje de bienvenida')
      navigate(`/automations/${automation.id}`)
    } catch {
      showToast('error', 'No se pudo crear desde la plantilla')
      setCreating(null)
    }
  }

  const runAutomationTest = async () => {
    const automation = automations.find((item) => item.id === selectedAutomationId)
    if (!automation) {
      showToast('warning', 'Elige una automatización')
      return
    }
    if (automation.status !== 'published') {
      showToast('warning', 'Publica la automatización antes de probarla')
      return
    }
    if (!selectedContact) {
      showToast('warning', 'Elige o crea un contacto de prueba')
      return
    }

    setTestRunning(true)
    setTestResult(null)
    try {
      const result = await automationsService.testAutomation(automation.id, { contactId: selectedContact.id })
      setTestResult(result)
      showToast('success', 'Prueba iniciada', `${result.contactName} entró a ${result.automationName}`)
    } catch (error) {
      showToast('error', 'No se pudo probar la automatización', error instanceof Error ? error.message : 'Intenta otra vez')
    } finally {
      setTestRunning(false)
    }
  }

  const recentLog = testResult?.enrollment.log?.slice(-4) || []
  const canRunTest = Boolean(selectedAutomationId && selectedContact && !testRunning)

  return (
    <div className={styles.homeShell}>
      <AutomationLibrary />

      <main className={styles.homeMain}>
        <div className={styles.homeContent}>
          <section className={styles.automationTestPanel} aria-labelledby="automation-test-title">
            <div className={styles.automationTestHeader}>
              <div>
                <p className={styles.automationTestEyebrow}>Prueba rápida</p>
                <h2 id="automation-test-title">Probar automatización</h2>
              </div>
              {testResult && (
                <span className={styles.automationTestStatus}>
                  {enrollmentStatusLabel(testResult.enrollment.status)}
                </span>
              )}
            </div>

            <div className={styles.automationTestControls}>
              <label className={styles.automationTestField}>
                <span>Automatización</span>
                <CustomSelect
                  portal
                  size="large"
                  options={automationOptions}
                  value={selectedAutomationId}
                  onValueChange={(value) => {
                    setSelectedAutomationId(value)
                    setTestResult(null)
                  }}
                  placeholder={loadingAutomations ? 'Cargando...' : 'Elige una automatización publicada'}
                  disabled={loadingAutomations || automationOptions.length === 0 || testRunning}
                  aria-label="Automatización para prueba"
                />
              </label>

              <div className={styles.automationTestContact}>
                <ContactSearchInput
                  value={selectedContact}
                  onChange={(contact) => {
                    setSelectedContact(contact)
                    setTestResult(null)
                  }}
                  placeholder="Buscar/crear contacto"
                  disabled={testRunning}
                />
              </div>

              <Button
                className={styles.automationTestButton}
                type="button"
                leftIcon={<Play size={15} />}
                loading={testRunning}
                disabled={!canRunTest}
                onClick={() => void runAutomationTest()}
              >
                Probar
              </Button>
            </div>

            {!loadingAutomations && automations.length > 0 && publishedAutomations.length === 0 && (
              <p className={styles.automationTestHint}>
                Publica una automatización para poder correr una prueba.
              </p>
            )}

            {testResult && (
              <div className={styles.automationTestResult} role="status" aria-live="polite">
                <div className={styles.automationTestResultMain}>
                  <span>{testResult.contactName}</span>
                  <span>{testResult.automationName}</span>
                  <span>{new Date(testResult.testedAt).toLocaleString('es-MX')}</span>
                </div>
                {recentLog.length > 0 && (
                  <ol className={styles.automationTestLog}>
                    {recentLog.map((entry, index) => (
                      <li key={`${entry.nodeId}-${entry.at || index}`}>
                        <span>{entry.label || entry.nodeId}</span>
                        <p>{entry.detail || enrollmentStatusLabel(entry.status)}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </section>

          <h1 className={styles.homeTitle}>Automatizaciones</h1>
          <p className={styles.homeSubtitle}>
            Crea flujos que responden y dan seguimiento a tus contactos por WhatsApp, Messenger e
            Instagram. Abre una automatización desde la librería de la izquierda o crea una nueva:
          </p>

          <div className={styles.homeCards}>
            <button
              type="button"
              className={styles.homeCard}
              disabled={creating !== null}
              onClick={() => void createBlank()}
            >
              <span className={styles.homeCardIcon} data-accent="blue">
                <Plus size={20} />
              </span>
              <span className={styles.homeCardTitle}>En blanco</span>
              <span className={styles.homeCardDescription}>
                Empieza desde cero con la tarjeta "Cuando..." y arma tu flujo paso a paso
              </span>
            </button>

            <button
              type="button"
              className={styles.homeCard}
              disabled={creating !== null}
              onClick={() => void createFromTemplate()}
            >
              <span className={styles.homeCardIcon} data-accent="green">
                <LayoutTemplate size={20} />
              </span>
              <span className={styles.homeCardTitle}>Desde plantilla</span>
              <span className={styles.homeCardDescription}>
                Bienvenida automática: responde por WhatsApp cuando un cliente te escribe
              </span>
            </button>

            <button
              type="button"
              className={styles.homeCard}
              onClick={() =>
                showToast('info', 'Próximamente', 'Describe tu flujo y la IA lo armará por ti')
              }
            >
              <span className={styles.homeCardIcon} data-accent="purple">
                <Sparkles size={20} />
              </span>
              <span className={styles.homeCardTitle}>
                Con IA
                <span className={styles.newBadge}>PRONTO</span>
              </span>
              <span className={styles.homeCardDescription}>
                Cuéntale a la IA qué quieres automatizar y genera el flujo completo
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
