namespace Darkroom.Models;

public sealed class RoomAdmin
{
    public long Id { get; set; }

    public Guid RoomId { get; set; }

    public Guid UserId { get; set; }

    public DateTimeOffset GrantedAt { get; set; } = DateTimeOffset.UtcNow;
}

