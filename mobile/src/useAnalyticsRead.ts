import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import { resolveCacheNamespace } from './cache';
import { startAnalyticsRead } from './analyticsRead';
import { analyticsSnapshot } from './analyticsSnapshots';

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

type PanelState<T> = { key: string; value?: T; live: boolean; fetching: boolean; error: string; revision: number };

export function useAnalyticsRead<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  online: boolean,
  revision: number,
) {
  const namespace = resolveCacheNamespace();
  const identity = namespace + '/' + key;
  const [state, setState] = useState<PanelState<T>>({ key: '', live: false, fetching: false, error: '', revision: -1 });
  useEffect(() => {
    if (!key) return;
    setState((current) => ({
      key: identity, value: current.key === identity ? current.value : undefined, live: false, fetching: online, error: '', revision,
    }));
    const snapshot = analyticsSnapshot(key, namespace);
    return startAnalyticsRead<T>({
      online,
      load,
      readSaved: () => snapshot.read<T>(),
      showSaved: (value) => {
        if (snapshot.current()) setState((current) => ({ ...current, value }));
      },
      showLive: (value) => {
        if (!snapshot.current()) return;
        void snapshot.save(value);
        setState((current) => ({ ...current, value, live: true, error: '' }));
      },
      showError: (error) => {
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403) snapshot.revoke();
        setState((current) => ({
          ...current, value: undefined, live: false, error: error instanceof Error ? error.message : 'No se pudieron cargar estos datos.',
        }));
      },
      setFetching: (fetching) => setState((current) => ({ ...current, fetching })),
    });
  }, [identity, key, load, namespace, online, revision]);
  return state.key === identity
    ? { ...state, live: state.live && online && state.revision === revision }
    : { value: undefined, live: false, fetching: false, error: '', revision: -1 };
}
