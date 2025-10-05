# Ristak - High Level

Dashboard de marketing que integra **HighLevel CRM** con **Meta Ads** para visualizar métricas financieras y rendimiento de campañas.

## Características

- 📊 Dashboard con KPIs financieros (Ingresos, ROAS, Ganancia Neta, etc.)
- 🔄 Sincronización automática con HighLevel (contactos, pagos, citas)
- 📱 Integración con Meta Ads (campañas, métricas, insights)
- 🪝 Webhooks en tiempo real para actualizaciones instantáneas
- ⏰ Actualización automática de ads cada hora (cron job)
- 🌓 Modo claro/oscuro
- 📱 Diseño responsive

## Stack Tecnológico

### Backend
- Node.js + Express
- SQLite (base de datos local)
- node-cron para tareas programadas
- Integración con HighLevel API y Meta Graph API

### Frontend
- React 18 + TypeScript
- Vite
- CSS Modules
- Recharts (gráficas)
- React Router

## Instalación Local

### Requisitos
- Node.js >= 20.0.0
- npm o yarn

### Pasos

1. **Instalar dependencias del backend:**
```bash
cd backend
npm install
```

2. **Instalar dependencias del frontend:**
```bash
cd frontend
npm install
```

3. **Configurar variables de entorno:**

**Backend** (`backend/.env`):
```bash
NODE_ENV=development
PORT=3001
PUBLIC_URL=http://localhost:3001
```

**Frontend** (`frontend/.env`):
```bash
VITE_API_URL=http://localhost:3001
```

4. **⚠️ IMPORTANTE - Iniciar con el script start-local.sh:**

Desde la raíz del proyecto:
```bash
bash start-local.sh
```

Este script:
- Mata procesos antiguos en puertos 3000 y 3001
- Inicia el backend en puerto 3001
- Inicia el frontend en puerto 3000
- Abre automáticamente el navegador en http://localhost:3000
- Configura todo para usar SQLite local (ristak.db)

## Configuración Inicial

### 1. Conectar HighLevel

1. Ve a **Settings** en la app
2. Ingresa tu **Location ID** y **API Token** de HighLevel
3. Clic en "Probar Conexión" para validar
4. Clic en "Guardar y Configurar Webhooks"
5. Clic en "Sincronizar Datos Iniciales" (esto puede tardar varios minutos)

Esto creará automáticamente los Custom Values en HighLevel con las URLs de los webhooks.

### 2. Configurar Webhooks en HighLevel

Después de guardar la configuración, debes crear workflows en HighLevel:

**Webhook de Contactos:**
- Trigger: Contact Created/Updated
- Action: Webhook → Usar la URL del custom value `webhook_contacts`

**Webhook de Pagos:**
- Trigger: Payment Received
- Action: Webhook → Usar la URL del custom value `webhook_payments`

**Webhook de Citas:**
- Trigger: Appointment Booked
- Action: Webhook → Usar la URL del custom value `webhook_appointments`

### 3. Conectar Meta Ads

**Opción A: Desde HighLevel (automático)**

Si guardaste estos Custom Values en HighLevel, la app los detectará automáticamente:
- `Facebook - Ad Account ID`
- `Facebook - App Access Token`

**Opción B: Manual**

1. Ve a la pestaña **Meta Ads** en Settings
2. Ingresa:
   - Ad Account ID (ej: `act_123456789`)
   - Access Token (token de larga duración de 60 días)
3. Guarda la configuración

### 4. Sincronizar Ads de Meta

1. En la página **Campaigns**, clic en "Sincronizar Campañas"
2. Selecciona fecha de inicio (máximo 35 meses atrás)
3. Espera a que termine la sincronización

Esto obtendrá TODOS los ads desde esa fecha. La sincronización puede tardar varios minutos dependiendo de cuántos ads tengas.

## 📦 Base de Datos

Este proyecto usa **SQLite** como base de datos local. El archivo `ristak.db` se crea automáticamente en la raíz del proyecto al iniciar el servidor.

### Ver tus datos

Para visualizar los datos en tu base de datos SQLite, puedes usar:

1. **DB Browser for SQLite** (Gratis - Recomendado)
   - Descarga: https://sqlitebrowser.org
   - Abre el archivo `/Users/raulgomez/Desktop/Ristak - High Level/ristak.db`
   - Interfaz visual tipo Excel

2. **TablePlus** (De pago después de 14 días trial)
   - Descarga: https://tableplus.com
   - Interfaz moderna y bonita

3. **Beekeeper Studio** (Gratis - Open Source)
   - Descarga: https://www.beekeeperstudio.io
   - Alternativa gratuita moderna

