using Microsoft.AspNetCore.Mvc;

namespace Darkroom.Controllers;

public sealed class ProfileController : Controller
{
    private const string DisplayNameCookie = "dr.name";

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult SetName(string displayName, string? returnUrl = null)
    {
        var trimmed = (displayName ?? "").Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return RedirectToLocal(returnUrl);
        }

        if (trimmed.Length > 30)
        {
            trimmed = trimmed[..30];
        }

        Response.Cookies.Append(DisplayNameCookie, trimmed, new CookieOptions
        {
            Expires = DateTimeOffset.UtcNow.AddDays(365),
            HttpOnly = true,
            IsEssential = true,
            Path = "/",
            SameSite = SameSiteMode.Lax,
            Secure = Request.IsHttps,
        });

        return RedirectToLocal(returnUrl);
    }

    private IActionResult RedirectToLocal(string? returnUrl)
    {
        if (!string.IsNullOrWhiteSpace(returnUrl) && Url.IsLocalUrl(returnUrl))
        {
            return Redirect(returnUrl);
        }

        return RedirectToAction("Index", "Rooms");
    }
}
