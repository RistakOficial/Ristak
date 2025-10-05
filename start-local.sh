#!/bin/bash

echo ""
echo "🚀 RISTAK HIGH LEVEL - LOCAL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Función para matar proceso en puerto específico
kill_port() {
    local PORT=$1
    local NAME=$2

    # Buscar TODOS los PIDs del proceso en el puerto
    local PIDS=$(lsof -ti:$PORT 2>/dev/null)

    if [ ! -z "$PIDS" ]; then
        echo "🔪 Matando $NAME en puerto $PORT..."
        # Matar todos los PIDs encontrados
        for PID in $PIDS; do
            kill -9 $PID 2>/dev/null || true
        done
        sleep 1
    else
        echo "✅ Puerto $PORT libre"
    fi
}

# Obtener el directorio base del script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Matar SOLO procesos en nuestros puertos específicos
echo "🧹 Limpiando puertos específicos..."
kill_port 3001 "Backend API"
kill_port 3000 "Frontend"

# Esperar un momento para asegurar que los puertos se liberaron completamente
sleep 2

# Establecer que estamos en desarrollo
export NODE_ENV=development

# Cargar variables de entorno del backend
if [ -f "$SCRIPT_DIR/backend/.env" ]; then
    echo "📋 Cargando variables de entorno del backend..."
    export $(cat "$SCRIPT_DIR/backend/.env" | grep -v '^#' | xargs)
fi

# Iniciar Backend API
echo ""
echo "🚀 Iniciando Backend API en puerto 3001..."
cd "$SCRIPT_DIR/backend"
# Usar start sin watch para evitar EMFILE en macOS
npm run start &
API_PID=$!

# Esperar a que la API esté lista
echo "⏳ Esperando Backend API..."
MAX_RETRIES=30
RETRY_COUNT=0
while ! curl -s http://localhost:3001/api/health > /dev/null 2>&1; do
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "❌ Error: El Backend API no pudo iniciar después de 30 segundos"
        kill $API_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
    RETRY_COUNT=$((RETRY_COUNT + 1))
done
echo "✅ Backend API listo"

# Iniciar Frontend
cd "$SCRIPT_DIR/frontend"
echo ""
echo "🎨 Iniciando Frontend en puerto 3000..."

# Verificar que existe index.html o el archivo principal de Vite
if [ ! -f "index.html" ] && [ ! -f "src/main.tsx" ]; then
    echo "❌ Error: No se encontró index.html o src/main.tsx en $SCRIPT_DIR/frontend"
    echo "   Asegúrate de estar en el directorio correcto del proyecto"
    kill $API_PID 2>/dev/null || true
    exit 1
fi

# Iniciar Vite con configuración específica
npm run dev &
FRONTEND_PID=$!

# Esperar a que el frontend esté listo
echo "⏳ Esperando Frontend..."
sleep 5

# Verificar que el frontend responde correctamente
MAX_RETRIES=10
RETRY_COUNT=0
while true; do
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null)

    if [ "$RESPONSE" = "200" ]; then
        echo "✅ Frontend listo"
        break
    elif [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "❌ Error: El frontend no responde correctamente (HTTP $RESPONSE)"
        kill $API_PID 2>/dev/null || true
        kill $FRONTEND_PID 2>/dev/null || true
        exit 1
    fi

    echo "⏳ Esperando respuesta del frontend (intento $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ RISTAK HIGH LEVEL - LISTO!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Backend API: http://localhost:3001"
echo "Frontend:    http://localhost:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🔗 Configura tu cuenta de HighLevel desde el Dashboard"
echo "   Ve a Settings -> Integraciones"
echo ""
echo "💡 Para detener: Ctrl+C"
echo ""

# Abrir el navegador automáticamente
sleep 2
open http://localhost:3000

# Función para limpiar al salir
cleanup() {
    echo ""
    echo "🛑 Deteniendo servicios..."
    kill $API_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    kill_port 3001 "Backend API"
    kill_port 3000 "Frontend"
    echo "✅ Servicios detenidos"
    exit 0
}

# Capturar Ctrl+C y limpiar
trap cleanup INT TERM EXIT

# Mantener corriendo y mostrar logs
wait $API_PID $FRONTEND_PID
