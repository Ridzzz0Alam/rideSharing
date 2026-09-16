# Build RideShare from scratch

A step-by-step guide to building the .NET 10 + Aspire + Next.js RideShare platform yourself,
in the order that keeps every step testable.

The finished project (`RideShare-dotnet.zip`) is your answer key. Every file mentioned here
exists there with the same path. When this guide says **"copy from reference"**, open that
file in the zip, read it, and type or paste it in. The guide explains *why* each piece exists
and *what to check* before moving on.

---

## How this guide is organised

The project is built bottom-up, following the dependency graph. Nothing is written before
the thing it depends on exists, and every phase ends with a **checkpoint** you can run.

| Phase | You build | Depends on | Checkpoint |
|---|---|---|---|
| 0 | Tools installed | nothing | version commands print |
| 1 | Empty solution, all projects | 0 | `dotnet build` succeeds |
| 2 | Service defaults | 1 | builds |
| 3 | AppHost with Redis, Kafka, Postgres | 2 | containers green in the dashboard |
| 4 | Messaging library (events + Kafka) | 1 | builds |
| 5 | Location Service | 2, 3, 4 | drivers saved in Redis, nearby search works |
| 6 | Ride Service | 2, 3, 4 | ride saved, event visible in Kafka UI |
| 7 | Matching Service | 5, 6 | ride becomes `ACCEPTED` on its own |
| 8 | Gateway | 5, 6 | whole API reachable on port 8080 |
| 9 | Tests | 6, 7 | `dotnet test` green |
| 10 | Next.js frontend | 8 | full ride flow in the browser |
| 11 | Frontend inside Aspire | 3, 10 | one command starts everything |
| 12 | Docker images + Compose | all | `docker compose up` works without the .NET SDK |

A rough time budget, if you type most of it yourself: phases 0–4 take an afternoon,
5–9 a day, and 10–12 another day.

---

## Phase 0 — Install the tools

| Tool | Why | Check |
|---|---|---|
| .NET 10 SDK | builds and runs all C# projects | `dotnet --version` → `10.0.x` |
| Node.js 22 LTS (or newer) | runs Next.js | `node -v` |
| Docker Desktop, or Podman | Aspire and Compose run Redis, Kafka and Postgres as containers | `docker info` |
| Aspire project templates | `dotnet new aspire-*` templates | `dotnet new list aspire` |
| Aspire CLI (optional, recommended) | `aspire run`, `aspire add` | `aspire --version` |
| Editor | VS Code + C# Dev Kit, Rider, or Visual Studio 2026 | — |
| REST client (optional) | runs `http/rideshare.http` | VS Code "REST Client" extension, or Rider/VS built-in |

```bash
dotnet new install Aspire.ProjectTemplates
dotnet tool install -g Aspire.Cli        # or use the install script from aspire.dev
dotnet dev-certs https --trust           # only needed for the https launch profile
```

**Mental model before you start.** There are four long-running .NET processes and one Node
process:

- **Location** owns driver positions (Redis).
- **Ride** owns rides (Postgres) and talks to browsers over SignalR.
- **Matching** has no storage. It reacts to Kafka events and calls Location over HTTP.
- **Gateway** forwards browser traffic to Location and Ride.
- **The frontend** only ever talks to the gateway.

---

## Phase 1 — Solution skeleton

**Goal:** every project exists and the empty solution builds. Creating all projects first
means project references and the AppHost's generated `Projects.*` types resolve from the start.

### 1.1 Create the folder and root files

```bash
mkdir rideshare && cd rideshare
git init
```

Create these files in this order, copying each from the reference:

1. **`global.json`** pins the SDK major version, so everyone builds with .NET 10.
2. **`Directory.Build.props`** is imported automatically by every project below it. It sets
   `net10.0`, nullable, implicit usings and invariant globalization. It also defines the
   version properties (`$(AspireVersion)`, `$(OpenTelemetryVersion)` and so on) that every
   `.csproj` uses. Upgrading later is then a one-line change.
3. **`.gitignore`** and **`.dockerignore`** keep `bin/`, `obj/`, `node_modules/` and `.next/`
   out of git and out of Docker build contexts.

`Directory.Build.props` at a glance:

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>
  <PropertyGroup>
    <AspireVersion>13.5.3</AspireVersion>
    <ServiceDiscoveryVersion>10.6.0</ServiceDiscoveryVersion>
    <OpenTelemetryVersion>1.15.3</OpenTelemetryVersion>
    <OpenTelemetryInstrumentationVersion>1.15.0</OpenTelemetryInstrumentationVersion>
    <AspNetCoreVersion>10.0.0</AspNetCoreVersion>
  </PropertyGroup>
</Project>
```

> Check nuget.org for newer patch versions when you start. Only this file needs to change.

### 1.2 Generate the projects

```bash
dotnet new sln -n RideShare --format slnx

