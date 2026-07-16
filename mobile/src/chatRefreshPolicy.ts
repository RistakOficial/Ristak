export const CHAT_FALLBACK_REFRESH_INTERVAL_MS = 30_000;
export const CHAT_HEALTHY_RECONCILE_INTERVAL_MS = 2 * 60_000;
export const CHAT_TRAILING_REFRESH_DELAY_MS = 500;

export type ChatLiveRefreshConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export function shouldRunChatReconciliation(
  liveConnected: boolean,
  lastReconciledAt: number,
  now = Date.now(),
): boolean {
  if (!liveConnected) return true;
  return now - Math.max(0, lastReconciledAt) >= CHAT_HEALTHY_RECONCILE_INTERVAL_MS;
}

/**
 * Waits for the initial request that was already in flight when SSE first
 * connected. A successful bootstrap needs no extra GET; a failed bootstrap gets
 * exactly one immediate recovery instead of waiting for the fallback interval.
 */
export async function runInitialConnectedRecovery(
  initialRequest: Promise<unknown> | null,
  hasSuccessfulReconciliation: () => boolean,
  refresh: () => Promise<unknown>,
): Promise<boolean> {
  if (initialRequest) await initialRequest.catch(() => undefined);
  if (hasSuccessfulReconciliation()) return false;
  await refresh();
  return true;
}

/**
 * The chat SSE endpoint does not replay frames after a reconnect. Keep enough
 * local state to request exactly one canonical snapshot after a real connection
 * gap, without duplicating the initial bootstrap load when the first stream
 * connection succeeds.
 */
export class ChatReconnectReconciliationGate {
  private hasConnected = false;
  private disconnectedAfterConnection = false;

  observe(status: ChatLiveRefreshConnectionStatus): boolean {
    if (status === 'disconnected') {
      if (this.hasConnected) this.disconnectedAfterConnection = true;
      return false;
    }

    if (status !== 'connected') return false;

    const shouldReconcile = this.hasConnected && this.disconnectedAfterConnection;
    this.hasConnected = true;
    this.disconnectedAfterConnection = false;
    return shouldReconcile;
  }

  reset(): void {
    this.hasConnected = false;
    this.disconnectedAfterConnection = false;
  }
}

export class ChatRefreshBurstGate {
  private phase: 'idle' | 'primary' | 'followUp' = 'idle';
  private pendingFollowUp = false;
  private pendingTrailing = false;

  get isInFlight(): boolean {
    return this.phase !== 'idle';
  }

  beginOrQueue(): boolean {
    if (this.phase === 'primary') {
      this.pendingFollowUp = true;
      return false;
    }
    if (this.phase === 'followUp') {
      // A message committed after the follow-up started may not exist in that
      // response. Preserve one dirty bit so the caller can reconcile it after a
      // short cooldown instead of either losing it or starting an unbounded GET.
      this.pendingTrailing = true;
      return false;
    }
    this.phase = 'primary';
    this.pendingFollowUp = false;
    this.pendingTrailing = false;
    return true;
  }

  consumeFollowUp(): boolean {
    if (this.phase !== 'primary' || !this.pendingFollowUp) return false;
    this.pendingFollowUp = false;
    this.phase = 'followUp';
    return true;
  }

  finish(): boolean {
    const trailingNeeded = this.pendingTrailing;
    this.phase = 'idle';
    this.pendingFollowUp = false;
    this.pendingTrailing = false;
    return trailingNeeded;
  }
}

export type ChatRefreshBurstResult = {
  ran: boolean;
  trailingNeeded: boolean;
};

export async function runChatRefreshBurst(
  gate: ChatRefreshBurstGate,
  currentRequest: Promise<unknown> | null,
  refresh: () => Promise<unknown>,
): Promise<ChatRefreshBurstResult> {
  if (!gate.beginOrQueue()) return { ran: false, trailingNeeded: false };

  let trailingNeeded = false;
  try {
    if (currentRequest) {
      // The nudge arrived after this request had already started. Wait for it,
      // then force a fresh snapshot; callers must not merely return whichever
      // request later replaced this one because that replacement may also have
      // started before the latest nudge.
      gate.beginOrQueue();
      await currentRequest.catch(() => undefined);
    } else {
      await refresh();
    }

    if (gate.consumeFollowUp()) {
      await refresh();
    }
  } finally {
    trailingNeeded = gate.finish();
  }
  return { ran: true, trailingNeeded };
}
