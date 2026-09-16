"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { RideMap, type MapCar } from "@/components/map/RideMap";
import { MapLayout } from "@/components/Nav";
import { Button, cx, Field, LiveBadge, Notice, Panel, SectionTitle, StatusLine, StatusPill } from "@/components/ui";
import { queryKeys } from "@/lib/api";
import { distanceKm, formatCoords, formatDateTime, formatFare, formatKm, SAMPLE, shortId } from "@/lib/format";
import { useApi, useLiveState, useLiveSubscription, useStoredValue } from "@/lib/providers";
import { isTerminal, type DriverSnapshot, type LatLng, type Ride } from "@/lib/types";

interface Stop {
  position: LatLng;
  address: string;
}

type StopKind = "pickup" | "drop";

const SEARCH_RADIUS_KM = 5;

export function RiderConsole() {
  const api = useApi();
  const queryClient = useQueryClient();
  const live = useLiveState() === "live";

  const [riderId, setRiderId] = useStoredValue("rideshare.riderId", "rider:1");
  const [pickup, setPickup] = useState<Stop | null>(null);
  const [drop, setDrop] = useState<Stop | null>(null);
  const [placing, setPlacing] = useState<StopKind>("pickup");
  const [viewedRideId, setViewedRideId] = useState<string | null>(null);
  const [dismissedRideId, setDismissedRideId] = useState<string | null>(null);

  useLiveSubscription("SubscribeToRider", riderId);

  const drivers = useQuery({
    queryKey: queryKeys.drivers,
    queryFn: api.getDrivers,
    refetchInterval: 3_000,
  });

  const history = useQuery({
    queryKey: queryKeys.riderRides(riderId),
    queryFn: () => api.getRiderRides(riderId),
    enabled: riderId.trim().length > 0,
    refetchInterval: live ? false : 5_000,
  });

  // Resume an unfinished ride automatically (e.g. after a page reload).
  const openRide = history.data?.find((ride) => !isTerminal(ride.status) && ride.id !== dismissedRideId);
  const currentRideId = viewedRideId ?? openRide?.id ?? null;

  useLiveSubscription("SubscribeToRide", currentRideId);

  const ride = useQuery({
    queryKey: queryKeys.ride(currentRideId ?? "none"),
    queryFn: () => api.getRide(currentRideId!),
    enabled: currentRideId !== null,
    initialData: () => history.data?.find((r) => r.id === currentRideId),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (live || (data && isTerminal(data.status))) return false;
      return 3_000;
    },
  });

  const estimate = useQuery({
    queryKey: pickup && drop ? queryKeys.estimate(pickup.position, drop.position) : ["estimate", "none"],
    queryFn: () => api.estimateFare(pickup!.position, drop!.position),
    enabled: pickup !== null && drop !== null,
  });

  const requestRide = useMutation({
    mutationFn: () =>
      api.requestRide({
        riderId: riderId.trim(),
        pickupLatitude: pickup!.position.lat,
        pickupLongitude: pickup!.position.lng,
        pickupAddress: pickup!.address.trim(),
        dropLatitude: drop!.position.lat,
        dropLongitude: drop!.position.lng,
        dropAddress: drop!.address.trim(),
      }),
    onSuccess: (created) => {
      queryClient.setQueryData(queryKeys.ride(created.id), created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.riderRides(riderId) });
      setViewedRideId(created.id);
    },
  });

  const cancelRide = useMutation({
    mutationFn: (rideId: string) => api.cancelRide(rideId, "Cancelled by rider"),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.ride(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: ["rides"] });
    },
  });

  const nearbyCount = useMemo(() => {
    if (!pickup || !drivers.data) return null;
    return drivers.data.filter((d) => !d.busy && distanceKm(pickup.position, { lat: d.latitude, lng: d.longitude }) <= SEARCH_RADIUS_KM).length;
  }, [pickup, drivers.data]);

  const activeRide = currentRideId ? ride.data : undefined;

  // ── Map ──
  const shownPickup = activeRide ? { lat: activeRide.pickupLatitude, lng: activeRide.pickupLongitude } : pickup?.position;
  const shownDrop = activeRide ? { lat: activeRide.dropLatitude, lng: activeRide.dropLongitude } : drop?.position;
  const cars: MapCar[] = (drivers.data ?? []).map((d) => ({
    driverId: d.driverId,
    position: { lat: d.latitude, lng: d.longitude },
    variant: activeRide?.driverId === d.driverId ? "mine" : d.busy ? "busy" : "idle",
  }));
  const focus = [shownPickup, shownDrop].filter((p): p is LatLng => Boolean(p));

  const placeStop = (position: LatLng) => {
    if (activeRide) return;
    const stop = { position, address: `Pinned at ${formatCoords(position)}` };
    if (placing === "pickup") {
      setPickup(stop);
      if (!drop) setPlacing("drop");
    } else {
      setDrop(stop);
    }
  };

  const applySampleTrip = () => {
    setPickup({ ...SAMPLE.pickup });
    setDrop({ ...SAMPLE.drop });
    setPlacing("drop");
  };

  const backToBooking = () => {
    if (currentRideId) setDismissedRideId(currentRideId);
    setViewedRideId(null);
    requestRide.reset();
    cancelRide.reset();
  };

  const canRequest =
    riderId.trim() !== "" &&
    pickup !== null &&
    drop !== null &&
    pickup.address.trim() !== "" &&
    drop.address.trim() !== "";

  const panel = activeRide ? (
    <Panel title="Your ride" aside={<LiveBadge />}>
      <ActiveRide
        ride={activeRide}
        driver={drivers.data?.find((d) => d.driverId === activeRide.driverId)}
        onCancel={() => cancelRide.mutate(activeRide.id)}
        cancelling={cancelRide.isPending}
        onDone={backToBooking}
      />
      {cancelRide.error && <Notice>{cancelRide.error.message}</Notice>}
    </Panel>
  ) : (
    <Panel title="Where to?" aside={<LiveBadge />}>
      <Field
        label="Rider"
        value={riderId}
        onChange={(e) => setRiderId(e.target.value)}
        placeholder="rider:1"
        hint="Any id works. Your trip history is stored under it."
      />

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Trip</SectionTitle>
          <Button variant="ghost" className="min-h-0 px-0 text-xs" onClick={applySampleTrip}>
            Use the sample Bangalore trip
          </Button>
        </div>
        <StopInput
          kind="pickup"
          stop={pickup}
          placing={placing === "pickup"}
          onPlace={() => setPlacing("pickup")}
          onAddressChange={(address) => pickup && setPickup({ ...pickup, address })}
        />
        <StopInput
          kind="drop"
          stop={drop}
          placing={placing === "drop"}
          onPlace={() => setPlacing("drop")}
          onAddressChange={(address) => drop && setDrop({ ...drop, address })}
        />
      </div>

      {nearbyCount !== null &&
        (nearbyCount === 0 ? (
          <Notice tone="info">
            No available drivers within {SEARCH_RADIUS_KM} km of the pickup. Add some from Drive or Fleet first,
            or the request will be cancelled.
          </Notice>
        ) : (
          <p className="text-sm text-muted">
            {nearbyCount} {nearbyCount === 1 ? "driver" : "drivers"} available near the pickup
          </p>
        ))}

      {pickup && drop && (
        <div className="flex items-end justify-between rounded-xl bg-kerb px-4 py-3">
          <div>
            <p className="text-sm text-muted">Estimated fare</p>
            <p className="text-3xl font-bold tracking-tight">
              {estimate.data ? formatFare(estimate.data.estimatedFare) : estimate.isError ? "—" : "…"}
            </p>
          </div>
          {estimate.data && <p className="pb-1 text-sm text-muted">{formatKm(estimate.data.distanceKm)} direct</p>}
        </div>
      )}
      {estimate.error && <Notice>{estimate.error.message}</Notice>}

      <Button className="w-full" disabled={!canRequest} busy={requestRide.isPending} onClick={() => requestRide.mutate()}>
        Request ride
      </Button>
      {requestRide.error && <Notice>{requestRide.error.message}</Notice>}

      <RideHistory rides={history.data} loading={history.isLoading} error={history.error} onSelect={setViewedRideId} />
    </Panel>
  );

  return (
    <MapLayout
      panel={panel}
      map={
        <RideMap
          center={SAMPLE.center}
          pickup={shownPickup}
          drop={shownDrop}
          cars={cars}
          focus={focus}
          onMapClick={placeStop}
          cursor={activeRide ? undefined : "crosshair"}
        />
      }
    />
  );
}

