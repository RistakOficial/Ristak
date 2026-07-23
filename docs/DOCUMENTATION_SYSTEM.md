# Sistema de documentacion

Ultima consolidacion: 2026-07-22.

Este documento define como se mantiene la documentacion de Ristak. El objetivo no
es tener menos archivos a lo bruto; el objetivo es que cada archivo tenga dueño,
proposito y una razon clara para existir.

## Estructura canonica

- `docs/README.md`: indice principal. Cualquier documento nuevo debe enlazarse
  ahi.
- `docs/RISTAK_MASTER_MANUAL.md`: manual consolidado de producto, arquitectura,
  modulos, runtime, datos, integraciones y reglas de operacion.
- `docs/DOCUMENTATION_SYSTEM.md`: esta regla de mantenimiento.
- Documentos de control: reglas obligatorias que no deben fusionarse dentro del
  manual porque bloquean cambios peligrosos.
  - `docs/DATE_TIME_GUIDELINES.md`
  - `docs/CURRENCY_GUIDELINES.md`
  - `docs/DESIGN_SYSTEM.md`
  - `docs/INTEGRATION_CRON_RULES.md`
- Documentos especializados: integraciones o superficies con suficiente detalle
  operativo para vivir separadas.

## Regla de mantenimiento para cada cambio

Cada cambio de codigo debe contestar estas preguntas antes de cerrar:

1. Que comportamiento visible cambio para el usuario?
2. Que ruta, servicio, tabla, job, integracion o configuracion se agrego o se
   modifico?
3. Ya existe una seccion en el manual o un documento especializado para eso?
4. Si se agrego una regla critica, esta documentada como regla y no solo como
   descripcion?
5. El resumen final menciona la documentacion actualizada?

Si el cambio es puramente mecanico, formateo, test interno o refactor sin cambio
de comportamiento, puede no actualizar docs. En ese caso el resumen final debe
decirlo explicitamente.

## Matriz de propiedad

| Area | Documento propietario |
| --- | --- |
| Producto completo, mapa de app, backend, frontend, datos, permisos, licencias, seguridad | `docs/RISTAK_MASTER_MANUAL.md` |
| Nuevas rutas o reorganizacion de docs | `docs/README.md` y `docs/DOCUMENTATION_SYSTEM.md` |
| Fechas de negocio, zonas horarias, calendarios, citas, reportes por rango, pagos programados | `docs/DATE_TIME_GUIDELINES.md` |
| Moneda, currency, importes, precios, productos, pagos, reportes financieros y conversiones con monto | `docs/CURRENCY_GUIDELINES.md` |
| Pantallas desktop, componentes comunes, estilos, tokens, auditoria visual | `docs/DESIGN_SYSTEM.md` |
| Integraciones con crons, watchdogs, polling, jobs de sincronizacion | `docs/INTEGRATION_CRON_RULES.md` |
| Deploy Render | `docs/DEPLOY-RENDER.md` |
| Licencia central e Installer | `docs/LICENSING.md` |
| API externa, OAuth, MCP | `docs/EXTERNAL_API_ACCESS.md` |
| Meta OAuth, BISU, permisos, handoff y broker multi-tenant de webhooks | `docs/META_OAUTH.md` |
| Enrutamiento entre MCP funcional y soporte interno; investigacion de clientes instalados via Installer | `docs/support-mcp-operations.md` |
| WhatsApp YCloud, Meta directo, Coexistence, webhooks, IDs y Baileys | `docs/integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md` y seccion Chat del manual maestro |
| Pixel/tracking/conversiones, CORS público, Cloudflare/CDN y tracking nativo de Sites | `docs/TRACKING_PIXEL.md`, `docs/PIXEL_SETUP.md` y seccion Meta/pagos del manual |
| Media/Bunny | `docs/MEDIA_STORAGE_BUNNY.md` |
| Movil/web, Android `mobile/`, Apple `ios/app` y store release via Installer/MCP | `docs/MOBILE_APP.md`, `docs/MOBILE_NATIVE_PARITY_CHECKLIST.md`, `docs/MOBILE_STORE_RELEASES.md`, `mobile/README.md`, `ios/README.md` |
| Bridge MDP | `docs/mdp-program-bridge.md` |

## Cuando crear un documento nuevo

No crees docs nuevos por reflejo. Primero intenta actualizar el manual maestro.

Crea un documento nuevo solo si:

- El tema tiene pasos operativos largos que estorban en el manual.
- El tema tiene reglas obligatorias que deben leerse antes de tocar codigo.
- El tema pertenece a una integracion compleja con credenciales, webhooks,
  callbacks o deploy propio.
- El documento sera reutilizado por humanos y agentes en mas de una tarea.

Si creas uno:

1. Ponlo bajo `docs/<dominio>/<tema>.md` o en `docs/` si es una regla global.
2. Agrega proposito, alcance y fuentes de verdad.
3. Enlazalo en `docs/README.md`.
4. Agrega o actualiza la fila correspondiente en la matriz de propiedad.

## Politica de secretos

La documentacion nunca debe contener valores reales de:

- Tokens API.
- Passwords.
- Claves privadas.
- Webhook signing secrets.
- Connection strings reales.
- Certificados.
- Refresh tokens.

Si hace falta documentar credenciales, registra solo:

- Nombre de la variable, tabla o campo.
- Donde vive.
- Quien la configura.
- Para que se usa.
- Si es obligatoria para arrancar o solo para activar una integracion.

## Regla especifica para pagos test y Meta

Los pagos en modo `test` no deben mandar conversiones reales a Meta.

Excepcion permitida: si en Configuracion > Meta esta activo el codigo de Test
Events (`meta_test_event_code`), el backend puede mandar el evento CAPI de pago
test con `test_event_code`, para que llegue al panel de pruebas de Meta. El pixel
publico del navegador no debe usarse como escape para pagos test si no hay una
garantia tecnica de aislamiento equivalente.

Esta regla debe mantenerse documentada en el manual maestro y cubierta por tests
de `backend/test/metaPaymentPurchaseEvent.test.mjs`.

## Checklist final para agentes

Antes de cerrar una tarea:

- `git diff --check` no debe reportar whitespace roto.
- Si tocaste UI desktop, abre la referencia visual en el navegador interno/aislado
  del agente (no Google Chrome ni el navegador personal del usuario) y corre
  `cd frontend && npm run design:audit`.
- Si tocaste moneda/currency/importes, confirma que los defaults salgan de
  `account_currency` segun `docs/CURRENCY_GUIDELINES.md`.
- Si tocaste TypeScript frontend, `cd frontend && npm run typecheck`.
- Si tocaste backend compartido o servicios, corre los tests relevantes de
  backend.
- Si tocaste pagos/Meta, corre
  `cd backend && node --test --test-concurrency=1 test/metaPaymentPurchaseEvent.test.mjs`.
- Actualiza docs en la misma rama.
- No dejes docs nuevos sin enlace en `docs/README.md`.
