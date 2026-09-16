"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import type { LatLng } from "@/lib/types";
import type { MapCar, RideMapProps } from "./types";

const pickupIcon = L.divIcon({
  className: "",
  html: '<div class="pin pin-pickup"><span>A</span></div>',
  iconSize: [30, 30],
  iconAnchor: [4, 30],
});

const dropIcon = L.divIcon({
  className: "",
  html: '<div class="pin pin-drop"><span>B</span></div>',
  iconSize: [30, 30],
  iconAnchor: [4, 30],
});

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const iconCache = new Map<string, L.DivIcon>();

function carIcon(car: MapCar) {
  const cacheKey = `${car.variant}|${car.driverId}`;
  const cached = iconCache.get(cacheKey);
  if (cached) return cached;
  const size = car.variant === "mine" ? 32 : 26;
  const label = escapeHtml(car.driverId.split(":").pop()?.slice(0, 3) ?? "");
  const icon = L.divIcon({
    className: "",
    html: `<div class="car car-${car.variant}">${label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
  iconCache.set(cacheKey, icon);
  return icon;
}

const toTuple = (p: LatLng): [number, number] => [p.lat, p.lng];

function ClickHandler({ onClick }: { onClick?: (position: LatLng) => void }) {
  useMapEvents({
    click(event) {
      onClick?.({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

/** Pans/zooms when the set of focus points changes (not on every driver tick). */
function FitTo({ points, fitKey }: { points: LatLng[]; fitKey: string }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(toTuple(points[0]), Math.max(map.getZoom(), 14));
    } else {
      // On desktop the control panel covers the left ~440px of the map.
      const wide = map.getContainer().clientWidth >= 768;
      map.fitBounds(
        L.latLngBounds(points.map(toTuple)),
        wide
          ? { paddingTopLeft: [460, 60], paddingBottomRight: [60, 60], maxZoom: 15 }
          : { padding: [40, 40], maxZoom: 15 },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit only when fitKey changes
  }, [fitKey, map]);
  return null;
}

/** Leaflet needs a size recalculation when its container changes (mobile layout). */
function ResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

export default function LeafletMap({ center, pickup, drop, cars = [], focus = [], onMapClick, cursor }: RideMapProps) {
  const route = useMemo(() => (pickup && drop ? [toTuple(pickup), toTuple(drop)] : null), [pickup, drop]);
  const fitKey = focus.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|");

  return (
    <MapContainer
      center={toTuple(center)}
      zoom={13}
      zoomControl={false}
      className="h-full w-full"
      style={{ cursor: cursor ?? "grab" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={19}
      />
      <ClickHandler onClick={onMapClick} />
      <FitTo points={focus} fitKey={fitKey} />
      <ResizeWatcher />

      {route && (
        <>
          <Polyline positions={route} pathOptions={{ color: "#ffffff", weight: 9, opacity: 0.9 }} />
          <Polyline positions={route} pathOptions={{ color: "#2f5bea", weight: 5, dashArray: "1 10", lineCap: "round" }} />
        </>
      )}

      {cars.map((car) => (
        <Marker
          key={car.driverId}
          position={toTuple(car.position)}
          icon={carIcon(car)}
          zIndexOffset={car.variant === "mine" ? 1000 : 0}
          keyboard={false}
        >
          <Tooltip direction="top" offset={[0, -12]}>
            {car.driverId}
            {car.variant === "busy" ? " (on a trip)" : ""}
          </Tooltip>
        </Marker>
      ))}

      {pickup && (
        <Marker position={toTuple(pickup)} icon={pickupIcon} zIndexOffset={2000}>
          <Tooltip direction="top" offset={[10, -28]}>Pickup</Tooltip>
        </Marker>
      )}
      {drop && (
        <Marker position={toTuple(drop)} icon={dropIcon} zIndexOffset={2000}>
          <Tooltip direction="top" offset={[10, -28]}>Drop-off</Tooltip>
        </Marker>
      )}
    </MapContainer>
  );
}
