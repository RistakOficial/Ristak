export type MobileFirstSyncStage =
  | 'account'
  | 'settings'
  | 'contacts'
  | 'conversations'
  | 'localCopy'
  | 'complete';

export type MobileFirstSyncProgress = {
  stage: MobileFirstSyncStage;
  detail: string;
  error?: string;
};

export const MOBILE_FIRST_SYNC_STAGES: Array<{
  id: MobileFirstSyncStage;
  title: string;
  fraction: number;
}> = [
  { id: 'account', title: 'Conectando tu cuenta', fraction: 0.10 },
  { id: 'settings', title: 'Cargando configuración', fraction: 0.28 },
  { id: 'contacts', title: 'Preparando contactos', fraction: 0.50 },
  { id: 'conversations', title: 'Preparando conversaciones', fraction: 0.78 },
  { id: 'localCopy', title: 'Guardando copia rápida', fraction: 0.94 },
  { id: 'complete', title: 'Todo listo', fraction: 1 },
];

export function getMobileFirstSyncStage(stage: MobileFirstSyncStage) {
  return MOBILE_FIRST_SYNC_STAGES.find((entry) => entry.id === stage) || MOBILE_FIRST_SYNC_STAGES[0];
}
