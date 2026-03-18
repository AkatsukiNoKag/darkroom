using System.ComponentModel.DataAnnotations;

namespace Darkroom.Models;

public sealed class Room
{
    public Guid Id { get; set; } = Guid.NewGuid();

    [Required]
    [StringLength(50)]
    public string Name { get; set; } = "未命名房间";

    [Range(2, 50)]
    public int MaxMembers { get; set; } = 8;

    public Guid OwnerUserId { get; set; }

    public string? PasswordHash { get; set; }

    public string? AvatarPath { get; set; }

    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public long? LastEmptyAtUnixSeconds { get; set; }
}
