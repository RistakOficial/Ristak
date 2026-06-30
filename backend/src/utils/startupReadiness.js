export function isRuntimeReadyForTraffic({
  ready = false,
  error = null,
  shuttingDown = false
} = {}) {
  return ready === true && !error && shuttingDown !== true
}

export function runtimeHealthStatusCode(state = {}) {
  return isRuntimeReadyForTraffic(state) ? 200 : 503
}
