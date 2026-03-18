using Darkroom.Data;
using Darkroom.Hubs;
using Darkroom.Infrastructure;
using Darkroom.Models;
using Darkroom.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using System.Diagnostics;
using System.Net;
using System.Text.Json.Serialization;



var builder = WebApplication.CreateBuilder(args);
if (Debugger.IsAttached)
{
    builder.WebHost.UseUrls("https://0.0.0.0:45678");
}
else
{
    builder.WebHost.ConfigureKestrel(options =>
    {
        options.Listen(IPAddress.Any, 3392, listenOptions =>
        {
            listenOptions.UseHttps("/home/darkroom/cert.pfx", "");
        });
    });
}

builder.Services.AddControllersWithViews();
builder.Services
    .AddSignalR()
    .AddJsonProtocol(options =>
        options.PayloadSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddHttpContextAccessor();
builder.Services.AddDataProtection();
builder.Services.AddScoped<UserContextAccessor>();
builder.Services.AddSingleton<RoomPresenceService>();
builder.Services.AddSingleton<RoomJoinTokenService>();
builder.Services.AddSingleton<IPasswordHasher<Room>, PasswordHasher<Room>>();

var dbPath = Path.Combine(builder.Environment.ContentRootPath, "darkroom.db");
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("Default") ?? $"Data Source={dbPath}"));

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
    SqliteSchemaBootstrapper.EnsureLatest(db);
    db.RoomMembers.ExecuteDelete();

    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    db.Rooms.ExecuteUpdate(setters =>
        setters.SetProperty(r => r.LastEmptyAtUnixSeconds, r => r.LastEmptyAtUnixSeconds ?? (long?)now));
}

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Rooms/Error");
    app.UseHsts();
    app.UseHttpsRedirection();
}

app.Use(async (context, next) =>
{
    context.Response.Headers["Permissions-Policy"] = "microphone=(self), camera=(self)";
    await next();
});

app.UseStaticFiles();

app.UseRouting();
app.UseMiddleware<UserContextMiddleware>();

app.UseAuthorization();

app.MapHub<RoomHub>("/hubs/room");
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Rooms}/{action=Index}/{id?}");

app.Run();
