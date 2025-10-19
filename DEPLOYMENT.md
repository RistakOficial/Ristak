# 🚀 Guía de Deploy en Render

Esta guía te explica cómo deployar tu propia instancia de Ristak en Render en **menos de 5 minutos**.

## 📋 Requisitos Previos

1. Una cuenta de Render (gratis o de pago) - [Crear cuenta aquí](https://render.com)
2. Eso es todo 😎

---

## ⚡ Deploy en 1 Click

### Opción 1: Botón Deploy to Render (MÁS FÁCIL)

1. **Haz click en este botón:**

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/RAULG0MEZ/Ristak-HighLevel)

2. **Render te va a pedir:**
   - Conectar con tu cuenta (si no lo has hecho)
   - Nombre para tu servicio (ej: "ristak-mi-negocio")
   - Región (elige la más cercana a ti)

3. **Click en "Apply"**

4. **Espera 5-10 minutos** mientras Render:
   - Crea tu base de datos PostgreSQL
   - Deploya el backend + frontend
   - Configura todo automáticamente

5. **¡Listo!** Render te dará una URL como: `https://ristak-mi-negocio.onrender.com`

---

## 🎯 Opción 2: Deploy Manual (si prefieres más control)

1. Ve a [Render Dashboard](https://dashboard.render.com)
2. Click en **"New +"** → **"Blueprint"**
3. En el campo **"Public Git Repository"**, pega: `https://github.com/RAULG0MEZ/Ristak-HighLevel`
4. Click en **"Apply"**

Render va a leer el archivo `render.yaml` y va a:

- ✅ Crear automáticamente una base de datos PostgreSQL
- ✅ Crear el servicio web (backend + frontend)
- ✅ Configurar todas las variables de entorno necesarias
- ✅ Hacer el primer deploy

**IMPORTANTE**: El deploy tarda entre 5-10 minutos la primera vez.

---

## 🔄 Cómo Recibir Actualizaciones

**IMPORTANTE**: Como usas el repositorio original (sin fork), necesitas configurar auto-updates:

1. Ve a tu servicio en Render Dashboard
2. **Settings** → **Build & Deploy**
3. En **"Auto-Deploy"**, asegúrate que esté **ON** (activado)
4. Branch: **main**

**Ahora, cada vez que haya una actualización:**
- Render detectará el nuevo commit automáticamente
- Hará auto-deploy de la nueva versión (2-3 minutos)
- Tu app se actualiza sin que hagas nada 🎉

### Ver qué cambió:

Puedes ver el historial de actualizaciones en:
- GitHub: https://github.com/RAULG0MEZ/Ristak-HighLevel/commits/main
- Render Dashboard → Events (verás cada deploy)

---

## 🔐 Configuración de Seguridad (AUTOMÁTICA)

### Clave de Encriptación

**NO necesitas configurar nada**. La app genera automáticamente una clave maestra de encriptación al primer deploy y la guarda en la base de datos.

Esta clave se usa para proteger tus tokens de Meta Ads y otros datos sensibles.

**📝 Nota**: Si por alguna razón quieres usar tu propia clave:

1. Ve a **Environment** en Render
2. Agrega una variable: `ENCRYPTION_MASTER_KEY`
3. Genera una clave con este comando:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Guarda el valor generado

---

## ✅ Paso 3: Verificar que Funciona

### A. Revisar los Logs

1. En Render Dashboard, ve a tu servicio
2. Click en **"Logs"**
3. Busca estos mensajes de éxito:

```
✅ ENCRYPTION_MASTER_KEY cargada desde base de datos
✅ Nueva ENCRYPTION_MASTER_KEY generada y guardada en DB
🚀 Servidor corriendo en puerto 3001
```

### B. Abrir la App

1. Render te da una URL como: `https://tu-app.onrender.com`
2. Abre esa URL en tu navegador
3. Deberías ver la pantalla de login/configuración

---

## 🔗 Paso 4: Conectar HighLevel

1. Ve a **HighLevel** (app.gohighlevel.com) y obtén:
   - Tu **Access Token** (Settings → Integrations → API Key)
   - Tu **Location ID** (Settings → Company)

2. En Ristak, ve a **Settings** → **HighLevel Integration**:
   - Pega tu Access Token
   - Pega tu Location ID
   - Click en **"Guardar y Sincronizar"**

3. La app va a:
   - Guardar tus credenciales de forma segura (encriptadas)
   - Sincronizar tus contactos, pagos y citas automáticamente

---

## 📊 Paso 5: Conectar Meta Ads (Opcional)

Si quieres trackear tus campañas de Facebook/Instagram:

### EN HIGHLEVEL (no en Ristak):

1. Ve a **Settings → Meta Ads** en Ristak para ver el **tutorial completo paso a paso**
2. Sigue las instrucciones para:
   - Crear una App en Meta Developers
   - Generar un System User Token (nunca caduca)
   - Obtener tu Ad Account ID

3. **Guarda estos 4 valores en HighLevel Custom Values:**
   - `Facebook - Ad Account ID`
   - `Facebook - App Access Token`
   - `Facebook - App ID`
   - `Facebook - App Secret`

### EN RISTAK:

4. Ve a **Settings → HighLevel** y haz clic en **"Sincronizar"**
5. Ristak traerá automáticamente la configuración de Meta desde HighLevel
6. Ve a **Publicidad** y haz clic en **"Sincronizar Meta Ads"**

La app sincronizará automáticamente tus métricas de anuncios cada hora.

---

## 🆘 Solución de Problemas

### Error: "Master key no inicializada"

**Solución**: Reinicia el servicio en Render:
- Dashboard → tu servicio → **Manual Deploy** → **"Clear build cache & deploy"**

### La app no sincroniza datos

**Verifica**:
1. Que tu Access Token de HighLevel sea válido
2. Que tu Location ID sea correcto
3. Revisa los logs en Render para ver errores específicos

### "Error al desencriptar datos"

**Causa**: Cambiaste de base de datos o perdiste la encryption key

**Solución**:
1. Ve a Settings → HighLevel Integration
2. Vuelve a guardar tu Access Token
3. Esto re-encriptará con la nueva clave

---

## 🔄 Actualizaciones

Cuando salgan nuevas versiones de Ristak:

1. En tu fork de GitHub, click en **"Sync fork"**
2. Render detectará los cambios automáticamente
3. Hará auto-deploy de la nueva versión (2-3 minutos)

---

## 💡 Tips de Seguridad

✅ **NUNCA** compartas tu Access Token de HighLevel
✅ **NUNCA** compartas tu Meta Access Token
✅ Usa el plan de pago de Render para mejor uptime
✅ Haz backups de tu base de datos regularmente

---

## 📞 Soporte

Si tienes problemas con el deploy:

1. Revisa los **Logs** en Render Dashboard
2. Verifica que todas las variables de entorno estén configuradas
3. Contacta a soporte técnico si el problema persiste

---

**¡Listo!** Tu app ya está corriendo en producción 🎉
