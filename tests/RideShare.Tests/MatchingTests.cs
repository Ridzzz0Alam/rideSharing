using Microsoft.Extensions.Options;
using RideShare.MatchingService;

namespace RideShare.Tests;

public class DriverScorerTests
{
    private sealed class FixedRatings(Dictionary<string, double> ratings) : IDriverRatingProvider
    {
        public double GetRating(string driverId) => ratings[driverId];
    }

    [Fact]
    public void Closer_driver_wins_when_ratings_are_equal()
    {
        var scorer = new DriverScorer(
            new FixedRatings(new() { ["near"] = 4.5, ["far"] = 4.5 }),
            Options.Create(new MatchingOptions()));

        var ranked = scorer.Rank([
            new NearbyDriver("far", 0, 0, 3.0),
            new NearbyDriver("near", 0, 0, 0.5)
        ]);

        Assert.Equal("near", ranked[0].Driver.DriverId);
    }

    [Fact]
    public void Rating_can_outweigh_a_small_distance_difference()
    {
        var scorer = new DriverScorer(
            new FixedRatings(new() { ["a"] = 4.0, ["b"] = 5.0 }),
            Options.Create(new MatchingOptions()));

        // a: 1/(2.0+0.1)*0.7 + 4.0*0.3 = 1.533 ; b: 1/(2.2+0.1)*0.7 + 5.0*0.3 = 1.804
        var ranked = scorer.Rank([
            new NearbyDriver("a", 0, 0, 2.0),
            new NearbyDriver("b", 0, 0, 2.2)
        ]);

        Assert.Equal("b", ranked[0].Driver.DriverId);
    }

    [Theory]
    [InlineData("driver:1", 4.64)]
    [InlineData("driver:2", 4.02)]
    [InlineData("driver:3", 4.40)]
    public void Simulated_rating_is_stable_and_in_range(string driverId, double expected)
    {
        var provider = new SimulatedDriverRatingProvider();

        Assert.Equal(expected, provider.GetRating(driverId), precision: 2);
        Assert.InRange(provider.GetRating(driverId), 4.0, 5.0);
    }
}
