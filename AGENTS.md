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

- **Compuerta de alcance: estas reglas NO son globales.** Se activan solamente
  cuando el cambio modifica de forma intencional la presentación visual o la
  interacción visible del frontend de escritorio: estructura JSX/TSX renderizada,
  componentes visuales, estilos, tokens, layout, responsive o estados visuales.
  También se activan si Raúl pide explícitamente una revisión de diseño.
- **No activar por asociación.** No leas `docs/DESIGN_SYSTEM.md`, no abras la
  referencia visual y no corras `design:audit` para cambios exclusivos de backend,
  rutas, servicios, base de datos, migraciones, jobs, integraciones, tests,
  documentación, copy sin cambio visual o lógica frontend que conserve exactamente
  el mismo markup y estilos. Que un bug de backend tenga un síntoma visible en la
  app no convierte automáticamente el arreglo en una tarea de diseño.
- **Bugs full-stack.** Si la solución realmente modifica UI visual de escritorio,
  aplica estas reglas solo a esa parte del cambio. Si la causa raíz y el arreglo
  quedan en backend o en lógica no visual, valida esas capas y omite por completo
  el ritual de diseño.
- **ALTO antes de tocar UI visual.** Antes de crear o modificar cualquier elemento
  que sí caiga dentro del alcance visual definido arriba:
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

## Tracking público, CORS y Sites — OBLIGATORIO

- **ALTO antes de investigar o cambiar tracking.** Antes de optimizar, auditar
  seguridad o modificar pixel externo, `/snip.js`, `/collect`, CORS, Cloudflare,
  CDN, cookies/storage, dominios públicos, renderer de Sites, sesiones o
  atribución web, lee **`docs/TRACKING_PIXEL.md`** completo.
- Existen dos tuberías distintas: el pixel de páginas externas usa normalmente
  CORS y `tracking_source=external_pixel`; las páginas públicas de Sites usan
  tracking nativo first-party y `tracking_source=native_site`. No las mezcles ni
  instales el pixel externo sobre Sites por reflejo.
- `www.tudominio.com` y `track.tudominio.com` comparten dominio raíz, pero son
  orígenes distintos para el navegador. Nunca “arregles” eso abriendo el CORS de
  APIs privadas, activando credenciales públicas o agregando cada landing como
  secret de Render.
- Preview/editor de Sites apaga tracking intencionalmente. Una validación real
  exige URL pública publicada, navegador real y confirmación en la base de datos;
  reporta eventos y sesiones únicas por separado.
- CORS no autentica la ingesta pública. Cualquier hardening debe conservar el
  aislamiento de rutas privadas y evaluar abuso/rate limiting o un diseño
  firmado de servidor; un secret fijo dentro de JavaScript público no es secret.

## Enrutamiento MCP: operar Ristak vs dar soporte — OBLIGATORIO

- No trates todos los pedidos sobre Ristak como si fueran lo mismo. Primero
  clasifica la intencion y usa un solo carril como punto de entrada:

  | Intencion de Raul | Punto de entrada |
  | --- | --- |
  | Operar una funcion de Ristak como usuario: crear/buscar contactos, leer o mandar mensajes, agendar citas, ejecutar automatizaciones, gestionar pagos, crear/publicar Sites y acciones equivalentes | MCP funcional de Ristak: servidor `ristak`, `/api/mcp`, herramientas `mcp__ristak__*` |
  | Investigar un cliente instalado, una falla real, backend en produccion, chats/IA que no funcionaron, logs, deploy, health, esquema o datos del cliente | MCP de soporte del Installer: servidor `ristak-render-support`, herramientas `mcp__ristak_render_support__*` o `npm run render:support` |
  | Implementar una funcion, refactor o cambio de codigo sin incidente en una instalacion real | Repo local en rama/worktree limpio; no invoques soporte por reflejo |

- Si Raul dice "MSP", entiende que quiso decir **MCP** y decide cual de los dos
  por la intencion. No supongas que "MSP" siempre significa soporte.
- El MCP funcional es la primera opcion para ejecutar acciones de negocio. Respeta
  las herramientas realmente disponibles, la cuenta autenticada, scopes,
  permisos, licencia y confirmaciones; no prometas una capacidad que no aparezca
  en el MCP actual.
- El MCP de soporte es para evidencia operativa y diagnostico, no para operar el
  CRM ni como atajo para escribir directamente en la DB de un cliente. Sus
  consultas son read-only.
- Si el problema es de backend/codigo **y ocurre en un cliente o produccion**, lee
  **`docs/support-mcp-operations.md`**, usa soporte primero para probar el fallo y
  despues inspecciona o cambia el repo que corresponda. El MCP de soporte no
  sustituye la revision del codigo: identifica la instalacion, logs y datos reales.
- Si una operacion normal hecha con el MCP funcional falla de forma inesperada,
  conserva la evidencia de esa llamada y cambia al MCP de soporte para investigar;
  no sigas repitiendo escrituras a ciegas.
- En una solicitud mixta, separa las fases y dilo explicitamente: operacion con
  `ristak`; diagnostico con `ristak-render-support`; correccion en el repo
  correspondiente. Nunca uses ambos para ejecutar la misma escritura.
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
  `docs/MOBILE_STORE_RELEASES.md` y dispara el flujo desde Ristak Installer:
  MCP `ristak-mobile-stores` (`npm --prefix "/Users/raulgomez/Desktop/Ristak - Installer/backend" run mobile:stores:mcp`),
  botón **Tiendas móviles** o servicio `publishMobileStoreRelease`. El workflow
  `mobile-store-release` espera un `mobile_release_token` temporal generado por
  Installer.
- El MCP de tiendas móviles corre con `dryRun` por defecto. Para subir de verdad
  exige `dryRun=false` y confirmación explícita (`GENERAR`, `ENVIAR` o
  `PUBLICAR`). No inventes un camino paralelo desde este repo.
- Para iOS, Installer debe validar el certificado `.p12` guardado contra App
  Store Connect y refrescar/crear los provisioning profiles App Store de
  `com.ristak.app` y `com.ristak.app.NotificationService` antes de mandar el
  build a GitHub Actions. Si falla ese preflight, corrige credenciales en
  Installer; no regeneres ni pegues secretos en el repo de Ristak.
