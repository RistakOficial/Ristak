import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('automation editor toolbar does not expose the old flow preview action', () => {
  const editorSource = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.tsx')
  const stylesSource = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.module.css')

  assert.equal(editorSource.includes('Vista previa del flujo'), false)
  assert.equal(editorSource.includes('setPreviewOpen'), false)
  assert.equal(editorSource.includes('previewOpen'), false)
  assert.equal(editorSource.includes('previewSteps'), false)
  assert.equal(editorSource.includes('leftIcon={<Eye'), false)
  assert.equal(stylesSource.includes('.previewList'), false)
  assert.equal(stylesSource.includes('.previewStep'), false)
})
