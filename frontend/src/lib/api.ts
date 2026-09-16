import type { DriverSnapshot, FareEstimate, LatLng, NearbyDriver, Ride, RideRequest } from "./types";

/** RFC 9457 problem details returned by the .NET services. */
interface ProblemDetails {
  title?: string;
  detail?: string;
  message?: string;
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<ApiError> {
  let problem: ProblemDetails = {};
  try {
    problem = (await response.json()) as ProblemDetails;
  } catch {
    // Non-JSON error body (e.g. gateway 502).
  }

  const fieldMessages = Object.values(problem.errors ?? {}).flat();
  const message =
    problem.detail ??
    problem.message ??
    (fieldMessages.length > 0 ? fieldMessages.join(" ") : undefined) ??
    problem.title ??
    `Request failed with status ${response.status}`;

  return new ApiError(message, response.status, problem.errors);
}

const id = (value: string) => encodeURIComponent(value);

export function createApi(gatewayUrl: string) {
  const base = gatewayUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
    } catch {
      throw new ApiError(`Can't reach the gateway at ${base}. Check that the backend is running.`, 0);
    }

    if (!response.ok) {
      throw await readError(response);
    }
    return (await response.json()) as T;
  }

  const json = (body: unknown) => JSON.stringify(body);

  return {
    gatewayUrl: base,

    // ── Location service ──
    updateDriverLocation: (driverId: string, position: LatLng) =>
      request<{ message: string }>("/api/v1/locations/drivers/update", {
        method: "POST",
        body: json({ driverId, latitude: position.lat, longitude: position.lng }),
      }),
    getDrivers: () => request<DriverSnapshot[]>("/api/v1/locations/drivers/"),
    getNearbyDrivers: (position: LatLng, radiusKm = 5) =>
      request<NearbyDriver[]>(
        `/api/v1/locations/drivers/nearby?latitude=${position.lat}&longitude=${position.lng}&radius=${radiusKm}`,
      ),
    removeDriver: (driverId: string) =>
      request<{ message: string }>(`/api/v1/locations/drivers/${id(driverId)}`, { method: "DELETE" }),

    // ── Ride service ──
    estimateFare: (pickup: LatLng, drop: LatLng) =>
      request<FareEstimate>("/api/v1/rides/estimate", {
        method: "POST",
        body: json({
          pickupLatitude: pickup.lat,
          pickupLongitude: pickup.lng,
          dropLatitude: drop.lat,
          dropLongitude: drop.lng,
        }),
      }),
    requestRide: (body: RideRequest) =>
      request<Ride>("/api/v1/rides/request", { method: "POST", body: json(body) }),
    getRide: (rideId: string) => request<Ride>(`/api/v1/rides/${id(rideId)}`),
    getRiderRides: (riderId: string) => request<Ride[]>(`/api/v1/rides/rider/${id(riderId)}`),
    getDriverRides: (driverId: string) => request<Ride[]>(`/api/v1/rides/driver/${id(driverId)}`),
    markArriving: (rideId: string) => request<Ride>(`/api/v1/rides/${id(rideId)}/arriving`, { method: "PUT" }),
    startRide: (rideId: string) => request<Ride>(`/api/v1/rides/${id(rideId)}/start`, { method: "PUT" }),
    completeRide: (rideId: string) => request<Ride>(`/api/v1/rides/${id(rideId)}/complete`, { method: "PUT" }),
    cancelRide: (rideId: string, reason?: string) =>
      request<Ride>(
        `/api/v1/rides/${id(rideId)}/cancel${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`,
        { method: "PUT" },
      ),
  };
}

export type Api = ReturnType<typeof createApi>;

export const queryKeys = {
  drivers: ["drivers"] as const,
  ride: (rideId: string) => ["ride", rideId] as const,
  riderRides: (riderId: string) => ["rides", "rider", riderId] as const,
  driverRides: (driverId: string) => ["rides", "driver", driverId] as const,
  estimate: (pickup: LatLng, drop: LatLng) =>
    ["estimate", pickup.lat, pickup.lng, drop.lat, drop.lng] as const,
};
