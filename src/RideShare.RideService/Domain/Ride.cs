namespace RideShare.RideService.Domain;

/// <summary>
/// REQUESTED → MATCHING → ACCEPTED → DRIVER_ARRIVING → RIDE_STARTED → COMPLETED
/// CANCELLED is reachable from any non-terminal state.
/// </summary>
public enum RideStatus
{
    Requested,
    Matching,
    Accepted,
    DriverArriving,
    RideStarted,
    Completed,
    Cancelled
}

public sealed class RideNotFoundException(Guid rideId)
    : Exception($"Ride '{rideId}' was not found.");

public sealed class InvalidRideStateException(string message) : Exception(message);

/// <summary>
/// Aggregate root. Unlike the Java entity (a bag of setters validated in the service),
/// every transition is guarded here so no caller can put a ride into an impossible state.
/// </summary>
public sealed class Ride
{
    private Ride()
    {
        // Required by EF Core.
    }

    public Guid Id { get; private set; }
    public string RiderId { get; private set; } = null!;
    public string? DriverId { get; private set; }

    public double PickupLatitude { get; private set; }
    public double PickupLongitude { get; private set; }
    public string PickupAddress { get; private set; } = null!;

    public double DropLatitude { get; private set; }
    public double DropLongitude { get; private set; }
    public string DropAddress { get; private set; } = null!;

    public RideStatus Status { get; private set; }
    public decimal EstimatedFare { get; private set; }
    public decimal? ActualFare { get; private set; }
    public string? CancellationReason { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public DateTimeOffset? StartedAt { get; private set; }
    public DateTimeOffset? CompletedAt { get; private set; }
    public DateTimeOffset? CancelledAt { get; private set; }

    /// <summary>Optimistic concurrency token (mapped to PostgreSQL xmin).</summary>
    public uint Version { get; private set; }

    public bool IsTerminal => Status is RideStatus.Completed or RideStatus.Cancelled;

    public static Ride Request(
        string riderId,
        double pickupLatitude, double pickupLongitude, string pickupAddress,
        double dropLatitude, double dropLongitude, string dropAddress,
        decimal estimatedFare,
        DateTimeOffset now) => new()
    {
        Id = Guid.CreateVersion7(now),
        RiderId = riderId,
        PickupLatitude = pickupLatitude,
        PickupLongitude = pickupLongitude,
        PickupAddress = pickupAddress,
        DropLatitude = dropLatitude,
        DropLongitude = dropLongitude,
        DropAddress = dropAddress,
        EstimatedFare = estimatedFare,
        Status = RideStatus.Requested,
        CreatedAt = now,
        UpdatedAt = now
    };

    /// <summary>
    /// Moves to MATCHING. Called *before* the ride is persisted and the event published.
    /// The Java version set MATCHING after publishing, which could overwrite an ACCEPTED
    /// status if the matcher replied quickly.
    /// </summary>
    public void BeginMatching(DateTimeOffset now)
    {
        EnsureStatus(nameof(BeginMatching), RideStatus.Requested);
        Transition(RideStatus.Matching, now);
    }

    /// <summary>Returns false when the event is a duplicate for the same driver (idempotent).</summary>
    public bool AssignDriver(string driverId, DateTimeOffset now)
    {
        if (Status == RideStatus.Accepted && DriverId == driverId)
        {
            return false;
        }

        EnsureStatus(nameof(AssignDriver), RideStatus.Requested, RideStatus.Matching);
        DriverId = driverId;
        Transition(RideStatus.Accepted, now);
        return true;
    }

    public void MarkDriverArriving(DateTimeOffset now)
    {
        EnsureStatus(nameof(MarkDriverArriving), RideStatus.Accepted);
        Transition(RideStatus.DriverArriving, now);
    }

    public void Start(DateTimeOffset now)
    {
        EnsureStatus(nameof(Start), RideStatus.Accepted, RideStatus.DriverArriving);
        StartedAt = now;
        Transition(RideStatus.RideStarted, now);
    }

    public void Complete(DateTimeOffset now)
    {
        EnsureStatus(nameof(Complete), RideStatus.RideStarted);
        CompletedAt = now;
        ActualFare = EstimatedFare;
        Transition(RideStatus.Completed, now);
    }

    public void Cancel(string? reason, DateTimeOffset now)
    {
        if (IsTerminal)
        {
            throw new InvalidRideStateException($"Ride cannot be cancelled. Current status: {Status}");
        }

        CancellationReason = string.IsNullOrWhiteSpace(reason) ? "Cancelled by rider" : reason.Trim();
        CancelledAt = now;
        Transition(RideStatus.Cancelled, now);
    }

    /// <summary>Returns false if the ride had already moved on (e.g. the rider cancelled first).</summary>
    public bool MarkNoDriverFound(string reason, DateTimeOffset now)
    {
        if (Status is not (RideStatus.Requested or RideStatus.Matching))
        {
            return false;
        }

        Cancel(reason, now);
        return true;
    }

    private void Transition(RideStatus next, DateTimeOffset now)
    {
        Status = next;
        UpdatedAt = now;
    }

    private void EnsureStatus(string action, params RideStatus[] allowed)
    {
        if (!allowed.Contains(Status))
        {
            throw new InvalidRideStateException(
                $"Cannot {action} a ride in status {Status}. Allowed: {string.Join(", ", allowed)}.");
        }
    }
}

public sealed class FareOptions
{
    public decimal BaseFare { get; set; } = 50m;
    public decimal PerKm { get; set; } = 12m;
}

/// <summary>Haversine distance + base/per-km fare (same formula as RideService.java).</summary>
public sealed class FareCalculator(FareOptions options)
{
    private const double EarthRadiusKm = 6371.0;

    public static double DistanceKm(double lat1, double lon1, double lat2, double lon2)
    {
        var phi1 = double.DegreesToRadians(lat1);
        var phi2 = double.DegreesToRadians(lat2);
        var dPhi = phi2 - phi1;
        var dLambda = double.DegreesToRadians(lon2 - lon1);

        var a = Math.Pow(Math.Sin(dPhi / 2), 2)
              + Math.Cos(phi1) * Math.Cos(phi2) * Math.Pow(Math.Sin(dLambda / 2), 2);

        return EarthRadiusKm * 2 * Math.Asin(Math.Sqrt(a));
    }

    public decimal Estimate(double pickupLat, double pickupLon, double dropLat, double dropLon)
    {
        var distanceKm = (decimal)DistanceKm(pickupLat, pickupLon, dropLat, dropLon);
        return Math.Round(options.BaseFare + distanceKm * options.PerKm, 2, MidpointRounding.AwayFromZero);
    }
}
