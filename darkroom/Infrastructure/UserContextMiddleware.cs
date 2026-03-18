using Microsoft.Extensions.Primitives;

namespace Darkroom.Infrastructure;

public sealed class UserContextMiddleware(RequestDelegate next)
{
    public const string ItemKey = "Darkroom.UserContext";
    private const string UserIdCookie = "dr.uid";
    private const string DisplayNameCookie = "dr.name";

    public async Task InvokeAsync(HttpContext context)
    {
        var userId = ReadOrCreateUserId(context);
        var displayName = ReadOrCreateDisplayName(context);

        context.Items[ItemKey] = new UserContext(userId, displayName);

        DeleteLegacyCookiePaths(context, UserIdCookie);
        DeleteLegacyCookiePaths(context, DisplayNameCookie);

        await next(context);
    }

    private static Guid ReadOrCreateUserId(HttpContext context)
    {
        if (context.Request.Cookies.TryGetValue(UserIdCookie, out var raw)
            && Guid.TryParse(raw, out var userId)
            && userId != Guid.Empty)
        {
            return userId;
        }

        userId = Guid.NewGuid();
        WriteCookie(context, UserIdCookie, userId.ToString("D"), httpOnly: true);
        return userId;
    }

    private static string ReadOrCreateDisplayName(HttpContext context)
    {
        if (context.Request.Cookies.TryGetValue(DisplayNameCookie, out var name)
            && !StringValues.IsNullOrEmpty(name))
        {
            var trimmed = name.ToString().Trim();
            if (!string.IsNullOrWhiteSpace(trimmed))
            {
                return trimmed.Length <= 30 ? trimmed : trimmed[..30];
            }
        }

        var fallback = $"用户{Random.Shared.Next(1000, 9999)}";
        WriteCookie(context, DisplayNameCookie, fallback, httpOnly: true);
        return fallback;
    }

    private static void WriteCookie(HttpContext context, string key, string value, bool httpOnly)
    {
        context.Response.Cookies.Append(
            key,
            value,
            new CookieOptions
            {
                Expires = DateTimeOffset.UtcNow.AddDays(365),
                HttpOnly = httpOnly,
                IsEssential = true,
                Path = "/",
                SameSite = SameSiteMode.Lax,
                Secure = context.Request.IsHttps,
            });
    }

    private static void DeleteLegacyCookiePaths(HttpContext context, string key)
    {
        var legacyPaths = new[]
        {
            "/Rooms",
            "/Rooms/Room",
            "/Rooms/Join",
            "/Rooms/Create",
            "/Rooms/Settings",
            "/hubs",
        };

        foreach (var path in legacyPaths)
        {
            context.Response.Cookies.Delete(key, new CookieOptions { Path = path });
        }
    }
}
