namespace RideShare.Messaging;

/// <summary>Kafka topic names used across the platform.</summary>
public static class Topics
{
    /// <summary>Ride Service → Matching Service. A rider asked for a ride.</summary>
    public const string RideRequested = "ride.requested";

    /// <summary>Matching Service → Ride Service. A driver was claimed for the ride.</summary>
    public const string RideMatched = "ride.matched";

    /// <summary>Matching Service → Ride Service. No driver could be found (new; the Java version only logged this).</summary>
    public const string RideMatchFailed = "ride.match-failed";

    /// <summary>Ride Service → Location Service. Ride ended, so the driver becomes available again (new).</summary>
    public const string RideFinished = "ride.finished";

    public const int Partitions = 3;

    public static string DeadLetter(string topic) => $"{topic}.dlq";

    public static IReadOnlyList<string> All { get; } =
    [
        RideRequested, RideMatched, RideMatchFailed, RideFinished,
        DeadLetter(RideRequested), DeadLetter(RideMatched), DeadLetter(RideMatchFailed), DeadLetter(RideFinished)
    ];
}

public sealed record RideRequestedEvent(
    Guid RideId,
    string RiderId,
    double PickupLatitude,
    double PickupLongitude,
    string PickupAddress,
    double DropLatitude,
    double DropLongitude,
    string DropAddress);

public sealed record RideMatchedEvent(
    Guid RideId,
    string RiderId,
    string DriverId,
    double DriverLatitude,
    double DriverLongitude,
    double DistanceToPickupKm);

public sealed record RideMatchFailedEvent(
    Guid RideId,
    string RiderId,
    string Reason);

public sealed record RideFinishedEvent(
    Guid RideId,
    string DriverId,
    string FinalStatus);
