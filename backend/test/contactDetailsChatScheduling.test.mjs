import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const repoFile = (path) => new URL(`../../${path}`, import.meta.url)

test('la ficha de contacto permite programar texto con el mismo modal de Chat', async () => {
  const [contactDetails, desktopChat, scheduleModal] = await Promise.all([
    readFile(repoFile('frontend/src/components/common/ContactDetailsModal/ContactDetailsModal.tsx'), 'utf8'),
    readFile(repoFile('frontend/src/pages/DesktopChat/DesktopChat.tsx'), 'utf8'),
    readFile(repoFile('frontend/src/components/common/ChatScheduleModal/ChatScheduleModal.tsx'), 'utf8')
  ])

  assert.match(contactDetails, /aria-label="Programar mensaje"/)
  assert.match(contactDetails, /<ChatScheduleModal[\s\S]*timezone=\{timezone\}/)
  assert.match(contactDetails, /whatsappApiService\.scheduleMessage\(\{[\s\S]*contactId: selectedContact\.id/)
  assert.match(contactDetails, /businessPhoneNumberId: provider === 'whatsapp_api' \? selectedBusinessPhone\?\.id/)

  assert.match(desktopChat, /<ChatScheduleModal/)
  assert.doesNotMatch(desktopChat, /className=\{styles\.scheduleModalBody\}/)

  assert.match(scheduleModal, /localDateTimeInputToUTCISOString\(localInput, timezone\)/)
  assert.match(scheduleModal, /todayDateOnlyInTimezone\(timezone\)/)
  assert.doesNotMatch(scheduleModal, /type="number"/)
})