dotnet new aspire-apphost          -n RideShare.AppHost          -o src/RideShare.AppHost
dotnet new aspire-servicedefaults  -n RideShare.ServiceDefaults  -o src/RideShare.ServiceDefaults
dotnet new classlib                -n RideShare.Messaging        -o src/RideShare.Messaging
dotnet new web                     -n RideShare.LocationService  -o src/RideShare.LocationService
dotnet new web                     -n RideShare.RideService      -o src/RideShare.RideService
dotnet new web                     -n RideShare.MatchingService  -o src/RideShare.MatchingService
dotnet new web                     -n RideShare.Gateway          -o src/RideShare.Gateway
dotnet new xunit                   -n RideShare.Tests            -o tests/RideShare.Tests
```

Tidy-ups after generating:

- Delete `src/RideShare.Messaging/Class1.cs`.
- Delete the `<TargetFramework>`, `<Nullable>` and `<ImplicitUsings>` lines the templates put
  in each `.csproj`, because `Directory.Build.props` provides them. Leaving them is harmless,
  but removing them keeps a single source of truth.
- Delete each generated `appsettings.Development.json`, or keep it empty. The reference only
  uses `appsettings.json`.

### 1.3 Add projects to the solution

```bash
dotnet sln add src/RideShare.AppHost src/RideShare.ServiceDefaults src/RideShare.Messaging \
  src/RideShare.LocationService src/RideShare.RideService src/RideShare.MatchingService \
  src/RideShare.Gateway tests/RideShare.Tests
```

Compare the result with the reference `RideShare.slnx`. Solution folders (`/src/`, `/tests/`)
are optional and cosmetic.

### 1.4 Add project references

```bash
# Every service uses the shared defaults
for p in LocationService RideService MatchingService Gateway; do
  dotnet add src/RideShare.$p reference src/RideShare.ServiceDefaults
done

# Services that use Kafka
for p in LocationService RideService MatchingService; do
  dotnet add src/RideShare.$p reference src/RideShare.Messaging
done

# The AppHost references every runnable service
for p in LocationService RideService MatchingService Gateway; do
  dotnet add src/RideShare.AppHost reference src/RideShare.$p
done

# Tests reference the projects they test
dotnet add tests/RideShare.Tests reference src/RideShare.RideService src/RideShare.MatchingService
```

On Windows PowerShell, run each `dotnet add` line individually instead of the `for` loops.

### 1.5 Fix the ports

Replace each service's `Properties/launchSettings.json` with the reference version. Each has
a single `http` profile on a fixed port: Location **8082**, Ride **8083**, Matching **8084**,
Gateway **8080**. These match the original Java services, so the old README requests still work.

### ✅ Checkpoint 1

```bash
dotnet build
```

Everything compiles (the web projects are still "Hello World").

---

## Phase 2 — Service defaults

**Goal:** one shared place for telemetry, health checks, service discovery and HTTP
resilience. This replaces Spring Boot Actuator and the Feign configuration.

The template already generated `Extensions.cs` and the package references. Make two changes:

1. **`RideShare.ServiceDefaults.csproj`**: switch the package versions to the properties
   from `Directory.Build.props`, as in the reference.
2. **`Extensions.cs`**: in `MapDefaultEndpoints`, map `/health` and `/alive` in **every**
   environment, not only Development, so Docker health probes work. Copy from reference.

Then call the defaults from each web project's `Program.cs`. You'll rewrite those files
later, but add this now:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.AddServiceDefaults();
var app = builder.Build();
app.MapDefaultEndpoints();
app.Run();
```

### ✅ Checkpoint 2

`dotnet build` still succeeds.

---

## Phase 3 — AppHost with infrastructure only

**Goal:** Aspire starts Redis, Kafka and Postgres, and you can see them before writing any
business code. This replaces the original `docker-compose.yml` for development.

### 3.1 Add the hosting integrations

```bash
cd src/RideShare.AppHost
aspire add redis
aspire add kafka
aspire add postgres
# without the Aspire CLI:
# dotnet add package Aspire.Hosting.Redis --version 13.5.3   (same for .Kafka and .PostgreSQL)
cd ../..
```

Then change the versions in `RideShare.AppHost.csproj` to `$(AspireVersion)`, and make sure
the first line reads `<Project Sdk="Aspire.AppHost.Sdk/13.5.3">`.

### 3.2 Write `AppHost.cs` (infrastructure part only)

```csharp
var builder = DistributedApplication.CreateBuilder(args);

var redis = builder.AddRedis("redis").WithRedisInsight();
var kafka = builder.AddKafka("kafka").WithKafkaUI();          // KRaft, no Zookeeper
var postgres = builder.AddPostgres("postgres").WithDataVolume().WithPgAdmin();
var rideDb = postgres.AddDatabase("ridedb");

builder.Build().Run();
```

The resource names (`redis`, `kafka`, `ridedb`) matter. They become the connection string
names the services read (`ConnectionStrings:redis` and so on).

### ✅ Checkpoint 3

```bash
aspire run        # or: dotnet run --project src/RideShare.AppHost
```

The dashboard opens and shows `redis`, `kafka`, `postgres` and `ridedb` as **Running**.
Open Kafka UI from the dashboard; the cluster should have no topics yet.
Stop with Ctrl+C.

---

## Phase 4 — Messaging library

**Goal:** one definition of every event, and reusable Kafka plumbing. In the Java project
each service had its own copy of the event classes, and the copies had drifted.

### 4.1 Package

```bash
dotnet add src/RideShare.Messaging package Aspire.Confluent.Kafka --version 13.5.3
```

Add `<FrameworkReference Include="Microsoft.AspNetCore.App" />` to the `.csproj`, which gives
it hosting and logging types. Switch the version to `$(AspireVersion)`.

### 4.2 Files, in order

1. **`Contracts.cs`** (copy from reference). Write this first because every service depends
   on it. It contains:
   - the `Topics` constants: `ride.requested`, `ride.matched`, `ride.match-failed`,
     `ride.finished`, and a `.dlq` dead-letter topic for each;
   - four immutable `record` events.

   ```csharp
   public sealed record RideRequestedEvent(Guid RideId, string RiderId,
       double PickupLatitude, double PickupLongitude, string PickupAddress,
       double DropLatitude, double DropLongitude, string DropAddress);
   ```

