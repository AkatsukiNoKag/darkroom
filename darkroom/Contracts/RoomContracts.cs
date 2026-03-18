using Darkroom.Models;

namespace Darkroom.Contracts;

public sealed record PeerDto(Guid UserId, string DisplayName);

public sealed record MemberDto(
    Guid UserId,
    string DisplayName,
    RoomRole Role,
    bool IsOnline,
    bool MicOn,
    bool CamOn,
    long PresenceVersion);

public sealed record ChatMessageDto(Guid UserId, string DisplayName, string Content, DateTimeOffset SentAt);

public sealed record SessionDescriptionDto(string Type, string Sdp);

public sealed record IceCandidateDto(string Candidate, string? SdpMid, int? SdpMLineIndex);
