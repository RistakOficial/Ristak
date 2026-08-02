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

En instalaciones administradas por Ristak Installer, la base creada por API nace
con autoscaling apagado. El monitor central consulta cada cinco minutos las
métricas de Render y guarda el snapshot fuera del tenant, así que puede detectar
una base llena aunque PostgreSQL ya no acepte conexiones. Al llegar al 80%, Ristak
muestra la capacidad efectiva y el siguiente salto; al 90%, el Installer manda
un aviso de campana y push al celular con enlace al portal de recuperación.

El modal sólo aparece a administradores con permiso de escritura sobre la cuenta y
muestra en USD el costo de almacenamiento cobrado directamente por Render: tarifa
por GB/mes, costo actual, costo con la nueva capacidad y diferencia mensual. Esa
tarifa vive en la configuración interna del Installer bajo
`render_postgres_storage_usd_per_gb_month`; no se infiere de la moneda de negocio
de Ristak porque es un precio externo de Render.

- **Autorizar aumento:** el Installer registra una operación idempotente, reanuda
  PostgreSQL si está suspendido y aumenta `diskSizeGB` explícitamente. El
  autoscaling queda apagado para que el siguiente salto vuelva a pedir permiso.
- **No aumentar:** exige escribir `RECHAZAR`, conserva el límite y deja un aviso de
  riesgo persistente. Si el disco se llena, Render puede suspender PostgreSQL y
  Ristak dejará de guardar datos o funcionar hasta ampliar el espacio.
- La decisión se registra por instalación y por salto de capacidad. Después de un
  aumento, el siguiente salto vuelve a requerir una decisión consciente.
- Si el tenant ya no puede leer su base, la página pública responde 507 con la
  causa, la cotización y un botón autenticado a `/start?storage=1`; no confunde la
  caída con un dominio sin configurar.
- Cuando el arranque confirma con el Installer que PostgreSQL está suspendido o
  lleno, el proceso entra en modo `storage_recovery`: conserva `/health` en 200
  para que Render acepte el contenedor nuevo, pero mantiene el resto de la app
  bloqueado detrás de la página 507. Cualquier otro error de arranque conserva el
  fail-fast normal y no puede disfrazarse como una recuperación de almacenamiento.
- El modo `storage_recovery` se autorrepara: cada 15 segundos comprueba tanto una
  consulta real a PostgreSQL como el estado central del Installer. Después de dos
  confirmaciones sanas consecutivas termina el proceso para que Render lo reinicie
  y ejecute el arranque completo. Si la base vuelve a fallar, el Installer todavía
  reporta lleno/suspendido o una consulta queda en vuelo, no reinicia ni duplica
  verificaciones; espera el siguiente ciclo y evita un crash loop.

Este flujo depende de que el Installer conserve cifrada la Render API Key y el ID
de la base. Si la instalación no es administrable, Ristak muestra el riesgo pero no
ofrece botones que prometan un cambio que no puede ejecutar.

Los jobs automáticos viven dentro del backend. No hay cron services separados en
Render.

### Dirección canónica root / www de Sites

Render crea una pareja automática: si se agrega la raíz, `www` redirige a la
raíz; si se agrega `www`, la raíz redirige a `www`. Esa decisión ocurre antes de
que el request llegue a Express, por lo que no puede contradecir el
`canonical_domain` guardado en Ristak.

En una instalación administrada, Ristak solicita el cambio a
`POST /api/license/sites-domain/sync`. Installer lista los custom domains del web
service, modifica sólo la pareja exacta raíz/`www`, confirma cuál quedó sin
`redirectForName` y conserva los demás subdominios. Si el alta falla después de
retirar la pareja anterior, intenta restaurar el principal previo antes de
responder error. La API Key permanece cifrada en Installer y sólo se descifra en
memoria; no se copia a la app ni a un nuevo secret.

El backend también valida `/health` con redirects manuales: el secundario puede
redirigir al canónico, pero el canónico no puede redirigir hacia afuera. Esa
compuerta impide ciclos incluso durante una desalineación o un fallo parcial de
la sincronización. Standalone no tiene autoridad sobre la cuenta Render y debe
configurar la pareja externamente con la misma dirección elegida en Ristak.

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
