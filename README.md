# Darkroom

一个基于 **ASP.NET Core + SignalR** 的轻量“房间”应用：在浏览器里用 **WebRTC（Mesh 点对点）** 做语音/视频通话，并提供弹幕聊天、房间密码、房主/管理员等能力。

## 功能特性

- 房间列表 / 创建 / 加入（人数上限、可选密码、房间头像）
- 房间内实时协作：WebRTC 音视频、弹幕聊天（含历史）、成员列表与在线状态
- 房主能力：房间设置（名称/人数上限/密码/头像）、设置管理员、删除房间
- 匿名身份：基于 Cookie 自动生成 `dr.uid`（用户 ID）与 `dr.name`（昵称）

## 技术栈

- .NET 8 / ASP.NET Core MVC
- SignalR（信令/实时状态，Hub 路径：`/hubs/room`）
- WebRTC（浏览器点对点 Mesh；服务器不转发媒体流）
- EF Core + SQLite（默认数据库文件：`darkroom/darkroom.db`）

## 快速开始（开发）

### 前置条件

- 安装 .NET SDK 8.x
- （可选）Visual Studio 2022

### 运行（推荐：VS 调试启动）

`darkroom/Program.cs` 在 **附加调试器** 时会监听：`https://0.0.0.0:45678`。

1. 用 Visual Studio 打开 `darkroom.sln`
2. F5 运行
3. 访问 `https://localhost:45678`

### 构建

```powershell
dotnet build .\darkroom.sln
```

> 说明：直接在命令行执行 `dotnet run`（未附加调试器）会走“生产监听”分支，默认绑定 `3392` 并要求证书文件 `/home/darkroom/cert.pfx`（见下文）。

## 生产运行

`darkroom/Program.cs` 在未附加调试器时会使用 Kestrel 监听：`https://0.0.0.0:3392`，并加载证书：`/home/darkroom/cert.pfx`（PFX，密码为空字符串）。

- 端口：`3392`（HTTPS）
- 证书：`/home/darkroom/cert.pfx`（如需自定义请修改 `darkroom/Program.cs`）

## 配置

配置文件：`darkroom/appsettings.json`

### SQLite 数据库

- 默认连接串：`ConnectionStrings:Default = Data Source=darkroom.db`
- 默认数据库文件：`darkroom/darkroom.db`
- 启动时自动建库（`EnsureCreated()`）并做少量 schema 自举（见 `darkroom/Data/SqliteSchemaBootstrapper.cs`）

### WebRTC（STUN/TURN）

支持通过配置注入 ICE Servers：

- `WebRtc:IceTransportPolicy`: `all` 或 `relay`
- `WebRtc:IceServers`: `Urls`（必填数组）、`Username`/`Credential`（可选）

TURN 部署与配置示例见：`darkroom/docs/turn.md`

## 重要说明

- 麦克风/摄像头需要“安全上下文”：`https` 或 `http://localhost`。
- 当前为 WebRTC Mesh（每人对每人一条连接）：人数越多越吃带宽且更不稳，建议小房间使用；大规模建议 SFU。
- 房间无人在线持续 >= 1 小时后，下一位加入者会自动接管房主并清空管理员（见 `darkroom/Hubs/RoomHub.cs`）。

## 目录结构

- `darkroom/`：Web 项目
  - `Controllers/`：页面与房间管理
  - `Hubs/`：SignalR Hub（信令）
  - `Data/`：EF Core / SQLite
  - `Services/`：在线状态、Join Token
  - `Views/`、`wwwroot/`：页面与前端逻辑（`wwwroot/js/room.js`）