function StopInput({
  kind,
  stop,
  placing,
  onPlace,
  onAddressChange,
}: {
  kind: StopKind;
  stop: Stop | null;
  placing: boolean;
  onPlace: () => void;
  onAddressChange: (address: string) => void;
}) {
  const isPickup = kind === "pickup";
  const label = isPickup ? "Pickup" : "Drop-off";

  return (
    <div
      className={cx(
        "flex gap-3 rounded-xl border p-3 transition-colors",
        placing ? "border-route bg-route/5" : "border-line",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white",
          isPickup ? "bg-pickup" : "bg-drop",
        )}
      >
        {isPickup ? "A" : "B"}
      </span>
      <div className="min-w-0 flex-1">
        {stop ? (
          <>
            <label className="sr-only" htmlFor={`${kind}-address`}>
              {label} address
            </label>
            <input
              id={`${kind}-address`}
              value={stop.address}
              onChange={(e) => onAddressChange(e.target.value)}
              className="w-full bg-transparent font-medium focus:outline-none"
            />
            <p className="text-xs text-muted">{formatCoords(stop.position)}</p>
          </>
        ) : (
          <p className="font-medium text-muted">{placing ? `Tap the map to set the ${label.toLowerCase()}` : `No ${label.toLowerCase()} yet`}</p>
        )}
      </div>
      {!placing && (
        <button type="button" onClick={onPlace} className="shrink-0 self-center text-sm font-semibold text-route hover:underline">
          {stop ? "Move" : "Set"}
        </button>
      )}
    </div>
  );
}

