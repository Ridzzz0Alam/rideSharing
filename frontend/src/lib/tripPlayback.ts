"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryKeys } from "./api";
import { distanceKm } from "./format";
import { useApi } from "./providers";
import type { LatLng, Ride } from "./types";

const FRAME_MS = 100; // marker refresh rate while driving
const SYNC_MS = 1_000; // how often a moving car's position is sent to the location service
const MS_PER_KM = 8_000; // demo speed: slow enough to follow the car
const MIN_LEG_MS = 6_000;
const MAX_LEG_MS = 45_000;
const ARRIVED_KM = 0.015; // closer than this counts as being at the stop
const PRESENCE_MS = 1_000;
const PRESENCE_TIMEOUT_MS = 2_500;

export type Stop = "pickup" | "drop";

// ───────────────────────── Cross-tab channel ─────────────────────────

/**
 * Tabs of this app in the same browser talk over a BroadcastChannel so the Ride and Drive
 * screens move in step without waiting for polling. Other devices still converge through
 * the location service and SignalR.
 */
type TripMessage =
  | { type: "driver-online"; driverId: string }
  | { type: "position"; driverId: string; position: LatLng }
  | { type: "ride"; ride: Ride };

let channel: BroadcastChannel | null | undefined;

function tripChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("rideshare.trip");
  }
  return channel;
}

const publish = (message: TripMessage) => tripChannel()?.postMessage(message);

function applyRide(queryClient: QueryClient, ride: Ride) {
  queryClient.setQueryData(queryKeys.ride(ride.id), ride);
  void queryClient.invalidateQueries({ queryKey: ["rides"] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.drivers });
}

/** Stores an updated ride and tells the other open tabs about it. */
export function usePublishRide() {
  const queryClient = useQueryClient();
  return useCallback(
    (ride: Ride) => {
      applyRide(queryClient, ride);
      publish({ type: "ride", ride });
    },
    [queryClient],
  );
}

// ───────────────────────── Playback ─────────────────────────

function legOf(ride: Ride | undefined): Stop | null {
  if (!ride?.driverId) return null;
  if (ride.status === "ACCEPTED" || ride.status === "DRIVER_ARRIVING") return "pickup";
  if (ride.status === "RIDE_STARTED") return "drop";
  return null;
}

const stopPosition = (ride: Ride, stop: Stop): LatLng =>
  stop === "pickup" ? { lat: ride.pickupLatitude, lng: ride.pickupLongitude } : { lat: ride.dropLatitude, lng: ride.dropLongitude };

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface TripPlaybackOptions {
  /**
   * "driver" is the Drive screen: while online it owns the car. "rider" is the Ride screen:
   * it follows an open Drive screen, and drives the car itself only when there is none.
   */
  role: "rider" | "driver";
  driverId: string | null;
  ride: Ride | undefined;
  /** Rider: the location service's last known position. Driver: the screen's own position. */
  basePosition: LatLng | undefined;
  /** Driver only: the screen is online. */
  online?: boolean;
  /** Driver only: drive towards the stops instead of waiting for map clicks. */
  autoDrive?: boolean;
  /** Driver only: called for every animation frame. */
  onMove?: (position: LatLng) => void;
}

/**
 * Plays out an assigned ride: the car drives to the pickup and waits for the rider to start the
 * trip, then drives to the drop-off and waits for the rider to confirm. Exactly one screen moves
 * the car; the others show the same position and the same waiting state.
 */
