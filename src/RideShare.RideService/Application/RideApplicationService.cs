using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using RideShare.Messaging;
using RideShare.Messaging.Kafka;
using RideShare.RideService.Data;
using RideShare.RideService.Domain;

namespace RideShare.RideService.Application;

// ───────────────────────────── DTOs ─────────────────────────────

public sealed record RideRequest(
    [Required, StringLength(64, MinimumLength = 1)] string RiderId,
    [Required, Range(-90, 90)] double? PickupLatitude,
    [Required, Range(-180, 180)] double? PickupLongitude,
    [Required, StringLength(512, MinimumLength = 1)] string PickupAddress,
    [Required, Range(-90, 90)] double? DropLatitude,
    [Required, Range(-180, 180)] double? DropLongitude,
    [Required, StringLength(512, MinimumLength = 1)] string DropAddress);

public sealed record FareEstimateRequest(
    [Required, Range(-90, 90)] double? PickupLatitude,
    [Required, Range(-180, 180)] double? PickupLongitude,
    [Required, Range(-90, 90)] double? DropLatitude,
    [Required, Range(-180, 180)] double? DropLongitude);

public sealed record FareEstimateResponse(double DistanceKm, decimal EstimatedFare);

public sealed record RideResponse(
    Guid Id,
    string RiderId,
    string? DriverId,
    double PickupLatitude,
    double PickupLongitude,
    string PickupAddress,
    double DropLatitude,
    double DropLongitude,
    string DropAddress,
    RideStatus Status,
    decimal EstimatedFare,
    decimal? ActualFare,
    string? CancellationReason,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    DateTimeOffset? CancelledAt)
{
    public static RideResponse From(Ride ride) => new(
        ride.Id, ride.RiderId, ride.DriverId,
        ride.PickupLatitude, ride.PickupLongitude, ride.PickupAddress,
        ride.DropLatitude, ride.DropLongitude, ride.DropAddress,
        ride.Status, ride.EstimatedFare, ride.ActualFare, ride.CancellationReason,
        ride.CreatedAt, ride.UpdatedAt, ride.StartedAt, ride.CompletedAt, ride.CancelledAt);
}

public sealed class RideDispatchException(string message, Exception inner) : Exception(message, inner);

// ─────────────────────── Real-time updates ───────────────────────

public interface IRideHubClient
{
    Task RideUpdated(RideResponse ride);
}

/// <summary>
/// New: pushes ride status to the browser so the frontend does not have to poll
/// <c>GET /rides/{id}</c> like the README's manual flow did.
/// </summary>
public sealed class RideHub : Hub<IRideHubClient>
{
    public Task SubscribeToRide(Guid rideId) => Groups.AddToGroupAsync(Context.ConnectionId, RideGroups.Ride(rideId));
    public Task UnsubscribeFromRide(Guid rideId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, RideGroups.Ride(rideId));

    public Task SubscribeToRider(string riderId) => Groups.AddToGroupAsync(Context.ConnectionId, RideGroups.Rider(riderId));
    public Task UnsubscribeFromRider(string riderId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, RideGroups.Rider(riderId));

    public Task SubscribeToDriver(string driverId) => Groups.AddToGroupAsync(Context.ConnectionId, RideGroups.Driver(driverId));
    public Task UnsubscribeFromDriver(string driverId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, RideGroups.Driver(driverId));
}

public static class RideGroups
{
    public static string Ride(Guid rideId) => $"ride:{rideId}";
    public static string Rider(string riderId) => $"rider:{riderId}";
    public static string Driver(string driverId) => $"driver:{driverId}";
}

public interface IRideNotifier
{
    Task RideChangedAsync(RideResponse ride, CancellationToken cancellationToken = default);
}

