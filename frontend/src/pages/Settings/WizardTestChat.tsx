import React, { useEffect, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, Video } from 'lucide-react'
import {
  PhoneChatPreview,
  PhoneChatPreviewAttachmentMenu,
  PhoneChatPreviewComposer,
  PhoneChatPreviewDraftAttachments,
  PhoneChatPreviewEmojiPicker,
  PhoneChatPreviewVoiceComposer,
  type PhoneChatPreviewAttachment,
  type PhoneChatPreviewMessage
} from '@/components/phone/PhoneChatPreview'
import { useNotification } from '@/contexts/NotificationContext'
import {
  conversationalAgentService,
  type ConversationalAgentDefInput,
  type ConversationalAgentTestAttachment,
  type ConversationalAgentTestMessage,
  type ConversationalAgentTestResult
} from '@/services/conversationalAgentService'
import { describeConversationalPreviewAction } from './conversationalPreviewAction'

const MAX_ATTACHMENTS = 6
const MAX_BYTES = 18 * 1024 * 1024
const MIN_VOICE_MS = 600
const MAX_VOICE_MS = 120_000
const PHOTO_ACCEPT = 'image/*'
const VIDEO_ACCEPT = 'video/*'
const FILE_ACCEPT = [
  'audio/*', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.json',
  'application/pdf', 'text/plain', 'text/csv', 'application/json'
].join(',')
const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'md', 'html', 'xml'])
const STATIC_BARS = Array.from({ length: 28 }, (_, i) => 6 + (i % 5) * 4)

