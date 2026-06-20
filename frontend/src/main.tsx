import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerPwa } from './pwa'
import { ensureLocalDevAuth, installAuthFetch } from './services/authFetch'
import { mobileAppService } from './services/mobileAppService'
import { installEnterSubmitShortcuts } from './utils/enterSubmitShortcuts'
import { installNumberInputWheelGuard } from './utils/numberInputSafety'
import './styles/index.css'

async function bootstrapRistak() {
  installAuthFetch()
  installEnterSubmitShortcuts()
  installNumberInputWheelGuard()
  await ensureLocalDevAuth()
  registerPwa()
  mobileAppService.configureShell()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrapRistak()