2. **`Kafka/Kafka.cs`** (copy from reference). Read it in this order, because each part
   builds on the previous one:

   | Type | Role | Java equivalent |
   |---|---|---|
   | `KafkaJson` | camelCase JSON (de)serialisation | Spring `JsonSerializer` |
   | `IEventPublisher` / `KafkaEventPublisher` | `PublishAsync(topic, key, event)` over one `IProducer<string, byte[]>` | `KafkaTemplate` |
   | `KafkaConsumerWorker` | base `BackgroundService`: subscribe, consume, retry 3×, dead-letter, store offset after success | `@KafkaListener` |
   | `KafkaTopicInitializer` | creates topics on startup, retrying while Kafka boots | `NewTopic` beans |
   | `MessagingExtensions.AddRideShareMessaging(groupId?)` | registers all of the above | auto-configuration |

**Key design choices to understand:**

- **Byte payloads.** Producer and consumer use `byte[]` values, and JSON is handled in code.
  One producer therefore serves every event type, and a malformed message can be caught and
  dead-lettered instead of crashing the consumer.
- **Offset timing.** `EnableAutoOffsetStore = false`, and `StoreOffset` runs only after the
  handler succeeds. That gives at-least-once delivery, so handlers must be idempotent (you'll
  make them so in phase 6).
- **Consumer thread.** The consume loop runs on a dedicated long-running thread because
  `Consume()` blocks.
- **Topics before consumers.** The topic initializer is registered first, so topics exist
  before any consumer subscribes.

### ✅ Checkpoint 4

`dotnet build` succeeds.

---

## Phase 5 — Location Service

**Goal:** store driver positions in Redis GEO, answer "who is near this point?", and
reserve a driver atomically.

### 5.1 Packages

```bash
dotnet add src/RideShare.LocationService package Aspire.StackExchange.Redis --version 13.5.3
dotnet add src/RideShare.LocationService package Microsoft.AspNetCore.OpenApi --version 10.0.0
```

In the `.csproj`, add the `InterceptorsNamespaces` property from the reference. It enables
.NET 10's minimal-API validation generator.

### 5.2 Files, in order

1. **`appsettings.json`** holds local-default connection strings (`redis`, `kafka`) and
   `Location:MaxNearbyResults`. Aspire overrides the connection strings when it runs the
   service.
2. **`DriverLocationStore.cs`**. Build it in this order:
   - **DTO records** with validation attributes, for example
     `[Range(-90, 90)] double Latitude`.
   - **The `IDriverLocationStore` interface.**
   - **`RedisDriverLocationStore`**, one method at a time:
     - `UpsertAsync` uses `GeoAddAsync(key, longitude, latitude, member)`. **Longitude comes first.**
     - `FindNearbyAsync` uses `GeoSearchAsync(...)` with `GeoSearchCircle`, `WithCoordinates | WithDistance`, ascending order, and filters out busy drivers.
     - `GetAllAsync` combines `SortedSetRangeByRankAsync`, `GeoPositionAsync` and `HashGetAsync`.
     - `RemoveAsync` uses `GeoRemoveAsync`.
     - `TryClaimAsync` uses `HashSetAsync(busyKey, driverId, rideId, When.NotExists)`. This is the atomic reservation, and a repeated claim for the same ride also succeeds.
     - `ReleaseAsync` uses a small Lua script that deletes the entry only if it still belongs to *this* ride.
3. **`Program.cs`**, written top to bottom:
   - register services: `AddServiceDefaults`, `AddRedisClient("redis")`,
     `AddRideShareMessaging("location-service-group")`, the store, `AddOpenApi`,
     `AddValidation`, `AddProblemDetails`;
   - map the endpoint group `/api/v1/locations/drivers`: `update`, `nearby`, `/`, delete,
     `claim`, `release`;
   - add `RideFinishedConsumer` at the bottom. It frees the driver when a ride ends. You can
     write it now even though nothing publishes `ride.finished` yet.

### 5.3 Register it in the AppHost

```csharp
var locationService = builder.AddProject<Projects.RideShare_LocationService>("location-service")
    .WithReference(redis).WithReference(kafka)
    .WaitFor(redis).WaitFor(kafka)
    .WithHttpHealthCheck("/health");
```

`WithReference(redis)` injects `ConnectionStrings__redis`, and `WaitFor` delays startup until
Redis is healthy.

### ✅ Checkpoint 5

`aspire run`, then send these requests to `http://localhost:8082` (the first requests of
`http/rideshare.http`, with the host changed):

```http
POST http://localhost:8082/api/v1/locations/drivers/update
Content-Type: application/json

{ "driverId": "driver:1", "latitude": 12.9716, "longitude": 77.5946 }

###
GET http://localhost:8082/api/v1/locations/drivers/nearby?latitude=12.9716&longitude=77.5946&radius=5
```

Expected results:

- The nearby call returns `driver:1` with `distanceInKm: 0`.
- Sending `"latitude": 123` returns **400** with validation problem details.
- In Kafka UI, the `ride.*` topics now exist, created by the topic initializer.
- Optionally, in RedisInsight run `GEOPOS drivers:locations driver:1`.
- `http://localhost:8082/openapi/v1.json` shows the API.