internal sealed class SignalRRideNotifier(IHubContext<RideHub, IRideHubClient> hub, ILogger<SignalRRideNotifier> logger)
    : IRideNotifier
{
    public async Task RideChangedAsync(RideResponse ride, CancellationToken cancellationToken = default)
    {
        List<string> groups = [RideGroups.Ride(ride.Id), RideGroups.Rider(ride.RiderId)];
        if (ride.DriverId is not null)
        {
            groups.Add(RideGroups.Driver(ride.DriverId));
        }

        try
        {
            await hub.Clients.Groups(groups).RideUpdated(ride);
        }
        catch (Exception ex)
        {
            // A push failure must never fail the business operation.
            logger.LogWarning(ex, "Failed to push update for ride {RideId}", ride.Id);
        }
    }
}

// ─────────────────────── Application service ───────────────────────

/// <summary>Port of RideService.java.</summary>
public sealed class RideApplicationService(
    RideDbContext db,
    IEventPublisher events,
    IRideNotifier notifier,
    FareCalculator fares,
    TimeProvider clock,
    ILogger<RideApplicationService> logger)
{
    public FareEstimateResponse Estimate(FareEstimateRequest request)
    {
        var (pLat, pLon, dLat, dLon) = (request.PickupLatitude!.Value, request.PickupLongitude!.Value, request.DropLatitude!.Value, request.DropLongitude!.Value);
        return new FareEstimateResponse(
            Math.Round(FareCalculator.DistanceKm(pLat, pLon, dLat, dLon), 2),
            fares.Estimate(pLat, pLon, dLat, dLon));
    }

    public async Task<RideResponse> RequestRideAsync(RideRequest request, CancellationToken cancellationToken)
    {
        logger.LogInformation("New ride request from rider {RiderId}", request.RiderId);
        var now = clock.GetUtcNow();

        var ride = Ride.Request(
            request.RiderId.Trim(),
            request.PickupLatitude!.Value, request.PickupLongitude!.Value, request.PickupAddress.Trim(),
            request.DropLatitude!.Value, request.DropLongitude!.Value, request.DropAddress.Trim(),
            fares.Estimate(request.PickupLatitude.Value, request.PickupLongitude.Value, request.DropLatitude.Value, request.DropLongitude.Value),
            now);

        // Persist as MATCHING before publishing so a fast matcher can never be overwritten.
        ride.BeginMatching(now);
        db.Rides.Add(ride);
        await db.SaveChangesAsync(cancellationToken);

        var @event = new RideRequestedEvent(
            ride.Id, ride.RiderId,
            ride.PickupLatitude, ride.PickupLongitude, ride.PickupAddress,
            ride.DropLatitude, ride.DropLongitude, ride.DropAddress);

        try
        {
            await events.PublishAsync(Topics.RideRequested, ride.Id.ToString(), @event, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // No dangling MATCHING rides: record why and surface a 503.
            ride.Cancel("Dispatch is temporarily unavailable", clock.GetUtcNow());
            await db.SaveChangesAsync(CancellationToken.None);
            throw new RideDispatchException("Could not dispatch the ride request. Try again shortly.", ex);
        }

        var response = RideResponse.From(ride);
        await notifier.RideChangedAsync(response, cancellationToken);
        return response;
    }

    public async Task<RideResponse> GetAsync(Guid rideId, CancellationToken cancellationToken) =>
        RideResponse.From(await FindAsync(rideId, cancellationToken, tracking: false));

    public async Task<IReadOnlyList<RideResponse>> GetByRiderAsync(string riderId, CancellationToken cancellationToken) =>
        await db.Rides.AsNoTracking()
            .Where(r => r.RiderId == riderId)
            .OrderByDescending(r => r.CreatedAt)
            .Take(100)
            .Select(r => RideResponse.From(r))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyList<RideResponse>> GetByDriverAsync(string driverId, CancellationToken cancellationToken) =>
        await db.Rides.AsNoTracking()
            .Where(r => r.DriverId == driverId)
            .OrderByDescending(r => r.CreatedAt)
            .Take(100)
            .Select(r => RideResponse.From(r))
            .ToListAsync(cancellationToken);

    public Task<RideResponse> MarkDriverArrivingAsync(Guid rideId, CancellationToken cancellationToken) =>
        TransitionAsync(rideId, (ride, now) => ride.MarkDriverArriving(now), cancellationToken);

    public Task<RideResponse> StartAsync(Guid rideId, CancellationToken cancellationToken) =>
        TransitionAsync(rideId, (ride, now) => ride.Start(now), cancellationToken);

    public Task<RideResponse> CompleteAsync(Guid rideId, CancellationToken cancellationToken) =>
        TransitionAsync(rideId, (ride, now) => ride.Complete(now), cancellationToken);

    public Task<RideResponse> CancelAsync(Guid rideId, string? reason, CancellationToken cancellationToken) =>
        TransitionAsync(rideId, (ride, now) => ride.Cancel(reason, now), cancellationToken);

    /// <summary>Handles <see cref="RideMatchedEvent"/>.</summary>
    public async Task AssignDriverAsync(RideMatchedEvent @event, CancellationToken cancellationToken)
    {
        var ride = await FindAsync(@event.RideId, cancellationToken);

        var alreadyTakenByAnotherDriver = ride.DriverId is not null && ride.DriverId != @event.DriverId;
        if (ride.IsTerminal || alreadyTakenByAnotherDriver)
        {
            // Rider cancelled while we were matching (or a stale event): give the driver back.
            logger.LogInformation("Ride {RideId} is {Status}; releasing driver {DriverId}", ride.Id, ride.Status, @event.DriverId);
            await PublishFinishedAsync(ride.Id, @event.DriverId, ride.Status, cancellationToken);
            return;
        }

        if (!ride.AssignDriver(@event.DriverId, clock.GetUtcNow()))
        {
            logger.LogInformation("Duplicate match event for ride {RideId}; ignoring", ride.Id);
            return;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Driver {DriverId} assigned to ride {RideId} ({Distance:F2} km away)",
            @event.DriverId, ride.Id, @event.DistanceToPickupKm);
        await notifier.RideChangedAsync(RideResponse.From(ride), cancellationToken);
    }

    /// <summary>Handles <see cref="RideMatchFailedEvent"/>.</summary>
    public async Task MarkNoDriverFoundAsync(RideMatchFailedEvent @event, CancellationToken cancellationToken)
    {
        var ride = await FindAsync(@event.RideId, cancellationToken);
        if (!ride.MarkNoDriverFound(@event.Reason, clock.GetUtcNow()))
        {
            return;
        }

        await db.SaveChangesAsync(cancellationToken);
        await notifier.RideChangedAsync(RideResponse.From(ride), cancellationToken);
    }

    private async Task<RideResponse> TransitionAsync(Guid rideId, Action<Ride, DateTimeOffset> transition, CancellationToken cancellationToken)
    {
        var ride = await FindAsync(rideId, cancellationToken);
        transition(ride, clock.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);

        if (ride.IsTerminal && ride.DriverId is not null)
        {
            await PublishFinishedAsync(ride.Id, ride.DriverId, ride.Status, cancellationToken);
        }

        var response = RideResponse.From(ride);
        await notifier.RideChangedAsync(response, cancellationToken);
        return response;
    }

    private async Task PublishFinishedAsync(Guid rideId, string driverId, RideStatus status, CancellationToken cancellationToken)
    {
        try
        {
            await events.PublishAsync(Topics.RideFinished, rideId.ToString(),
                new RideFinishedEvent(rideId, driverId, status.ToString()), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The ride state is already committed. In production use a transactional outbox here.
            logger.LogError(ex, "Failed to publish RideFinished for ride {RideId}; driver {DriverId} may stay busy", rideId, driverId);
        }
    }

    private async Task<Ride> FindAsync(Guid rideId, CancellationToken cancellationToken, bool tracking = true)
    {
        var query = tracking ? db.Rides : db.Rides.AsNoTracking();
        return await query.FirstOrDefaultAsync(r => r.Id == rideId, cancellationToken)
               ?? throw new RideNotFoundException(rideId);
    }
}
