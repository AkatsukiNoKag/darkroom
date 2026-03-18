using System.ComponentModel.DataAnnotations;

namespace Darkroom.Models;

public sealed class ChatMessage
{
    public long Id { get; set; }

    public Guid RoomId { get; set; }

    public Guid UserId { get; set; }

    [Required]
    [StringLength(30)]
    public string DisplayName { get; set; } = "";

    [Required]
    [StringLength(500)]
    public string Content { get; set; } = "";

    public DateTimeOffset SentAt { get; set; } = DateTimeOffset.UtcNow;
}