---

## Phase 6 — Ride Service

**Goal:** the ride lifecycle, persisted in Postgres, with events out, events in, and live
pushes to browsers. This is the biggest service, so it's split into layers. Build them
inside out.

### 6.1 Packages

```bash
dotnet add src/RideShare.RideService package Aspire.Npgsql.EntityFrameworkCore.PostgreSQL --version 13.5.3
dotnet add src/RideShare.RideService package Microsoft.AspNetCore.OpenApi --version 10.0.0
```

Also in the `.csproj`: add the `InterceptorsNamespaces` property and
`<InternalsVisibleTo Include="RideShare.Tests" />`.

> **Why Postgres and not MySQL?** The MySQL EF Core provider (Pomelo) had no stable EF Core 10
> release when this was built. The root README describes how to switch back later.

### 6.2 Files, in order

1. **`appsettings.json`** holds the `ridedb` and `kafka` connection strings, plus the `Fare`
   section (`BaseFare` 50, `PerKm` 12).

2. **`Domain/Ride.cs`** is pure C#, with no framework code. Write it first and test it early
   (phase 9 can start right after this file). It contains:
   - **`RideStatus`**, the enum.
   - **Exceptions:** `RideNotFoundException` and `InvalidRideStateException`.
   - **`Ride`**, the aggregate:
     - private setters and a private constructor for EF;
     - `Ride.Request(...)` creates a ride with `Guid.CreateVersion7`;
     - one method per transition: `BeginMatching`, `AssignDriver` (returns `false` for a
       duplicate), `MarkDriverArriving`, `Start`, `Complete`, `Cancel`, `MarkNoDriverFound`;
     - each transition calls `EnsureStatus(...)`, so illegal moves throw.
   - **`FareOptions` and `FareCalculator`**: the Haversine formula plus base fare and
     per-km rate, using `decimal` for money.

3. **`Data/RideDbContext.cs`** contains:
   - `RideDbContext` with the table, max lengths, the enum stored as a string, and the money
     precision. The `uint Version` property marked `.IsRowVersion()` maps to Postgres `xmin`
     for optimistic concurrency.
   - `DatabaseInitializer`, a hosted service that calls `EnsureCreatedAsync` with retries.
     This is the equivalent of Hibernate's `ddl-auto: update`; switch to migrations for
     production.

4. **`Application/RideApplicationService.cs`**. Write the sections in the order they appear
   in the reference:
   1. **Request/response records.** `RideRequest` uses `double?` plus `[Required]`, so a
      missing coordinate is a real validation error. `RideResponse.From(ride)` maps the
      entity to the response.
   2. **Real-time push:**
      - `IRideHubClient` is the typed client, with `RideUpdated(RideResponse)`.
      - `RideHub` has `SubscribeToRide`, `SubscribeToRider` and `SubscribeToDriver`, plus
        their `Unsubscribe*` counterparts. These add the connection to SignalR groups.
      - `RideGroups` holds the group-name helpers.
      - `IRideNotifier` / `SignalRRideNotifier` send to the ride, rider and driver groups,
        and never throw.
   3. **`RideApplicationService`**, the port of `RideService.java`. Write the methods in this order:
      - **`Estimate`.**
      - **`RequestRideAsync`.** Note the order: create → `BeginMatching` → save → publish.
        Saving as `MATCHING` *before* publishing fixes the Java race. If publishing fails, the
        ride is cancelled and a 503 is returned.
      - **`GetAsync`, `GetByRiderAsync`, `GetByDriverAsync`.**
      - **`TransitionAsync`**, the helper that loads, transitions, saves, publishes
        `ride.finished` if the ride ended with a driver, and notifies. Then the four
        one-liners that use it.
      - **`AssignDriverAsync`**, the `ride.matched` handler. It is idempotent: if the ride
        already ended or has a different driver, it releases the incoming driver instead.
      - **`MarkNoDriverFoundAsync`**, the `ride.match-failed` handler.

5. **`Program.cs`**, top to bottom:
   - **Registration order matters:** `AddServiceDefaults` → `AddNpgsqlDbContext<RideDbContext>("ridedb")`
     → `AddHostedService<DatabaseInitializer>` (before the consumer) → `AddRideShareMessaging("ride-service-group")`
     → `AddHostedService<RideEventsConsumer>`.
   - `TimeProvider.System`, `FareOptions` bound from config, `FareCalculator`,
     `RideApplicationService` (scoped) and the notifier.
   - **JSON:** `JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseUpper)` for both HTTP and
     SignalR, so statuses look like `RIDE_STARTED`, the same as the Java API.
   - `AddOpenApi`, `AddValidation`, `AddProblemDetails`, `AddExceptionHandler<RideExceptionHandler>`.
   - **Endpoints:** `request`, `estimate`, `{id}`, `rider/{id}`, `driver/{id}`, `arriving`,
     `start`, `complete`, `cancel`. Then `app.MapHub<RideHub>("/hubs/rides")`.
   - **`RideExceptionHandler`** maps exceptions to status codes: not found → 404,
     invalid state → 409, concurrency → 409, dispatch failure → 503.
   - **`RideEventsConsumer`** subscribes to `ride.matched` and `ride.match-failed` and
     dispatches on `message.Topic`.

### 6.3 Register it in the AppHost

```csharp
var rideService = builder.AddProject<Projects.RideShare_RideService>("ride-service")
    .WithReference(rideDb).WithReference(kafka)
    .WaitFor(rideDb).WaitFor(kafka)
    .WithHttpHealthCheck("/health");
```

