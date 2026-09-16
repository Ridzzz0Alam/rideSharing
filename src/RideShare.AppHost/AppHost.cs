// Replaces docker-compose.yml + "mvn spring-boot:run" ×3.
// `aspire run` (or `dotnet run` in this folder) starts the infrastructure containers,
// all .NET services, the gateway and the Next.js frontend, plus the Aspire dashboard.

#pragma warning disable ASPIREJAVASCRIPT001 // AddNextJsApp is marked experimental

var builder = DistributedApplication.CreateBuilder(args);

// ── Infrastructure ────────────────────────────────────────────────
var redis = builder.AddRedis("redis")
    .WithRedisInsight();

var kafka = builder.AddKafka("kafka")          // KRaft mode, no Zookeeper needed
    .WithKafkaUI();

var postgres = builder.AddPostgres("postgres")
    .WithDataVolume()
    .WithPgAdmin();

var rideDb = postgres.AddDatabase("ridedb");

// ── Services ──────────────────────────────────────────────────────
var locationService = builder.AddProject<Projects.RideShare_LocationService>("location-service")
    .WithReference(redis)
    .WithReference(kafka)
    .WaitFor(redis)
    .WaitFor(kafka)
    .WithHttpHealthCheck("/health");

var rideService = builder.AddProject<Projects.RideShare_RideService>("ride-service")
    .WithReference(rideDb)
    .WithReference(kafka)
    .WaitFor(rideDb)
    .WaitFor(kafka)
    .WithHttpHealthCheck("/health");

builder.AddProject<Projects.RideShare_MatchingService>("matching-service")
    .WithReference(kafka)
    .WithReference(locationService)
    .WaitFor(kafka)
    .WaitFor(locationService);

var gateway = builder.AddProject<Projects.RideShare_Gateway>("gateway")
    .WithReference(locationService)
    .WithReference(rideService)
    .WaitFor(locationService)
    .WaitFor(rideService)
    .WithExternalHttpEndpoints();

// ── Frontend ──────────────────────────────────────────────────────
builder.AddNextJsApp("web", "../../frontend", runScriptName: "dev")
    .WithEnvironment("GATEWAY_URL", gateway.GetEndpoint("http"))
    .WithExternalHttpEndpoints()
    .WaitFor(gateway);

builder.Build().Run();
