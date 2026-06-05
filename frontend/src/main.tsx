import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { registerPwa } from './pwa'
import './styles/index.css'

registerPwa()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
