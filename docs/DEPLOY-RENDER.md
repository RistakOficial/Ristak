# Render Blueprint Actual

Esta nota existe para evitar documentación duplicada y vieja. La guía principal está en [../DEPLOYMENT.md](../DEPLOYMENT.md).

## Estado Real Del `render.yaml`

El Blueprint actual define:

- Un `web` service llamado `ristak-app`.
- Runtime Node.
- Región `oregon`.
- Build de backend + frontend.
- Start command del backend.
- Una base PostgreSQL `ristak-db`.
- `DATABASE_URL` conectado desde esa base.
- `JWT_SECRET` generado por Render.
- Storage autoscaling habilitado para la base.
- Registro automático con el broker central cuando se usa por primera vez una integración
  compartida.

No define:

- Cron jobs separados de Render.
- `APP_URL`.
- `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` ni `HIGHLEVEL_API_KEY`.
- Credenciales de Installer, Bunny, Google, Meta, Mercado Pago o push.
- Servicios frontend/backend separados.

La URL pública se obtiene de `RENDER_EXTERNAL_URL`. El tenant genera su identidad técnica,
demuestra control de esa URL mediante un challenge firmado y recibe la configuración central
por backend. Por eso aplicar el Blueprint crudo sólo requiere la base y el `JWT_SECRET` generado:
no hay que copiar secrets desde Installer ni sincronizar manualmente variables de Bunny.

Esta autonomía cubre el runtime del producto: Google Login/Calendar, Meta OAuth, WhatsApp Meta
Direct, Mercado Pago, notificaciones push, Bunny multimedia, directorio móvil y dominios de
Sites. Las operaciones administrativas de infraestructura —actualizar una instalación,
promover versiones, consentimiento de disco, cancelación y releases de tiendas— siguen siendo
funciones de Installer y no forman parte del runtime del CRM.

Define:

- `diskSizeGB: 1` para que una base nueva arranque con 1 GB de storage.
  `storageAutoscalingEnabled` queda habilitado. Render no permite reducir disco,
  asi que un Blueprint sync puede fallar si una base existente ya fue aumentada
  manualmente por encima de 1 GB.

### Consentimiento del cliente antes de aumentar el disco

En instalaciones administradas por Ristak Installer, la base nace con autoscaling
habilitado como seguro. Ristak mide el uso real de PostgreSQL y, al llegar al 80%,
solicita al Installer la capacidad efectiva y el siguiente salto que aplicaría
Render. Si no existe una decisión para ese salto, el Installer pausa el autoscaling
antes de mostrar el aviso para impedir un aumento de precio sin autorización.

El modal sólo aparece a administradores con permiso de escritura sobre la cuenta y
muestra en USD el costo de almacenamiento cobrado directamente por Render: tarifa
por GB/mes, costo actual, costo con la nueva capacidad y diferencia mensual. Esa
tarifa vive en la configuración interna del Installer bajo
`render_postgres_storage_usd_per_gb_month`; no se infiere de la moneda de negocio
de Ristak porque es un precio externo de Render.

- **Autorizar aumento:** el Installer reactiva el autoscaling. Render puede ampliar
  el disco al llegar a su umbral operativo del 90%.
- **No aumentar:** exige escribir `RECHAZAR`, conserva el límite y deja un aviso de
  riesgo persistente. Si el disco se llena, Render puede suspender PostgreSQL y
  Ristak dejará de guardar datos o funcionar hasta ampliar el espacio.
- La decisión se registra por instalación y por salto de capacidad. Después de un
  aumento, el siguiente salto vuelve a requerir una decisión consciente.

Este flujo depende de que el Installer conserve cifrada la Render API Key y el ID
de la base. Si la instalación no es administrable, Ristak muestra el riesgo pero no
ofrece botones que prometan un cambio que no puede ejecutar.

Los jobs automáticos viven dentro del backend. No hay cron services separados en
Render.

Los crons de sistema arrancan con el backend. Los crons de integraciones se
registran en `backend/src/jobs/integrationCronRegistry.js` y sólo se activan si
la integración está conectada localmente. Esa regla está documentada en
[INTEGRATION_CRON_RULES.md](./INTEGRATION_CRON_RULES.md).

