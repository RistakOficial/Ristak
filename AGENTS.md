# Codex Instructions

## Fechas y zonas horarias — OBLIGATORIO

- **ALTO antes de tocar fechas.** Antes de crear o modificar cualquier lógica de
  fechas, horas, rangos, crones, pagos programados, citas, contactos, anuncios,
  reportes, sitios, formularios, mensajes programados o integraciones externas,
  lee **`docs/DATE_TIME_GUIDELINES.md`** completo.
- Regla base: la zona horaria del negocio manda. La base guarda instantes en UTC,
  las fechas de calendario se interpretan en la zona del negocio, y el frontend no
  debe depender de la zona horaria del navegador para datos del CRM.
- No uses `new Date().toISOString().slice(0, 10)`, `DateTime.local()`,
  `DateTime.now().toISODate()` ni conversiones manuales para fechas de negocio.
  Usa `backend/src/utils/dateUtils.js` y `frontend/src/utils/timezone.ts`.

## Moneda y currency — OBLIGATORIO

- **ALTO antes de tocar moneda.** Antes de crear o modificar cualquier lógica de
  currency, moneda, importes, precios, productos, pagos, planes, suscripciones,
  reportes, Sites/formularios, tracking, Meta/CAPI, automatizaciones o prompts de
  IA relacionados con dinero, lee **`docs/CURRENCY_GUIDELINES.md`** completo.
- Regla base: la moneda default SIEMPRE es la configurada en la cuenta
  (`account_currency`). No la infieras del navegador, pais, pasarela, Meta,
  ejemplos de docs ni hardcodees `MXN`/`USD` como default de negocio.
- Frontend: usa `useAccountCurrency()` o `ACCOUNT_CURRENCY_CONFIG_KEY`, y pasa la
  moneda explicita a `formatCurrency(value, currency)`. No uses
  `formatCurrency(value)` desnudo para importes de negocio de la cuenta.
- Backend: usa `getAccountCurrency()` desde `backend/src/utils/accountLocale.js`
  o helpers existentes que lo envuelvan. `DEFAULT_CURRENCY` solo es fallback de
  normalizacion/seguridad, no la fuente de verdad para funciones nuevas.

## UI / diseño — OBLIGATORIO

- **ALTO antes de tocar UI.** Antes de crear o modificar CUALQUIER pantalla,
  componente, estilo o función con interfaz del frontend de escritorio:
  1. Lee **`docs/DESIGN_SYSTEM.md`** completo (reglas estrictas / lista de rechazo).
  2. Abre **`docs/design-reference/design-system.html`** en el navegador
     interno/aislado del agente (en Codex: `browser:control-in-app-browser` /
     Browser in-app). **No abras Google Chrome ni el navegador personal del
     usuario** para esta revisión salvo
     que el usuario lo pida explícitamente. Si `file://` queda bloqueado, sirve
     `docs/design-reference/` por `127.0.0.1` desde el worktree y abre esa URL en
     el navegador interno.
  3. Reutiliza los componentes de `frontend/src/components/common/` y los **tokens**
     de `frontend/src/styles/index.css`. No inventes estilos.
- **No negociable** (detalle en `docs/DESIGN_SYSTEM.md`): nada de hex/rgba
  hardcodeados (usa tokens `--bg/--surface/--text/--accent/--pos/--neg/--radius-*/
  --shadow-*`); `+/-` y estados con `var(--pos)`/`var(--neg)`, nunca verde/rojo a
  mano; buscadores/segmentos con fondo `var(--surface)` (transparente se ve vacío en
  Onyx); negrita solo en títulos/números/badges; probar en las 4 familias ×
  claro/oscuro; **no cambiar layout/posición/flujo** (solo lo visual).
- **Religión de componentes globales.** Si existe o se repite un patrón
  (buscador, botón, input con icono, tabs, card, tabla, modal, badge, menú,
  etiqueta/pill), usa o extiende `frontend/src/components/common/` y los tokens
  globales. No crees CSS local tipo `.searchBox`, `.searchInput`, `.tabs`,
  `.badge`, `.modal`, etc. para resolver lo mismo en una página.
- **Auditoría obligatoria.** Antes de cerrar cualquier cambio de UI de escritorio,
  corre `cd frontend && npm run design:audit`. Si falla, migra al componente
  global correcto. No agregues archivos a la allowlist del auditor salvo que sea
  deuda legacy ya existente y quede explícitamente justificado en el cambio.
