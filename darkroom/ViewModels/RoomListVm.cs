namespace Darkroom.ViewModels;

public sealed record RoomListVm(
    string DisplayName,
    IReadOnlyList<RoomCardVm> Rooms);

