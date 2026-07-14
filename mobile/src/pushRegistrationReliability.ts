export type NativePushRegistrationOutcome =
  | 'subscribed'
  | 'not_supported'
  | 'not_configured'
  | 'denied'
  | 'failed';

export const NATIVE_PUSH_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;

export function shouldRetryNativePushRegistration(status: NativePushRegistrationOutcome): boolean {
  return status === 'failed' || status === 'not_configured';
}

export function getNativePushRegistrationRetryDelay(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return NATIVE_PUSH_RETRY_DELAYS_MS[
    Math.min(safeAttempt, NATIVE_PUSH_RETRY_DELAYS_MS.length - 1)
  ];
}
