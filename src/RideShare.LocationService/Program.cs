using System.ComponentModel.DataAnnotations;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using RideShare.LocationService;
using RideShare.Messaging;
using RideShare.Messaging.Kafka;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddRedisClient("redis");
builder.AddRideShareMessaging(consumerGroupId: "location-service-group");

builder.Services.Configure<LocationOptions>(builder.Configuration.GetSection("Location"));
builder.Services.AddSingleton<IDriverLocationStore, RedisDriverLocationStore>();
builder.Services.AddHostedService<RideFinishedConsumer>();

builder.Services.AddOpenApi();
builder.Services.AddValidation();
builder.Services.AddProblemDetails();

var app = builder.Build();

app.UseExceptionHandler();
app.MapOpenApi();
app.MapDefaultEndpoints();

var drivers = app.MapGroup("/api/v1/locations/drivers").WithTags("Driver locations");

// Driver phone calls this every few seconds.
drivers.MapPost("/update", async (DriverLocationRequest request, IDriverLocationStore store) =>
{
    await store.UpsertAsync(request.DriverId, request.Latitude, request.Longitude);
    return TypedResults.Ok(new MessageResponse("Driver location updated"));
})
.WithName("UpdateDriverLocation");

// Matching Service calls this when a ride is requested.
drivers.MapGet("/nearby", async (
        [Range(-90, 90)] double latitude,
        [Range(-180, 180)] double longitude,
        IDriverLocationStore store,
        IOptions<LocationOptions> options,
        [Range(0.1, 50)] double radius = 5.0) =>
    TypedResults.Ok(await store.FindNearbyAsync(latitude, longitude, radius, options.Value.MaxNearbyResults)))
.WithName("GetNearbyDrivers");

// New: every known driver (used by the fleet map in the frontend).
drivers.MapGet("/", async (IDriverLocationStore store) => TypedResults.Ok(await store.GetAllAsync()))
    .WithName("GetAllDrivers");

// Driver goes offline.
drivers.MapDelete("/{driverId}", async (string driverId, IDriverLocationStore store) =>
    await store.RemoveAsync(driverId)
        ? Results.Ok(new MessageResponse("Driver removed successfully"))
        : Results.NotFound(new MessageResponse($"Driver '{driverId}' is not online")))
.WithName("RemoveDriver");

// New: atomic reservation used by the Matching Service.
drivers.MapPost("/{driverId}/claim", async (string driverId, ClaimDriverRequest request, IDriverLocationStore store) =>
    await store.TryClaimAsync(driverId, request.RideId!.Value) switch
    {
        ClaimResult.Claimed => Results.Ok(new MessageResponse("Driver claimed")),
        ClaimResult.AlreadyBusy => Results.Conflict(new MessageResponse($"Driver '{driverId}' is already on a ride")),
        _ => Results.NotFound(new MessageResponse($"Driver '{driverId}' is not online"))
    })
.WithName("ClaimDriver");

drivers.MapPost("/{driverId}/release", async (string driverId, ClaimDriverRequest request, IDriverLocationStore store) =>
    TypedResults.Ok(new { released = await store.ReleaseAsync(driverId, request.RideId!.Value) }))
.WithName("ReleaseDriver");

app.Run();

/// <summary>Frees the driver once a ride completes or is cancelled.</summary>
internal sealed class RideFinishedConsumer(
    IConsumer<string, byte[]> consumer,
    IEventPublisher publisher,
    IServiceScopeFactory scopeFactory,
    ILogger<RideFinishedConsumer> logger)
    : KafkaConsumerWorker(consumer, publisher, scopeFactory, logger)
{
    protected override IReadOnlyCollection<string> SubscribedTopics => [Topics.RideFinished];

    protected override async Task HandleAsync(ConsumeResult<string, byte[]> message, IServiceProvider services, CancellationToken cancellationToken)
    {
        var @event = KafkaJson.Deserialize<RideFinishedEvent>(message.Message.Value);
        await services.GetRequiredService<IDriverLocationStore>().ReleaseAsync(@event.DriverId, @event.RideId);
    }
}
