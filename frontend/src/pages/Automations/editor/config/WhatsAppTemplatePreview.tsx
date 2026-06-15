import React, { useEffect, useState } from 'react'
import { ExternalLink, Image, Loader2, Phone, Reply, Video, FileText } from 'lucide-react'
import { getWhatsAppTemplate } from '@/services/automationCatalogsService'
import type { WhatsAppApiTemplate } from '@/services/whatsappApiService'
import styles from '../AutomationEditor.module.css'

/**
 * Muestra EXACTAMENTE qué envía una plantilla aprobada de WhatsApp:
 * encabezado, cuerpo (con sus variables {{1}}), pie y botones — para no
 * automatizar a ciegas.
 */

interface Component {
  type?: string
  format?: string
  text?: string
  buttons?: Array<{ type?: string; text?: string; url?: string; phone_number?: string }>
}

/** Resalta las variables {{1}} de la plantilla como chips */
const TemplateText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\{\{\s*\d+\s*\}\})/g)
  return (
    <>
      {parts.map((part, index) =>
        /^\{\{\s*\d+\s*\}\}$/.test(part) ? (
          <span key={index} className={styles.templateVarChip}>
            {part.replace(/[{}\s]/g, '') ? `Variable ${part.replace(/[{}\s]/g, '')}` : part}
          </span>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  )
}

/** Carga la plantilla completa (undefined = cargando, null = no encontrada) */
export function useWhatsAppTemplate(templateId: string): WhatsAppApiTemplate | null | undefined {
  const [template, setTemplate] = useState<WhatsAppApiTemplate | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setTemplate(undefined)
    if (!templateId) {
      setTemplate(null)
      return
    }
    void getWhatsAppTemplate(templateId).then((data) => {
      if (!cancelled) setTemplate(data)
    })
    return () => {
      cancelled = true
    }
  }, [templateId])
  return template
}

/** Extrae del template lo que el usuario debe llenar */
export function templateInputs(template: WhatsAppApiTemplate | null | undefined): {
  variables: string[]
  headerFormat: string
} {
  if (!template) return { variables: [], headerFormat: '' }
  const components = (template.components || []) as Component[]
  const header = components.find((component) => String(component.type).toUpperCase() === 'HEADER')
  const body = components.find((component) => String(component.type).toUpperCase() === 'BODY')
  const text = `${header?.text || ''}\n${body?.text || ''}`
  const variables = [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((match) => match[1]))]
  const headerFormat = String(header?.format || '').toUpperCase()
  return { variables, headerFormat: headerFormat === 'TEXT' ? '' : headerFormat }
}

export const WhatsAppTemplatePreview: React.FC<{ templateId: string }> = ({ templateId }) => {
  const template = useWhatsAppTemplate(templateId)

  if (!templateId) return null
  if (template === undefined) {
    return (
      <div className={styles.templatePreviewLoading}>
        <Loader2 size={12} className="animate-spin" /> Cargando vista previa…
      </div>
    )
  }
  if (template === null) {
    return <div className={styles.templatePreviewLoading}>No se encontró el contenido de la plantilla.</div>
  }

  const components = (template.components || []) as Component[]
  const header = components.find((component) => String(component.type).toUpperCase() === 'HEADER')
  const body = components.find((component) => String(component.type).toUpperCase() === 'BODY')
  const footer = components.find((component) => String(component.type).toUpperCase() === 'FOOTER')
  const buttons = components.find((component) => String(component.type).toUpperCase() === 'BUTTONS')?.buttons || []

  const headerFormat = String(header?.format || '').toUpperCase()

  return (
    <div className={styles.templatePreview}>
      <div className={styles.templatePreviewBubble}>
        {header && headerFormat !== 'TEXT' && headerFormat && (
          <div className={styles.templatePreviewMedia}>
            {headerFormat === 'IMAGE' && <Image size={13} />}
            {headerFormat === 'VIDEO' && <Video size={13} />}
            {headerFormat === 'DOCUMENT' && <FileText size={13} />}
            {headerFormat === 'IMAGE' ? 'Imagen' : headerFormat === 'VIDEO' ? 'Video' : 'Documento'} del encabezado
          </div>
        )}
        {header?.text && headerFormat === 'TEXT' && (
          <div className={styles.templatePreviewHeader}>
            <TemplateText text={header.text} />
          </div>
        )}
        {body?.text && (
          <div className={styles.templatePreviewBody}>
            <TemplateText text={body.text} />
          </div>
        )}
        {footer?.text && <div className={styles.templatePreviewFooter}>{footer.text}</div>}
      </div>

      {buttons.length > 0 && (
        <div className={styles.templatePreviewButtons}>
          {buttons.map((button, index) => {
            const kind = String(button.type || '').toUpperCase()
            return (
              <span key={index} className={styles.templatePreviewButton}>
                {kind === 'URL' && <ExternalLink size={11} />}
                {kind === 'PHONE_NUMBER' && <Phone size={11} />}
                {kind === 'QUICK_REPLY' && <Reply size={11} />}
                {button.text || button.url || 'Botón'}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
