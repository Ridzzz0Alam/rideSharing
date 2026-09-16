"use client";

import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApi, queryKeys, type Api } from "./api";
import type { Ride } from "./types";

// ───────────────────────── Config / API ─────────────────────────

const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside <Providers>");
  return api;
}

// ───────────────────────── Live updates ─────────────────────────

export type HubMethod = "SubscribeToRide" | "SubscribeToRider" | "SubscribeToDriver";
export type LiveState = "connecting" | "live" | "reconnecting" | "offline";

interface HubContextValue {
  state: LiveState;
  subscribe: (method: HubMethod, arg: string) => () => void;
}

const HubContext = createContext<HubContextValue | null>(null);

export function useLiveState(): LiveState {
  return useContext(HubContext)?.state ?? "offline";
}

/** Joins a SignalR group for as long as the calling component is mounted. */
export function useLiveSubscription(method: HubMethod, arg: string | null | undefined) {
  const hub = useContext(HubContext);
  useEffect(() => {
    if (!hub || !arg) return;
    return hub.subscribe(method, arg);
  }, [hub, method, arg]);
}

function RideHubProvider({ gatewayUrl, children }: { gatewayUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");
  const connectionRef = useRef<HubConnection | null>(null);
  // Desired subscriptions, keyed "Method|arg" with a reference count.
  const subscriptions = useRef(new Map<string, number>());

  const invoke = useCallback((key: string, prefix: "Subscribe" | "Unsubscribe") => {
    const connection = connectionRef.current;
    if (connection?.state !== HubConnectionState.Connected) return;
    const [method, arg] = key.split("|", 2);
    const target = prefix === "Subscribe" ? method : method.replace("Subscribe", "Unsubscribe");
    connection.invoke(target, arg).catch(() => {
      // Resubscribed on the next reconnect.
    });
  }, []);

  useEffect(() => {
    const connection = new HubConnectionBuilder()
      .withUrl(`${gatewayUrl}/hubs/rides`)
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 15000])
      .configureLogging(LogLevel.Warning)
      .build();
    connectionRef.current = connection;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let starting: Promise<void> = Promise.resolve();

    const resubscribeAll = () => {
      for (const key of subscriptions.current.keys()) invoke(key, "Subscribe");
    };

    connection.on("RideUpdated", (ride: Ride) => {
      queryClient.setQueryData(queryKeys.ride(ride.id), ride);
      void queryClient.invalidateQueries({ queryKey: ["rides"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.drivers });
    });
    // Ignore events from a torn-down connection so they can't clobber its replacement's state.
    connection.onreconnecting(() => {
      if (!cancelled) setState("reconnecting");
    });
    connection.onreconnected(() => {
      if (cancelled) return;
      setState("live");
      resubscribeAll(); // groups are per-connection and lost on reconnect
    });
    connection.onclose(() => {
      if (!cancelled) setState("offline");
    });

    const start = async () => {
      try {
        starting = connection.start();
        await starting;
        if (cancelled) return;
        setState("live");
        resubscribeAll();
      } catch {
        if (cancelled) return;
        setState("offline");
        retryTimer = setTimeout(start, 5000);
      }
    };
    void start();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      connectionRef.current = null;
      // Stopping mid-negotiation makes SignalR log "The connection was stopped during negotiation"
      // (React Strict Mode unmounts every effect once in development), so let start() settle first.
      void starting.catch(() => {}).then(() => connection.stop());
    };
  }, [gatewayUrl, invoke, queryClient]);

  const subscribe = useCallback(
    (method: HubMethod, arg: string) => {
      const key = `${method}|${arg}`;
      const count = subscriptions.current.get(key) ?? 0;
      subscriptions.current.set(key, count + 1);
      if (count === 0) invoke(key, "Subscribe");

      return () => {
        const current = subscriptions.current.get(key) ?? 1;
        if (current <= 1) {
          subscriptions.current.delete(key);
          invoke(key, "Unsubscribe");
        } else {
          subscriptions.current.set(key, current - 1);
        }
      };
    },
    [invoke],
  );

  const value = useMemo(() => ({ state, subscribe }), [state, subscribe]);
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

// ───────────────────────── Root provider ─────────────────────────

export function Providers({ gatewayUrl, children }: { gatewayUrl: string; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  const api = useMemo(() => createApi(gatewayUrl), [gatewayUrl]);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>
        <RideHubProvider gatewayUrl={api.gatewayUrl}>{children}</RideHubProvider>
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

// ───────────────────────── Local identity ─────────────────────────

/** A small persisted value (rider / driver id). Starts with the fallback to keep SSR output stable. */
export function useStoredValue(key: string, fallback: string) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from storage after mount
      if (stored) setValue(stored);
    } catch {
      // Storage unavailable (private mode); keep the fallback.
    }
  }, [key]);

  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Ignore.
      }
    },
    [key],
  );

  return [value, update] as const;
}
