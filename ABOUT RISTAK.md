# Ristak - HighLevel + Meta Ads

Ristak es una app full-stack para operar un dashboard de marketing y ventas conectado a HighLevel, Meta Ads, calendarios, pagos y un pixel propio de tracking web.

## Stack Real

Frontend:
- React 19 + TypeScript 5.7
- Vite 5
- React Router 7
- Recharts
- CSS Modules + Tailwind utilities

Backend:
- Node.js 20+ / 22 en Render
- Express 4
- SQLite en desarrollo local cuando no existe `DATABASE_URL`
- PostgreSQL en Render cuando existe `DATABASE_URL`
- `node-cron` para sincronizaciones internas

Deploy:
- Render Blueprint (`render.yaml`)
- Un solo web service sirve API + frontend compilado
- Postgres administrado por Render

## Funcionalidad Principal

- Dashboard financiero y de marketing
- Contactos, pagos, reportes y campañas
- Sincronización con HighLevel: contactos, citas e invoices/pagos
- Integración Meta Ads: cuentas, pixels, campañas, creatividades y métricas
- Calendarios HighLevel: vistas mes/semana/día, citas, usuarios y horarios bloqueados
- Pixel propio: `/snip.js`, `/collect` y API de sesiones
- Analíticas con datos del tracking interno
- Configuración persistente en `app_config` con cache en `localStorage`
- Autenticación propia con setup inicial del primer usuario

## Desarrollo Local

Instala dependencias una vez:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Arranca todo desde la raíz:

```bash
bash start-local.sh
```

URLs locales:
- Frontend: `http://localhost:3000`
- Backend/API: `http://localhost:3001`
- Health check: `http://localhost:3001/api/health`

El script libera los puertos `3000` y `3001`, carga `backend/.env` si existe, inicia el backend y luego Vite.

## Deploy En Render

El deploy actual usa `render.yaml` en la raíz:

- Build: instala backend, limpia frontend, instala frontend y ejecuta `vite build`.
- Durante el build crea `frontend/.env.production` con `VITE_API_URL=https://$RENDER_EXTERNAL_HOSTNAME`.
- Start: `npm start --prefix backend`.
- Render crea `DATABASE_URL` desde la base `ristak-db`.
- Los cron jobs viven dentro del proceso backend, no como servicios cron separados de Render.

Guía detallada: [DEPLOYMENT.md](./DEPLOYMENT.md)

## Documentación Técnica

- [CLAUDE.md](./CLAUDE.md): arquitectura viva, reglas de desarrollo, rutas y modelo de datos.
- [DEPLOYMENT.md](./DEPLOYMENT.md): deploy actual en Render.
- [docs/TRACKING_PIXEL.md](./docs/TRACKING_PIXEL.md): comportamiento real del pixel y tabla `sessions`.
- [docs/PIXEL_SETUP.md](./docs/PIXEL_SETUP.md): guía simple para instalar el pixel.
- [WHATSAPP_AD_ATTRIBUTION.md](./WHATSAPP_AD_ATTRIBUTION.md): atribución WhatsApp según el webhook actual.
- [backend/src/services/README_CALENDARS.md](./backend/src/services/README_CALENDARS.md): servicio backend de calendarios.
- [frontend/src/pages/Appointments/README.md](./frontend/src/pages/Appointments/README.md): módulo frontend de citas.

## Scripts

Raíz:
- `npm run build`: instala dependencias del frontend y compila `frontend/dist`.
- `npm start`: instala dependencias del backend y arranca `backend/src/server.js`.

Backend:
- `npm start`: arranca Express.
- `npm run dev`: arranca Express con `node --watch`.

Frontend:
- `npm run dev`: Vite en puerto `3000`.
- `npm run build`: build de producción.
- `npm run preview`: preview de Vite.

## Seguridad

- El primer usuario se crea desde `/setup`; ya no existe usuario admin por defecto.
- `ENCRYPTION_MASTER_KEY` se lee de env si existe o se genera y guarda en DB.
- `JWT_SECRET` debe existir en producción para no usar el fallback de desarrollo.
- Tokens de HighLevel y Meta se configuran desde Settings. Stripe se configura manualmente desde Settings con la cuenta propia del usuario y Secret keys guardadas cifradas en backend.

## Licencia

MIT.
