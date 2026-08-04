import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

test('la ficha de contacto reutiliza el runtime completo de Chat para programar mensajes', async () => {
  const [contactDetails, desktopChat, scheduleModal] = await Promise.all([
    readFile(repoFile('frontend/src/components/common/ContactDetailsModal/ContactDetailsModal.tsx'), 'utf8'),
    readFile(repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'), 'utf8'),
    readFile(repoFile('frontend/src/components/common/ChatScheduleModal/ChatScheduleModal.tsx'), 'utf8')
  ])

  assert.match(contactDetails, /const LazyEmbeddedDesktopChat = lazy/)
  assert.match(contactDetails, /<LazyEmbeddedDesktopChat embeddedContact=\{embeddedChatContact\} \/>/)
  assert.match(contactDetails, /data-contact-chat-shared-runtime="desktop-chat"/)
  assert.doesNotMatch(contactDetails, /import \{ ChatScheduleModal \}/)
  assert.doesNotMatch(contactDetails, /<ChatScheduleModal/)

  assert.match(desktopChat, /embeddedContact\?: Contact \| null/)
  assert.match(desktopChat, /<ChatScheduleModal/)
  assert.match(desktopChat, /whatsappApiService\.scheduleMessage\(\{[\s\S]*contactId: activeContact\.id/)
  assert.doesNotMatch(desktopChat, /className=\{styles\.scheduleModalBody\}/)

  assert.match(scheduleModal, /localDateTimeInputToUTCISOString\(localInput, timezone\)/)
  assert.match(scheduleModal, /todayDateOnlyInTimezone\(timezone\)/)
  assert.doesNotMatch(scheduleModal, /type="number"/)
})