### ✅ Checkpoint 6

`aspire run`, then send the "Request a ride" request from `http/rideshare.http` to `:8083`.

- **Response:** **201**, with `"status": "MATCHING"` and `estimatedFare: 112.22`.
- **Kafka UI:** `ride.requested` contains one message keyed by the ride id.
- **Status stays `MATCHING`:** that's expected, because nobody consumes the event yet.
- **Error mapping:** `PUT /api/v1/rides/{id}/complete` returns **409**, and a random GUID
  returns **404**.
- **Cancel:** `PUT .../cancel` moves the ride to `CANCELLED`.
- **Database (optional):** in pgAdmin, the `rides` table exists in `ridedb`.

---

## Phase 7 — Matching Service

**Goal:** close the loop. Consume `ride.requested`, rank drivers, claim one, and publish the
result.

### 7.1 Packages

None beyond the project references. The typed `HttpClient`, service discovery and resilience
all come from ServiceDefaults.

### 7.2 Files, in order

1. **`appsettings.json`** contains:
   - the `kafka` connection string;
   - a `Services:location-service:http` entry, a service-discovery fallback so `dotnet run`
     works without Aspire;
   - the `Matching` weights (0.7 / 0.3) and the 5 km radius.

2. **`Program.cs`**. The top-level statements come first, followed by a
   `namespace RideShare.MatchingService { ... }` block. Write the types in this order:
   1. **`MatchingOptions`, `NearbyDriver`, `ScoredDriver`.**
   2. **`LocationServiceClient`**, the Feign replacement:
      - base address `https+http://location-service`, resolved by service discovery;
      - URLs built with `string.Create(CultureInfo.InvariantCulture, ...)`, so decimal commas
        on locales like Hungarian can't break the query;
      - `TryClaimAsync` treats 409 and 404 as "not available".
   3. **`IDriverRatingProvider` / `SimulatedDriverRatingProvider`.** The rating is stable per
      driver (an FNV-1a hash). Java's `Math.random()` in a comparator gave inconsistent
      ranking.
   4. **`DriverScorer.Rank`.** `score = 1/(distance + 0.1) × 0.7 + rating × 0.3`, highest first.
   5. **`DriverMatcher.MatchAsync`.** Get nearby drivers. If there are none, publish
      `ride.match-failed`. Otherwise loop through the ranked candidates: the first successful
      claim publishes `ride.matched`. If every claim fails, publish `ride.match-failed`.
   6. **`RideRequestedConsumer`.**
   7. **The top-level registrations:** `AddHttpClient<LocationServiceClient>`, the provider,
      the scorer, `DriverMatcher` (scoped) and the consumer.

### 7.3 Register it in the AppHost

```csharp
builder.AddProject<Projects.RideShare_MatchingService>("matching-service")
    .WithReference(kafka)
    .WithReference(locationService)     // enables http://location-service discovery
    .WaitFor(kafka).WaitFor(locationService);
```

### ✅ Checkpoint 7 (the core system works)

1. Add the three drivers from `http/rideshare.http` to `:8082`.
2. Request a ride on `:8083`. Within about a second, `GET /api/v1/rides/{id}` shows
   `driverId: "driver:1"` and `status: "ACCEPTED"`.
3. `GET :8082/api/v1/locations/drivers/` shows `driver:1` with `busy: true`.
4. Start the ride, then complete it. `driver:1` goes back to `busy: false`, freed by
   `ride.finished`.
5. Delete all drivers, then request a ride. It becomes `CANCELLED` with
   `cancellationReason: "No drivers available within 5 km"`.
6. In the dashboard, open **Traces**. One request shows spans across Ride, Matching and
   Location.

---

## Phase 8 — Gateway

**Goal:** a single browser-facing address with CORS, WebSocket forwarding and a basic rate
limit.

### 8.1 Packages

```bash
dotnet add src/RideShare.Gateway package Yarp.ReverseProxy --version 2.3.0
dotnet add src/RideShare.Gateway package Microsoft.Extensions.ServiceDiscovery.Yarp --version 10.6.0
```

The gateway does **not** reference the Messaging project.

### 8.2 Files, in order

1. **`appsettings.json`** has three sections:
   - `ReverseProxy` routes: `/api/v1/locations/**` goes to `location-service`;
     `/api/v1/rides/**` and `/hubs/**` go to `ride-service`.
   - Cluster destinations use `https+http://<service-name>`.
   - `Cors:AllowedOrigins` and a `Services` fallback for running without Aspire.
2. **`Program.cs`** registers, in order:
   - `AddReverseProxy().LoadFromConfig(...).AddServiceDiscoveryDestinationResolver()`;
   - **CORS:** any loopback origin in Development, configured origins otherwise, always with
     `AllowCredentials()`, which SignalR needs;
   - a fixed-window rate limiter.

   Then the middleware order: `UseCors` → `UseRateLimiter` → `UseWebSockets` →
   `MapDefaultEndpoints` → `MapReverseProxy`.

### 8.3 Register it in the AppHost

```csharp
var gateway = builder.AddProject<Projects.RideShare_Gateway>("gateway")
    .WithReference(locationService).WithReference(rideService)
    .WaitFor(locationService).WaitFor(rideService)
    .WithExternalHttpEndpoints();
```

### ✅ Checkpoint 8

Add `http/rideshare.http` from the reference (`@gateway = http://localhost:8080`) and run
the whole file top to bottom. Every request works through port 8080.

