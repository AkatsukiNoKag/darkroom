using System.ComponentModel.DataAnnotations;

namespace Darkroom.ViewModels;

public sealed class JoinRoomVm
{
    public Guid RoomId { get; set; }

    public string RoomName { get; set; } = "";

    public string? AvatarUrl { get; set; }

    public int OnlineCount { get; set; }

    public int MaxMembers { get; set; }

    public bool HasPassword { get; set; }

    [StringLength(50)]
    public string? Password { get; set; }
}