export function useTripPlayback({ role, driverId, ride, basePosition, online = false, autoDrive = true, onMove }: TripPlaybackOptions) {
  const api = useApi();
  const queryClient = useQueryClient();
  const publishRide = usePublishRide();

  const [live, setLive] = useState<{ driverId: string; position: LatLng } | null>(null);
  const [driverScreenFor, setDriverScreenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leg = legOf(ride);
  const rideId = ride?.id ?? null;
  const driverScreenOpen = role === "rider" && driverId !== null && driverScreenFor === driverId;
  const leads = role === "driver" ? online && autoDrive : !driverScreenOpen;

  const livePosition = live && live.driverId === driverId ? live.position : null;
  const position = role === "driver" ? (basePosition ?? null) : ((leg ? livePosition : null) ?? basePosition ?? null);

  // Listen to the other tabs.
  useEffect(() => {
    const ch = tripChannel();
    if (!ch) return;
    let expiry: ReturnType<typeof setTimeout> | undefined;

    const onMessage = (event: MessageEvent<TripMessage>) => {
      const message = event.data;
      if (message.type === "ride") {
        applyRide(queryClient, message.ride);
        return;
      }
      if (role !== "rider" || !driverId || message.driverId !== driverId) return;
      if (message.type === "position") setLive({ driverId, position: message.position });
      setDriverScreenFor(driverId);
      clearTimeout(expiry);
      expiry = setTimeout(() => setDriverScreenFor(null), PRESENCE_TIMEOUT_MS);
    };

    ch.addEventListener("message", onMessage);
    return () => {
      ch.removeEventListener("message", onMessage);
      clearTimeout(expiry);
    };
  }, [role, driverId, queryClient]);

  // An online Drive screen announces itself and every move of its car.
  useEffect(() => {
    if (role !== "driver" || !online || !driverId) return;
    const beat = () => publish({ type: "driver-online", driverId });
    beat();
    const timer = setInterval(beat, PRESENCE_MS);
    return () => clearInterval(timer);
  }, [role, online, driverId]);

  const broadcastLat = role === "driver" && online ? basePosition?.lat : undefined;
  const broadcastLng = role === "driver" && online ? basePosition?.lng : undefined;
  useEffect(() => {
    if (!driverId || broadcastLat === undefined || broadcastLng === undefined) return;
    publish({ type: "position", driverId, position: { lat: broadcastLat, lng: broadcastLng } });
  }, [driverId, broadcastLat, broadcastLng]);

  // The drive loop reads the latest values through refs so refetches don't restart the animation.
  const rideRef = useRef(ride);
  const positionRef = useRef(position);
  const onMoveRef = useRef(onMove);
  const sentArriving = useRef(new Set<string>());
  useEffect(() => {
    rideRef.current = ride;
    positionRef.current = position;
    onMoveRef.current = onMove;
  });

  const hasPosition = position !== null;

  useEffect(() => {
    const current = rideRef.current;
    const from = positionRef.current;
    if (!leads || !current || !leg || !driverId || !from) return;

    // Sent once per ride, even if the effect re-runs (Strict Mode, a tab taking over).
    if (leg === "pickup" && current.status === "ACCEPTED" && !sentArriving.current.has(current.id)) {
      sentArriving.current.add(current.id);
      api.markArriving(current.id).then(publishRide, () => {
        // Another screen may already have moved the ride on; pick up its real state instead.
        void queryClient.invalidateQueries({ queryKey: queryKeys.ride(current.id) });
      });
    }

    const target = stopPosition(current, leg);
    const distance = distanceKm(from, target);
    if (distance < ARRIVED_KM) return;

    const duration = Math.min(MAX_LEG_MS, Math.max(MIN_LEG_MS, distance * MS_PER_KM));
    const startedAt = Date.now();
    let lastSync = 0;

    const timer = setInterval(() => {
      const now = Date.now();
      const t = Math.min(1, (now - startedAt) / duration);
      const k = easeInOut(t);
      const next = { lat: from.lat + (target.lat - from.lat) * k, lng: from.lng + (target.lng - from.lng) * k };

      positionRef.current = next;
      if (role === "driver") onMoveRef.current?.(next);
      else setLive({ driverId, position: next });

      if (t === 1 || now - lastSync >= SYNC_MS) {
        lastSync = now;
        api.updateDriverLocation(driverId, next).then(
          () => setError(null),
          (e: Error) => setError(e.message),
        );
      }
      if (t === 1) clearInterval(timer);
    }, FRAME_MS);

    return () => clearInterval(timer);
  }, [leads, rideId, driverId, leg, hasPosition, role, api, publishRide, queryClient]);

  const waitingAt = ride && leg && position && distanceKm(position, stopPosition(ride, leg)) < ARRIVED_KM ? leg : null;

  const confirm = useMutation({
    mutationFn: ({ id, stop }: { id: string; stop: Stop }) => (stop === "pickup" ? api.startRide(id) : api.completeRide(id)),
    onSuccess: publishRide,
  });

  return {
    /** Where the car is right now, as every screen should draw it. */
    position,
    /** The stop the car is at and waiting for the rider's go-ahead. */
    waitingAt,
    /** Rider only: an online Drive screen for this driver is open in another tab. */
    driverScreenOpen,
    error,
    /** Starts the trip at the pickup, or completes it at the drop-off. */
    confirm: () => rideId && waitingAt && confirm.mutate({ id: rideId, stop: waitingAt }),
    confirming: confirm.isPending,
    confirmError: confirm.error,
  };
}
