import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { resolveCacheNamespace } from './cache';
import { startAnalyticsRead } from './analyticsRead';
import type { AnalyticsReportQuery } from './cacheKeys';
import { analyticsSnapshot, type SavedAnalytics } from './analyticsSnapshots';

export function useAnalyticsOnline() {
  const [active, setActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [online, setOnline] = useState(true);
  useEffect(() => {
    let mounted = true;
    let observedNetwork = false;
    const updateNetwork = (state: Network.NetworkState) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    };
    const network = Network.addNetworkStateListener((state) => {
      observedNetwork = true;
      updateNetwork(state);
    });
    void Network.getNetworkStateAsync().then((state) => {
      if (mounted && !observedNetwork) updateNetwork(state);
    }).catch(() => undefined);
    const app = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => {
      mounted = false;
      network.remove();
      app.remove();
    };
  }, []);
  return online && active;
}

type PanelState<T> = { key: string; value?: T; previousEndDate?: string; live: boolean; fetching: boolean; error: string; revision: number };

export function useAnalyticsRead<T>(
  request: string | AnalyticsReportQuery,
  load: (signal: AbortSignal) => Promise<T>,
  online: boolean,
  revision: number,
) {
  const namespace = resolveCacheNamespace();
  const key = typeof request === 'string' ? request : request.exactKey;
  const periodKey = typeof request === 'string' ? '' : request.periodKey;
  const startDate = typeof request === 'string' ? '' : request.startDate;
  const endDate = typeof request === 'string' ? '' : request.endDate;
  const identity = namespace + '/' + key + '/' + periodKey;
  const [state, setState] = useState<PanelState<T>>({ key: '', live: false, fetching: false, error: '', revision: -1 });
  useEffect(() => {
    if (!key) return;
    setState((current) => ({
      key: identity, value: current.key === identity ? current.value : undefined,
      previousEndDate: current.key === identity ? current.previousEndDate : undefined, live: false, fetching: online, error: '', revision,
    }));
    const snapshot = analyticsSnapshot({ exactKey: key, periodKey, startDate, endDate }, namespace);
    return startAnalyticsRead<T, SavedAnalytics<T>>({
      online,
      load,
      readSaved: () => snapshot.read<T>(),
      showSaved: ({ value, previousEndDate }) => {
        if (snapshot.current()) setState((current) => ({ ...current, value, previousEndDate }));
      },
      showLive: (value) => {
        if (!snapshot.current()) return;
        void snapshot.save(value);
        setState((current) => ({ ...current, value, previousEndDate: undefined, live: true, error: '' }));
      },
      showError: (error) => {
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403) snapshot.revoke();
        setState((current) => ({
          ...current, value: undefined, previousEndDate: undefined, live: false, error: error instanceof Error ? error.message : 'No se pudieron cargar estos datos.',
        }));
      },
      setFetching: (fetching) => setState((current) => ({ ...current, fetching })),
    });
  }, [endDate, identity, key, load, namespace, online, periodKey, revision, startDate]);
  return state.key === identity
    ? { ...state, live: state.live && online && state.revision === revision }
    : { value: undefined, previousEndDate: undefined, live: false, fetching: false, error: '', revision: -1 };
}
