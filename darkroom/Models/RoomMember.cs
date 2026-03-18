using System.ComponentModel.DataAnnotations;

namespace Darkroom.Models;

public sealed class RoomMember
{
    public long Id { get; set; }

    public Guid RoomId { get; set; }

    public Guid UserId { get; set; }

    [Required]
    [StringLength(30)]
    public string DisplayName { get; set; } = "";

    public DateTimeOffset JoinedAt { get; set; } = DateTimeOffset.UtcNow;

    public Room Room { get; set; } = null!;
}

