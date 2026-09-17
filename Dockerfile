# Generic multi-stage image for any service in src/.
#   docker build --build-arg PROJECT=RideShare.RideService -t rideshare/ride-service .
# (Alternative without a Dockerfile: dotnet publish src/<Project> /t:PublishContainer)

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PROJECT
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY src/ src/
RUN dotnet publish "src/${PROJECT}/${PROJECT}.csproj" -c Release -o /app \
    && mv "/app/${PROJECT}" /app/service

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
ENV ASPNETCORE_HTTP_PORTS=8080
WORKDIR /app
COPY --from=build /app .
EXPOSE 8080
USER $APP_UID
# Exec form, no shell: dash drops env vars with '-' in the name,
# which would lose service discovery keys like services__ride-service__http__0.
ENTRYPOINT ["/app/service"]
