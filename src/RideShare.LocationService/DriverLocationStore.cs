using System.ComponentModel.DataAnnotations;
using StackExchange.Redis;

namespace RideShare.LocationService;

public sealed record DriverLocationRequest(
    [Required, StringLength(64, MinimumLength = 1)] string DriverId,
    [Range(-90, 90)] double Latitude,
    [Range(-180, 180)] double Longitude);

public sealed record NearbyDriverResponse(string DriverId, double Latitude, double Longitude, double DistanceInKm);

public sealed record DriverSnapshot(string DriverId, double Latitude, double Longitude, bool Busy, Guid? CurrentRideId);

public sealed record ClaimDriverRequest([Required] Guid? RideId);

public sealed record MessageResponse(string Message);

public enum ClaimResult { Claimed, AlreadyBusy, UnknownDriver }

public sealed class LocationOptions
{
    public int MaxNearbyResults { get; set; } = 10;
}

public interface IDriverLocationStore
{
    Task UpsertAsync(string driverId, double latitude, double longitude);
    Task<IReadOnlyList<NearbyDriverResponse>> FindNearbyAsync(double latitude, double longitude, double radiusKm, int limit);
    Task<IReadOnlyList<DriverSnapshot>> GetAllAsync();
    Task<bool> RemoveAsync(string driverId);
    Task<ClaimResult> TryClaimAsync(string driverId, Guid rideId);
    Task<bool> ReleaseAsync(string driverId, Guid rideId);
}

/// <summary>
/// Redis-backed driver positions (port of LocationService.java).
/// <list type="bullet">
/// <item><c>drivers:locations</c> — GEO set (GEOADD / GEOSEARCH / ZREM)</item>
/// <item><c>drivers:busy</c> — hash driverId → rideId. New: stops one driver being matched to two rides.</item>
/// </list>
/// </summary>
public sealed class RedisDriverLocationStore(IConnectionMultiplexer redis, ILogger<RedisDriverLocationStore> logger)
    : IDriverLocationStore
{
    private const string GeoKey = "drivers:locations";
    private const string BusyKey = "drivers:busy";

    // Compare-and-delete: only free the driver if they are still on *this* ride.
    private const string ReleaseScript = """
        if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
          return redis.call('HDEL', KEYS[1], ARGV[1])
        end
        return 0
        """;

    private IDatabase Db => redis.GetDatabase();

    public async Task UpsertAsync(string driverId, double latitude, double longitude)
    {
        // GEOADD takes longitude first, latitude second.
        await Db.GeoAddAsync(GeoKey, longitude, latitude, driverId);
        logger.LogDebug("Location updated for driver {DriverId}", driverId);
    }

    public async Task<IReadOnlyList<NearbyDriverResponse>> FindNearbyAsync(double latitude, double longitude, double radiusKm, int limit)
    {
        // Over-fetch so that filtering out busy drivers still leaves up to `limit` results.
        var results = await Db.GeoSearchAsync(
            GeoKey,
            longitude,
            latitude,
            new GeoSearchCircle(radiusKm, GeoUnit.Kilometers),
            count: limit * 5,
            demandClosest: true,
            order: Order.Ascending,
            options: GeoRadiusOptions.WithCoordinates | GeoRadiusOptions.WithDistance);

        if (results.Length == 0)
        {
            return [];
        }

        var busy = await Db.HashGetAsync(BusyKey, results.Select(r => r.Member).ToArray());

        var nearby = results
            .Where((result, index) => busy[index].IsNull && result.Position.HasValue)
            .Take(limit)
            .Select(result => new NearbyDriverResponse(
                result.Member.ToString(),
                result.Position!.Value.Latitude,
                result.Position.Value.Longitude,
                Math.Round(result.Distance ?? 0, 4)))
            .ToList();

        logger.LogInformation("Found {Count} available drivers within {Radius} km of ({Lat}, {Lon})",
            nearby.Count, radiusKm, latitude, longitude);
        return nearby;
    }

    public async Task<IReadOnlyList<DriverSnapshot>> GetAllAsync()
    {
        var members = await Db.SortedSetRangeByRankAsync(GeoKey);
        if (members.Length == 0)
        {
            return [];
        }

        var positions = await Db.GeoPositionAsync(GeoKey, members);
        var rides = await Db.HashGetAsync(BusyKey, members);

        var snapshots = new List<DriverSnapshot>(members.Length);
        for (var i = 0; i < members.Length; i++)
        {
            if (positions[i] is not { } position)
            {
                continue;
            }

            Guid? rideId = Guid.TryParse(rides[i].ToString(), out var parsed) ? parsed : null;
            snapshots.Add(new DriverSnapshot(members[i].ToString(), position.Latitude, position.Longitude, !rides[i].IsNull, rideId));
        }

        return snapshots;
    }

    public async Task<bool> RemoveAsync(string driverId)
    {
        // Busy state is intentionally kept: a driver who drops offline mid-ride is still on that ride.
        var removed = await Db.GeoRemoveAsync(GeoKey, driverId);
        logger.LogInformation("Driver {DriverId} went offline (removed: {Removed})", driverId, removed);
        return removed;
    }

    public async Task<ClaimResult> TryClaimAsync(string driverId, Guid rideId)
    {
        var position = await Db.GeoPositionAsync(GeoKey, driverId);
        if (position is null)
        {
            return ClaimResult.UnknownDriver;
        }

        var ride = rideId.ToString();
        if (await Db.HashSetAsync(BusyKey, driverId, ride, When.NotExists))
        {
            logger.LogInformation("Driver {DriverId} claimed for ride {RideId}", driverId, rideId);
            return ClaimResult.Claimed;
        }

        // Idempotent: a retried claim for the same ride still succeeds.
        var current = await Db.HashGetAsync(BusyKey, driverId);
        return current == ride ? ClaimResult.Claimed : ClaimResult.AlreadyBusy;
    }

    public async Task<bool> ReleaseAsync(string driverId, Guid rideId)
    {
        var result = await Db.ScriptEvaluateAsync(ReleaseScript, [BusyKey], [driverId, rideId.ToString()]);
        var released = (long)result == 1;
        logger.LogInformation("Release driver {DriverId} from ride {RideId}: {Released}", driverId, rideId, released);
        return released;
    }
}
