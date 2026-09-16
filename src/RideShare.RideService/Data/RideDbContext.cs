using Microsoft.EntityFrameworkCore;
using RideShare.RideService.Domain;

namespace RideShare.RideService.Data;

public sealed class RideDbContext(DbContextOptions<RideDbContext> options) : DbContext(options)
{
    public DbSet<Ride> Rides => Set<Ride>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var ride = modelBuilder.Entity<Ride>();

        ride.ToTable("rides");
        ride.HasKey(r => r.Id);
        ride.Property(r => r.Id).ValueGeneratedNever();

        ride.Property(r => r.RiderId).HasMaxLength(64).IsRequired();
        ride.Property(r => r.DriverId).HasMaxLength(64);
        ride.Property(r => r.PickupAddress).HasMaxLength(512).IsRequired();
        ride.Property(r => r.DropAddress).HasMaxLength(512).IsRequired();
        ride.Property(r => r.CancellationReason).HasMaxLength(256);

        ride.Property(r => r.Status).HasConversion<string>().HasMaxLength(32).IsRequired();
        ride.Property(r => r.EstimatedFare).HasPrecision(10, 2);
        ride.Property(r => r.ActualFare).HasPrecision(10, 2);

        // Npgsql maps a uint row version to the PostgreSQL xmin system column.
        ride.Property(r => r.Version).IsRowVersion();

        ride.Ignore(r => r.IsTerminal);

        ride.HasIndex(r => new { r.RiderId, r.CreatedAt });
        ride.HasIndex(r => new { r.DriverId, r.CreatedAt });
    }
}

/// <summary>
/// Creates the schema on startup (the Java app used <c>ddl-auto: update</c>).
/// For production, switch to EF Core migrations: <c>dotnet ef migrations add Initial</c>.
/// </summary>
internal sealed class DatabaseInitializer(IServiceScopeFactory scopeFactory, ILogger<DatabaseInitializer> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<RideDbContext>();
                await db.Database.EnsureCreatedAsync(cancellationToken);
                logger.LogInformation("Ride database ready");
                return;
            }
            catch (Exception ex) when (attempt < 30 && ex is not OperationCanceledException)
            {
                logger.LogWarning("Database not ready ({Message}); retry {Attempt}/30", ex.Message, attempt);
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
