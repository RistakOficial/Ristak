# Documentacion de Ristak

Ultima consolidacion: 2026-07-22.

Este folder es la entrada canonica de documentacion. La regla es simple:
antes de crear otro README perdido, revisa este indice y actualiza el documento
correcto. Si de verdad hace falta un documento nuevo, debe quedar enlazado aqui.

## Lectura rapida

| Necesitas entender | Lee |
| --- | --- |
| La app completa, modulos, runtime, datos, integraciones y reglas criticas | [RISTAK_MASTER_MANUAL.md](./RISTAK_MASTER_MANUAL.md) |
| Como debe mantenerse la documentacion en cada cambio | [DOCUMENTATION_SYSTEM.md](./DOCUMENTATION_SYSTEM.md) |
| Reglas obligatorias para fechas, horarios, citas, rangos, reportes y pagos programados | [DATE_TIME_GUIDELINES.md](./DATE_TIME_GUIDELINES.md) |
| Reglas obligatorias para moneda, currency, importes, pagos, precios y reportes financieros | [CURRENCY_GUIDELINES.md](./CURRENCY_GUIDELINES.md) |
| Reglas obligatorias de UI desktop | [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) |
| Reglas obligatorias para crons/jobs de integraciones externas | [INTEGRATION_CRON_RULES.md](./INTEGRATION_CRON_RULES.md) |
| Reglas obligatorias de atribucion de conversiones y eventos Meta CAPI | [CONVERSION_ATTRIBUTION.md](./CONVERSION_ATTRIBUTION.md) |
| OAuth de Meta, BISU, permisos, handoff y broker multi-tenant de webhooks | [META_OAUTH.md](./META_OAUTH.md) |
| Como elegir entre el MCP funcional de Ristak y el MCP de soporte; revisar clientes, logs, chats, DB e IA instalada | [support-mcp-operations.md](./support-mcp-operations.md) |
| Diferencias y contrato entre WhatsApp YCloud, Meta directo, Coexistence y Baileys | [integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md](./integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md) |

## Rutas por tipo de cambio

| Tipo de cambio | Documento que debes actualizar |
| --- | --- |
| Arquitectura general, rutas principales, dominios, flujos de usuario, cambios cross-module | [RISTAK_MASTER_MANUAL.md](./RISTAK_MASTER_MANUAL.md) |
| Cambios al sistema de documentacion o nuevas rutas de docs | [DOCUMENTATION_SYSTEM.md](./DOCUMENTATION_SYSTEM.md) y este indice |
| Fechas, horas, rangos, citas, crons por fecha, pagos programados, reportes por periodo | [DATE_TIME_GUIDELINES.md](./DATE_TIME_GUIDELINES.md) |
| Moneda, currency, importes, precios, productos, pagos, reportes financieros, Meta CAPI con compras | [CURRENCY_GUIDELINES.md](./CURRENCY_GUIDELINES.md) |
| UI desktop, componentes, estilos, tokens, auditoria visual | [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) |
| Jobs periodicos, polling, watchdogs o crons de integraciones externas | [INTEGRATION_CRON_RULES.md](./INTEGRATION_CRON_RULES.md) |
| Render/deploy | [DEPLOY-RENDER.md](./DEPLOY-RENDER.md) y [../DEPLOYMENT.md](../DEPLOYMENT.md) |
| Licenciamiento, distribucion managed Docker, restricciones por plan | [LICENSING.md](./LICENSING.md) |
| API externa, OAuth, MCP y tokens de integracion | [EXTERNAL_API_ACCESS.md](./EXTERNAL_API_ACCESS.md) |
| Conexion de Meta OAuth, convivencia manual y relay central de Messenger/Instagram/comentarios | [META_OAUTH.md](./META_OAUTH.md) |
| Enrutamiento entre MCP funcional y soporte interno via Ristak Installer | [support-mcp-operations.md](./support-mcp-operations.md) |
| WhatsApp YCloud, Meta directo, Coexistence, webhooks, IDs y Baileys | [integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md](./integrations/WHATSAPP_PROVIDER_ARCHITECTURE.md) y la seccion Chat del manual |
| Pixel, tracking, sesiones, conversiones, CORS público, Cloudflare/CDN, Sites públicos y rastreo web | [TRACKING_PIXEL.md](./TRACKING_PIXEL.md) y [PIXEL_SETUP.md](./PIXEL_SETUP.md) |
| Atribucion de compras/citas, ultimo paid touch, superficie y payload Meta CAPI | [CONVERSION_ATTRIBUTION.md](./CONVERSION_ATTRIBUTION.md) |
| Media, Bunny Storage, Bunny Stream y cuotas | [MEDIA_STORAGE_BUNNY.md](./MEDIA_STORAGE_BUNNY.md) |
| Rutas moviles, `/movil` web y app Android `mobile/` | [MOBILE_APP.md](./MOBILE_APP.md) y [MOBILE_NATIVE_PARITY_CHECKLIST.md](./MOBILE_NATIVE_PARITY_CHECKLIST.md) |
| App nativa Apple (SwiftUI, iPhone/iPad) | [../ios/README.md](../ios/README.md), [../ios/docs/ARCHITECTURE.md](../ios/docs/ARCHITECTURE.md) y [../ios/docs/research/](../ios/docs/research/) |
| Builds para App Store / Play Store via Ristak Installer/MCP | [MOBILE_STORE_RELEASES.md](./MOBILE_STORE_RELEASES.md) |
| Bridge embebido MDP | [mdp-program-bridge.md](./mdp-program-bridge.md) |
| Calendarios locales y embebidos | [../backend/src/services/README_CALENDARS.md](../backend/src/services/README_CALENDARS.md) y [../frontend/src/pages/Appointments/README.md](../frontend/src/pages/Appointments/README.md) |

## Documentos historicos

Estos archivos siguen existiendo porque contienen contexto util o porque otros
flujos todavia los referencian, pero la ruta canonica para orientarte es este
indice y el manual maestro:

- [../ABOUT RISTAK.md](../ABOUT%20RISTAK.md)
- [../READ ME.md](../READ%20ME.md)
- [../DEPLOYMENT.md](../DEPLOYMENT.md)
- [../WHATSAPP_AD_ATTRIBUTION.md](../WHATSAPP_AD_ATTRIBUTION.md)
- [../CLAUDE.md](../CLAUDE.md)
- [../audit-crm/](../audit-crm/)

No dupliques informacion grande en esos documentos. Si algo cambia, actualiza el
manual o el documento especializado y deja los historicos como referencia.

## Regla para IA y agentes

Todo agente que modifique Ristak debe:

1. Leer [../AGENTS.md](../AGENTS.md).
2. Revisar este indice antes de tocar documentacion.
3. Actualizar el documento correcto en la misma rama del cambio.
4. No escribir secretos reales, tokens, passwords ni credenciales en docs.
5. En el resumen final, decir que documentacion se actualizo o por que no aplicaba.
6. Si una regla pide abrir `docs/design-reference/design-system.html`, usar el
   navegador interno/aislado del agente; no usar Google Chrome ni el navegador
   personal del usuario salvo peticion explicita.

Si se agrega un modulo nuevo y no encaja en los documentos actuales, crea una
ruta bajo `docs/<dominio>/<tema>.md`, enlazala aqui y explica en
[DOCUMENTATION_SYSTEM.md](./DOCUMENTATION_SYSTEM.md) cuando debe usarse.
