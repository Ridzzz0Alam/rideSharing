using System.Text;
using System.Text.Json;
using Confluent.Kafka;
using Confluent.Kafka.Admin;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace RideShare.Messaging.Kafka;

/// <summary>JSON settings for every Kafka payload (camelCase, same shape Spring's JsonSerializer produced).</summary>
public static class KafkaJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static byte[] Serialize<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);

    public static T Deserialize<T>(byte[] payload) =>
        JsonSerializer.Deserialize<T>(payload, Options)
        ?? throw new InvalidDataException($"Kafka payload deserialized to null for {typeof(T).Name}.");
}

/// <summary>Equivalent of Spring's KafkaTemplate, typed by event.</summary>
public interface IEventPublisher
{
    Task PublishAsync<TEvent>(string topic, string key, TEvent @event, CancellationToken cancellationToken = default);

    Task PublishRawAsync(string topic, string key, byte[] payload, Headers? headers, CancellationToken cancellationToken = default);
}

internal sealed class KafkaEventPublisher(IProducer<string, byte[]> producer, ILogger<KafkaEventPublisher> logger)
    : IEventPublisher
{
    public Task PublishAsync<TEvent>(string topic, string key, TEvent @event, CancellationToken cancellationToken = default)
    {
        var headers = new Headers { { "event-type", Encoding.UTF8.GetBytes(typeof(TEvent).Name) } };
        return PublishRawAsync(topic, key, KafkaJson.Serialize(@event), headers, cancellationToken);
    }

    public async Task PublishRawAsync(string topic, string key, byte[] payload, Headers? headers, CancellationToken cancellationToken = default)
    {
        var result = await producer.ProduceAsync(
            topic,
            new Message<string, byte[]> { Key = key, Value = payload, Headers = headers ?? new Headers() },
            cancellationToken);

        logger.LogInformation("Published message with key {Key} to {TopicPartitionOffset}", key, result.TopicPartitionOffset);
    }
}

/// <summary>
/// Base class for a Kafka consumer loop (the equivalent of <c>@KafkaListener</c>).
/// Delivery is at-least-once: the offset is stored only after the handler finishes.
/// Transient failures are retried; poison messages go to <c>{topic}.dlq</c>
/// (the Java version had a "send to dead letter queue" TODO at this point).
/// </summary>
public abstract class KafkaConsumerWorker(
    IConsumer<string, byte[]> consumer,
    IEventPublisher publisher,
    IServiceScopeFactory scopeFactory,
    ILogger logger) : BackgroundService
{
    private const int MaxAttempts = 3;

    protected abstract IReadOnlyCollection<string> SubscribedTopics { get; }

    /// <summary>Handle one message. A fresh DI scope is created per attempt (DbContext etc.).</summary>
    protected abstract Task HandleAsync(ConsumeResult<string, byte[]> message, IServiceProvider services, CancellationToken cancellationToken);

    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        // Consume() blocks, so run the loop on its own thread instead of a thread-pool thread.
        Task.Factory.StartNew(
            () => RunAsync(stoppingToken),
            stoppingToken,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default).Unwrap();

    private async Task RunAsync(CancellationToken stoppingToken)
    {
        consumer.Subscribe(SubscribedTopics);
        logger.LogInformation("Subscribed to {Topics}", string.Join(", ", SubscribedTopics));

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                ConsumeResult<string, byte[]>? result;
                try
                {
                    result = consumer.Consume(stoppingToken);
                }
                catch (ConsumeException ex)
                {
                    logger.LogWarning(ex, "Kafka consume error: {Reason}", ex.Error.Reason);
                    await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
                    continue;
                }

                if (result?.Message is null)
                {
                    continue;
                }

                await ProcessAsync(result, stoppingToken);
                consumer.StoreOffset(result);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        finally
        {
            consumer.Close();
        }
    }

    private async Task ProcessAsync(ConsumeResult<string, byte[]> result, CancellationToken stoppingToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                await HandleAsync(result, scope.ServiceProvider, stoppingToken);
                return;
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException)
            {
                await SendToDeadLetterAsync(result, ex, stoppingToken);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException && attempt < MaxAttempts)
            {
                var delay = TimeSpan.FromMilliseconds(250 * Math.Pow(2, attempt));
                logger.LogWarning(ex, "Attempt {Attempt}/{MaxAttempts} failed for {TopicPartitionOffset}; retrying in {Delay}",
                    attempt, MaxAttempts, result.TopicPartitionOffset, delay);
                await Task.Delay(delay, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await SendToDeadLetterAsync(result, ex, stoppingToken);
                return;
            }
        }
    }

    private async Task SendToDeadLetterAsync(ConsumeResult<string, byte[]> result, Exception error, CancellationToken cancellationToken)
    {
        var deadLetterTopic = Topics.DeadLetter(result.Topic);
        logger.LogError(error, "Sending message {TopicPartitionOffset} to {DeadLetterTopic}", result.TopicPartitionOffset, deadLetterTopic);

        var headers = new Headers();
        foreach (var header in result.Message.Headers ?? new Headers())
        {
            headers.Add(header.Key, header.GetValueBytes());
        }
        headers.Add("dlq-source", Encoding.UTF8.GetBytes(result.TopicPartitionOffset.ToString()));
        headers.Add("dlq-error", Encoding.UTF8.GetBytes(error.GetType().Name + ": " + error.Message));

        try
        {
            await publisher.PublishRawAsync(deadLetterTopic, result.Message.Key ?? string.Empty, result.Message.Value, headers, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Never block the partition because the DLQ is unavailable.
            logger.LogCritical(ex, "Failed to dead-letter message {TopicPartitionOffset}; dropping it", result.TopicPartitionOffset);
        }
    }
}

