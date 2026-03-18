using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http;

namespace Darkroom.ViewModels;

public sealed class RoomSettingsVm
{
    public Guid RoomId { get; set; }

    public string? CurrentAvatarUrl { get; set; }

    [Required]
    [StringLength(50)]
    public string Name { get; set; } = "";

    [Range(2, 50)]
    public int MaxMembers { get; set; } = 8;

    [StringLength(50)]
    public string? NewPassword { get; set; }

    public bool RemovePassword { get; set; }

    public IFormFile? Avatar { get; set; }
}

