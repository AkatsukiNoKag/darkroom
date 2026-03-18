using Darkroom.Contracts;
using Darkroom.Data;
using Darkroom.Infrastructure;
using Darkroom.Models;
using Darkroom.Services;
using Darkroom.ViewModels;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Darkroom.Hubs;

namespace Darkroom.Controllers;

public sealed class RoomsController(
    AppDbContext db,
    UserContextAccessor userContextAccessor,
    RoomJoinTokenService joinTokenService,
    IPasswordHasher<Room> passwordHasher,
    RoomPresenceService presence,
    IHubContext<RoomHub> hubContext,
    IConfiguration config,
    IWebHostEnvironment env) : Controller
{
    [HttpGet]
    public async Task<IActionResult> Index()
    {
        var user = userContextAccessor.Current;

        var rooms = await db.Rooms.ToListAsync();
        rooms = rooms.OrderByDescending(r => r.CreatedAt).ToList();

        var roomIds = rooms.Select(r => r.Id).ToList();

        var onlineCounts = await db.RoomMembers
            .Where(m => roomIds.Contains(m.RoomId))
            .GroupBy(m => m.RoomId)
            .Select(g => new { RoomId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.RoomId, x => x.Count);

        var cards = rooms.Select(r =>
        {
            onlineCounts.TryGetValue(r.Id, out var onlineCount);
            var hasToken = r.OwnerUserId == user.UserId || HasValidJoinToken(r, user.UserId);
            return new RoomCardVm(
                r.Id,
                r.Name,
                string.IsNullOrWhiteSpace(r.AvatarPath) ? "/img/room-default.svg" : r.AvatarPath,
                onlineCount,
                r.MaxMembers,
                !string.IsNullOrWhiteSpace(r.PasswordHash),
                hasToken,
                r.OwnerUserId == user.UserId);
        }).ToList();

        return View(new RoomListVm(user.DisplayName, cards));
    }

    [HttpGet]
    public IActionResult Create() => View(new CreateRoomVm());

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(CreateRoomVm model)
    {
        var user = userContextAccessor.Current;

        if (!ModelState.IsValid)
        {
            return View(model);
        }

        var room = new Room
        {
            Name = model.Name.Trim(),
            MaxMembers = model.MaxMembers,
            OwnerUserId = user.UserId,
            CreatedAt = DateTimeOffset.UtcNow,
            LastEmptyAtUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
        };

        if (!string.IsNullOrWhiteSpace(model.Password))
        {
            room.PasswordHash = passwordHasher.HashPassword(room, model.Password.Trim());
        }

        db.Rooms.Add(room);
        await db.SaveChangesAsync();

        if (model.Avatar is not null)
        {
            var avatarPath = await TrySaveRoomAvatarAsync(room.Id, model.Avatar);
            if (avatarPath is null && !ModelState.IsValid)
            {
                return View(model);
            }

            room.AvatarPath = avatarPath;
            await db.SaveChangesAsync();
        }

        IssueJoinToken(room, user.UserId);
        return RedirectToAction(nameof(Room), new { id = room.Id });
    }

    [HttpGet]
    public async Task<IActionResult> Join(Guid id)
    {
        var user = userContextAccessor.Current;
        var room = await db.Rooms.AsNoTracking().SingleOrDefaultAsync(r => r.Id == id);
        if (room is null)
        {
            return NotFound();
        }

        if (room.OwnerUserId == user.UserId || HasValidJoinToken(room, user.UserId))
        {
            return RedirectToAction(nameof(Room), new { id });
        }

        var onlineCount = await db.RoomMembers.CountAsync(m => m.RoomId == id);

        return View(new JoinRoomVm
        {
            RoomId = room.Id,
            RoomName = room.Name,
            AvatarUrl = room.AvatarPath,
            OnlineCount = onlineCount,
            MaxMembers = room.MaxMembers,
            HasPassword = !string.IsNullOrWhiteSpace(room.PasswordHash),
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Join(JoinRoomVm model)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == model.RoomId);
        if (room is null)
        {
            return NotFound();
        }

        if (!string.IsNullOrWhiteSpace(room.PasswordHash))
        {
            var password = model.Password?.Trim() ?? "";
            var result = passwordHasher.VerifyHashedPassword(room, room.PasswordHash, password);
            if (result == PasswordVerificationResult.Failed)
            {
                ModelState.AddModelError(nameof(model.Password), "密码不正确");
            }
        }

        var onlineCount = await db.RoomMembers.CountAsync(m => m.RoomId == room.Id);
        if (onlineCount >= room.MaxMembers)
        {
            ModelState.AddModelError(string.Empty, "房间人数已满");
        }

        if (!ModelState.IsValid)
        {
            model.RoomName = room.Name;
            model.AvatarUrl = room.AvatarPath;
            model.OnlineCount = onlineCount;
            model.MaxMembers = room.MaxMembers;
            model.HasPassword = !string.IsNullOrWhiteSpace(room.PasswordHash);
            return View(model);
        }

        IssueJoinToken(room, user.UserId);
        return RedirectToAction(nameof(Room), new { id = room.Id });
    }

    [HttpGet]
    public async Task<IActionResult> Room(Guid id)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.AsNoTracking().SingleOrDefaultAsync(r => r.Id == id);
        if (room is null)
        {
            return NotFound();
        }

        var isOwner = room.OwnerUserId == user.UserId;
        if (!isOwner && !HasValidJoinToken(room, user.UserId))
        {
            return RedirectToAction(nameof(Join), new { id });
        }

        IssueJoinToken(room, user.UserId);

        var recentMessages = await db.ChatMessages
            .Where(m => m.RoomId == id)
            .OrderByDescending(m => m.Id)
            .Take(50)
            .OrderBy(m => m.Id)
            .Select(m => new ChatMessageDto(m.UserId, m.DisplayName, m.Content, m.SentAt))
            .ToListAsync();

        var iceServers = GetIceServers(config);
        var iceTransportPolicy = GetIceTransportPolicy(config);

        return View(new RoomPageVm
        {
            RoomId = room.Id,
            RoomName = room.Name,
            MaxMembers = room.MaxMembers,
            AvatarUrl = string.IsNullOrWhiteSpace(room.AvatarPath) ? "/img/room-default.svg" : room.AvatarPath,
            HasPassword = !string.IsNullOrWhiteSpace(room.PasswordHash),
            UserId = user.UserId,
            DisplayName = user.DisplayName,
            IsOwner = isOwner,
            RecentMessages = recentMessages,
            IceTransportPolicy = iceTransportPolicy,
            IceServers = iceServers,
        });
    }

    [HttpGet]
    public async Task<IActionResult> Settings(Guid id)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == id);
        if (room is null)
        {
            return NotFound();
        }

        if (room.OwnerUserId != user.UserId)
        {
            return Forbid();
        }

        return View(new RoomSettingsVm
        {
            RoomId = room.Id,
            CurrentAvatarUrl = room.AvatarPath,
            Name = room.Name,
            MaxMembers = room.MaxMembers,
        });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Settings(RoomSettingsVm model)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == model.RoomId);
        if (room is null)
        {
            return NotFound();
        }

        if (room.OwnerUserId != user.UserId)
        {
            return Forbid();
        }

        if (!ModelState.IsValid)
        {
            model.CurrentAvatarUrl = room.AvatarPath;
            return View(model);
        }

        room.Name = model.Name.Trim();
        room.MaxMembers = model.MaxMembers;

        if (!string.IsNullOrWhiteSpace(model.NewPassword))
        {
            room.PasswordHash = passwordHasher.HashPassword(room, model.NewPassword.Trim());
        }
        else if (model.RemovePassword)
        {
            room.PasswordHash = null;
        }

        if (model.Avatar is not null)
        {
            var avatarPath = await TrySaveRoomAvatarAsync(room.Id, model.Avatar);
            if (avatarPath is null && !ModelState.IsValid)
            {
                model.CurrentAvatarUrl = room.AvatarPath;
                return View(model);
            }

            room.AvatarPath = avatarPath;
        }

        await db.SaveChangesAsync();

        return RedirectToAction(nameof(Room), new { id = room.Id });
    }

    public sealed record SetAdminRequest(Guid RoomId, Guid TargetUserId, bool MakeAdmin);

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetAdmin([FromBody] SetAdminRequest request)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.AsNoTracking().SingleOrDefaultAsync(r => r.Id == request.RoomId);
        if (room is null)
        {
            return NotFound();
        }

        if (room.OwnerUserId != user.UserId)
        {
            return Forbid();
        }

        if (request.TargetUserId == room.OwnerUserId)
        {
            return BadRequest("不能修改房主权限。");
        }

        var isOnlineMember = await db.RoomMembers.AnyAsync(m => m.RoomId == request.RoomId && m.UserId == request.TargetUserId);
        if (!isOnlineMember)
        {
            return BadRequest("目标成员不在房间里。");
        }

        if (request.MakeAdmin)
        {
            var exists = await db.RoomAdmins.AnyAsync(a => a.RoomId == request.RoomId && a.UserId == request.TargetUserId);
            if (!exists)
            {
                db.RoomAdmins.Add(new RoomAdmin { RoomId = request.RoomId, UserId = request.TargetUserId });
                await db.SaveChangesAsync();
            }
        }
        else
        {
            var admin = await db.RoomAdmins.SingleOrDefaultAsync(a => a.RoomId == request.RoomId && a.UserId == request.TargetUserId);
            if (admin is not null)
            {
                db.RoomAdmins.Remove(admin);
                await db.SaveChangesAsync();
            }
        }

        await BroadcastMembersAsync(request.RoomId);

        return Ok();
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult Leave(Guid id)
    {
        var cookieName = RoomJoinTokenService.CookieName(id);
        Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/" });
        Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/Rooms" });
        return RedirectToAction(nameof(Index));
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(Guid id)
    {
        var user = userContextAccessor.Current;

        var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == id);
        if (room is null)
        {
            return NotFound();
        }

        if (room.OwnerUserId != user.UserId)
        {
            return Forbid();
        }

        TryDeleteRoomAvatarFile(room.AvatarPath);

        await db.RoomAdmins.Where(x => x.RoomId == id).ExecuteDeleteAsync();
        await db.ChatMessages.Where(x => x.RoomId == id).ExecuteDeleteAsync();
        await db.RoomMembers.Where(x => x.RoomId == id).ExecuteDeleteAsync();

        db.Rooms.Remove(room);
        await db.SaveChangesAsync();

        var cookieName = RoomJoinTokenService.CookieName(id);
        Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/" });
        Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/Rooms" });

        return RedirectToAction(nameof(Index));
    }

    [HttpGet]
    public IActionResult Error() => View();

    private bool HasValidJoinToken(Room room, Guid userId)
    {
        if (!Request.Cookies.TryGetValue(RoomJoinTokenService.CookieName(room.Id), out var token)
            || string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        return joinTokenService.TryValidate(
            token,
            room.Id,
            userId,
            RoomJoinTokenService.GetRoomStamp(room.PasswordHash),
            out _);
    }

    private void IssueJoinToken(Room room, Guid userId)
    {
        var cookieName = RoomJoinTokenService.CookieName(room.Id);
        var expiresAt = DateTimeOffset.UtcNow.AddHours(12);
        var token = joinTokenService.Create(
            room.Id,
            userId,
            expiresAt,
            RoomJoinTokenService.GetRoomStamp(room.PasswordHash));

        Response.Cookies.Append(cookieName, token, new CookieOptions
        {
            Expires = expiresAt,
            HttpOnly = true,
            IsEssential = true,
            Path = "/",
            SameSite = SameSiteMode.Lax,
            Secure = Request.IsHttps,
        });

        Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/Rooms" });
    }

    private async Task<string?> TrySaveRoomAvatarAsync(Guid roomId, IFormFile file)
    {
        if (file.Length <= 0)
        {
            return null;
        }

        if (file.Length > 2_000_000)
        {
            ModelState.AddModelError("Avatar", "头像文件过大（最大 2MB）");
            return null;
        }

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp" };
        if (!allowed.Contains(ext))
        {
            ModelState.AddModelError("Avatar", "仅支持 png/jpg/jpeg/webp");
            return null;
        }

        if (string.IsNullOrWhiteSpace(env.WebRootPath))
        {
            ModelState.AddModelError("Avatar", "未配置 WebRootPath");
            return null;
        }

        var dir = Path.Combine(env.WebRootPath, "uploads", "rooms");
        Directory.CreateDirectory(dir);

        var fileName = $"{roomId:D}{ext}";
        var diskPath = Path.Combine(dir, fileName);

        await using (var stream = System.IO.File.Create(diskPath))
        {
            await file.CopyToAsync(stream);
        }

        return $"/uploads/rooms/{fileName}";
    }

    private async Task BroadcastMembersAsync(Guid roomId)
    {
        var room = await db.Rooms.AsNoTracking().SingleOrDefaultAsync(r => r.Id == roomId);
        if (room is null)
        {
            return;
        }

        var onlineStates = presence.GetOnlineStates(roomId);
        var adminSet = await db.RoomAdmins
            .Where(x => x.RoomId == roomId)
            .Select(x => x.UserId)
            .ToHashSetAsync();

        var rawMembers = await db.RoomMembers
            .Where(m => m.RoomId == roomId)
            .OrderBy(m => m.Id)
            .ToListAsync();

        var members = rawMembers
            .Select(m =>
            {
                var role =
                    m.UserId == room.OwnerUserId ? RoomRole.Owner :
                    adminSet.Contains(m.UserId) ? RoomRole.Admin :
                    RoomRole.Member;

                var isOnline = onlineStates.TryGetValue(m.UserId, out var state);
                var version = isOnline ? state!.Version : 0;
                return new MemberDto(
                    m.UserId,
                    m.DisplayName,
                    role,
                    isOnline,
                    isOnline && state!.MicOn,
                    isOnline && state!.CamOn,
                    version);
            })
            .OrderByDescending(m => m.Role)
            .ThenBy(m => m.DisplayName)
            .ToList();

        await hubContext.Clients.Group($"room:{roomId:D}").SendAsync("MembersUpdated", members);
    }

    private void TryDeleteRoomAvatarFile(string? avatarPath)
    {
        if (string.IsNullOrWhiteSpace(avatarPath))
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(env.WebRootPath))
        {
            return;
        }

        if (!avatarPath.StartsWith("/uploads/rooms/", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var relative = avatarPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var fullPath = Path.GetFullPath(Path.Combine(env.WebRootPath, relative));
        var roomsDir = Path.GetFullPath(Path.Combine(env.WebRootPath, "uploads", "rooms")) + Path.DirectorySeparatorChar;

        if (!fullPath.StartsWith(roomsDir, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (System.IO.File.Exists(fullPath))
        {
            System.IO.File.Delete(fullPath);
        }
    }

    private static IReadOnlyList<WebRtcIceServerVm> GetIceServers(IConfiguration config)
    {
        var servers = config.GetSection("WebRtc:IceServers").Get<List<WebRtcIceServerVm>>() ?? [];

        var cleaned = servers
            .Where(s => s.Urls is { Length: > 0 })
            .Select(s =>
            {
                var urls = s.Urls
                    .Where(u => !string.IsNullOrWhiteSpace(u))
                    .Select(u => u.Trim())
                    .ToArray();

                var username = string.IsNullOrWhiteSpace(s.Username) ? null : s.Username.Trim();
                var credential = string.IsNullOrWhiteSpace(s.Credential) ? null : s.Credential.Trim();

                return new WebRtcIceServerVm(urls, username, credential);
            })
            .Where(s => s.Urls.Length > 0)
            .ToList();

        if (cleaned.Count == 0)
        {
            cleaned.Add(new WebRtcIceServerVm(["stun:stun.cloudflare.com:3478"], null, null));
            cleaned.Add(new WebRtcIceServerVm(["stun:stun.l.google.com:19302"], null, null));
        }

        return cleaned;
    }

    private static string? GetIceTransportPolicy(IConfiguration config)
    {
        var policy = config.GetValue<string?>("WebRtc:IceTransportPolicy");
        if (string.IsNullOrWhiteSpace(policy))
        {
            return null;
        }

        policy = policy.Trim().ToLowerInvariant();
        return policy is "all" or "relay" ? policy : null;
    }
}
