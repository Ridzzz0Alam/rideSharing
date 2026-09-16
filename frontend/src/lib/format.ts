import type { LatLng, RideStatus } from "./types";

const fare = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatFare = (value: number | null | undefined) => (value == null ? "—" : fare.format(value));
export const formatTime = (iso: string | null | undefined) => (iso ? time.format(new Date(iso)) : "");
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
export const formatCoords = ({ lat, lng }: LatLng) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
export const shortId = (id: string) => id.slice(-6);

export const statusLabel: Record<RideStatus, string> = {
  REQUESTED: "Requested",
  MATCHING: "Finding a driver",
  ACCEPTED: "Driver assigned",
  DRIVER_ARRIVING: "Driver arriving",
  RIDE_STARTED: "On the way",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Straight-line distance, used only by the driving simulator. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Moves `from` up to `stepKm` towards `to`. */
export function stepTowards(from: LatLng, to: LatLng, stepKm: number): LatLng {
  const remaining = distanceKm(from, to);
  if (remaining <= stepKm) return to;
  const t = stepKm / remaining;
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
}

/** Sample data from the original README (Bangalore). */
export const SAMPLE = {
  center: { lat: 12.9606, lng: 77.6046 } satisfies LatLng,
  pickup: { position: { lat: 12.9716, lng: 77.5946 } satisfies LatLng, address: "MG Road, Bangalore" },
  drop: { position: { lat: 12.9352, lng: 77.6245 } satisfies LatLng, address: "Koramangala, Bangalore" },
  drivers: [
    { driverId: "driver:1", position: { lat: 12.9716, lng: 77.5946 } },
    { driverId: "driver:2", position: { lat: 12.98, lng: 77.58 } },
    { driverId: "driver:3", position: { lat: 12.96, lng: 77.61 } },
  ],
};
