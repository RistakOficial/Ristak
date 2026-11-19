// One mounted panel owns its request, disk read and retry timer. Explicitly
// separate temporary transport failures from rejected requests or invalid data.
export function isTemporaryAnalyticsFailure(error: unknown) {
  const failure = error as { status?: number; code?: string; message?: string } | null;
  if (failure?.status) {
    return [408, 425, 429].includes(failure.status) || failure.status >= 500;
  }
  return failure?.code === 'request_timeout' || failure?.code === 'invalid_response'
    || /network|failed to fetch|offline/i.test(failure?.message || '');
}

export function startAnalyticsRead<T>({
  online, readSaved, load, showSaved, showLive, showError, setFetching,
}: {
  online: boolean;
  readSaved: () => Promise<T | undefined>;
  load: (signal: AbortSignal) => Promise<T>;
  showSaved: (value: T) => void;
  showLive: (value: T) => void;
  showError: (error: unknown) => void;
  setFetching: (fetching: boolean) => void;
}) {
  const controller = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 2_000;
  let allowSaved = !online;
  let settled = false;
  let saved: T | undefined;

  const revealSaved = () => {
    allowSaved = true;
    if (!controller.signal.aborted && !settled && saved !== undefined) showSaved(saved);
  };
  if (online) fallbackTimer = setTimeout(revealSaved, 350);
  void readSaved().then((value) => {
    saved = value;
    if (allowSaved) revealSaved();
  });
  const run = async () => {
    setFetching(true);
    try {
      const value = await load(controller.signal);
      if (controller.signal.aborted) return;
      settled = true;
      clearTimeout(fallbackTimer);
      showLive(value);
    } catch (error) {
      if (controller.signal.aborted) return;
      clearTimeout(fallbackTimer);
      if (isTemporaryAnalyticsFailure(error)) {
        revealSaved();
        retryTimer = setTimeout(run, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      } else {
        settled = true;
        showError(error);
      }
    } finally {
      if (!controller.signal.aborted) setFetching(false);
    }
  };
  if (online) void run();
  return () => {
    controller.abort();
    clearTimeout(fallbackTimer);
    clearTimeout(retryTimer);
  };
}
