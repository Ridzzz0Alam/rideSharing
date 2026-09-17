import type { LatLng } from "@/lib/types";

export interface MapCar {
  driverId: string;
  position: LatLng;
  /** "assigned" is the rider's matched driver, highlighted on the Ride screen. */
  variant: "idle" | "busy" | "mine" | "assigned";
}

export interface RideMapProps {
  center: LatLng;
  pickup?: LatLng | null;
  drop?: LatLng | null;
  cars?: MapCar[];
  /** Points to keep in view; the map refits only when these change. */
  focus?: LatLng[];
  onMapClick?: (position: LatLng) => void;
  cursor?: string;
}
