using System.Globalization;
using System.Net;
using Confluent.Kafka;
using Microsoft.Extensions.Options;
using RideShare.MatchingService;
using RideShare.Messaging;
using RideShare.Messaging.Kafka;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.AddRideShareMessaging(consumerGroupId: "matching-service-group");

builder.Services.Configure<MatchingOptions>(builder.Configuration.GetSection("Matching"));

// Replaces the OpenFeign client. "https+http://" = service discovery, prefer HTTPS.
builder.Services.AddHttpClient<LocationServiceClient>(client =>
    client.BaseAddress = new Uri("https+http://location-service"));

builder.Services.AddSingleton<IDriverRatingProvider, SimulatedDriverRatingProvider>();
builder.Services.AddSingleton<DriverScorer>();
builder.Services.AddScoped<DriverMatcher>();
builder.Services.AddHostedService<RideRequestedConsumer>();

var app = builder.Build();
app.MapDefaultEndpoints();
app.MapGet("/", () => "Matching service is running. It consumes ride.requested from Kafka.");
app.Run();

namespace RideShare.MatchingService
{
    public sealed class MatchingOptions
    {
        public double SearchRadiusKm { get; set; } = 5.0;
        public double DistanceWeight { get; set; } = 0.7;
        public double RatingWeight { get; set; } = 0.3;
    }

    public sealed record NearbyDriver(string DriverId, double Latitude, double Longitude, double DistanceInKm);

    public sealed record ScoredDriver(NearbyDriver Driver, double Rating, double Score);

    /// <summary>Typed HTTP client for the Location Service (was a @FeignClient).</summary>
    public sealed class LocationServiceClient(HttpClient http)
    {
        public async Task<IReadOnlyList<NearbyDriver>> GetNearbyDriversAsync(
            double latitude, double longitude, double radiusKm, CancellationToken cancellationToken)
        {
            // Invariant culture: a comma decimal separator (e.g. hu-HU) would break the query string.
            var url = string.Create(CultureInfo.InvariantCulture,
                $"/api/v1/locations/drivers/nearby?latitude={latitude}&longitude={longitude}&radius={radiusKm}");

            return await http.GetFromJsonAsync<List<NearbyDriver>>(url, cancellationToken) ?? [];
        }

        /// <summary>Atomically reserves the driver. False if someone else got them first.</summary>
        public async Task<bool> TryClaimAsync(string driverId, Guid rideId, CancellationToken cancellationToken)
        {
            using var response = await http.PostAsJsonAsync(
                $"/api/v1/locations/drivers/{Uri.EscapeDataString(driverId)}/claim",
                new { rideId },
                cancellationToken);

            if (response.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.NotFound)
            {
                return false;
            }

            response.EnsureSuccessStatusCode();
            return true;
        }
    }

    public interface IDriverRatingProvider
    {
        double GetRating(string driverId);
    }

    /// <summary>
    /// Simulated rating in [4.0, 5.0). The Java version used Math.random() on every comparison,
    /// which made the ranking non-deterministic; this derives a stable rating from the driver id.
    /// In production, fetch this from a Driver Service.
    /// </summary>
    public sealed class SimulatedDriverRatingProvider : IDriverRatingProvider
    {
        public double GetRating(string driverId)
        {
            // FNV-1a: string.GetHashCode() is randomized per process, so it can't be used here.
            var hash = 2166136261u;
            foreach (var c in driverId)
            {
                hash = (hash ^ c) * 16777619u;
            }

            return Math.Round(4.0 + hash % 1000 / 1000.0, 2);
        }
    }

    /// <summary>
    /// Score = (1 / (distance + 0.1)) × distanceWeight + rating × ratingWeight.
    /// Same weights as MatchingService.java (70% distance, 30% rating).
    /// </summary>
    public sealed class DriverScorer(IDriverRatingProvider ratings, IOptions<MatchingOptions> options)
    {
        public IReadOnlyList<ScoredDriver> Rank(IEnumerable<NearbyDriver> drivers)
        {
            var weights = options.Value;
            return drivers
                .Select(driver =>
                {
                    var rating = ratings.GetRating(driver.DriverId);
                    var distanceScore = 1.0 / (driver.DistanceInKm + 0.1); // +0.1 avoids division by zero
                    var score = distanceScore * weights.DistanceWeight + rating * weights.RatingWeight;
                    return new ScoredDriver(driver, rating, score);
                })
                .OrderByDescending(scored => scored.Score)
                .ToList();
        }
    }

    /// <summary>Port of MatchingService.matchDriverForRide.</summary>
    public sealed class DriverMatcher(
        LocationServiceClient locations,
        DriverScorer scorer,
        IEventPublisher events,
        IOptions<MatchingOptions> options,
        ILogger<DriverMatcher> logger)
    {
        public async Task MatchAsync(RideRequestedEvent ride, CancellationToken cancellationToken)
        {
            var radius = options.Value.SearchRadiusKm;

            // 1. Ask the Location Service for available drivers near the pickup.
            var nearby = await locations.GetNearbyDriversAsync(ride.PickupLatitude, ride.PickupLongitude, radius, cancellationToken);
            if (nearby.Count == 0)
            {
                await FailAsync(ride, $"No drivers available within {radius:0.#} km", cancellationToken);
                return;
            }

            // 2. Score, then try to claim drivers best-first until one succeeds.
            foreach (var candidate in scorer.Rank(nearby))
            {
                if (!await locations.TryClaimAsync(candidate.Driver.DriverId, ride.RideId, cancellationToken))
                {
                    logger.LogInformation("Driver {DriverId} was taken; trying next candidate", candidate.Driver.DriverId);
                    continue;
                }

                // 3. Publish the match.
                var matched = new RideMatchedEvent(
                    ride.RideId,
                    ride.RiderId,
                    candidate.Driver.DriverId,
                    candidate.Driver.Latitude,
                    candidate.Driver.Longitude,
                    candidate.Driver.DistanceInKm);

                await events.PublishAsync(Topics.RideMatched, ride.RideId.ToString(), matched, cancellationToken);
                logger.LogInformation(
                    "Ride {RideId} matched to {DriverId} (score {Score:F3}, rating {Rating}, {Distance:F2} km)",
                    ride.RideId, candidate.Driver.DriverId, candidate.Score, candidate.Rating, candidate.Driver.DistanceInKm);
                return;
            }

            await FailAsync(ride, "All nearby drivers are busy", cancellationToken);
        }

        private async Task FailAsync(RideRequestedEvent ride, string reason, CancellationToken cancellationToken)
        {
            logger.LogWarning("Could not match ride {RideId}: {Reason}", ride.RideId, reason);
            await events.PublishAsync(Topics.RideMatchFailed, ride.RideId.ToString(),
                new RideMatchFailedEvent(ride.RideId, ride.RiderId, reason), cancellationToken);
        }
    }

    /// <summary>Port of RideEventConsumer.java (matching side).</summary>
    internal sealed class RideRequestedConsumer(
        IConsumer<string, byte[]> consumer,
        IEventPublisher publisher,
        IServiceScopeFactory scopeFactory,
        ILogger<RideRequestedConsumer> logger)
        : KafkaConsumerWorker(consumer, publisher, scopeFactory, logger)
    {
        protected override IReadOnlyCollection<string> SubscribedTopics => [Topics.RideRequested];

        protected override Task HandleAsync(ConsumeResult<string, byte[]> message, IServiceProvider services, CancellationToken cancellationToken) =>
            services.GetRequiredService<DriverMatcher>()
                .MatchAsync(KafkaJson.Deserialize<RideRequestedEvent>(message.Message.Value), cancellationToken);
    }
}
