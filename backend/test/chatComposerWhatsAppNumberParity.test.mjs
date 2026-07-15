import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const readSource = (path) => readFile(join(repoRoot, path), 'utf8')

test('el selector inferior de desktop lista cada WhatsApp y fija el numero en el contacto', async () => {
  const source = await readSource('frontend/src/pages/DesktopChat/DesktopChat.tsx')

  assert.match(source, /whatsappComposerPhones\.map\(\(phone\) => \(\{[\s\S]*?value: `whatsapp:\$\{phone\.id\}`/)
  assert.match(source, /void handleUpdatePreferredWhatsAppPhoneNumber\(nextBusinessPhoneId, 'composer'\)/)
  assert.match(source, /routingReason:[\s\S]*?'Cambio desde selector inferior del chat'/)
  assert.match(source, /preferred_whatsapp_phone_number_id: nextPreferredId/)
})

test('el selector inferior de movil web persiste y revierte el numero si falla', async () => {
  const source = await readSource('frontend/src/pages/PhoneChat/PhoneChat.tsx')

  assert.match(source, /businessPhones\.map\(\(phone, index\) => \(\{[\s\S]*?value: `whatsapp:\$\{phone\.id\}`/)
  assert.match(source, /const handleComposerMessageChannelSelect = async/)
  assert.match(source, /contactsService\.updateContact\(contactId,[\s\S]*?routingReason: 'Cambio desde selector inferior del chat'/)
  assert.match(source, /const rollbackPatch = \{[\s\S]*?preferredWhatsAppPhoneNumberId: previousPreferredPhoneId/)
})

test('Android fija desde el boton inferior el mismo preferred WhatsApp del contacto', async () => {
  const source = await readSource('mobile/src/App.tsx')

  assert.match(source, /connectedPhones\.map\(\(phone, index\) => \(\{[\s\S]*?value: `whatsapp:\$\{phone\.id\}`/)
  assert.match(source, /const selectComposerChannel = useCallback\(async/)
  assert.match(source, /api\.updateContact\(contact\.id,[\s\S]*?routingReason: 'Cambio desde selector inferior del chat'/)
  assert.match(source, /onSelect=\{\(channel\) => \{ void selectComposerChannel\(channel\); \}\}/)
})

test('iOS vuelve a mostrar el boton inferior y guarda la preferencia compartida', async () => {
  const [composer, viewModel] = await Promise.all([
    readSource('ios/app/Ristak/Features/Chats/Composer/ComposerView.swift'),
    readSource('ios/app/Ristak/Features/Chats/Thread/ConversationViewModel.swift')
  ])

  assert.match(composer, /ChannelBadgeView\(channel: viewModel\.selectedChannel\.badgeChannel, size: 22\)/)
  assert.match(composer, /viewModel\.isComposerChannelSheetPresented = true/)
  assert.match(composer, /ChannelPickerSheet\(viewModel: viewModel\)/)
  assert.match(viewModel, /for \(index, phone\) in whatsAppPhones\.enumerated\(\)/)
  assert.match(viewModel, /contactsService\.setPreferredWhatsAppPhoneNumber\([\s\S]*?routingReason: "Cambio desde selector inferior o ficha del chat"/)
})
