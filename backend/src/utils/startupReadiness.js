export function isDatabaseStorageOutageOffer(offer = {}) {
  return offer?.storage_full === true ||
    String(offer?.postgres_status || '').toLowerCase() === 'suspended' ||
    Number(offer?.usage_percent || 0) >= 99
}

export function isRuntimeReadyForTraffic({
  ready = false,
  error = null,
  recoveryMode = null,
  shuttingDown = false
} = {}) {
  const servingDatabaseStorageRecovery = recoveryMode === 'database_storage'
  return (ready === true || servingDatabaseStorageRecovery) &&
    (!error || servingDatabaseStorageRecovery) &&
    shuttingDown !== true
}

export function runtimeHealthStatusCode(state = {}) {
  return isRuntimeReadyForTraffic(state) ? 200 : 503
}
