namespace Darkroom.ViewModels;

public sealed record RoomCardVm(
    Guid RoomId,
    string Name,
    string AvatarUrl,
    int OnlineCount,
    int MaxMembers,
    bool HasPassword,
    bool HasJoinToken,
    bool IsOwner);

