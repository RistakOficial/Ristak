import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const desktopChatSource = () => readFile(
  join(repoRoot, 'frontend/src/pages/DesktopChat/DesktopChat.tsx'),
  'utf8'
)

test('DesktopChat permite grabar voz en Meta nativo o HighLevel sin exigir telefono de WhatsApp', async () => {
  const source = await desktopChatSource()
  const start = source.indexOf('const startVoiceRecording = useCallback')
  const end = source.indexOf('const stopVoiceRecording = useCallback', start)

  assert.ok(start >= 0 && end > start, 'No se encontro la ruta de grabacion de voz de DesktopChat')
  const recordingSource = source.slice(start, end)

  assert.match(source, /const activeNativeMetaChannel:[^=]+=[\s\S]*?composerChannel === 'messenger' && metaMessengerConnected[\s\S]*?composerChannel === 'instagram' && metaInstagramConnected/)
  assert.match(source, /const socialVoiceChannelReady = Boolean\([\s\S]*?activeNativeMetaChannel[\s\S]*?highLevelConnected/)
  assert.match(recordingSource, /if \(composerChannel === 'messenger' \|\| composerChannel === 'instagram'\) \{[\s\S]*?if \(!socialVoiceChannelReady\)/)
  assert.match(recordingSource, /if \(!whatsappConnected && !selectedQrReady\)/)
})

test('DesktopChat envia voz y audio de Meta por sendMetaSocialAudio y conserva HighLevel y WhatsApp', async () => {
  const source = await desktopChatSource()
  const start = source.indexOf('const handleSendMessage = async')
  const end = source.indexOf('const handleReactToMessage = async', start)

  assert.ok(start >= 0 && end > start, 'No se encontro la ruta de envio de DesktopChat')
  const sendSource = source.slice(start, end)

  assert.match(sendSource, /const sendVoiceThroughNativeMeta = Boolean\(voiceToSend && activeNativeMetaChannel\)/)
  assert.match(sendSource, /const nativeMetaAudioAttachment =[\s\S]*?getDraftAttachmentMessageType\(attachmentsToSend\[0\]\) === 'audio'/)
  assert.match(sendSource, /whatsappApiService\.sendMetaSocialAudio\(\{\s*contactId: activeContact\.id,\s*platform: activeNativeMetaChannel,\s*audioDataUrl: nativeMetaAudio\.dataUrl,\s*durationMs: nativeMetaAudioDurationMs,\s*voice: Boolean\(sendVoiceThroughNativeMeta\),\s*externalId: nativeMetaOptimisticId\s*\}\)/)
  assert.match(sendSource, /voiceToSend && sendVoiceThroughHighLevel[\s\S]*?highLevelService\.sendConversationMessage\(\{[\s\S]*?audioDataUrl: voiceToSend\.dataUrl[\s\S]*?durationMs: voiceToSend\.durationMs/)
  assert.match(sendSource, /else if \(voiceToSend\) \{\s*const result = await whatsappApiService\.sendAudio\(/)
  assert.doesNotMatch(sendSource, /Messenger e Instagram nativo todav[ií]a no mandan archivos desde este chat/)
})
