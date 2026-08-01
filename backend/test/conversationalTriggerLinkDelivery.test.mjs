import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import { readTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'

test('el agente conversacional entrega el trigger link opaco del contacto y no el destino directo', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const contactId = `rstk_contact_agent_trigger_${suffix}`
  let triggerLink = null

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name) VALUES (?, ?)',
      [contactId, 'Contacto agente trigger']
    )
    triggerLink = await createTriggerLink({
      name: `Trigger agente ${suffix}`,
      destinationUrl: 'https://example.test/recurso-final'
    })
    const items = [{
      id: 'send_link',
      enabled: true,
      linkKind: 'trigger',
      triggerLinkId: triggerLink.id,
      url: triggerLink.destinationUrl
    }]
    const ctx = {
      runtimeMode: 'tool_calling_v2',
      contactId,
      agentId: `agent_trigger_${suffix}`,
      channel: 'whatsapp',
      dryRun: true,
      followUpMode: false,
      actions: [],
      publicBaseUrl: 'https://links.ristak.test',
      config: {
        id: `agent_trigger_${suffix}`,
        runtimeMode: 'tool_calling_v2',
        objective: 'custom',
        capabilitiesConfig: { schemaVersion: 1, items }
      }
    }

    const sendLink = createConversationalTools(ctx).find(item => item.name === 'send_trigger_link')
    const result = await sendLink.invoke(null, JSON.stringify({
      intencionDetectada: 'Pidió el recurso',
      resumen: 'Se entrega el enlace rastreable'
    }))

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.sentUrl, /^https:\/\/links\.ristak\.test\/pce1_[A-Za-z0-9_-]+$/)
    assert.notEqual(result.sentUrl, triggerLink.destinationUrl)
    assert.ok(!result.sentUrl.includes(contactId))
    assert.deepEqual(
      await readTriggerLinkRecipientToken(new URL(result.sentUrl).pathname.slice(1)),
      { publicId: triggerLink.publicId, contactId }
    )
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