## Estructura del Proyecto

```
ristak-high-level/
├── backend/
│   ├── src/
│   │   ├── config/         # Configuración (DB, constantes)
│   │   ├── controllers/    # Lógica de negocio
│   │   ├── routes/         # Endpoints de Express
│   │   ├── services/       # Servicios (HighLevel, Meta)
│   │   ├── jobs/           # Cron jobs
│   │   ├── utils/          # Utilidades
│   │   └── server.js       # Entry point
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/     # Componentes React
│   │   ├── contexts/       # Contexts (Auth, Theme, etc)
│   │   ├── pages/          # Páginas
│   │   ├── services/       # API clients
│   │   ├── styles/         # CSS global
│   │   ├── types/          # TypeScript types
│   │   └── utils/          # Utilidades
│   └── package.json
└── render.yaml             # Configuración de Render
```

## API Endpoints

### HighLevel
- `POST /api/highlevel/test-connection` - Probar conexión
- `POST /api/highlevel/config` - Guardar configuración
- `GET /api/highlevel/config` - Obtener configuración
- `POST /api/highlevel/sync` - Sincronizar datos
- `GET /api/highlevel/sync/progress` - Ver progreso

### Meta
- `POST /api/meta/config` - Guardar configuración
- `GET /api/meta/config` - Obtener configuración
- `POST /api/meta/sync` - Sincronizar ads
- `GET /api/meta/sync/progress` - Ver progreso
- `POST /api/meta/update-recent` - Actualizar ads recientes
- `GET /api/meta/campaigns` - Obtener campañas

### Dashboard
- `GET /api/dashboard/metrics?startDate=X&endDate=Y` - Obtener KPIs
- `GET /api/dashboard/chart-data?startDate=X&endDate=Y&groupBy=day` - Datos de gráficas

### Webhooks
- `POST /webhook/contact` - Nuevo contacto
- `POST /webhook/payment` - Nuevo pago
- `POST /webhook/appointment` - Nueva cita
- `POST /webhook/whatsapp/attribution` - Atribución WhatsApp

## Cron Jobs

### Actualización de Meta Ads (cada hora)
- **Desarrollo:** Se ejecuta automáticamente con node-cron
- **Producción:** Render Cron Job llama a `/api/meta/update-recent`
- **Qué hace:** Actualiza solo los últimos 7 días sin borrar datos históricos

## Tablas de la Base de Datos
- `contacts` - Contactos de HighLevel
- `payments` - Transacciones/pagos
- `appointments` - Citas agendadas
- `meta_ads` - Ads de Meta con métricas diarias
- `meta_config` - Configuración de Meta
- `highlevel_config` - Configuración de HighLevel
- `whatsapp_attribution` - Atribución de WhatsApp

## Notas Importantes

### Single Tenant
Esta app está diseñada para **un solo cliente por instancia**. Si necesitas múltiples clientes, debes:
1. Clonar el repositorio
2. Hacer deploy de una instancia nueva en Render
3. Cada cliente tendrá su propia URL y base de datos

### Webhooks
Los webhooks solo funcionan en producción (con URL pública). En desarrollo local, HighLevel no puede enviar webhooks a `localhost`.

Para probar webhooks en local, usa:
- [ngrok](https://ngrok.com): `ngrok http 3001`
- [localtunnel](https://localtunnel.github.io/www/): `lt --port 3001`

### Límites de API
- **HighLevel:** 120 requests/minuto
- **Meta:** 200 requests/hora por token

La app maneja paginación automática pero no tiene rate limiting implementado. Si tienes muchos datos, las sincronizaciones iniciales pueden tardar.

## Troubleshooting

### "Error al conectar con HighLevel"
- Verifica que el Location ID y API Token sean correctos
- El token debe tener permisos de lectura/escritura
- Verifica que la API de HighLevel esté funcionando

### "Error al sincronizar Meta Ads"
- Verifica que el Access Token no haya expirado (duración: 60 días)
- El Ad Account ID debe empezar con `act_`
- Verifica permisos del token (necesita `ads_read`)

### "Webhooks no llegan"
- Verifica que creaste los workflows en HighLevel
- Verifica que las URLs de los webhooks sean correctas
- En desarrollo local, necesitas un túnel (ngrok/localtunnel)

### "Base de datos no inicializa"
- Verifica que tengas permisos de escritura en la carpeta del proyecto
- El archivo `ristak.db` debe crearse automáticamente en la raíz
- Revisa los logs del servidor para ver errores específicos

## Licencia

Privado - Solo para uso interno

## Soporte

Para reportar bugs o solicitar features, contacta al equipo de desarrollo.
