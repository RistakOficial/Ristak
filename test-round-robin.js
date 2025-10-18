#!/usr/bin/env node

/**
 * Script de prueba para verificar el flujo de Round Robin
 * Obtiene el calendario ADMISIONES y luego obtiene los datos de sus team members
 */

const API_BASE = 'https://ristak.raulgomez.com.mx';

async function testRoundRobinFlow() {
  try {
    console.log('🔍 Paso 1: Obteniendo lista de calendarios...\n');

    // Paso 1: Obtener lista de calendarios
    const calendarsRes = await fetch(`${API_BASE}/api/calendars`);
    const calendarsData = await calendarsRes.json();

    if (!calendarsData.success) {
      console.error('❌ Error al obtener calendarios:', calendarsData.error);
      return;
    }

    const calendars = calendarsData.calendars || [];
    console.log(`✅ ${calendars.length} calendarios encontrados\n`);

    // Buscar el calendario de ADMISIONES
    const admisionesCalendar = calendars.find(cal =>
      cal.name && cal.name.toUpperCase().includes('ADMISIONES')
    );

    if (!admisionesCalendar) {
      console.log('❌ No se encontró el calendario ADMISIONES');
      console.log('Calendarios disponibles:');
      calendars.forEach(cal => {
        console.log(`  - ${cal.name} (${cal.calendarType})`);
      });
      return;
    }

    console.log('📅 Calendario ADMISIONES encontrado:');
    console.log(`  ID: ${admisionesCalendar.id}`);
    console.log(`  Nombre: ${admisionesCalendar.name}`);
    console.log(`  Tipo: ${admisionesCalendar.calendarType}`);
    console.log(`  EventType: ${admisionesCalendar.eventType || 'N/A'}`);
    console.log(`  Team Members: ${admisionesCalendar.teamMembers?.length || 0}\n`);

    // Paso 2: Verificar si es Round Robin
    const isRoundRobin = admisionesCalendar.calendarType === 'round_robin' ||
                        admisionesCalendar.eventType?.includes('RoundRobin');

    console.log(`🔄 ¿Es Round Robin? ${isRoundRobin ? 'SÍ' : 'NO'}\n`);

    if (!admisionesCalendar.teamMembers || admisionesCalendar.teamMembers.length === 0) {
      console.log('⚠️  El calendario no tiene team members asignados');
      return;
    }

    // Paso 3: Extraer los userIds de teamMembers
    const userIds = admisionesCalendar.teamMembers.map(tm => tm.userId);
    console.log('👥 Team Member IDs:');
    userIds.forEach(id => console.log(`  - ${id}`));
    console.log();

    // Paso 4: Obtener datos completos de los usuarios
    console.log('🔍 Paso 2: Obteniendo datos de usuarios...\n');

    const usersRes = await fetch(`${API_BASE}/api/highlevel/users/by-ids`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userIds })
    });

    const usersData = await usersRes.json();

    if (!usersData.success) {
      console.error('❌ Error al obtener usuarios:', usersData.error);
      return;
    }

    const users = usersData.users || [];
    console.log(`✅ ${users.length} usuarios obtenidos:\n`);

    users.forEach(user => {
      console.log(`👤 ${user.name || user.email || user.id}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Email: ${user.email || 'N/A'}`);
      console.log(`   Nombre: ${user.firstName || ''} ${user.lastName || ''}`.trim() || 'N/A');
      console.log();
    });

    console.log('✅ Prueba exitosa! El flujo de Round Robin funciona correctamente.');

  } catch (error) {
    console.error('❌ Error en la prueba:', error.message);
    console.error(error.stack);
  }
}

// Ejecutar prueba
testRoundRobinFlow();