/// <summary>
/// Creates the topics on startup (the Java version declared <c>NewTopic</c> beans in KafkaConfig).
/// Retries while the broker is still starting.
/// </summary>
internal sealed class KafkaTopicInitializer(IConfiguration configuration, ILogger<KafkaTopicInitializer> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var bootstrapServers = configuration.GetConnectionString(MessagingExtensions.ConnectionName);
        if (string.IsNullOrWhiteSpace(bootstrapServers))
        {
            logger.LogWarning("No Kafka connection string configured; skipping topic creation");
            return;
        }

        using var admin = new AdminClientBuilder(new AdminClientConfig { BootstrapServers = bootstrapServers }).Build();
        var specifications = Topics.All.Select(name => new TopicSpecification
        {
            Name = name,
            NumPartitions = Topics.Partitions,
            ReplicationFactor = 1
        }).ToList();

        for (var attempt = 1; attempt <= 30; attempt++)
        {
            try
            {
                await admin.CreateTopicsAsync(specifications);
                logger.LogInformation("Kafka topics created");
                return;
            }
            catch (CreateTopicsException ex) when (ex.Results.All(r => r.Error.Code is ErrorCode.NoError or ErrorCode.TopicAlreadyExists))
            {
                logger.LogInformation("Kafka topics already exist");
                return;
            }
            catch (KafkaException ex) when (attempt < 30)
            {
                logger.LogWarning("Kafka not ready ({Reason}); retry {Attempt}/30", ex.Error.Reason, attempt);
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

public static class MessagingExtensions
{
    /// <summary>Name of the Kafka resource in the AppHost / the connection string key.</summary>
    public const string ConnectionName = "kafka";

    /// <summary>
    /// Registers the producer, the event publisher and topic creation.
    /// Pass <paramref name="consumerGroupId"/> when the service also consumes events.
    /// </summary>
    public static IHostApplicationBuilder AddRideShareMessaging(this IHostApplicationBuilder builder, string? consumerGroupId = null)
    {
        // Registered first so topics exist before any consumer loop starts.
        builder.Services.AddHostedService<KafkaTopicInitializer>();

        builder.AddKafkaProducer<string, byte[]>(ConnectionName, settings =>
        {
            settings.Config.Acks = Acks.All;
            settings.Config.EnableIdempotence = true;
        });

        if (consumerGroupId is not null)
        {
            builder.AddKafkaConsumer<string, byte[]>(ConnectionName, settings =>
            {
                settings.Config.GroupId = consumerGroupId;
                settings.Config.AutoOffsetReset = AutoOffsetReset.Earliest;
                settings.Config.EnableAutoCommit = true;
                settings.Config.EnableAutoOffsetStore = false; // offsets stored manually after handling
            });
        }

        builder.Services.AddSingleton<IEventPublisher, KafkaEventPublisher>();
        return builder;
    }
}
