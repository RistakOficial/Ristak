import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LayoutTemplate, Plus, Sparkles } from 'lucide-react'
import { useNotification } from '@/contexts/NotificationContext'
import automationsService from '@/services/automationsService'
import { AutomationLibrary } from './AutomationLibrary'
import styles from './editor/AutomationEditor.module.css'

// Generador local de ids (mismo formato que el editor, sin importar su grafo)
const genId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/**
 * Página principal de Automatizaciones: librería de archivos a la izquierda
 * (carpetas y flujos, como un explorador) y un lanzador simple para crear
 * una automatización desde cero, plantilla o con IA.
 */

/** Flujo de la plantilla "Bienvenida": respuesta del cliente → WhatsApp */
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
              type: 'trigger-customer-replied',
              config: { channel: 'any', keywords: [], match: 'contains' }
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

export const AutomationsHome: React.FC = () => {
  const navigate = useNavigate()
  const { showToast } = useNotification()
  const [creating, setCreating] = useState<'blank' | 'template' | null>(null)

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

  return (
    <div className={styles.homeShell}>
      <AutomationLibrary />

      <main className={styles.homeMain}>
        <div className={styles.homeContent}>
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
