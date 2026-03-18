using Darkroom.Contracts;
using Darkroom.Data;
using Darkroom.Infrastructure;
using Darkroom.Models;
using Darkroom.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Darkroom.Hubs;

public sealed class RoomHub(
    AppDbContext db,
    RoomPresenceService presence,
    RoomJoinTokenService joinTokenService,
    ILogger<RoomHub> logger) : Hub
{
    public async Task<IReadOnlyList<PeerDto>> JoinRoom(Guid roomId, Guid userId)
    {
        var user = GetAndValidateUser(userId);

        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == roomId);
            if (room is null)
            {
                throw new HubException("房间不存在。");
            }

            ValidateJoinToken(room, user.UserId);

            var nowUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var anyOnline = await db.RoomMembers.AnyAsync(m => m.RoomId == roomId);
            if (!anyOnline)
            {
                if (room.LastEmptyAtUnixSeconds is long lastEmptyUnix
                    && nowUnix - lastEmptyUnix >= 3600)
                {
                    room.OwnerUserId = user.UserId;
                    await db.RoomAdmins.Where(x => x.RoomId == roomId).ExecuteDeleteAsync();
                }

                room.LastEmptyAtUnixSeconds = null;
            }
            else if (room.LastEmptyAtUnixSeconds is not null)
            {
                room.LastEmptyAtUnixSeconds = null;
            }

            var member = await db.RoomMembers.SingleOrDefaultAsync(m => m.RoomId == roomId && m.UserId == user.UserId);
            if (member is null)
            {
                var onlineCount = await db.RoomMembers.CountAsync(m => m.RoomId == roomId);
                if (onlineCount >= room.MaxMembers)
                {
                    throw new HubException("房间人数已满。");
                }

                member = new RoomMember
                {
                    RoomId = roomId,
                    UserId = user.UserId,
                    DisplayName = user.DisplayName,
                    JoinedAt = DateTimeOffset.UtcNow,
                };
                db.RoomMembers.Add(member);
            }
            else
            {
                member.DisplayName = user.DisplayName;
            }

            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(roomId));

        var peers = presence.AddConnection(roomId, user.UserId, user.DisplayName, Context.ConnectionId)
            .Select(x => new PeerDto(x.UserId, x.DisplayName))
            .ToList();

        await BroadcastMembersAsync(roomId);

        logger.LogInformation("User {UserId} joined room {RoomId} ({ConnectionId}).", user.UserId, roomId, Context.ConnectionId);

        return peers;
    }

    public async Task SendChatMessage(Guid roomId, string content)
    {
        var user = GetUser();

        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        content = content.Trim();
        if (content.Length > 500)
        {
            content = content[..500];
        }

        var isMember = await db.RoomMembers.AnyAsync(m => m.RoomId == roomId && m.UserId == user.UserId);
        if (!isMember)
        {
            throw new HubException("你不在该房间里。");
        }

        var message = new ChatMessage
        {
            RoomId = roomId,
            UserId = user.UserId,
            DisplayName = user.DisplayName,
            Content = content,
            SentAt = DateTimeOffset.UtcNow,
        };

        db.ChatMessages.Add(message);
        await db.SaveChangesAsync();

        await Clients.Group(RoomGroup(roomId)).SendAsync(
            "ReceiveChatMessage",
            new ChatMessageDto(message.UserId, message.DisplayName, message.Content, message.SentAt));
    }

    public async Task SendOffer(Guid roomId, Guid targetUserId, SessionDescriptionDto description)
    {
        var user = GetUser();
        await SendToPeer(roomId, targetUserId, "ReceiveOffer", user.UserId, user.DisplayName, description);
    }

    public async Task SendAnswer(Guid roomId, Guid targetUserId, SessionDescriptionDto description)
    {
        var user = GetUser();
        await SendToPeer(roomId, targetUserId, "ReceiveAnswer", user.UserId, user.DisplayName, description);
    }

    public async Task SendIceCandidate(Guid roomId, Guid targetUserId, IceCandidateDto candidate)
    {
        var user = GetUser();
        await SendToPeer(roomId, targetUserId, "ReceiveIceCandidate", user.UserId, user.DisplayName, candidate);
    }

    public async Task UpdateMediaState(Guid roomId, bool micOn, bool camOn)
    {
        var user = GetUser();

        var isMember = await db.RoomMembers.AnyAsync(m => m.RoomId == roomId && m.UserId == user.UserId);
        if (!isMember)
        {
            throw new HubException("You are not in this room.");
        }

        presence.TryUpdateMediaState(roomId, user.UserId, user.DisplayName, micOn, camOn);
        await BroadcastMembersAsync(roomId);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var info = presence.RemoveConnection(Context.ConnectionId);
        if (info is not null)
        {
            var (roomId, userId) = info.Value;
            var stillOnline = presence.GetOnlineUsers(roomId).ContainsKey(userId);

            if (!stillOnline)
            {
                var member = await db.RoomMembers.SingleOrDefaultAsync(m => m.RoomId == roomId && m.UserId == userId);
                if (member is not null)
                {
                    db.RoomMembers.Remove(member);
                    await db.SaveChangesAsync();
                }

                var anyOnline = await db.RoomMembers.AnyAsync(m => m.RoomId == roomId);
                if (!anyOnline)
                {
                    var room = await db.Rooms.SingleOrDefaultAsync(r => r.Id == roomId);
                    if (room is not null)
                    {
                        room.LastEmptyAtUnixSeconds = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                        await db.SaveChangesAsync();
                    }
                }

                await Clients.Group(RoomGroup(roomId)).SendAsync("PeerLeft", userId);
            }

            await BroadcastMembersAsync(roomId);

            logger.LogInformation("User {UserId} left room {RoomId} ({ConnectionId}).", userId, roomId, Context.ConnectionId);
        }

        await base.OnDisconnectedAsync(exception);
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

        await Clients.Group(RoomGroup(roomId)).SendAsync("MembersUpdated", members);
    }

    private async Task SendToPeer<TPayload>(
        Guid roomId,
        Guid targetUserId,
        string method,
        Guid fromUserId,
        string fromDisplayName,
        TPayload payload)
    {
        var isMember = await db.RoomMembers.AnyAsync(m => m.RoomId == roomId && m.UserId == fromUserId);
        if (!isMember)
        {
            throw new HubException("你不在该房间里。");
        }

        if (!presence.TryGetAnyConnectionId(roomId, targetUserId, out var connectionId))
        {
            return;
        }

        await Clients.Client(connectionId).SendAsync(method, new
        {
            roomId,
            fromUserId,
            fromDisplayName,
            payload,
        });
    }

    private UserContext GetAndValidateUser(Guid userId)
    {
        var user = GetUser();
        if (user.UserId != userId)
        {
            throw new HubException("身份无效。");
        }

        return user;
    }

    private UserContext GetUser()
    {
        var http = Context.GetHttpContext();
        if (http is null)
        {
            throw new HubException("无法获取请求上下文。");
        }

        if (http.Items.TryGetValue(UserContextMiddleware.ItemKey, out var value)
            && value is UserContext user)
        {
            return user;
        }

        throw new HubException("身份信息缺失。");
    }

    private void ValidateJoinToken(Room room, Guid userId)
    {
        var http = Context.GetHttpContext();
        if (http is null)
        {
            throw new HubException("无法获取请求上下文。");
        }

        if (room.OwnerUserId == userId)
        {
            return;
        }

        if (!http.Request.Cookies.TryGetValue(RoomJoinTokenService.CookieName(room.Id), out var token)
            || string.IsNullOrWhiteSpace(token)
            || !joinTokenService.TryValidate(
                token,
                room.Id,
                userId,
                RoomJoinTokenService.GetRoomStamp(room.PasswordHash),
                out _))
        {
            throw new HubException("请先加入房间。");
        }
    }

    private static string RoomGroup(Guid roomId) => $"room:{roomId:D}";
}
