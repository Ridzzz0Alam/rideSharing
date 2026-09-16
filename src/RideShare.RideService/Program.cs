using System.Text.Json;
using System.Text.Json.Serialization;
using Confluent.Kafka;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using RideShare.Messaging;
using RideShare.Messaging.Kafka;
using RideShare.RideService.Application;
using RideShare.RideService.Data;
using RideShare.RideService.Domain;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddNpgsqlDbContext<RideDbContext>("ridedb");

// Schema must exist before the Kafka consumer starts handling events.
builder.Services.AddHostedService<DatabaseInitializer>();
builder.AddRideShareMessaging(consumerGroupId: "ride-service-group");
builder.Services.AddHostedService<RideEventsConsumer>();

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(builder.Configuration.GetSection("Fare").Get<FareOptions>() ?? new FareOptions());
builder.Services.AddSingleton<FareCalculator>();
builder.Services.AddScoped<RideApplicationService>();
builder.Services.AddSingleton<IRideNotifier, SignalRRideNotifier>();

// Enum values serialize as RIDE_STARTED etc., matching the Java API.
var enumConverter = new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseUpper);
builder.Services.ConfigureHttpJsonOptions(options => options.SerializerOptions.Converters.Add(enumConverter));
builder.Services.AddSignalR()
    .AddJsonProtocol(options => options.PayloadSerializerOptions.Converters.Add(enumConverter));

builder.Services.AddOpenApi();
builder.Services.AddValidation();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<RideExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();
app.MapOpenApi();
app.MapDefaultEndpoints();

var rides = app.MapGroup("/api/v1/rides").WithTags("Rides");

rides.MapPost("/request", async (RideRequest request, RideApplicationService service, CancellationToken ct) =>
{
    var ride = await service.RequestRideAsync(request, ct);
    return TypedResults.Created($"/api/v1/rides/{ride.Id}", ride);
})
.WithName("RequestRide");

// New: lets the UI show the price before the rider commits.
rides.MapPost("/estimate", (FareEstimateRequest request, RideApplicationService service) =>
    TypedResults.Ok(service.Estimate(request)))
.WithName("EstimateFare");

rides.MapGet("/{rideId:guid}", async (Guid rideId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.GetAsync(rideId, ct)))
.WithName("GetRide");

rides.MapGet("/rider/{riderId}", async (string riderId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.GetByRiderAsync(riderId, ct)))
.WithName("GetRidesByRider");

// New: the driver app needs its assigned rides.
rides.MapGet("/driver/{driverId}", async (string driverId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.GetByDriverAsync(driverId, ct)))
.WithName("GetRidesByDriver");

// New: DRIVER_ARRIVING existed in the Java enum but nothing ever set it.
rides.MapPut("/{rideId:guid}/arriving", async (Guid rideId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.MarkDriverArrivingAsync(rideId, ct)))
.WithName("MarkDriverArriving");

rides.MapPut("/{rideId:guid}/start", async (Guid rideId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.StartAsync(rideId, ct)))
.WithName("StartRide");

rides.MapPut("/{rideId:guid}/complete", async (Guid rideId, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.CompleteAsync(rideId, ct)))
.WithName("CompleteRide");

rides.MapPut("/{rideId:guid}/cancel", async (Guid rideId, string? reason, RideApplicationService service, CancellationToken ct) =>
    TypedResults.Ok(await service.CancelAsync(rideId, reason, ct)))
.WithName("CancelRide");

app.MapHub<RideHub>("/hubs/rides");

app.Run();

/// <summary>
/// Port of GlobalExceptionHandler.java, returning RFC 9457 problem details.
/// "Not found" is now a 404 and invalid transitions a 409 (the Java version returned 400 for everything).
/// Validation errors are produced automatically by AddValidation().
/// </summary>
internal sealed class RideExceptionHandler(IProblemDetailsService problemDetails, ILogger<RideExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        var (status, title) = exception switch
        {
            RideNotFoundException => (StatusCodes.Status404NotFound, "Ride not found"),
            InvalidRideStateException => (StatusCodes.Status409Conflict, "Invalid ride state"),
            DbUpdateConcurrencyException => (StatusCodes.Status409Conflict, "Ride was changed by another request"),
            RideDispatchException => (StatusCodes.Status503ServiceUnavailable, "Dispatch unavailable"),
            _ => (0, string.Empty)
        };

        if (status == 0)
        {
            return false;
        }

        logger.LogWarning("{Title}: {Message}", title, exception.Message);
        httpContext.Response.StatusCode = status;

        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = status,
                Title = title,
                Detail = exception.Message
            }
        });
    }
}

/// <summary>Port of RideEventConsumer.java — now also handles "no driver found".</summary>
internal sealed class RideEventsConsumer(
    IConsumer<string, byte[]> consumer,
    IEventPublisher publisher,
    IServiceScopeFactory scopeFactory,
    ILogger<RideEventsConsumer> logger)
    : KafkaConsumerWorker(consumer, publisher, scopeFactory, logger)
{
    protected override IReadOnlyCollection<string> SubscribedTopics => [Topics.RideMatched, Topics.RideMatchFailed];

    protected override Task HandleAsync(ConsumeResult<string, byte[]> message, IServiceProvider services, CancellationToken cancellationToken)
    {
        var rides = services.GetRequiredService<RideApplicationService>();

        return message.Topic switch
        {
            Topics.RideMatched => rides.AssignDriverAsync(
                KafkaJson.Deserialize<RideMatchedEvent>(message.Message.Value), cancellationToken),
            Topics.RideMatchFailed => rides.MarkNoDriverFoundAsync(
                KafkaJson.Deserialize<RideMatchFailedEvent>(message.Message.Value), cancellationToken),
            _ => Task.CompletedTask
        };
    }
}
