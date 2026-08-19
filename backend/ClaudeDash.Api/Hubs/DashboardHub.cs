using Microsoft.AspNetCore.SignalR;

namespace ClaudeDash.Api.Hubs;

public sealed class DashboardHub : Hub
{
}

public sealed record ChangeEvent(string Kind, string? WorkspaceId, string? SessionId, DateTime At);
