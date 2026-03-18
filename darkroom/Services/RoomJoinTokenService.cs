using Microsoft.AspNetCore.DataProtection;

namespace Darkroom.Services;

public sealed class RoomJoinTokenService(IDataProtectionProvider dataProtectionProvider)
{
    private readonly IDataProtector _protector =
        dataProtectionProvider.CreateProtector("Darkroom.RoomJoinToken.v1");

    public static string CookieName(Guid roomId) => $"dr.room.{roomId:D}.join";

    public static string GetRoomStamp(string? passwordHash) => passwordHash ?? "";

    public string Create(Guid roomId, Guid userId, DateTimeOffset expiresAt, string roomStamp)
    {
        var unixSeconds = expiresAt.ToUnixTimeSeconds();
        var payload = string.IsNullOrWhiteSpace(roomStamp)
            ? $"{roomId:D}|{userId:D}|{unixSeconds}"
            : $"{roomId:D}|{userId:D}|{unixSeconds}|{roomStamp}";
        return _protector.Protect(payload);
    }

    public bool TryValidate(
        string token,
        Guid roomId,
        Guid userId,
        string expectedRoomStamp,
        out DateTimeOffset expiresAt)
    {
        expiresAt = default;
        string raw;
        try
        {
            raw = _protector.Unprotect(token);
        }
        catch
        {
            return false;
        }

        var parts = raw.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length is not (3 or 4))
        {
            return false;
        }

        if (!Guid.TryParse(parts[0], out var parsedRoomId) || parsedRoomId != roomId)
        {
            return false;
        }

        if (!Guid.TryParse(parts[1], out var parsedUserId) || parsedUserId != userId)
        {
            return false;
        }

        if (!long.TryParse(parts[2], out var unixSeconds))
        {
            return false;
        }

        var tokenRoomStamp = parts.Length == 4 ? parts[3] : "";
        if (!string.Equals(tokenRoomStamp, expectedRoomStamp, StringComparison.Ordinal))
        {
            return false;
        }

        expiresAt = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
        return DateTimeOffset.UtcNow <= expiresAt;
    }
}
