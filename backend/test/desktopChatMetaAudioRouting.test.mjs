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

const phoneChatSource = () => readFile(
  join(repoRoot, 'frontend/src/pages/PhoneChat/PhoneChat.tsx'),
  'utf8'
)

const whatsappApiClientSource = () => readFile(
  join(repoRoot, 'frontend/src/services/whatsappApiService.ts'),
  'utf8'
)

const backendRoutingSource = async () => ({
  server: await readFile(join(repoRoot, 'backend/src/server.js'), 'utf8'),
  contacts: await readFile(join(repoRoot, 'backend/src/controllers/contactsController.js'), 'utf8')
})

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

test('DesktopChat prioriza Meta nativo y envia voz y adjuntos multimedia en secuencia', async () => {
  const source = await desktopChatSource()
  const start = source.indexOf('const handleSendMessage = async')
  const end = source.indexOf('const handleReactToMessage = async', start)

  assert.ok(start >= 0 && end > start, 'No se encontro la ruta de envio de DesktopChat')
  const sendSource = source.slice(start, end)

  assert.match(sendSource, /const sendVoiceThroughNativeMeta = Boolean\(voiceToSend && activeNativeMetaChannel\)/)
  assert.match(sendSource, /const sendAttachmentsThroughHighLevel = attachmentsToSend\.length > 0 && !activeNativeMetaChannel && highLevelConnected/)
  assert.match(sendSource, /const sendAttachmentsThroughNativeMeta = attachmentsToSend\.length > 0 && Boolean\(activeNativeMetaChannel\)/)
  assert.match(sendSource, /whatsappApiService\.sendMetaSocialAudio\(\{\s*contactId: activeContact\.id,\s*platform: activeNativeMetaChannel,\s*audioDataUrl: nativeMetaAudio\.dataUrl,\s*audioMimeType: nativeMetaAudio\.type,\s*filename: nativeMetaAudio\.name,\s*durationMs: nativeMetaAudioDurationMs,\s*voice: Boolean\(sendVoiceThroughNativeMeta\),\s*externalId: nativeMetaOptimisticId\s*\}\)/)
  assert.match(sendSource, /for \(const \[index, attachment\] of attachmentsToSend\.entries\(\)\)/)
  assert.match(sendSource, /audioDataUrl: attachment\.dataUrl,[\s\S]*?voice: attachment\.deliveryMode === 'voice'/)
  assert.match(sendSource, /whatsappApiService\.sendMetaSocialAttachment\(\{[\s\S]*?attachmentType: attachmentType === 'document' \? 'file' : attachmentType,[\s\S]*?attachmentDataUrl: attachment\.dataUrl,[\s\S]*?filename: attachment\.name,[\s\S]*?mimeType: attachment\.mimeType/)
  assert.match(sendSource, /voiceToSend && sendVoiceThroughHighLevel[\s\S]*?highLevelService\.sendConversationMessage\(\{[\s\S]*?audioDataUrl: voiceToSend\.dataUrl[\s\S]*?durationMs: voiceToSend\.durationMs/)
  assert.match(sendSource, /else if \(voiceToSend\) \{\s*const result = await whatsappApiService\.sendAudio\(/)
  assert.doesNotMatch(sendSource, /const hasUnsupportedNativeMetaAttachment/)
  assert.doesNotMatch(sendSource, /Messenger e Instagram desde Meta nativo mandan texto o audio/)
  assert.doesNotMatch(sendSource, /Messenger e Instagram nativo todav[ií]a no mandan archivos desde este chat/)
  assert.match(source, /contactHasNativeMetaProfile\('messenger'\) && !activeSocialConversationUsesHighLevel/)
  assert.match(source, /contactHasNativeMetaProfile\('instagram'\) && !activeSocialConversationUsesHighLevel/)
  assert.match(source, /const latestSelectedSocialMessage =[\s\S]*?getSocialPlatformForDesktopMessage\(message\) === composerChannel/)
  assert.match(source, /const activeSocialConversationUsesHighLevel = latestSelectedSocialMessage[\s\S]*?isHighLevelMessageTransport\(latestSelectedSocialMessage\)[\s\S]*?: contactLastTransportUsesHighLevel/)
  assert.match(source, /activeNativeMetaChannel !== 'instagram' \? \([\s\S]*?<span>Documentos<\/span>/)
  assert.match(sendSource, /activeNativeMetaChannel === 'instagram' && attachmentsToSend\.some\([\s\S]*?getDraftAttachmentMessageType\(attachment\) === 'document'/)
})

test('PhoneChat envia multiples adjuntos por Meta nativo sin desviarlos a HighLevel', async () => {
  const source = await phoneChatSource()
  const start = source.indexOf('const handleSendMessage = async')
  const end = source.indexOf('const handleSendVoiceFromPanel', start)

  assert.ok(start >= 0 && end > start, 'No se encontro la ruta de envio de PhoneChat')
  const sendSource = source.slice(start, end)

  assert.match(sendSource, /const sendAttachmentsThroughHighLevel = attachmentsToSend\.length > 0 && !sendingThroughMetaSocial && highLevelConnected/)
  assert.match(sendSource, /for \(const \[index, attachment\] of attachmentsToSend\.entries\(\)\)/)
  assert.match(sendSource, /whatsappApiService\.sendMetaSocialAudio\(\{[\s\S]*?audioDataUrl: attachment\.dataUrl,[\s\S]*?voice: attachment\.deliveryMode === 'voice'/)
  assert.match(sendSource, /whatsappApiService\.sendMetaSocialAttachment\(\{[\s\S]*?attachmentType: attachmentKind === 'document' \? 'file' : attachmentKind,[\s\S]*?attachmentDataUrl: attachment\.dataUrl,[\s\S]*?filename: attachment\.name,[\s\S]*?mimeType: attachment\.type/)
  assert.match(sendSource, /message\.id === optimisticId \|\| message\.id === `\$\{optimisticId\}-text` \|\| message\.id\.startsWith\(`/)
  assert.doesNotMatch(sendSource, /const hasUnsupportedNativeMetaAttachment/)
  assert.doesNotMatch(sendSource, /Messenger e Instagram desde Meta nativo mandan texto o audio/)
  assert.match(source, /activeContactHasNativeMetaProfile &&\s*!activeSocialConversationUsesHighLevel/)
  assert.match(source, /activeSocialConversationUsesHighLevel/)
  assert.match(source, /const latestSelectedSocialMessage =[\s\S]*?getMetaPlatformForMessage\(message\) === activeMetaSocialChannel/)
  assert.match(source, /const activeSocialConversationUsesHighLevel = latestSelectedSocialMessage[\s\S]*?isHighLevelMessageTransport\(latestSelectedSocialMessage\)[\s\S]*?: contactLastTransportUsesHighLevel/)
  assert.match(source, /const allowDocuments = !\(sendingThroughMetaSocial && activeMetaSocialChannel === 'instagram'\)/)
  assert.match(sendSource, /activeMetaSocialChannel === 'instagram' && attachmentsToSend\.some\([\s\S]*?getDraftAttachmentKind\(attachment\) === 'document'/)
})

test('PhoneChat permite abrir el micrófono en Messenger o Instagram sin teléfono', async () => {
  const source = await phoneChatSource()
  const start = source.indexOf('const handleStartVoiceRecording = async')
  const end = source.indexOf('const handleSelectContact', start)
  assert.ok(start >= 0 && end > start, 'No se encontró la grabación de voz móvil')
  const recordingSource = source.slice(start, end)

  assert.match(recordingSource, /const socialVoiceRouteReady = sendingThroughMetaSocial \|\| Boolean\(sendingThroughHighLevel && !activeHighLevelChannelNeedsPhone\)/)
  assert.match(recordingSource, /!activeContact\?\.phone && !socialVoiceRouteReady/)
})

test('cliente frontend expone el endpoint de adjuntos Meta nativos', async () => {
  const source = await whatsappApiClientSource()

  assert.match(source, /export interface MetaSocialAttachmentSendPayload \{[\s\S]*?attachmentType: 'image' \| 'video' \| 'file'[\s\S]*?attachmentDataUrl\?: string/)
  assert.match(source, /export interface MetaSocialAttachmentSendPayload \{[\s\S]*?mimeType\?: string[\s\S]*?filename\?: string/)
  assert.match(source, /sendMetaSocialAttachment: \(payload: MetaSocialAttachmentSendPayload\) => apiClient\.post<WhatsAppApiSendResponse>\('\/whatsapp-api\/meta\/social\/messages\/attachment', payload\)/)
})

test('chat manual reserva respuestas a comentarios con el mismo ID optimista', async () => {
  const [desktop, phone] = await Promise.all([desktopChatSource(), phoneChatSource()])

  assert.match(desktop, /sendMetaSocialCommentReply\(\{[\s\S]*?commentId: selectedCommentReplyTarget\?\.commentId,[\s\S]*?externalId: optimisticId/)
  assert.match(phone, /sendMetaSocialCommentReply\(\{[\s\S]*?commentId: selectedCommentReplyTarget\?\.commentId,[\s\S]*?externalId: optimisticId/)
})

test('rutas sociales no heredan licencia WhatsApp y el inbox distingue Meta de HighLevel', async () => {
  const { server, contacts } = await backendRoutingSource()

  assert.match(server, /startsWith\('\/meta\/social\/'\)\) return next\(\)/)
  assert.match(server, /requireWhatsAppFeatureForWhatsAppApiRoute/)
  assert.match(contacts, /AS meta_has_messenger_profile/)
  assert.match(contacts, /AS meta_has_instagram_profile/)
  assert.match(contacts, /THEN 'ghl_' \|\| meta_social_messages\.platform/)
})
