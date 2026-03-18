using System.Collections.Concurrent;
using System.Threading;

namespace Darkroom.Services;

public sealed class RoomPresenceService
{
    private sealed class UserPresence
    {
        public required Guid UserId { get; init; }
        public required string DisplayName { get; set; }
        public bool MicOn { get; set; }
        public bool CamOn { get; set; }
        public long Version { get; set; }
        public ConcurrentDictionary<string, long> Connections { get; } = new();
    }

    public sealed record OnlineUserState(string DisplayName, bool MicOn, bool CamOn, long Version);

    private readonly ConcurrentDictionary<Guid, ConcurrentDictionary<Guid, UserPresence>> _rooms = new();
    private readonly ConcurrentDictionary<string, (Guid RoomId, Guid UserId)> _connectionIndex = new();
    private long _connectionSequence = 0;

    public IReadOnlyList<(Guid UserId, string DisplayName)> AddConnection(
        Guid roomId,
        Guid userId,
        string displayName,
        string connectionId)
    {
        var room = _rooms.GetOrAdd(roomId, _ => new ConcurrentDictionary<Guid, UserPresence>());

        var existingPeers = room
            .Where(kvp => kvp.Key != userId)
            .Select(kvp => (kvp.Key, kvp.Value.DisplayName))
            .ToList();

        var presence = room.AddOrUpdate(
            userId,
            _ => new UserPresence { UserId = userId, DisplayName = displayName },
            (_, current) =>
            {
                current.DisplayName = displayName;
                return current;
            });

        var seq = Interlocked.Increment(ref _connectionSequence);
        presence.Connections[connectionId] = seq;
        presence.Version = seq;
        _connectionIndex[connectionId] = (roomId, userId);

        return existingPeers;
    }

    public (Guid RoomId, Guid UserId)? RemoveConnection(string connectionId)
    {
        if (!_connectionIndex.TryRemove(connectionId, out var info))
        {
            return null;
        }

        if (!_rooms.TryGetValue(info.RoomId, out var room))
        {
            return info;
        }

        if (!room.TryGetValue(info.UserId, out var presence))
        {
            return info;
        }

        presence.Connections.TryRemove(connectionId, out _);
        if (!presence.Connections.Any())
        {
            room.TryRemove(info.UserId, out _);
        }

        if (room.IsEmpty)
        {
            _rooms.TryRemove(info.RoomId, out _);
        }

        return info;
    }

    public IReadOnlyDictionary<Guid, string> GetOnlineUsers(Guid roomId)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return new Dictionary<Guid, string>();
        }

        return room.ToDictionary(x => x.Key, x => x.Value.DisplayName);
    }

    public IReadOnlyDictionary<Guid, OnlineUserState> GetOnlineStates(Guid roomId)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return new Dictionary<Guid, OnlineUserState>();
        }

        return room.ToDictionary(
            x => x.Key,
            x => new OnlineUserState(x.Value.DisplayName, x.Value.MicOn, x.Value.CamOn, x.Value.Version));
    }

    public bool TryUpdateMediaState(Guid roomId, Guid userId, string displayName, bool micOn, bool camOn)
    {
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return false;
        }

        if (!room.TryGetValue(userId, out var presence))
        {
            return false;
        }

        presence.DisplayName = displayName;
        presence.MicOn = micOn;
        presence.CamOn = camOn;
        return true;
    }

    public bool TryGetAnyConnectionId(Guid roomId, Guid userId, out string connectionId)
    {
        connectionId = "";
        if (!_rooms.TryGetValue(roomId, out var room))
        {
            return false;
        }

        if (!room.TryGetValue(userId, out var presence))
        {
            return false;
        }

        connectionId = presence.Connections
            .OrderByDescending(x => x.Value)
            .Select(x => x.Key)
            .FirstOrDefault() ?? "";
        return !string.IsNullOrWhiteSpace(connectionId);
    }

    public int GetOnlineCount(Guid roomId) => GetOnlineUsers(roomId).Count;
}
