using System.Threading.RateLimiting;

// Single entry point for the frontend (new — the Java version had no gateway,
// so a browser would have had to call three ports and deal with CORS on each).
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddServiceDiscoveryDestinationResolver();

var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
{
    if (builder.Environment.IsDevelopment())
    {
        // Any localhost port: Aspire assigns the Next.js port dynamically.
        policy.SetIsOriginAllowed(origin => Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.IsLoopback);
    }
    else
    {
        policy.WithOrigins(allowedOrigins);
    }

    // SignalR sends credentials, so origins must be explicit (no "*").
    policy.AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

// Driver phones ping often; keep one client from flooding the platform.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = 600, Window = TimeSpan.FromMinutes(1) }));
});

var app = builder.Build();

app.UseCors();
app.UseRateLimiter();
app.UseWebSockets();

app.MapDefaultEndpoints();
app.MapGet("/", () => Results.Ok(new
{
    service = "RideShare gateway",
    routes = new[] { "/api/v1/locations/**", "/api/v1/rides/**", "/hubs/rides" }
}));
app.MapReverseProxy();

app.Run();
