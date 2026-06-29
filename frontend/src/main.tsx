import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerPwa } from './pwa'
import { ensureLocalDevAuth, installAuthFetch } from './services/authFetch'
import { mobileAppService } from './services/mobileAppService'
import { installBrowserAutofillGuard } from './utils/browserAutofill'
import { installEnterSubmitShortcuts } from './utils/enterSubmitShortcuts'
import { installNumberInputWheelGuard } from './utils/numberInputSafety'
import './styles/index.css'

async function bootstrapRistak() {
  installAuthFetch()
  installBrowserAutofillGuard()
  installEnterSubmitShortcuts()
  installNumberInputWheelGuard()
  const nativeShellReady = mobileAppService.configureShell()
  await ensureLocalDevAuth()
  registerPwa()
  void nativeShellReady

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrapRistak()
