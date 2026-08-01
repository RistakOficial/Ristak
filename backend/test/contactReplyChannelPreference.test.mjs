import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import {
  getContactReplyChannelPreference,
  normalizeContactReplyChannel,
  setContactReplyChannelPreference
} from '../src/services/contactReplyChannelPreferenceService.js'
import {
  getHighLevelConversationalChannelPreference
} from '../src/services/highLevelConversationalChannelRoutingService.js'

test('la preferencia general conserva canal y ruta sin contaminar el ruteo telefónico de HighLevel', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `contact_reply_preference_${suffix}`

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name)
       VALUES (?, ?, ?, ?)`,
      [contactId, `+52656${suffix.slice(0, 10).replace(/[a-f]/g, '7')}`, `${suffix}@test.com`, 'Canal preferido']
    )

    const instagram = await setContactReplyChannelPreference(contactId, 'instagram_dm', {
      routeId: 'ig_business_123',
      routeLabel: 'Instagram Direct',
      selectedByUserId: 'user_test',
      source: 'automation'
    })

    assert.equal(instagram.channel, 'instagram')
    assert.equal(instagram.routeId, 'ig_business_123')
    assert.equal(instagram.source, 'automation')
    assert.equal(await getHighLevelConversationalChannelPreference(contactId), null)

    await setContactReplyChannelPreference(contactId, 'whatsapp_api', {
      routeId: 'native_whatsapp_phone_123',
      routeLabel: 'Ventas',
      source: 'automation'
    })
    assert.equal(await getHighLevelConversationalChannelPreference(contactId), null)

    await setContactReplyChannelPreference(contactId, 'whatsapp_api', {
      routeId: 'highlevel',
      routeLabel: 'WhatsApp · HighLevel',
      source: 'manual'
    })
    const stored = await getContactReplyChannelPreference(contactId)
    const highLevel = await getHighLevelConversationalChannelPreference(contactId)

    assert.equal(stored.channel, 'whatsapp')
    assert.equal(stored.routeId, 'highlevel')
    assert.equal(highLevel.channel, 'whatsapp')
    assert.equal(highLevel.routeId, 'highlevel')
    assert.equal(normalizeContactReplyChannel('correo'), 'email')
  } finally {
    await db.run('DELETE FROM contact_reply_channel_preferences WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
