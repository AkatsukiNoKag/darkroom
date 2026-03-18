using Darkroom.Contracts;

namespace Darkroom.ViewModels;

public sealed class RoomPageVm
{
    public required Guid RoomId { get; init; }
    public required string RoomName { get; init; }
    public required int MaxMembers { get; init; }
    public required string AvatarUrl { get; init; }
    public required bool HasPassword { get; init; }

    public required Guid UserId { get; init; }
    public required string DisplayName { get; init; }
    public required bool IsOwner { get; init; }

    public required IReadOnlyList<ChatMessageDto> RecentMessages { get; init; }

    public required string? IceTransportPolicy { get; init; }
    public required IReadOnlyList<WebRtcIceServerVm> IceServers { get; init; }
}