---

## Phase 9 — Tests

**Goal:** lock down the pure logic: fares, the state machine and scoring.

1. Replace `tests/RideShare.Tests/RideShare.Tests.csproj` with the reference version, which
   pins `Microsoft.NET.Test.Sdk`, `xunit` and `xunit.runner.visualstudio`, and adds a global
   `using Xunit`. Delete the template's `UnitTest1.cs`.
2. **`RideTests.cs`** covers:
   - the fare for the README trip, which must be **112.22**;
   - the happy path;
   - illegal transitions throwing;
   - duplicate match events being ignored;
   - "no driver" after the rider already cancelled.
3. **`MatchingTests.cs`** covers:
   - the closer driver winning;
   - rating outweighing a small distance difference;
   - stable ratings (`driver:1` → 4.64, `driver:2` → 4.02, `driver:3` → 4.40).

### ✅ Checkpoint 9

```bash
dotnet test
```

All tests pass. (You can do this phase right after writing `Domain/Ride.cs`. That's a good
habit.)

---

## Phase 10 — Next.js frontend

**Goal:** three screens (Ride, Drive, Fleet) that talk only to the gateway.

### 10.1 Scaffold and install

From the repo root:

```bash
npx create-next-app@latest frontend --ts --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --use-npm --yes
cd frontend
npm install @microsoft/signalr @tanstack/react-query leaflet react-leaflet
npm install -D @types/leaflet
```

The scaffold creates `AGENTS.md`, which points to version-matched docs in
`node_modules/next/dist/docs/`. Use those when something differs from older tutorials.
For example, `middleware.ts` is now `proxy.ts` in Next 16.

Clean up the scaffold:

- delete `public/*.svg`, `src/app/page.tsx` and `src/app/favicon.ico`;
- add `public/.gitkeep`, so the Docker `COPY public` step has something to copy;
- create the folders `src/lib`, `src/components/map`, `src/app/driver` and `src/app/fleet`.

Then:

- Copy `.env.example` and save it as `.env.local`, containing `GATEWAY_URL=http://localhost:8080`.
- Update `package.json`: rename the project and add a `typecheck` script.
- Update `next.config.ts`: `output: "standalone"` and `typedRoutes: true`.

### 10.2 Files, in order (foundation first, then screens)

| # | File | What it gives you | Depends on |
|---|---|---|---|
| 1 | `src/app/globals.css` | Tailwind import, colour tokens (`--route`, `--pickup`, `--drop`, …) exposed via `@theme`, status-line pulse animation, map marker styles | — |
| 2 | `src/lib/types.ts` | TypeScript mirror of the C# DTOs; `RideStatus` union; `isTerminal()` | — |
| 3 | `src/lib/api.ts` | `createApi(gatewayUrl)` with one function per endpoint, `ApiError` built from ProblemDetails, `queryKeys` | 2 |
| 4 | `src/lib/format.ts` | money and time formatting, status labels, `distanceKm`, `stepTowards` (driving simulation), `SAMPLE` data from the original README | 2 |
| 5 | `src/lib/providers.tsx` | `Providers` (TanStack Query + API + SignalR), `useApi`, `useLiveState`, `useLiveSubscription`, `useStoredValue` | 3 |
| 6 | `src/components/ui.tsx` | `Button`, `Field`, `Notice`, `Panel`, `LiveBadge`, `StatusPill`, **`StatusLine`** (the transit-line status view) | 4, 5 |
| 7 | `src/components/map/types.ts` | `MapCar`, `RideMapProps` | 2 |
| 8 | `src/components/map/LeafletMap.tsx` | the actual map: tiles, route line, A/B pins, cars, click handler, fit-to-bounds | 7 |
| 9 | `src/components/map/RideMap.tsx` | `next/dynamic(..., { ssr: false })` wrapper, because Leaflet needs `window` | 8 |
| 10 | `src/components/Nav.tsx` | side rail (bottom bar on mobile) and `MapLayout` (map plus floating panel) | 6 |
| 11 | `src/app/layout.tsx` | reads `GATEWAY_URL` per request (`await connection()`), loads the font, renders `Providers` + `Nav` | 5, 10 |
| 12 | `src/components/FleetConsole.tsx` | **simplest screen, build it first**: list, add and remove drivers | 3–10 |
| 13 | `src/app/fleet/page.tsx` | route → `FleetConsole` | 12 |
| 14 | `src/components/RiderConsole.tsx` | booking form, estimate, request, active ride with `StatusLine`, history | 3–10 |
| 15 | `src/app/page.tsx` | route `/` → `RiderConsole` | 14 |
| 16 | `src/components/DriverConsole.tsx` | online/offline, 3-second location ping loop, auto-drive, trip actions, earnings | 3–10 |
| 17 | `src/app/driver/page.tsx` | route → `DriverConsole` | 16 |
| 18 | `src/app/not-found.tsx`, `src/app/icon.svg` | polish | — |

**Concepts worth understanding as you type them:**

- **Runtime config.** `NEXT_PUBLIC_*` variables are baked in at build time. Reading
  `process.env.GATEWAY_URL` in the server layout after `await connection()` and passing it
  down as a prop lets one Docker image run anywhere.
- **Live updates.**
  - The provider holds **one** SignalR connection.
  - Components call `useLiveSubscription("SubscribeToRide", id)`, which is reference-counted.
  - After a reconnect, the provider re-joins every group, because groups are
    per-connection on the server.
  - Incoming `RideUpdated` messages write into the TanStack Query cache and invalidate the
    ride lists, so every screen updates without extra code.
