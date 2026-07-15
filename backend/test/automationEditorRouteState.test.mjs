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

test('automation editor route changes remount the editor and clear stale load state', () => {
  const routeSource = readRepoFile('frontend/src/pages/Automations/Automations.tsx')
  const editorSource = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.tsx')

  assert.match(
    routeSource,
    /const LazyAutomationEditor = useMemo\(createAutomationEditor, \[retryKey\]\)/,
    'the lazy editor type should not be recreated implicitly by automation id'
  )
  assert.match(
    routeSource,
    /key=\{`\$\{automationId\}:\$\{retryKey\}`\}/,
    'the suspense boundary should reset when the active automation id changes'
  )
  assert.match(
    routeSource,
    /<LazyAutomationEditor key=\{automationId \|\| 'empty'\} \/>/,
    'the editor component should remount with a fresh state per automation id'
  )
  assert.match(
    editorSource,
    /const resetRouteState = \(\) => \{[\s\S]*?setLoadError\(null\)[\s\S]*?setAutomation\(null\)/,
    'opening an automation should clear stale error/loading state before fetching'
  )
  assert.match(
    editorSource,
    /const initFrom = \(data: Automation\) => \{[\s\S]*?setLoadError\(null\)[\s\S]*?setAutomation\(\{ \.\.\.data, flow: safeFlow \}\)/,
    'a successful fetch should leave the editor out of the previous error state'
  )
  assert.match(
    editorSource,
    /const statsAutomationId = current\.id[\s\S]*?getEnrollmentStats\(statsAutomationId\)[\s\S]*?automationRef\.current\?\.id !== statsAutomationId/,
    'late stats responses from a previous automation should not repaint the active editor'
  )
})
