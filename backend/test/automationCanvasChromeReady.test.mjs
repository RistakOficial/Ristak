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

test('automation canvas floating chrome waits for the editor frame before rendering', () => {
  const editorSource = readRepoFile('frontend/src/pages/Automations/editor/AutomationEditor.tsx')
  const canvasSource = readRepoFile('frontend/src/pages/Automations/editor/AutomationCanvas.tsx')

  assert.match(
    editorSource,
    /const \[canvasChromeReady, setCanvasChromeReady\] = useState\(false\)/,
    'the editor should keep canvas chrome hidden until the active automation is mounted'
  )
  assert.match(
    editorSource,
    /setCanvasChromeReady\(false\)[\s\S]*window\.requestAnimationFrame[\s\S]*window\.requestAnimationFrame[\s\S]*automationRef\.current\?\.id === activeAutomationId[\s\S]*setCanvasChromeReady\(true\)/,
    'floating canvas chrome should be enabled only after stable animation frames for the same automation'
  )
  assert.match(
    editorSource,
    /chromeReady=\{canvasChromeReady\}/,
    'the editor should pass readiness explicitly into the canvas'
  )

  assert.match(
    canvasSource,
    /chromeReady\?: boolean/,
    'the canvas should expose an explicit readiness gate for floating controls'
  )
  assert.match(
    canvasSource,
    /chromeReady = true/,
    'the readiness gate should default to true for direct canvas callers'
  )
  assert.match(
    canvasSource,
    /chromeReady && multiToolbar/,
    'contextual floating controls should not render before the editor chrome is ready'
  )
  assert.match(
    canvasSource,
    /chromeReady && \(\s*<>\s*\{\/\* Herramientas del canvas \*\/\}[\s\S]*className=\{styles\.canvasTools\}[\s\S]*\{children\}/,
    'zoom, post-it and child overlays should render together behind the readiness gate'
  )
})