- **Graceful fallback.** When the hub is down, the badge shows "Polling", and queries use
  `refetchInterval` only in that state.
- **The driver ping loop.**
  - The interval is created once per online session.
  - It reads the latest position and ride through refs, so it isn't recreated every tick.
  - Each tick moves the car up to 120 m towards the pickup, or the drop-off once the trip
    has started.

### ✅ Checkpoint 10

With the backend running under Aspire (phases 3–8) and `.env.local` in place:

```bash
npm run dev          # http://localhost:3000
```

1. **Fleet:** *Add the 3 sample drivers*. Three cars appear.
2. **Ride:** *Use the sample Bangalore trip*. The estimate shows **₹112.22**.
   *Request ride*. The status line reaches *Driver assigned*, and the badge says **Live**.
3. **Drive:** as `driver:1`, *Go online*. The car moves. *Start trip*, wait, then
   *Complete trip*. The Ride tab follows along live.
4. Run the quality gates:

   ```bash
   npm run lint && npm run typecheck && npm run build
   ```

If the badge says **Polling**, SignalR isn't connecting. Check the gateway CORS settings
and the `/hubs/**` route.

---

## Phase 11 — Run the frontend from Aspire

**Goal:** one command starts everything.

```bash
cd src/RideShare.AppHost
aspire add javascript        # or: dotnet add package Aspire.Hosting.JavaScript --version 13.5.3
```

Append this to `AppHost.cs`, and add `#pragma warning disable ASPIREJAVASCRIPT001` at the top
of the file (the API is marked experimental):

```csharp
builder.AddNextJsApp("web", "../../frontend", runScriptName: "dev")
    .WithEnvironment("GATEWAY_URL", gateway.GetEndpoint("http"))
    .WithExternalHttpEndpoints()
    .WaitFor(gateway);
```

The path is relative to the AppHost project folder.

### ✅ Checkpoint 11

```bash
cd frontend && npm install && cd ..
aspire run
```

The dashboard lists `web`. Open it and repeat the checkpoint 10 flow. You no longer need
`.env.local`.

---

## Phase 12 — Containers and Compose

**Goal:** run the whole stack on any machine with only Docker installed.

Create these in order:

1. **`Dockerfile`** (repo root). A single multi-stage image for any service, chosen with
   `--build-arg PROJECT=RideShare.RideService`. It builds with `sdk:10.0` and runs on
   `aspnet:10.0` as a non-root user on port 8080.
2. **`frontend/Dockerfile`** and **`frontend/.dockerignore`**. Three stages (deps → build →
   runtime) using the Next standalone output; the image runs `node server.js`.
3. **`docker-compose.yml`**:
   - **Infrastructure:** Redis, Postgres, and Kafka (the `apache/kafka` image in KRaft mode:
     one internal listener `kafka:9092`, one host listener `localhost:29092`), each with a
     health check, plus Kafka UI.
   - **Services:** each gets its connection strings as `ConnectionStrings__name`.
   - **Service discovery:** without Aspire, it comes from `services__<name>__http__0`
     variables.
   - **Frontend:** `GATEWAY_URL=http://localhost:8080`. It must be the address the
     **browser** can reach, not a container hostname.

### ✅ Checkpoint 12

```bash
docker compose up --build
```

Open http://localhost:3000 and run the full flow again.

---

## Appendix A — Package list by project

| Project | Packages |
|---|---|
| AppHost | SDK `Aspire.AppHost.Sdk/13.5.3`; `Aspire.Hosting.Redis`, `Aspire.Hosting.Kafka`, `Aspire.Hosting.PostgreSQL`, `Aspire.Hosting.JavaScript` |
| ServiceDefaults | `Microsoft.Extensions.Http.Resilience`, `Microsoft.Extensions.ServiceDiscovery`, `OpenTelemetry.Exporter.OpenTelemetryProtocol`, `OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Instrumentation.AspNetCore`, `.Http`, `.Runtime` |
| Messaging | `Aspire.Confluent.Kafka` (+ `Microsoft.AspNetCore.App` framework reference) |
| LocationService | `Aspire.StackExchange.Redis`, `Microsoft.AspNetCore.OpenApi` |
| RideService | `Aspire.Npgsql.EntityFrameworkCore.PostgreSQL`, `Microsoft.AspNetCore.OpenApi` (SignalR is built into ASP.NET Core) |
| MatchingService | none (uses references only) |
| Gateway | `Yarp.ReverseProxy`, `Microsoft.Extensions.ServiceDiscovery.Yarp` |
| Tests | `Microsoft.NET.Test.Sdk`, `xunit`, `xunit.runner.visualstudio` |
| frontend | `next`, `react`, `react-dom`, `@microsoft/signalr`, `@tanstack/react-query`, `leaflet`, `react-leaflet`; dev: `tailwindcss`, `@tailwindcss/postcss`, `typescript`, `eslint`, `eslint-config-next`, `@types/*` |

## Appendix B — Complete file checklist, in creation order

Tick these off as you go.