- **Campos numéricos sin steppers.** Está prohibido crear `<input type="number">`
  nativo o cualquier campo numérico con flechas de subir/bajar del navegador. Los
  números se teclean: usa `NumberInput` en escritorio o primitivas móviles que
  rendericen `type="text"` con `inputMode="numeric"`/`decimal`. `design:audit`
  debe bloquear inputs numéricos nativos.
- **Responsive sí importa.** Mantén layouts fluidos para compus chicas usando
  `flex`, `grid`, `minmax`, `clamp`, `min-width: 0`, container/media queries y
  variables del componente. No confundas responsive con inventar otra identidad
  visual aislada por pantalla.
- La app móvil integrada (`Phone*`, `data-phone-app`, `data-phone-chat-theme`) y
  Automatizaciones tienen su propio sistema visual y quedan fuera de los cambios
  de diseño de escritorio.

## Backend / integraciones con crons — OBLIGATORIO

- Si agregas una integración externa que requiera un cron, job periódico,
  watchdog, polling o reintento automático, primero lee
  **`docs/INTEGRATION_CRON_RULES.md`**.
- Regla central: un cron que depende de una integración externa NO debe arrancar
  sólo porque el backend arrancó. Debe activarse únicamente cuando esa
  integración esté conectada localmente y apagarse al desconectarla.
- Los crons de sistema sí pueden vivir siempre activos; los crons de
  integraciones deben registrarse en `backend/src/jobs/integrationCronRegistry.js`
  y evaluarse con detectores locales en
  `backend/src/services/integrationConnectionStateService.js`.
- Al conectar, desconectar o cambiar modo relevante de una integración, el
  controller debe llamar `syncRegisteredIntegrationCronsForProvider(...)` para
  prender/apagar el cron sin reiniciar el backend.

## Soporte MCP / Installer — OBLIGATORIO

- Si Raul pide revisar un cliente, error, chat, IA, logs o datos de una cuenta
  instalada, lee **`docs/support-mcp-operations.md`** antes de diagnosticar solo
  desde codigo local.
- El MCP externo `/api/mcp` de esta app es para integraciones del cliente. El
  soporte interno vive en **Ristak Installer** (`ristak-render-support` /
  `npm run render:support`) y es la ruta para resolver cliente, Render, logs y DB
  con llaves cifradas del Installer.
- No metas secrets de soporte en este repo. Si falta el entorno local del
  Installer, pide acceso; no inventes valores.

## Documentación — OBLIGATORIO

- Antes de crear, mover o modificar documentación, lee **`docs/README.md`** y
  **`docs/DOCUMENTATION_SYSTEM.md`**.
- Para cualquier cambio de producto, arquitectura, rutas, servicios, tablas,
  permisos, licencias, pagos, integraciones, jobs, IA, app móvil, Sites, tracking
  o comportamiento visible, actualiza la sección correspondiente en
  **`docs/RISTAK_MASTER_MANUAL.md`** o el documento especializado indicado en
  `docs/README.md`.
- Si agregas un documento nuevo, debe quedar enlazado en **`docs/README.md`** y
  explicado en **`docs/DOCUMENTATION_SYSTEM.md`** si introduce una ruta nueva de
  mantenimiento.
- Nunca documentes valores reales de secrets, tokens, contraseñas, connection
  strings, certificados o claves privadas. Documenta sólo nombre, ubicación,
  propósito y si es obligatorio para arrancar.
- En el resumen final de cada implementación, menciona qué documentación
  actualizaste o por qué no aplicaba actualizar documentación.

## Git publishing

- `main` is the only base and publish target for this repo.
- Do not switch, cherry-pick, or push any other branch as part of publishing.
- Do not include unrelated local changes when syncing branches.

## Mobile store releases

- La ruta operativa para subir builds iOS/Android es **Ristak Installer →
  Configuración → Tiendas móviles**, no secretos en este repo ni GitHub Secrets
  permanentes.
- Si el usuario pide subir un build móvil desde este repo, primero revisa
  `docs/MOBILE_STORE_RELEASES.md` y dispara el flujo desde Ristak Installer
  (botón de Tiendas móviles o `publishMobileStoreRelease`). El workflow
  `mobile-store-release` espera un `mobile_release_token` temporal generado por
  Installer.
- Para iOS, Installer debe validar el certificado `.p12` guardado contra App
  Store Connect y refrescar/crear los provisioning profiles App Store de
  `com.ristak.app` y `com.ristak.app.NotificationService` antes de mandar el
  build a GitHub Actions. Si falla ese preflight, corrige credenciales en
  Installer; no regeneres ni pegues secretos en el repo de Ristak.
