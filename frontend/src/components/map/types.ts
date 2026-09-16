import type { LatLng } from "@/lib/types";

export interface MapCar {
  driverId: string;
  position: LatLng;
  variant: "idle" | "busy" | "mine";
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
