let shutdownStarted = false
let nextWorkId = 1
const activeWork = new Map()

function cleanLabel(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function markDeployShutdownStarted() {
  shutdownStarted = true
}

export function isDeployShutdownStarted() {
  return shutdownStarted
}

export function beginDeployDrainWork(kind, label = '') {
  const id = nextWorkId
  nextWorkId += 1
  activeWork.set(id, {
    kind: cleanLabel(kind) || 'work',
    label: cleanLabel(label),
    startedAt: Date.now()
  })

  let finished = false
  return () => {
    if (finished) return
    finished = true
    activeWork.delete(id)
  }
}

export async function trackDeployDrainWork(kind, fn, label = '') {
  const finish = beginDeployDrainWork(kind, label)
  try {
    return await fn()
  } finally {
    finish()
  }
}

export function getDeployDrainSnapshot(now = Date.now()) {
  const byKind = {}
  let oldestStartedAt = null

  for (const item of activeWork.values()) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1
    if (!oldestStartedAt || item.startedAt < oldestStartedAt) {
      oldestStartedAt = item.startedAt
    }
  }

  return {
    total: activeWork.size,
    byKind,
    oldestAgeMs: oldestStartedAt ? Math.max(0, now - oldestStartedAt) : 0
  }
}

export function formatDeployDrainSnapshot(snapshot = getDeployDrainSnapshot()) {
  const parts = Object.entries(snapshot.byKind || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}:${count}`)

  return parts.length ? parts.join(', ') : 'sin trabajo critico activo'
}