```
[ ] global.json
[ ] Directory.Build.props
[ ] .gitignore, .dockerignore
[ ] RideShare.slnx                               (dotnet new sln + dotnet sln add)
[ ] src/*/  and tests/*/ projects                (dotnet new ...)
[ ] src/*/Properties/launchSettings.json         (fixed ports)
[ ] src/RideShare.ServiceDefaults/Extensions.cs
[ ] src/RideShare.AppHost/AppHost.cs             (infrastructure only)
[ ] src/RideShare.AppHost/appsettings.json, Properties/launchSettings.json
[ ] src/RideShare.Messaging/Contracts.cs
[ ] src/RideShare.Messaging/Kafka/Kafka.cs
[ ] src/RideShare.LocationService/appsettings.json
[ ] src/RideShare.LocationService/DriverLocationStore.cs
[ ] src/RideShare.LocationService/Program.cs
[ ] AppHost: + location-service
[ ] src/RideShare.RideService/appsettings.json
[ ] src/RideShare.RideService/Domain/Ride.cs
[ ] tests/RideShare.Tests/RideTests.cs           (optional: do it now)
[ ] src/RideShare.RideService/Data/RideDbContext.cs
[ ] src/RideShare.RideService/Application/RideApplicationService.cs
[ ] src/RideShare.RideService/Program.cs
[ ] AppHost: + ride-service
[ ] src/RideShare.MatchingService/appsettings.json
[ ] src/RideShare.MatchingService/Program.cs
[ ] AppHost: + matching-service
[ ] tests/RideShare.Tests/MatchingTests.cs
[ ] src/RideShare.Gateway/appsettings.json
[ ] src/RideShare.Gateway/Program.cs
[ ] AppHost: + gateway
[ ] http/rideshare.http
[ ] frontend/ (create-next-app + npm installs)
[ ] frontend/next.config.ts, package.json, .env.example
[ ] frontend/src/app/globals.css
[ ] frontend/src/lib/types.ts
[ ] frontend/src/lib/api.ts
[ ] frontend/src/lib/format.ts
[ ] frontend/src/lib/providers.tsx
[ ] frontend/src/components/ui.tsx
[ ] frontend/src/components/map/types.ts
[ ] frontend/src/components/map/LeafletMap.tsx
[ ] frontend/src/components/map/RideMap.tsx
[ ] frontend/src/components/Nav.tsx
[ ] frontend/src/app/layout.tsx
[ ] frontend/src/components/FleetConsole.tsx  +  src/app/fleet/page.tsx
[ ] frontend/src/components/RiderConsole.tsx  +  src/app/page.tsx
[ ] frontend/src/components/DriverConsole.tsx +  src/app/driver/page.tsx
[ ] frontend/src/app/not-found.tsx, src/app/icon.svg
[ ] AppHost: + web (AddNextJsApp)
[ ] Dockerfile
[ ] frontend/Dockerfile, frontend/.dockerignore
[ ] docker-compose.yml
[ ] README.md, frontend/README.md
```

## Appendix C — Command cheat sheet

```bash
# .NET
dotnet build                               # whole solution
dotnet test
aspire run                                 # everything, with dashboard
dotnet run --project src/RideShare.RideService   # a single service (needs infra running)
dotnet list package --outdated             # find newer package versions

# Frontend
npm run dev | build | lint | typecheck

# Containers
docker compose up --build
docker compose down -v                     # also deletes the Postgres volume

# Handy checks
docker exec -it redis-geo redis-cli GEOPOS drivers:locations driver:1   # compose only
curl http://localhost:8080/api/v1/locations/drivers/
```

## Appendix D — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `NU1102` / `NU1101` package not found | a pinned version doesn't exist yet or was superseded | change the number in `Directory.Build.props` (check nuget.org) |
| Warning or error `ASPIREJAVASCRIPT001` | `AddNextJsApp` is experimental | keep the `#pragma warning disable` at the top of `AppHost.cs` |
| Validation doesn't run (bad input returns 500 or is accepted) | validation generator not active | make sure `builder.Services.AddValidation()` is called and the `InterceptorsNamespaces` property is in the `.csproj` |
| Service logs "Kafka not ready" repeatedly | broker still starting | wait; startup retries for about 60 s. Under Aspire, `WaitFor(kafka)` handles this |
| Ride stays `MATCHING` forever | Matching Service not running, or can't reach Location | check its logs and traces in the dashboard, and the `services__location-service__*` settings |
| Ride instantly `CANCELLED`: "No drivers available…" | no online driver within 5 km of pickup | add drivers first (Fleet screen or `.http`) |
| `409 Invalid ride state` | calling start/complete in the wrong order | follow ACCEPTED → (arriving) → start → complete |
| Browser: CORS error | frontend origin not allowed | Development allows any localhost port; otherwise set `Cors__AllowedOrigins__0` |
| Badge stuck on "Polling" | SignalR can't connect | check the gateway `/hubs/**` route, `UseWebSockets()`, and that CORS includes `AllowCredentials()` |
| `window is not defined` during build | Leaflet imported on the server | import the map only through `RideMap.tsx` (`dynamic(..., { ssr: false })`) |
| Map is grey or markers are missing | tiles blocked or Leaflet CSS missing | check network access to the tile server; keep `import "leaflet/dist/leaflet.css"` in `LeafletMap.tsx` |
| Wrong coordinates in URLs on some machines | culture-specific decimal separator | build query strings with `CultureInfo.InvariantCulture` (see `LocationServiceClient`) |
| Port 8080–8084 already in use | another app, or the old Java services | stop them, or change ports in `launchSettings.json` and `.env.local` |
| `docker compose` web app can't reach the API | `GATEWAY_URL` set to a container name | use `http://localhost:8080`, since the browser makes the calls |
