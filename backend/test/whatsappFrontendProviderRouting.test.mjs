import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const readSource = (path) => readFile(join(repoRoot, path), 'utf8')

test('frontend resuelve la API oficial por cada numero y no por el estado global de YCloud', async () => {
  const source = await readSource('frontend/src/services/whatsappApiService.ts')

  assert.match(source, /export function isWhatsAppPhoneApiAvailable/)
  assert.match(source, /typeof phone\.availability\?\.apiAvailable === 'boolean'/)
  assert.match(source, /provider === 'meta_direct'[\s\S]*?status\?\.metaDirect\?\.connected/)
  assert.match(source, /configuredPhoneNumberId === phone\.id/)
  assert.match(source, /if \(provider === 'qr'\) return false/)
  assert.match(source, /return Boolean\(status\?\.connected\)/)
})

test('PhoneChat conserva el numero nativo seleccionado y aplica plantillas fuera de 24 horas', async () => {
  const source = await readSource('frontend/src/pages/PhoneChat/PhoneChat.tsx')

  assert.match(source, /const whatsappConnected = isWhatsAppPhoneApiAvailable\(selectedBusinessPhone, whatsappStatus\)/)
  assert.match(source, /activeHighLevelChatChannel === 'whatsapp_api' && !selectedBusinessPhone/)
  assert.match(source, /const selectedApiUnavailable = Boolean\(selectedBusinessPhone && !whatsappConnected\)/)
  assert.match(source, /message\.businessPhoneNumberId === selectedBusinessPhone\.id/)
  assert.match(source, /const composerBlockedByReplyWindow = Boolean\(outsideReplyWindow && !selectedApiUnavailable && !highLevelChannelRequired/)
  assert.doesNotMatch(source, /Boolean\(whatsappStatus\?\.connected && whatsappStatus\?\.configured\)/)
  assert.doesNotMatch(source, /activeHighLevelChatChannel === 'whatsapp_api' && !whatsappConnected && !selectedQrReady/)
})

test('PhoneChat ofrece rutas explicitas de HighLevel junto a cada WhatsApp nativo', async () => {
  const source = await readSource('frontend/src/pages/PhoneChat/PhoneChat.tsx')

  assert.match(source, /HIGHLEVEL_WHATSAPP_ROUTE_OVERRIDE_ID = '__highlevel_whatsapp__'/)
  assert.match(source, /value: 'whatsapp_api', label: 'WhatsApp · HighLevel'/)
  assert.match(source, /value: 'sms_qr', label: 'SMS · HighLevel'/)
  assert.match(source, /HIGHLEVEL_SMS_ROUTE_PREFIX = 'sms:highlevel:'/)
  assert.match(source, /highLevelPhoneNumbers\.map\(\(phone\)[\s\S]*?description: phone\.phoneNumber/)
  assert.match(source, /\.\.\.whatsappOptions,[\s\S]*?\.\.\.highLevelSmsOptions,[\s\S]*?\.\.\.baseOptions/)
  assert.match(source, /value === 'whatsapp_api'[\s\S]*?!highLevelConnected/)
  assert.match(source, /nextChannel === 'sms_qr'[\s\S]*?HIGHLEVEL_WHATSAPP_ROUTE_OVERRIDE_ID/)
  assert.match(source, /const preferredHighLevelPhoneChannel = nextChannel === 'sms_qr'[\s\S]*?value === 'whatsapp_api'/)
  assert.match(source, /updateConversationalChannelPreference\(contactId, preferredHighLevelPhoneChannel\)/)
  assert.match(source, /getLatestHighLevelWhatsAppInboundSender\(messages\)/)
  assert.match(source, /getHighLevelWhatsAppRouteLabel\(highLevelWhatsAppSender\)/)
  assert.match(source, /fromNumber: resolveHighLevelChatFromNumber\(requestedChannel,[\s\S]*?smsFromNumber: selectedHighLevelFromNumber,[\s\S]*?whatsappSender: highLevelWhatsAppSender/)
  assert.match(source, /fromPhone: provider === 'highlevel'[\s\S]*?resolveHighLevelChatFromNumber\(channel,[\s\S]*?whatsappSender: highLevelWhatsAppSender/)
})

test('DesktopChat no usa HighLevel como rescate silencioso de un numero nativo', async () => {
  const source = await readSource('frontend/src/pages/DesktopChat/DesktopChat.tsx')
  const sendStart = source.indexOf('const handleSendMessage = async')
  const sendEnd = source.indexOf('const handleReactToMessage = async', sendStart)

  assert.ok(sendStart >= 0 && sendEnd > sendStart, 'No se encontro la ruta de envio de DesktopChat')
  const sendSource = source.slice(sendStart, sendEnd)

  assert.match(source, /selectedBusinessPhoneValue && isWhatsAppPhoneApiAvailable\(selectedBusinessPhone, whatsappStatus\)/)
  assert.match(source, /selectedBusinessPhone[\s\S]*?\? whatsappConnected \|\| selectedQrReady[\s\S]*?: highLevelConnected/)
  assert.match(sendSource, /composerChannel === 'whatsapp' && !selectedBusinessPhone/)
  assert.match(sendSource, /highLevelConnected && \(composerChannel !== 'whatsapp' \|\| !selectedBusinessPhone\)/)
  assert.match(sendSource, /!apiReplyWindowOpen[\s\S]*?Usa una plantilla/)
  assert.doesNotMatch(source, /Boolean\(whatsappStatus\?\.connected && selectedBusinessPhoneValue\)/)
  assert.doesNotMatch(sendSource, /composerChannel === 'whatsapp' && !whatsappConnected && !selectedQrReady/)
})

test('DesktopChat permite elegir WhatsApp o SMS de HighLevel aunque existan numeros nativos', async () => {
  const source = await readSource('frontend/src/pages/DesktopChat/DesktopChat.tsx')
  const sendStart = source.indexOf('const handleSendMessage = async')
  const sendEnd = source.indexOf('const handleReactToMessage = async', sendStart)

  assert.ok(sendStart >= 0 && sendEnd > sendStart, 'No se encontro la ruta de envio de DesktopChat')
  const sendSource = source.slice(sendStart, sendEnd)

  assert.match(source, /HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID = '__highlevel_whatsapp__'/)
  assert.match(source, /HIGHLEVEL_WHATSAPP_COMPOSER_VALUE = 'whatsapp:highlevel'/)
  assert.match(source, /value: 'sms', label: 'SMS · HighLevel'/)
  assert.match(source, /HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX = 'sms:highlevel:'/)
  assert.match(source, /highLevelPhoneNumbers\.map\(\(phone\)[\s\S]*?phone\.phoneNumber/)
  assert.match(source, /getLatestHighLevelWhatsAppInboundSender\(messages\)/)
  assert.match(source, /label: getHighLevelWhatsAppRouteLabel\(highLevelWhatsAppSender\)/)
  assert.match(source, /if \(channel === 'sms'\) return 'sms_qr'/)
  assert.match(source, /nextBusinessPhoneId === 'highlevel'[\s\S]*?HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID/)
  assert.match(source, /const preferredHighLevelPhoneChannel = nextChannel === 'sms'[\s\S]*?value === HIGHLEVEL_WHATSAPP_COMPOSER_VALUE/)
  assert.match(source, /updateConversationalChannelPreference\(activeContact\.id, preferredHighLevelPhoneChannel\)/)
  assert.match(source, /highLevelPhoneVoiceChannelReady[\s\S]*?composerChannel === 'sms'/)
  assert.match(sendSource, /sendAttachmentsThroughHighLevel[\s\S]*?composerChannel === 'sms'/)
  assert.match(sendSource, /sendVoiceThroughHighLevel[\s\S]*?composerChannel === 'sms'/)
  assert.match(sendSource, /composerChannel === 'whatsapp' && !selectedBusinessPhone/)
  assert.match(sendSource, /fromNumber: resolveHighLevelChatFromNumber\(activeConversationChannel,[\s\S]*?smsFromNumber: selectedHighLevelFromNumber,[\s\S]*?whatsappSender: highLevelWhatsAppSender/)
  assert.doesNotMatch(sendSource, /fromNumber: selectedBusinessPhoneValue/)
})

test('apps nativas separan WhatsApp HighLevel de cada remitente SMS de HighLevel', async () => {
  const android = await readSource('mobile/src/App.tsx')
  const ios = await readSource('ios/app/Ristak/Features/Chats/Thread/ConversationViewModel.swift')
  const iosRouting = await readSource('ios/app/Ristak/Features/Chats/Thread/ConversationChannelRouting.swift')

  assert.match(android, /value: `highlevel:sms:\$\{phone\.id \|\| index\}`/)
  assert.match(android, /fromNumber: selectedHighLevelFromNumber/)
  assert.match(android, /getLastHighLevelWhatsAppBusinessPhone\(messages\)/)
  assert.match(android, /`WhatsApp · HighLevel · \$\{highLevelWhatsAppFromNumber\}`/)
  assert.match(iosRouting, /\.sms\(fromNumber: phone\.phoneNumber\)/)
  assert.match(ios, /fromNumber: selectedChannel\.highLevelFromNumber/)
  assert.match(ios, /ConversationHighLevelWhatsAppRouteResolver\.latestInboundBusinessPhone/)
  assert.match(iosRouting, /\.highLevelWhatsApp\(fromNumber: highLevelWhatsAppFromNumber\)/)
  assert.match(iosRouting, /title: "WhatsApp · HighLevel"/)
})