Crons de integración actuales:

- Google Calendar: `backend/src/jobs/googleCalendarSync.cron.js`.
- Meta Ads/social: `backend/src/jobs/metaSync.cron.js`.
- Versiones Meta API: `backend/src/jobs/metaVersionCron.js`.
- HighLevel: `backend/src/jobs/highlevelSync.cron.js`.
- Stripe: `backend/src/jobs/stripePaymentPlans.cron.js`.
- Conekta: `backend/src/jobs/conektaPaymentPlans.cron.js`.
- Mercado Pago: `backend/src/jobs/mercadoPagoPaymentPlans.cron.js`.
- WhatsApp QR: `backend/src/jobs/whatsappQrWatchdog.cron.js`.

## Deploy

1. Render Dashboard -> **New +** -> **Blueprint**.
2. Selecciona el repo.
3. Render lee `render.yaml`.
4. Aplica el Blueprint.

5. Abre la URL pública y completa `/setup`, o usa **Continuar con Google**. La primera acción que
   requiera una integración central registra automáticamente la instalación; no existe un paso
   manual para enlazarla con Installer.

No cambies nombres ni URLs en esta guía. Si necesitas renombrar servicios o base, hazlo directamente en `render.yaml` con cuidado porque el nombre de `fromDatabase.name` debe coincidir con la DB declarada.

### Contrato de migraciones durante un deploy

El backend escucha el puerto para que Render pueda observar el proceso, pero no
publica readiness hasta completar las migraciones versionadas. PostgreSQL
serializa la cadena completa con el advisory lock `versioned-migrations`; los
índices concurrentes permanecen fuera de una transacción y cada archivo se
registra en `schema_migrations` únicamente después de terminar correctamente.

Para impedir un deploy colgado indefinidamente, el tren `091*` en adelante y todos los
`CREATE INDEX CONCURRENTLY` usan por sesión:

- `lock_timeout`: 10 segundos.
- `statement_timeout`: 15 minutos.
- máximo tres intentos para timeouts, deadlocks o fallos de serialización
  transitorios.

Esos valores son internos, se restauran tras cada intento y no requieren nuevos
secrets ni variables de entorno. Si una creación concurrente fue cancelada y
dejó un índice homónimo inválido/no listo, el siguiente intento consulta
`pg_index`, elimina únicamente ese artifact con `DROP INDEX CONCURRENTLY` y lo
reconstruye. Un error persistente deja la nueva instancia fuera de readiness y
termina el proceso; nunca se marca el archivo a medias ni se habilita tráfico con
un índice inválido. Durante el primer rollout de índices sobre tablas grandes es
normal ver trabajo de I/O en PostgreSQL; la instancia anterior debe seguir
sirviendo hasta que la nueva quede saludable.

Las instalaciones históricas pueden tener `contacts.created_at`, `payments.date`
y `payments.created_at` como `TIMESTAMPTZ`, mientras una instalación nueva nace
con `TIMESTAMP`. Un índice de expresión compartido no debe forzar el fallback con
`TIMESTAMP '...'` ni con `TIMESTAMPTZ '...'`: ese cast cambia de volatilidad según
el esquema y PostgreSQL puede rechazarlo por no ser `IMMUTABLE`. Los cursores
`094a/094b` usan un literal UTC sin tipo explícito para que PostgreSQL lo resuelva
al tipo real de la columna; el SQL de lectura debe repetir exactamente esa misma
expresión. La regresión se valida en PostgreSQL real contra ambos tipos antes de
publicar una imagen.

## Dominio Y Frontend

Durante el build se crea:

```bash
frontend/.env.production
```

con:

```bash
VITE_API_URL=https://$RENDER_EXTERNAL_HOSTNAME
```

Eso hace que el frontend llame al mismo servicio Render donde corre el backend.

## Referencias Render

- [Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Environment variables and secrets](https://render.com/docs/configure-environment-variables/)
- [Deploys](https://render.com/docs/deploys/)
- [PostgreSQL pricing](https://render.com/docs/postgresql-refresh)
- [PostgreSQL disk autoscaling and full-disk behavior](https://render.com/docs/postgresql-creating-connecting)
