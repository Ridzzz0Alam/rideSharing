"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { RideMap, type MapCar } from "@/components/map/RideMap";
import { MapLayout } from "@/components/Nav";
import { Button, cx, Field, LiveBadge, Notice, Panel, SectionTitle, StatusPill } from "@/components/ui";
import { queryKeys } from "@/lib/api";
import { distanceKm, formatCoords, formatDateTime, formatFare, formatKm, SAMPLE } from "@/lib/format";
import { useApi, useLiveState, useLiveSubscription, useStoredValue } from "@/lib/providers";
import { usePublishRide, useTripPlayback } from "@/lib/tripPlayback";
import { isTerminal, type LatLng } from "@/lib/types";

const PING_INTERVAL_MS = 3_000; // same cadence as the original "driver phone" comment

export function DriverConsole() {
  const api = useApi();
  const queryClient = useQueryClient();
  const live = useLiveState() === "live";

  const [driverId, setDriverId] = useStoredValue("rideshare.driverId", "driver:1");
  // Null until the driver picks a spot or starts moving: until then the car stays where the
  // location service last saw it, so opening this screen never teleports a car mid-trip.
  const [chosenPosition, setPosition] = useState<LatLng | null>(null);
  const [online, setOnline] = useState(false);
  const [autoDrive, setAutoDrive] = useState(true);
  const [pingError, setPingError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<Date | null>(null);

  useLiveSubscription("SubscribeToDriver", online ? driverId : null);

  const drivers = useQuery({ queryKey: queryKeys.drivers, queryFn: api.getDrivers, refetchInterval: 3_000 });

  const rides = useQuery({
    queryKey: queryKeys.driverRides(driverId),
    queryFn: () => api.getDriverRides(driverId),
    enabled: driverId.trim().length > 0,
    refetchInterval: live ? false : 4_000,
  });

  const currentRide = rides.data?.find((ride) => !isTerminal(ride.status));
  const completed = rides.data?.filter((ride) => ride.status === "COMPLETED") ?? [];
  const earnings = completed.reduce((sum, ride) => sum + (ride.actualFare ?? 0), 0);

  const reported = drivers.data?.find((d) => d.driverId === driverId);
  const position: LatLng =
    chosenPosition ?? (reported ? { lat: reported.latitude, lng: reported.longitude } : SAMPLE.drivers[0].position);

  // The ping loop reads the latest position through a ref so the interval is not recreated every tick.
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  });

  // Driving itself (towards the pickup and drop-off) is done by the shared trip playback below;
  // this loop is the phone's regular heartbeat.
  useEffect(() => {
    if (!online) return;
    let cancelled = false;

    const tick = async () => {
      try {
        await api.updateDriverLocation(driverId, positionRef.current);
        if (cancelled) return;
        setLastPing(new Date());
        setPingError(null);
      } catch (error) {
        if (!cancelled) setPingError((error as Error).message);
      }
    };

    void tick();
    const timer = setInterval(tick, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [online, driverId, api]);

  const goOffline = useMutation({
    mutationFn: () => api.removeDriver(driverId),
    onSettled: () => {
      setOnline(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.drivers });
    },
  });

  const publishRide = usePublishRide();

  const rideAction = useMutation({
    mutationFn: ({ action, rideId }: { action: "arriving" | "start" | "complete" | "cancel"; rideId: string }) => {
      switch (action) {
        case "arriving":
          return api.markArriving(rideId);
        case "start":
          return api.startRide(rideId);
        case "complete":
          return api.completeRide(rideId);
        case "cancel":
          return api.cancelRide(rideId, "Cancelled by driver");
      }
    },
    onSuccess: publishRide,
  });

  const trip = useTripPlayback({
    role: "driver",
    driverId,
    ride: currentRide,
    basePosition: position,
    online,
    autoDrive,
    onMove: (next) => {
      positionRef.current = next;
      setPosition(next);
    },
  });

  const moveTo = (next: LatLng) => {
    setPosition(next);
    positionRef.current = next;
    if (online) {
      api.updateDriverLocation(driverId, next).then(
        () => setPingError(null),
        (error: Error) => setPingError(error.message),
      );
    }
  };

  const others: MapCar[] = (drivers.data ?? [])
    .filter((d) => d.driverId !== driverId)
    .map((d) => ({ driverId: d.driverId, position: { lat: d.latitude, lng: d.longitude }, variant: d.busy ? "busy" : "idle" }));
  const cars: MapCar[] = [...others, { driverId, position, variant: "mine" }];

  const pickup = currentRide ? { lat: currentRide.pickupLatitude, lng: currentRide.pickupLongitude } : null;
  const drop = currentRide ? { lat: currentRide.dropLatitude, lng: currentRide.dropLongitude } : null;
  const focus = currentRide ? [pickup!, drop!] : [];

  const target = currentRide?.status === "RIDE_STARTED" ? drop : pickup;
  const toTarget = target ? distanceKm(position, target) : null;
  const pending = rideAction.isPending ? rideAction.variables?.action : null;

  const panel = (
    <Panel title="Drive" aside={<LiveBadge />}>
      <div className="flex items-end gap-2">
        <Field
          className="flex-1"
          label="Driver"
          value={driverId}
          disabled={online}
          onChange={(e) => setDriverId(e.target.value)}
          placeholder="driver:1"
        />
        {online ? (
          <Button variant="secondary" busy={goOffline.isPending} onClick={() => goOffline.mutate()}>
            Go offline
          </Button>
        ) : (
          <Button disabled={!driverId.trim()} onClick={() => setOnline(true)}>
            Go online
          </Button>
        )}
      </div>

      <div className={cx("rounded-xl px-4 py-3", online ? "bg-pickup/10" : "bg-kerb")}>
        <p className="font-semibold">{online ? (currentRide ? "On a job" : "Waiting for requests") : "Offline"}</p>
        <p className="text-sm text-muted">
          {online
            ? `Sending location every ${PING_INTERVAL_MS / 1000} s${lastPing ? `, last at ${lastPing.toLocaleTimeString()}` : ""}`
            : "Tap the map to choose where you start, then go online."}
        </p>
        <p className="mt-1 text-xs text-muted">{formatCoords(position)}</p>
      </div>
      {pingError && <Notice>{pingError}</Notice>}

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-[var(--route)]"
          checked={autoDrive}
          onChange={(e) => setAutoDrive(e.target.checked)}
        />
        Drive automatically towards the pickup and drop-off
      </label>

      <div className="space-y-3">
        <SectionTitle>Current trip</SectionTitle>
        {!currentRide ? (
          <p className="text-sm text-muted">
            {online
              ? "Request a ride on the Ride screen with a pickup within 5 km of you. It will appear here."
              : "Go online to receive trips."}
          </p>
        ) : (
          <div className="space-y-4 rounded-xl border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-muted">{currentRide.riderId}</p>
                <p className="truncate font-semibold">{currentRide.pickupAddress}</p>
                <p className="truncate text-sm text-muted">to {currentRide.dropAddress}</p>
              </div>
              <StatusPill status={currentRide.status} />
            </div>
            <div className="flex justify-between text-sm">
              <span>{formatFare(currentRide.estimatedFare)}</span>
              {toTarget !== null && (
                <span className="text-muted">
                  {toTarget < 0.05 ? "You are there" : `${formatKm(toTarget)} to ${currentRide.status === "RIDE_STARTED" ? "drop-off" : "pickup"}`}
                </span>
              )}
            </div>
            {trip.waitingAt && (
              <Notice tone="info">
                {trip.waitingAt === "pickup"
                  ? `Waiting for ${currentRide.riderId} to start the ride.`
                  : `Waiting for ${currentRide.riderId} to confirm the drop-off.`}
              </Notice>
            )}
            <div className="grid grid-cols-2 gap-2">
              {currentRide.status === "ACCEPTED" && (
                <Button
                  variant="secondary"
                  busy={pending === "arriving"}
                  onClick={() => rideAction.mutate({ action: "arriving", rideId: currentRide.id })}
                >
                  Arriving now
                </Button>
              )}
              {(currentRide.status === "ACCEPTED" || currentRide.status === "DRIVER_ARRIVING") && (
                <Button busy={pending === "start"} onClick={() => rideAction.mutate({ action: "start", rideId: currentRide.id })}>
                  Start trip
                </Button>
              )}
              {currentRide.status === "RIDE_STARTED" && (
                <Button
                  className="col-span-2"
                  busy={pending === "complete"}
                  onClick={() => rideAction.mutate({ action: "complete", rideId: currentRide.id })}
                >
                  Complete trip
                </Button>
              )}
              {currentRide.status !== "RIDE_STARTED" && (
                <Button
                  variant="danger"
                  className="col-span-2"
                  busy={pending === "cancel"}
                  onClick={() => rideAction.mutate({ action: "cancel", rideId: currentRide.id })}
                >
                  Cancel trip
                </Button>
              )}
            </div>
          </div>
        )}
        {rideAction.error && <Notice>{rideAction.error.message}</Notice>}
        {trip.error && <Notice>{trip.error}</Notice>}
      </div>

      <div className="space-y-2 border-t border-line pt-5">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Trip history</SectionTitle>
          <p className="text-sm">
            <span className="text-muted">Earned </span>
            <span className="font-semibold">{formatFare(earnings)}</span>
          </p>
        </div>
        {rides.error && <Notice>{rides.error.message}</Notice>}
        {rides.data?.filter((r) => isTerminal(r.status)).length === 0 && (
          <p className="text-sm text-muted">Finished trips will show up here.</p>
        )}
        <ul className="divide-y divide-line">
          {rides.data
            ?.filter((r) => isTerminal(r.status))
            .slice(0, 8)
            .map((ride) => (
              <li key={ride.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{ride.dropAddress}</span>
                  <span className="block text-xs text-muted">{formatDateTime(ride.createdAt)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill status={ride.status} />
                  <span className="text-xs text-muted">{formatFare(ride.actualFare ?? 0)}</span>
                </span>
              </li>
            ))}
        </ul>
      </div>
    </Panel>
  );

  return (
    <MapLayout
      panel={panel}
      map={
        <RideMap
          center={SAMPLE.center}
          pickup={pickup}
          drop={drop}
          cars={cars}
          focus={focus}
          onMapClick={currentRide && autoDrive ? undefined : moveTo}
          cursor={currentRide && autoDrive ? undefined : "crosshair"}
        />
      }
    />
  );
}
