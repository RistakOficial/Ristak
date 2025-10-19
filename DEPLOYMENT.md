# 🚀 Guía de Deploy en Render

Esta guía te explica cómo deployar tu propia instancia de Ristak en Render paso a paso.

## 📋 Requisitos Previos

1. Una cuenta de GitHub (gratis)
2. Una cuenta de Render (gratis o de pago)
3. Acceso a este repositorio

---

## 🔧 Paso 1: Fork del Repositorio

1. Ve al repositorio en GitHub
2. Click en el botón **"Fork"** (arriba a la derecha)
3. Esto crea una copia del proyecto en TU cuenta de GitHub

---

## 🎯 Paso 2: Crear tu instancia en Render

### A. Conectar con GitHub

1. Ve a [Render Dashboard](https://dashboard.render.com)
2. Click en **"New +"** → **"Blueprint"**
3. Conecta tu cuenta de GitHub si aún no lo has hecho
4. Busca tu fork del repositorio **"Ristak-HighLevel"** y selecciónalo

### B. Configurar el Deploy

Render va a leer el archivo `render.yaml` y va a:

- ✅ Crear automáticamente una base de datos PostgreSQL
- ✅ Crear el servicio web (backend + frontend)
- ✅ Configurar todas las variables de entorno necesarias
- ✅ Hacer el primer deploy

**IMPORTANTE**: El deploy tarda entre 5-10 minutos la primera vez.

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

1. Ve a **Settings** en tu app
2. En la sección **HighLevel Integration**:
   - Pega tu **Access Token** de HighLevel
   - Pega tu **Location ID**
   - Click en **"Save"**

3. La app va a:
   - Encriptar y guardar tus credenciales de forma segura
   - Empezar a sincronizar tus contactos automáticamente

---

## 📊 Paso 5: Conectar Meta Ads (Opcional)

Si quieres trackear tus campañas de Facebook/Instagram:

1. Ve a **Settings** → **Meta Ads Integration**
2. Pega tu **Meta Access Token**
3. Pega tu **Ad Account ID**
4. Click en **"Save"**

La app comenzará a sincronizar tus métricas de anuncios cada hora.

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