function ActiveRide({
  ride,
  driver,
  onCancel,
  cancelling,
  onDone,
}: {
  ride: Ride;
  driver?: DriverSnapshot;
  onCancel: () => void;
  cancelling: boolean;
  onDone: () => void;
}) {
  const terminal = isTerminal(ride.status);
  const driverDistance =
    driver && !terminal
      ? distanceKm(
          { lat: driver.latitude, lng: driver.longitude },
          ride.status === "RIDE_STARTED"
            ? { lat: ride.dropLatitude, lng: ride.dropLongitude }
            : { lat: ride.pickupLatitude, lng: ride.pickupLongitude },
        )
      : null;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-semibold">{ride.pickupAddress}</p>
          <p className="truncate text-muted">to {ride.dropAddress}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tracking-tight">{formatFare(ride.actualFare ?? ride.estimatedFare)}</p>
          <p className="text-xs text-muted">{ride.actualFare != null ? "Charged" : "Estimated"}</p>
        </div>
      </div>

      {ride.driverId && (
        <div className="flex items-center gap-3 rounded-xl bg-kerb px-4 py-3">
          <span className="grid size-10 place-items-center rounded-lg bg-route font-bold text-white">
            {ride.driverId.split(":").pop()?.slice(0, 3)}
          </span>
          <div>
            <p className="font-semibold">{ride.driverId}</p>
            <p className="text-sm text-muted">
              {driverDistance === null
                ? terminal
                  ? "Your driver for this trip"
                  : "Location unavailable"
                : `${formatKm(driverDistance)} from ${ride.status === "RIDE_STARTED" ? "drop-off" : "pickup"}`}
            </p>
          </div>
        </div>
      )}

      <StatusLine ride={ride} />

      <p className="text-xs text-muted">Ride {shortId(ride.id)}, requested {formatDateTime(ride.createdAt)}</p>

      {terminal ? (
        <Button className="w-full" onClick={onDone}>
          Book another ride
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="danger" className="flex-1" busy={cancelling} onClick={onCancel}>
            Cancel ride
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Hide
          </Button>
        </div>
      )}
      {!terminal && (
        <p className="text-xs text-muted">
          Start and complete the trip from the Drive screen as {ride.driverId ?? "the assigned driver"}.
        </p>
      )}
    </>
  );
}

function RideHistory({
  rides,
  loading,
  error,
  onSelect,
}: {
  rides?: Ride[];
  loading: boolean;
  error: Error | null;
  onSelect: (rideId: string) => void;
}) {
  return (
    <div className="space-y-2 border-t border-line pt-5">
      <SectionTitle>Recent rides</SectionTitle>
      {error && <Notice>{error.message}</Notice>}
      {loading && <p className="text-sm text-muted">Loading history</p>}
      {rides?.length === 0 && <p className="text-sm text-muted">Your trips will show up here.</p>}
      <ul className="divide-y divide-line">
        {rides?.slice(0, 8).map((ride) => (
          <li key={ride.id}>
            <button
              type="button"
              onClick={() => onSelect(ride.id)}
              className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-kerb/60"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{ride.dropAddress}</span>
                <span className="block text-xs text-muted">{formatDateTime(ride.createdAt)}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <StatusPill status={ride.status} />
                <span className="text-xs text-muted">{formatFare(ride.actualFare ?? ride.estimatedFare)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
