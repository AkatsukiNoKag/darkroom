using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Http;

namespace Darkroom.ViewModels;

public sealed class CreateRoomVm
{
    [Required(ErrorMessage = "请输入房间名")]
    [StringLength(50)]
    public string Name { get; set; } = "";

    [Range(2, 50, ErrorMessage = "人数范围 2-50")]
    public int MaxMembers { get; set; } = 8;

    [StringLength(50)]
    public string? Password { get; set; }

    public IFormFile? Avatar { get; set; }
}

