import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isHighLevelConversationContactNotFoundError } from '../src/utils/highLevelConversationErrors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

test('reconoce el error canonico de contacto inexistente de HighLevel', () => {
  assert.equal(isHighLevelConversationContactNotFoundError(new Error(
    'GHL API Error (400): {"message":"Contact not found for id:abc","canonicalCode":"CONVERSATIONS_CONTACT_NOT_FOUND"}'
  )), true)
  assert.equal(isHighLevelConversationContactNotFoundError({
    response: { data: { canonicalCode: 'CONVERSATIONS_CONTACT_NOT_FOUND' } }
  }), true)
  assert.equal(isHighLevelConversationContactNotFoundError(new Error('Rate limit exceeded')), false)
})

test('el chat repara un vinculo GHL obsoleto y reintenta una sola vez', async () => {
  const source = await readFile(join(repoRoot, 'backend/src/controllers/highlevelController.js'), 'utf8')

  assert.match(source, /resolveHighLevelContactIdForChat\(\{ contact, ghlClient, forceRefresh = false \}\)/)
  assert.match(source, /if \(linkedGhlId && !forceRefresh\)/)
  assert.match(source, /if \(!forceRefresh && !isLocalOnlyContactId\(localContactId\)\)/)
  assert.match(source, /isHighLevelConversationContactNotFoundError\(error\)[\s\S]*?forceRefresh: true/)
  assert.match(source, /requestBody\.contactId = highLevelContactId;[\s\S]*?sendConversationMessage\(requestBody\)/)
})
