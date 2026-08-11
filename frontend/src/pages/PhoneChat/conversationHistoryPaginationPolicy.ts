type TouchPoint = {
  x: number
  y: number
}

const MINIMUM_VERTICAL_DRAG_PX = 6

/**
 * Separa el gesto humano de los eventos `scroll` creados por relayouts,
 * restauraciones de ancla o descargas tardías. El permiso es de un solo uso:
 * una página histórica requiere un gesto vertical nuevo.
 */
export class ConversationHistoryPaginationGate {
  private pendingUserGesture = false
  private touchStart: TouchPoint | null = null

  reset() {
    this.pendingUserGesture = false
    this.touchStart = null
  }

  touchDidStart(clientX?: number, clientY?: number) {
    this.pendingUserGesture = false
    this.touchStart = this.validPoint(clientX, clientY)
  }

  touchDidMove(clientX?: number, clientY?: number) {
    const current = this.validPoint(clientX, clientY)
    if (!this.touchStart || !current) return false

    const verticalDistance = current.y - this.touchStart.y
    const horizontalDistance = Math.abs(current.x - this.touchStart.x)
    if (verticalDistance < MINIMUM_VERTICAL_DRAG_PX || verticalDistance <= horizontalDistance) {
      return false
    }

    this.pendingUserGesture = true
    this.touchStart = null
    return true
  }

  touchDidEnd() {
    this.touchStart = null
  }

  wheelDidMove(deltaY: number) {
    if (!Number.isFinite(deltaY) || deltaY > -1) return false
    this.pendingUserGesture = true
    return true
  }

  consumeIfAtBoundary(isAtBoundary: boolean) {
    if (!isAtBoundary || !this.pendingUserGesture) return false
    this.pendingUserGesture = false
    return true
  }

  get hasPendingIntent() {
    return this.pendingUserGesture
  }

  private validPoint(clientX?: number, clientY?: number): TouchPoint | null {
    if (typeof clientX !== 'number' || !Number.isFinite(clientX)
      || typeof clientY !== 'number' || !Number.isFinite(clientY)) return null
    return { x: clientX, y: clientY }
  }
}
