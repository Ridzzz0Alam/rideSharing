"use client";

import dynamic from "next/dynamic";
import type { RideMapProps } from "./types";

// Leaflet touches `window` on import, so it must never render on the server.
const LeafletMap = dynamic(() => import("./LeafletMap"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center bg-[#dfe3e8] text-sm text-muted">Loading map</div>
  ),
});

export function RideMap(props: RideMapProps) {
  return <LeafletMap {...props} />;
}

export type { MapCar, RideMapProps } from "./types";
