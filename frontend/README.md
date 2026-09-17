# RideShare web

Next.js 16 (App Router) + TypeScript frontend for the RideShare .NET services.

| Screen | Path | What it does |
|---|---|---|
| Ride | `/` | Pick pickup/drop-off on the map, see the fare estimate, request a ride and follow it live |
| Drive | `/driver` | Driver simulator: goes online, sends its location every 3 s, drives itself to the pickup and drop-off, and starts/completes trips |
| Fleet | `/fleet` | All drivers in Redis, busy state, add drivers at random nearby spots or place them on the map (up to 10) |

## Stack

Next.js 16.3, React 19.2, Tailwind CSS 4, TanStack Query 5 for data fetching,
`@microsoft/signalr` 10 for live ride updates, Leaflet + react-leaflet 5 for maps
(CARTO Voyager tiles on OpenStreetMap data, no API key needed).

## Running

```bash
npm install
cp .env.example .env.local   # GATEWAY_URL=http://localhost:8080
npm run dev
```

When the whole solution is started with Aspire (`aspire run` in the repo root), this app is
started for you and `GATEWAY_URL` is injected automatically. Run `npm install` once first.

`GATEWAY_URL` is read on the server per request and passed to the browser, so a single
Docker image works in any environment (unlike `NEXT_PUBLIC_*`, which is frozen at build time).

## How it talks to the backend

Everything goes through the YARP gateway: REST under `/api/v1/**` and the SignalR hub at
`/hubs/rides`. The hub pushes `RideUpdated` messages to groups for a ride, a rider and a
driver; the client re-joins those groups after every reconnect. If the hub is unreachable
the badge shows "Polling" and screens fall back to refreshing every few seconds.

## Scripts

`npm run dev`, `npm run build`, `npm run lint`, `npm run typecheck`.
