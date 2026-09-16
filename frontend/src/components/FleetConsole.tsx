"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { RideMap, type MapCar } from "@/components/map/RideMap";
import { MapLayout } from "@/components/Nav";
import { Button, cx, LiveBadge, Notice, Panel, SectionTitle } from "@/components/ui";
import { queryKeys } from "@/lib/api";
import { formatCoords, SAMPLE, shortId } from "@/lib/format";
import { useApi } from "@/lib/providers";
import type { LatLng } from "@/lib/types";

export function FleetConsole() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [placing, setPlacing] = useState(false);

  const drivers = useQuery({ queryKey: queryKeys.drivers, queryFn: api.getDrivers, refetchInterval: 3_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.drivers });

  const seed = useMutation({
    mutationFn: () => Promise.all(SAMPLE.drivers.map((d) => api.updateDriverLocation(d.driverId, d.position))),
    onSettled: refresh,
  });

  const addAt = useMutation({
    mutationFn: (position: LatLng) => {
      const taken = new Set(drivers.data?.map((d) => d.driverId));
      let n = (drivers.data?.length ?? 0) + 1;
      while (taken.has(`driver:${n}`)) n++;
      return api.updateDriverLocation(`driver:${n}`, position);
    },
    onSettled: refresh,
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

  const error = drivers.error ?? seed.error ?? addAt.error ?? remove.error;

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
        <Button busy={seed.isPending} onClick={() => seed.mutate()}>
          Add the 3 sample drivers
        </Button>
        <Button variant={placing ? "primary" : "secondary"} onClick={() => setPlacing((p) => !p)}>
          {placing ? "Done placing" : "Place drivers on map"}
        </Button>
      </div>
      {placing && <Notice tone="info">Each tap on the map adds a new driver there.</Notice>}
      {error && <Notice>{error.message}</Notice>}

      <div className="space-y-2">
        <SectionTitle>Drivers in Redis</SectionTitle>
        {drivers.isLoading && <p className="text-sm text-muted">Loading drivers</p>}
        {drivers.isSuccess && list.length === 0 && (
          <p className="text-sm text-muted">No drivers are online. Add the sample drivers to try a ride.</p>
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
          onMapClick={placing ? (position) => addAt.mutate(position) : undefined}
          cursor={placing ? "copy" : undefined}
        />
      }
    />
  );
}
