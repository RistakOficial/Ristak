import { fork } from 'node:child_process'
import { ATTACHMENT_PREVIEW_MAX_BYTES } from '../mcp/attachmentConstants.js'

let activePreviews = 0
export function buildChatAttachmentPreview(buffer, { kind, page = 1, pageCount = 3 } = {}) {
  if (buffer.length > ATTACHMENT_PREVIEW_MAX_BYTES) return Promise.resolve({ error: 'El archivo supera los 15 MB de vista previa. Abre el original.' })
  if (activePreviews >= 2) return Promise.resolve({ error: 'El visor está ocupado. Intenta abrir el adjunto de nuevo.' })
  activePreviews += 1
  return new Promise((resolve) => {
    let worker
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker?.kill('SIGKILL')
      activePreviews -= 1
      resolve(result)
    }
    try {
      worker = fork(new URL('./chatAttachmentPreview.process.js', import.meta.url), {
        execArgv: ['--max-old-space-size=128'], serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        // The renderer needs no database, account, provider or OAuth credentials.
        env: { PATH: process.env.PATH, NODE_ENV: 'production' }
      })
      timer = setTimeout(() => finish({ error: 'La vista previa tardó demasiado. Abre el original.' }), 20000)
      worker.once('message', finish)
      worker.once('error', () => finish({ error: 'No se pudo generar la vista previa. Abre el original.' }))
      worker.once('exit', () => finish({ error: 'La vista previa se interrumpió. Abre el original.' }))
      worker.send({ bytes: buffer, kind, page, pageCount }, error => {
        if (error) finish({ error: 'No se pudo cargar el archivo en el visor.' })
      })
    } catch {
      void finish({ error: 'El visor no está disponible. Abre el original.' })
    }
  })
}
