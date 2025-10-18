# 🚀 Cómo Deployar Esta App en Render

Este repo está listo para que **cada usuario lo deploya en su propia cuenta de Render** con su propia URL única.

## 📋 Antes de Empezar

Cada usuario necesita:
1. Una cuenta en [Render.com](https://render.com) (plan gratuito funciona)
2. Una cuenta en GitHub
3. Un fork o copia de este repositorio

---

## 🔧 Pasos para Deployar

### 1️⃣ Fork o Copia el Repo

- Haz fork de este repo en tu cuenta de GitHub
- O descarga y crea tu propio repo privado

### 2️⃣ Edita el `render.yaml`

**IMPORTANTE**: Antes de deployar, edita estos valores en `render.yaml`:

```yaml
# Línea 10: Cambia el nombre del servicio web
name: tu-nombre-unico

# Línea 26: Cambia la URL de tu app
- key: APP_URL
  value: https://tu-nombre-unico.onrender.com

# Línea 32: Cambia el nombre del cron job
name: tu-nombre-meta-sync

# Línea 39: Cambia la URL del cron job también
- key: APP_URL
  value: https://tu-nombre-unico.onrender.com
```

**Ejemplo** para "Dr. Carlos Serrano":
```yaml
name: dr-carlos-serrano
# ...
value: https://dr-carlos-serrano.onrender.com
```

### 3️⃣ Conecta el Repo en Render

1. Ve a [Render Dashboard](https://dashboard.render.com)
2. Click en **"New +"** → **"Blueprint"**
3. Conecta tu cuenta de GitHub
4. Selecciona tu repositorio
5. Render detectará automáticamente el `render.yaml`
6. Click en **"Apply"**

### 4️⃣ Espera el Deploy

Render va a crear automáticamente:
- ✅ Base de datos PostgreSQL
- ✅ Servicio web (tu app)
- ✅ Cron job (sincronización de Meta Ads cada hora)

Tiempo estimado: **5-10 minutos**

### 5️⃣ Accede a tu App

Tu app estará disponible en:
```
https://tu-nombre-unico.onrender.com
```

---

## 🔐 Variables de Entorno

Después del deploy, puedes agregar tus tokens/keys en:

**Render Dashboard → Tu Servicio → Environment**

Variables importantes:
- `META_ACCESS_TOKEN` - Token de Facebook Ads
- `META_AD_ACCOUNT_ID` - ID de tu cuenta de anuncios
- `HIGHLEVEL_API_KEY` - API Key de HighLevel

---

## 🗄️ Base de Datos

- **Plan FREE** de PostgreSQL (90 días)
- Si necesitas permanente, cambiar a plan `standard` ($7/mes)
- Los datos se guardan automáticamente en PostgreSQL

---

## ⚠️ Notas Importantes

### Cada Usuario Es Independiente
- Cada cuenta de Render es separada
- Cada uno tiene su propia base de datos
- Cada uno tiene su propia URL

### URLs Únicas
Si dos personas usan el mismo nombre en `render.yaml`, Render añade un sufijo automático:
- Primera persona: `ristak-app.onrender.com`
- Segunda persona: `ristak-app-xyz.onrender.com`

Por eso es mejor cambiar el nombre ANTES de deployar.

### Actualizar la App
Cuando hay cambios en el código:
1. Haz `git pull` para obtener los últimos cambios
2. Haz `git push` a tu repo
3. Render hace auto-deploy automáticamente

---

## 🐛 Problemas Comunes

### "Build failed"
- Verifica que editaste correctamente el `render.yaml`
- Revisa los logs en Render Dashboard

### "Cannot connect to database"
- Espera 1-2 minutos después del deploy
- La base de datos tarda en estar lista

### "Cron job not working"
- Verifica que la `APP_URL` en el cron job sea correcta
- Debe coincidir con la URL de tu servicio web

---

## 📞 Soporte

Si tienes problemas, revisa:
1. Logs del servicio en Render
2. Variables de entorno configuradas
3. Que el `render.yaml` tenga las URLs correctas

---

**¡Listo!** Tu app debería estar funcionando 🎉
