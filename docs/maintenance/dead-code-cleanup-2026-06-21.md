# Auditoria de limpieza tecnica - 2026-06-21

## Alcance

- Base revisada: `origin/main` en worktree limpio `codex/dead-code-cleanup`.
- Arbol inventariado excluyendo `.git`, `node_modules` y `dist`: 941 archivos.
- Herramientas usadas: `rg`, `find`, `tsc --noUnusedLocals --noUnusedParameters`, `depcheck`, `git diff`, `npm run typecheck`, `npm run design:audit`, `npm run build`, `backend npm test`.
- Criterio de borrado automatico: solo elementos sin referencias estaticas y sin punto de entrada real. Migraciones, variables de entorno, despliegue, integraciones y modulos activos quedaron protegidos salvo imports/locals muertos sin impacto.

## Eliminado con confianza alta

| Archivo | Motivo | Confianza |
| --- | --- | --- |
| `frontend/package.json` | Dependencias directas sin imports ni configuracion activa: `lodash`, `@types/lodash`, `@tailwindcss/postcss`. | Alta |
| `frontend/package-lock.json` | Limpieza mecanica del lockfile tras quitar dependencias directas; npm removio 10 paquetes instalados. | Alta |
| `frontend/src/components/ai/AIAgentPanel/AIAgentPanel.tsx` | Helper local `formatTraceStatus` sin referencias. | Alta |
| `frontend/src/components/common/AppointmentModal/AppointmentModal.tsx` | Helper `localTodayInput` sin referencias; se conservo `padTwo` porque si se usa. | Alta |
| `frontend/src/components/common/GlobalSearch/GlobalSearch.tsx` | Constante `GLOBAL_SEARCH_DELAY_MS` sin referencias. | Alta |
| `frontend/src/contexts/ThemeContext.tsx` | Parser legacy `getConfigDesignPreset` sin referencias; se conservo `isDesignPreset` por uso real. | Alta |
| `frontend/src/pages/Appointments/Appointments.tsx` | Variable `statusLabel` calculada pero no usada. | Alta |
| `frontend/src/pages/Automations/AutomationLibrary.tsx` | Tipo importado sin uso. | Alta |
| `frontend/src/pages/Automations/editor/AutomationEditor.tsx` | Imports, mapa de badges y constantes no usados. | Alta |
| `frontend/src/pages/Automations/editor/AutomationNodeCard.tsx` | Constante importada sin uso. | Alta |
| `frontend/src/pages/Automations/editor/NodeConfigBubble.tsx` | Callback local sin referencias. | Alta |
| `frontend/src/pages/Automations/editor/config/MessageBlocksEditor.tsx` | Import sin uso. | Alta |
| `frontend/src/pages/Automations/editor/nodeRegistry.tsx` | Imports de iconos/tipo sin uso. | Alta |
| `frontend/src/pages/Automations/editor/variablesCatalog.ts` | Import sin uso. | Alta |
| `frontend/src/pages/Dashboard/Dashboard.tsx` | Estado de carga y flag calculado sin lectura. | Alta |
| `frontend/src/pages/DesktopChat/DesktopChat.tsx` | Constantes/callbacks sin uso y lectura de estado nunca consumida. | Alta |
| `frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx` | Busqueda global de citas, refresco y fetch/cache de futuras citas sin render ni caller. | Alta |
| `frontend/src/pages/PhoneChat/PhoneChat.tsx` | Estado/caches derivados sin lectura ni impacto visible. | Alta |
| `frontend/src/pages/PhoneSettings/PhoneSettings.tsx` | Estado de IA escrito pero nunca leido. | Alta |
| `frontend/src/pages/Settings/CalendarsConfiguration.tsx` | Normalizador de Google Calendar ID sin caller. No se tocaron los prompts pendientes. | Alta |
| `frontend/src/pages/Settings/ConversationalAgentSettings.tsx` | Alias `salesCurrency` sin uso. | Alta |
| `frontend/src/pages/Settings/MessageTemplates.tsx` | Helper y opciones de status sin uso. | Alta |
| `frontend/src/pages/Settings/MetaAdsIntegration.tsx` | Import/valor de tema, parametro no usado y flag sin lectura. | Alta |
| `frontend/src/pages/Settings/PaymentsConfiguration.tsx` | Tipo y constante de Stripe sin uso; no se removio logica de pagos. | Alta |
| `frontend/src/pages/Sites/Sites.tsx` | Helpers, componentes React no renderizados, callbacks/props/estados sin caller real y duplicado viejo de add block. | Alta |
| `frontend/src/utils/contactCustomFields.ts` | Tipos importados sin uso. | Alta |

## Revision manual pendiente

| Archivo | Motivo | Confianza |
| --- | --- | --- |
| `frontend/src/pages/Settings/CalendarsConfiguration.tsx` | `maybeShowGooglePostConnectPrompts`, `renderGoogleDefaultPromptModal`, `renderGoogleMergePromptModal`, `renderNotificationsHeaderAction`, `renderCalendarNotificationsModal` no tienen caller/render actual, pero pertenecen a calendario/Google Calendar, modulo protegido. | Media |
| `frontend/package.json` | `depcheck` marca `@capacitor/android` y `@capacitor/ios`, pero son necesarios para plataformas nativas de Capacitor. | Baja |
| `frontend/package.json` | `depcheck` marca `autoprefixer` y `postcss`, pero `postcss.config.js` los usa para el build CSS. | Baja |

## No eliminado

- Migraciones, scripts operativos, configuracion de despliegue, variables de entorno, Stripe, Mercado Pago, WhatsApp, IA, automatizaciones, sitios, anuncios, chats, contactos y calendario cuando habia duda razonable.
- `knip` sin configuracion local genero demasiados falsos positivos, asi que no se uso como fuente de borrado automatico.

## Resultado

- Archivos eliminados: 0.
- Archivos de producto modificados: 26.
- Reporte agregado: 1 archivo.
- Lineas eliminadas netas en producto: 1,172 (`36` insertadas, `1,208` eliminadas).
- Diff total incluyendo este reporte: 27 archivos, `105` insertadas, `1,208` eliminadas.
- Dependencias directas eliminadas: 3 (`lodash`, `@types/lodash`, `@tailwindcss/postcss`).
- Paquetes instalados removidos por npm: 10.
- Reduccion en archivos tracked de producto: 45,372 bytes.
- Reduccion total tracked incluyendo este reporte: 39,801 bytes.

## Validacion

- `frontend npm run typecheck`: OK.
- `frontend npm run design:audit`: OK.
- `npm run build`: OK.
- `backend npm test`: OK, 439 tests, 437 pass, 2 skipped, 0 fail.
- `npm run lint`: no disponible; no existe script `lint` en root, frontend ni backend.