function createWizardTestTrackingId(kind: 'agent' | 'session' | 'message') {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  return `wizard-test-${kind}-${random}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 160)
}

type DraftAttachment = ConversationalAgentTestAttachment & { id: string }
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: DraftAttachment[]
  internal?: boolean
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'))
    reader.readAsDataURL(file)
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el texto'))
    reader.readAsText(file)
  })
}

function getExtension(name: string) {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function inferKind(file: File): DraftAttachment['kind'] {
  const mime = file.type.toLowerCase()
  const ext = getExtension(file.name)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXTENSIONS.has(ext)) return 'text'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'document'
  return 'file'
}

async function createAttachment(file: File): Promise<DraftAttachment> {
  const kind = inferKind(file)
  const dataUrl = await readFileAsDataUrl(file)
  const text = kind === 'text' && file.size <= 200_000 ? await readFileAsText(file) : undefined
  return {
    id: `wz-att-${Date.now()}-${Math.round(performance.now())}-${file.size}`,
    kind,
    name: file.name || `archivo.${getExtension(file.name) || 'bin'}`,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
    ...(text ? { text: text.slice(0, 18_000) } : {})
  }
}

function getSupportedVoiceMime() {
  if (typeof MediaRecorder === 'undefined') return ''
  return VOICE_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) || ''
}

function attachmentLabel(attachments: DraftAttachment[] = []) {
  if (!attachments.length) return ''
  if (attachments.length === 1) {
    const [a] = attachments
    if (a.kind === 'audio') return 'Nota de voz'
    return a.name || 'Archivo'
  }
  return `${attachments.length} archivos`
}

function toPayload(message: ChatMessage): ConversationalAgentTestMessage {
  return {
    role: message.role,
    content: message.content,
    attachments: (message.attachments || []).map((a) => ({
      kind: a.kind, name: a.name, mimeType: a.mimeType, size: a.size,
      dataUrl: a.dataUrl, text: a.text, durationMs: a.durationMs
    }))
  }
}

interface Props {
  getConfig: () => ConversationalAgentDefInput
  agentName: string
  density?: 'regular' | 'compact'
}

export function WizardTestChat({ getConfig, agentName, density = 'regular' }: Props) {
  const { showToast } = useNotification()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceDraft, setVoiceDraft] = useState<DraftAttachment | null>(null)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)

  const composerInputRef = useRef<HTMLInputElement | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const sendAfterStopRef = useRef(false)
  const discardRef = useRef(false)
  const mountedRef = useRef(true)
  // El wizard todavía no tiene un agente guardado, pero su chat sí necesita
  // una identidad estable para conservar de forma aislada la oferta de horario
  // entre el turno donde la muestra y el turno donde la persona la confirma.
  // No habilita efectos reales: sólo identifica este mock dentro del tester.
  const previewAgentIdRef = useRef(createWizardTestTrackingId('agent'))
  const previewSessionIdRef = useRef(createWizardTestTrackingId('session'))

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }
  const clearTimer = () => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
  }
  // Limpia micrófono/grabador al desmontar (el wizard remonta este componente para reiniciar).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimer()
      try { recorderRef.current?.state === 'recording' && recorderRef.current.stop() } catch { /* noop */ }
      stopStream()
    }
  }, [])

  const voicePanelActive = voiceRecording || voiceProcessing || Boolean(voiceDraft)

  const previewMessages: PhoneChatPreviewMessage[] = messages.map((m, i) => ({
    id: `wz-test-${i}`,
    direction: m.internal ? 'system' : m.role === 'user' ? 'outbound' : 'inbound',
    body: m.content || attachmentLabel(m.attachments || []),
    attachments: (m.attachments || []).map((a): PhoneChatPreviewAttachment => ({
      id: a.id, kind: a.kind, name: a.name, mimeType: a.mimeType, size: a.size,
      dataUrl: a.dataUrl, durationMs: a.durationMs
    })),
    internal: m.internal
  }))

  async function submit(opts: { content?: string; attachments?: DraftAttachment[]; clearComposer?: boolean }) {
    const content = String(opts.content ?? '').trim()
    const atts = opts.attachments || []
    if (sending || (!content && atts.length === 0)) return

    const userMessage: ChatMessage = { role: 'user', content, ...(atts.length ? { attachments: atts } : {}) }
    const nextMessages = [...messages.filter((m) => !m.internal), userMessage]

    setMessages((current) => [...current, userMessage])
    setMenuOpen(false)
    setEmojiOpen(false)
    if (opts.clearComposer !== false) {
      setInput('')
      setAttachments([])
    }
    setSending(true)

    try {
      const result: ConversationalAgentTestResult = await conversationalAgentService.testAgent(
        nextMessages.map(toPayload),
        {
          config: getConfig(),
          agentId: previewAgentIdRef.current,
          testSessionId: previewSessionIdRef.current,
          testMessageId: createWizardTestTrackingId('message')
        }
      )
      for (const action of result.actions || []) {
        const actionMessage = describeConversationalPreviewAction(action)
        if (!actionMessage) continue
        setMessages((current) => [
          ...current,
          { role: 'assistant', content: actionMessage, internal: true }
        ])
      }
      const replies = result.replyParts?.length ? result.replyParts : (result.reply ? [result.reply] : [])
      if (replies.length) {
        for (const reply of replies) {
          setMessages((current) => [...current, { role: 'assistant', content: reply }])
        }
      } else {
        setMessages((current) => [...current, { role: 'assistant', content: '⚠︎ La prueba no devolvió una respuesta válida. Vuelve a intentarlo.', internal: true }])
      }
    } catch (error: any) {
      const status = error?.statusCode || error?.status
      const raw = String(error?.message || '')
      const needsAIConnection = status === 409 || /openai|claude|gemini|deepseek|llave|api key/i.test(raw)
      const message = needsAIConnection
        ? 'Conecta la IA seleccionada en Ajustes y vuelve a intentar.'
        : (raw || 'No se pudo probar el agente')
      setMessages((current) => [...current, { role: 'assistant', content: `⚠︎ ${message}`, internal: true }])
      showToast('error', 'No se pudo probar', message)
    } finally {
      setSending(false)
    }
  }

  const sendText = () => {
    if (sending) return
    void submit({ content: input, attachments, clearComposer: true })
  }

  const onAttachmentsChange: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const files = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    if (!files.length || sending) return
    const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length)
    if (slots <= 0) {
      showToast('warning', 'Límite de archivos', `Puedes mandar hasta ${MAX_ATTACHMENTS} adjuntos por mensaje.`)
      return
    }
    const accepted = files.slice(0, slots)
    const oversized = accepted.find((file) => file.size > MAX_BYTES)
    if (oversized) {
      showToast('error', 'Archivo muy pesado', `${oversized.name} supera el límite de 18 MB.`)
      return
    }
    try {
      const created = await Promise.all(accepted.map(createAttachment))
      setAttachments((current) => [...current, ...created].slice(0, MAX_ATTACHMENTS))
    } catch (error: any) {
      showToast('error', 'No se pudo leer el archivo', error?.message || 'Intenta con otro archivo.')
    }
  }

  const pickAttachment = (kind: 'photo' | 'file' | 'video') => {
    if (sending || voicePanelActive) return
    setMenuOpen(false)
    setEmojiOpen(false)
    if (kind === 'photo') photoInputRef.current?.click()
    else if (kind === 'video') videoInputRef.current?.click()
    else fileInputRef.current?.click()
  }

  const selectEmoji = (emoji: string) => {
    if (sending || voicePanelActive) return
    const el = composerInputRef.current
    setInput((current) => {
      if (!el) return `${current}${emoji}`
      const start = el.selectionStart ?? current.length
      const end = el.selectionEnd ?? start
      const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`
      window.requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + emoji.length, start + emoji.length) })
      return next
    })
  }

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') {
      setVoiceProcessing(true)
      recorderRef.current.stop()
    }
  }

  const startRecording = async () => {
    if (sending || voiceRecording || voiceProcessing) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('error', 'Audio no disponible', 'Este navegador no permite grabar notas de voz aquí.')
      return
    }
    setVoiceProcessing(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Si el componente se desmontó mientras el usuario daba permiso, apaga el mic y sal.
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      const mime = getSupportedVoiceMime()
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      setMenuOpen(false)
      setEmojiOpen(false)
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      startedAtRef.current = Date.now()
      sendAfterStopRef.current = false
      discardRef.current = false
      setVoiceDraft(null)
      setVoiceElapsedMs(0)

      recorder.ondataavailable = (event) => { if (event.data?.size) chunksRef.current.push(event.data) }
      recorder.onstop = async () => {
        clearTimer()
        stopStream()
        recorderRef.current = null
        // Si ya se desmontó, solo libera recursos: nada de setState/submit huérfanos.
        if (!mountedRef.current) return
        setVoiceRecording(false)
        setVoiceProcessing(true)
        const durationMs = Math.max(0, Date.now() - startedAtRef.current)
        const chunks = chunksRef.current
        const sendAfterStop = sendAfterStopRef.current
        const discard = discardRef.current
        sendAfterStopRef.current = false
        discardRef.current = false
        if (discard) { setVoiceProcessing(false); return }
        try {
          const type = recorder.mimeType || mime || 'audio/webm'
          const blob = new Blob(chunks, { type })
          if (durationMs < MIN_VOICE_MS || blob.size === 0) {
            showToast('warning', 'Nota muy corta', 'Graba tantito más para que el agente escuche algo útil.')
            return
          }
          if (blob.size > MAX_BYTES) {
            showToast('error', 'Audio muy pesado', 'La nota de voz supera el límite de 18 MB.')
            return
          }
          const dataUrl = await readFileAsDataUrl(blob)
          const attachment: DraftAttachment = {
            id: `wz-voice-${Date.now()}`,
            kind: 'audio',
            name: `nota-de-voz.${type.includes('mp4') ? 'm4a' : 'webm'}`,
            mimeType: type,
            size: blob.size,
            durationMs,
            dataUrl
          }
          if (sendAfterStop) {
            setVoiceDraft(null)
            await submit({ content: '', attachments: [attachment], clearComposer: false })
          } else {
            setVoiceDraft(attachment)
          }
        } catch (error: any) {
          showToast('error', 'No se pudo preparar el audio', error?.message || 'Intenta grabarlo otra vez.')
        } finally {
          setVoiceProcessing(false)
        }
      }

      recorder.start()
      setVoiceRecording(true)
      setVoiceProcessing(false)
      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current
        setVoiceElapsedMs(elapsed)
        if (elapsed >= MAX_VOICE_MS) stopRecording()
      }, 160)
    } catch (error: any) {
      clearTimer()
      stopStream()
      setVoiceRecording(false)
      setVoiceProcessing(false)
      showToast('error', 'No se pudo grabar', error?.message || 'Revisa el permiso del micrófono e intenta de nuevo.')
    }
  }

  const cancelVoice = () => {
    if (voiceRecording) {
      sendAfterStopRef.current = false
      discardRef.current = true
      chunksRef.current = []
      stopRecording()
    }
    audioRef.current?.pause()
    setVoicePlaying(false)
    setVoiceDraft(null)
    setVoiceElapsedMs(0)
  }

  const primaryVoice = () => {
    if (voiceRecording) { stopRecording(); return }
    const audio = audioRef.current
    if (!audio) return
    if (voicePlaying) { audio.pause(); setVoicePlaying(false); return }
    audio.play().then(() => setVoicePlaying(true)).catch(() => showToast('error', 'No se pudo escuchar', 'Toca el audio otra vez.'))
  }

  const sendVoice = () => {
    if (voiceRecording) { sendAfterStopRef.current = true; stopRecording(); return }
    if (!voiceDraft) return
    const attachment = voiceDraft
    setVoiceDraft(null)
    setVoiceElapsedMs(0)
    setVoicePlaying(false)
    void submit({ content: '', attachments: [attachment], clearComposer: false })
  }

  return (
    <PhoneChatPreview
      title={agentName.trim() || 'Tu asistente'}
      subtitle="Modo prueba"
      messages={previewMessages}
      typing={sending}
      emptyText="Escríbele algo para probarlo 👇"
      density={density}
      composer={(
        <>
          <input ref={photoInputRef} type="file" accept={PHOTO_ACCEPT} multiple hidden onChange={onAttachmentsChange} />
          <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple hidden onChange={onAttachmentsChange} />
          <input ref={videoInputRef} type="file" accept={VIDEO_ACCEPT} multiple hidden onChange={onAttachmentsChange} />
          <PhoneChatPreviewAttachmentMenu
            open={menuOpen}
            actions={[
              { id: 'photo', label: 'Mandar foto', icon: <ImageIcon size={29} />, onClick: () => pickAttachment('photo') },
              { id: 'file', label: 'Mandar archivo', icon: <FileText size={29} />, onClick: () => pickAttachment('file') },
              { id: 'video', label: 'Mandar video', icon: <Video size={29} />, onClick: () => pickAttachment('video') }
            ]}
          />
          <PhoneChatPreviewEmojiPicker open={emojiOpen} onSelect={selectEmoji} />
          <PhoneChatPreviewDraftAttachments
            attachments={attachments.map((a) => ({ id: a.id, kind: a.kind, name: a.name, mimeType: a.mimeType, size: a.size, dataUrl: a.dataUrl, durationMs: a.durationMs }))}
            onRemove={(id) => setAttachments((current) => current.filter((a) => a.id !== id))}
          />
          <PhoneChatPreviewComposer
            inputRef={composerInputRef}
            value={input}
            placeholder="Ejemplo: Hola, quiero agendar"
            controlsDisabled={sending}
            sendDisabled={sending || (!input.trim() && attachments.length === 0)}
            hasDraftContent={attachments.length > 0}
            onChange={setInput}
            onSend={sendText}
            onAttach={() => { if (!sending && !voicePanelActive) { setEmojiOpen(false); setMenuOpen((v) => !v) } }}
            onEmoji={() => { if (!sending && !voicePanelActive) { setMenuOpen(false); setEmojiOpen((v) => !v) } }}
            onVoice={startRecording}
            emojiOpen={emojiOpen}
            recording={voiceRecording}
            voicePanel={voicePanelActive ? (
              <PhoneChatPreviewVoiceComposer
                recording={voiceRecording}
                processing={voiceProcessing}
                playing={voicePlaying}
                durationMs={voiceDraft?.durationMs || voiceElapsedMs}
                bars={STATIC_BARS}
                audioSrc={voiceDraft?.dataUrl}
                audioRef={audioRef}
                onCancel={cancelVoice}
                onPrimary={primaryVoice}
                onSend={sendVoice}
                onAudioEnded={() => setVoicePlaying(false)}
                onAudioPause={() => setVoicePlaying(false)}
                onAudioPlay={() => setVoicePlaying(true)}
              />
            ) : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.stopPropagation()
                sendText()
              }
            }}
          />
        </>
      )}
    />
  )
}
