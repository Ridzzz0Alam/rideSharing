using RideShare.RideService.Domain;

namespace RideShare.Tests;

public class FareCalculatorTests
{
    [Fact]
    public void Estimate_matches_the_java_formula_for_the_readme_route()
    {
        // MG Road → Koramangala, ≈5.18 km → 50 + 5.18 × 12
        var fare = new FareCalculator(new FareOptions()).Estimate(12.9716, 77.5946, 12.9352, 77.6245);

        Assert.Equal(112.22m, fare);
    }

    [Fact]
    public void Same_pickup_and_drop_costs_the_base_fare()
    {
        var fare = new FareCalculator(new FareOptions { BaseFare = 40, PerKm = 10 }).Estimate(1, 1, 1, 1);

        Assert.Equal(40m, fare);
    }
}

public class RideStateMachineTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 16, 12, 0, 0, TimeSpan.Zero);

    private static Ride NewMatchingRide()
    {
        var ride = Ride.Request("rider:1", 12.97, 77.59, "A", 12.93, 77.62, "B", 100m, Now);
        ride.BeginMatching(Now);
        return ride;
    }

    [Fact]
    public void Happy_path_reaches_completed_and_sets_actual_fare()
    {
        var ride = NewMatchingRide();

        Assert.True(ride.AssignDriver("driver:1", Now));
        ride.MarkDriverArriving(Now);
        ride.Start(Now);
        ride.Complete(Now);

        Assert.Equal(RideStatus.Completed, ride.Status);
        Assert.Equal(100m, ride.ActualFare);
        Assert.NotNull(ride.StartedAt);
        Assert.NotNull(ride.CompletedAt);
    }

    [Fact]
    public void Start_is_allowed_directly_from_accepted()
    {
        var ride = NewMatchingRide();
        ride.AssignDriver("driver:1", Now);

        ride.Start(Now);

        Assert.Equal(RideStatus.RideStarted, ride.Status);
    }

    [Fact]
    public void Duplicate_match_event_is_ignored()
    {
        var ride = NewMatchingRide();
        ride.AssignDriver("driver:1", Now);

        Assert.False(ride.AssignDriver("driver:1", Now));
        Assert.Equal(RideStatus.Accepted, ride.Status);
    }

    [Fact]
    public void Cannot_start_a_ride_that_has_no_driver()
    {
        var ride = NewMatchingRide();

        Assert.Throws<InvalidRideStateException>(() => ride.Start(Now));
    }

    [Fact]
    public void Cannot_complete_before_starting()
    {
        var ride = NewMatchingRide();
        ride.AssignDriver("driver:1", Now);

        Assert.Throws<InvalidRideStateException>(() => ride.Complete(Now));
    }

    [Fact]
    public void Completed_ride_cannot_be_cancelled()
    {
        var ride = NewMatchingRide();
        ride.AssignDriver("driver:1", Now);
        ride.Start(Now);
        ride.Complete(Now);

        Assert.Throws<InvalidRideStateException>(() => ride.Cancel(null, Now));
    }

    [Fact]
    public void No_driver_found_cancels_a_matching_ride_with_reason()
    {
        var ride = NewMatchingRide();

        Assert.True(ride.MarkNoDriverFound("No drivers available within 5 km", Now));
        Assert.Equal(RideStatus.Cancelled, ride.Status);
        Assert.Equal("No drivers available within 5 km", ride.CancellationReason);
    }

    [Fact]
    public void No_driver_found_is_ignored_after_rider_cancelled()
    {
        var ride = NewMatchingRide();
        ride.Cancel("Changed my mind", Now);

        Assert.False(ride.MarkNoDriverFound("No drivers", Now));
        Assert.Equal("Changed my mind", ride.CancellationReason);
    }
}
