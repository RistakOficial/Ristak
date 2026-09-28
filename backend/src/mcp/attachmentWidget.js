import { readFile } from 'node:fs/promises'
import { ATTACHMENT_WIDGET_URI } from './attachmentConstants.js'

export const attachmentWidgetDefinition = Object.freeze({
  uri: ATTACHMENT_WIDGET_URI, name: 'ristak-chat-attachment', title: 'Visor de adjuntos de Ristak',
  mimeType: 'text/html;profile=mcp-app', description: 'Imágenes, PDFs paginados, audio, video y descarga del archivo original.'
})
const html = readFile(new URL('./ui/chat-attachment.html', import.meta.url), 'utf8')
export async function readAttachmentWidget(origin) {
  const allowedOrigin = new URL(origin).origin
  return { contents: [{ ...attachmentWidgetDefinition, text: await html,
    _meta: {
      ui: { prefersBorder: true, csp: { resourceDomains: [allowedOrigin], connectDomains: [] } },
      'openai/widgetDescription': 'Visor del adjunto seleccionado. PDFs como páginas legibles, imágenes, reproductor y descarga temporal.',
      'openai/widgetCSP': { resource_domains: [allowedOrigin], connect_domains: [], redirect_domains: [allowedOrigin] }
    }
  }] }
}
