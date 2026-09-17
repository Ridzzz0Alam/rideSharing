"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { RideMap, type MapCar } from "@/components/map/RideMap";
import { MapLayout } from "@/components/Nav";
import { Button, cx, LiveBadge, Notice, Panel, SectionTitle } from "@/components/ui";
import { queryKeys } from "@/lib/api";
import { formatCoords, SAMPLE, shortId } from "@/lib/format";
import { useApi } from "@/lib/providers";
import type { LatLng } from "@/lib/types";

const MAX_DRIVERS = 10;
// Random drivers land in a ring around the sample pickup, well inside the 5 km matching radius.
const SPAWN_MIN_KM = 0.3;
const SPAWN_MAX_KM = 2.5;

function randomNearby(center: LatLng): LatLng {
  // sqrt keeps the points evenly spread over the ring's area instead of bunching at the centre.
  const u = Math.random();
  const km = Math.sqrt(SPAWN_MIN_KM ** 2 + u * (SPAWN_MAX_KM ** 2 - SPAWN_MIN_KM ** 2));
  const bearing = Math.random() * 2 * Math.PI;
  const kmPerDegree = 111.32;
  return {
    lat: center.lat + (km * Math.cos(bearing)) / kmPerDegree,
    lng: center.lng + (km * Math.sin(bearing)) / (kmPerDegree * Math.cos((center.lat * Math.PI) / 180)),
  };
}

export function FleetConsole() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [placing, setPlacing] = useState(false);

  const drivers = useQuery({ queryKey: queryKeys.drivers, queryFn: api.getDrivers, refetchInterval: 3_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.drivers });

  // Ids handed out but not yet visible in the drivers list, so quick taps don't reuse one.
  const claimed = useRef(new Set<string>());
  const full = (drivers.data?.length ?? 0) >= MAX_DRIVERS;

  const addDriver = useMutation({
    mutationFn: async (position: LatLng) => {
      const taken = new Set([...(drivers.data?.map((d) => d.driverId) ?? []), ...claimed.current]);
      if (taken.size >= MAX_DRIVERS) throw new Error(`The fleet is limited to ${MAX_DRIVERS} drivers.`);
      let n = 1;
      while (taken.has(`driver:${n}`)) n++;
      const driverId = `driver:${n}`;
      claimed.current.add(driverId);
      try {
        await api.updateDriverLocation(driverId, position);
        await refresh();
      } finally {
        claimed.current.delete(driverId);
      }
    },
  });

  const remove = useMutation({
    mutationFn: (driverId: string) => api.removeDriver(driverId),
    onSettled: refresh,
  });

  const list = [...(drivers.data ?? [])].sort((a, b) => a.driverId.localeCompare(b.driverId, undefined, { numeric: true }));
  const busyCount = list.filter((d) => d.busy).length;
  const cars: MapCar[] = list.map((d) => ({
    driverId: d.driverId,
    position: { lat: d.latitude, lng: d.longitude },
    variant: d.busy ? "busy" : "idle",
  }));

  const error = drivers.error ?? addDriver.error ?? remove.error;

  const panel = (
    <Panel title="Fleet" aside={<LiveBadge />}>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-kerb px-4 py-3">
          <p className="text-3xl font-bold">{list.length - busyCount}</p>
          <p className="text-sm text-muted">available</p>
        </div>
        <div className="rounded-xl bg-asphalt px-4 py-3 text-white">
          <p className="text-3xl font-bold">{busyCount}</p>
          <p className="text-sm text-white/70">on a trip</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={full || !drivers.isSuccess}
          busy={addDriver.isPending && !placing}
          onClick={() => addDriver.mutate(randomNearby(SAMPLE.pickup.position))}
        >
          Add a driver
        </Button>
        <Button variant={placing ? "primary" : "secondary"} disabled={full && !placing} onClick={() => setPlacing((p) => !p)}>
          {placing ? "Done placing" : "Place drivers on map"}
        </Button>
      </div>
      {full ? (
        <Notice tone="info">The fleet is full at {MAX_DRIVERS} drivers. Take one offline to add another.</Notice>
      ) : (
        placing && <Notice tone="info">Each tap on the map adds a new driver there.</Notice>
      )}
      {error && <Notice>{error.message}</Notice>}

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Drivers in Redis</SectionTitle>
          <p className="text-sm text-muted">
            {list.length} / {MAX_DRIVERS}
          </p>
        </div>
        {drivers.isLoading && <p className="text-sm text-muted">Loading drivers</p>}
        {drivers.isSuccess && list.length === 0 && (
          <p className="text-sm text-muted">No drivers are online. Add a driver to try a ride.</p>
        )}
        <ul className="divide-y divide-line">
          {list.map((driver) => (
            <li key={driver.driverId} className="flex items-center gap-3 py-2.5">
              <span
                aria-hidden
                className={cx(
                  "grid size-8 shrink-0 place-items-center rounded-lg border-2 border-asphalt text-xs font-bold",
                  driver.busy ? "bg-asphalt text-white" : "bg-paper",
                )}
              >
                {driver.driverId.split(":").pop()?.slice(0, 3)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{driver.driverId}</span>
                <span className="block text-xs text-muted">
                  {driver.busy
                    ? `On ride ${driver.currentRideId ? shortId(driver.currentRideId) : ""}`
                    : formatCoords({ lat: driver.latitude, lng: driver.longitude })}
                </span>
              </span>
              <Button
                variant="ghost"
                className="min-h-0 px-1 text-xs"
                busy={remove.isPending && remove.variables === driver.driverId}
                onClick={() => remove.mutate(driver.driverId)}
                aria-label={`Take ${driver.driverId} offline`}
              >
                Take offline
              </Button>
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
          cars={cars}
          onMapClick={placing && !full ? (position) => addDriver.mutate(position) : undefined}
          cursor={placing && !full ? "copy" : undefined}
        />
      }
    />
  );
}
