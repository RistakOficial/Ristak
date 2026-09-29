import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import { ensureToolCallingV2VisibleReply, buildToolCallingV2ReplyCompletionEffect } from '../src/agents/conversational/runner.js'
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
    const emptyReply = ensureToolCallingV2VisibleReply('', ctx.actions)
    assert.ok(emptyReply.includes(result.sentUrl), 'el simulador muestra el enlace preparado aunque la IA termine con la herramienta')
    assert.match(emptyReply, /aquí tienes el enlace/i)
    const textReply = ensureToolCallingV2VisibleReply('Aquí puedes continuar.', ctx.actions)
    assert.ok(textReply.includes(result.sentUrl))
    assert.equal(ensureToolCallingV2VisibleReply(textReply, ctx.actions), textReply)
    assert.equal(buildToolCallingV2ReplyCompletionEffect(ctx.actions), null, 'una prueba jamás confirma una entrega real')
    for (const outcome of [{ status: 'error', ok: false }, { linkPrepared: false }]) {
      const failedActions = [{ ...ctx.actions[0], outcome: { ...ctx.actions[0].outcome, ...outcome } }]
      assert.ok(!ensureToolCallingV2VisibleReply('', failedActions).includes(result.sentUrl))
    }
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
