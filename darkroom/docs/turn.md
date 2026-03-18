# 使用 TURN（coturn）提升公网稳定性

当前 Darkroom 的音视频是 **WebRTC 点对点（Mesh）直连**：服务器（SignalR）只负责信令（交换 offer/answer/ICE），媒体流默认不经过 ASP.NET 服务器。

在公网/跨运营商/UDP 受限环境下，P2P 直连会变得不稳定或直接失败。解决方案是部署 **TURN（coturn）** 做媒体中继兜底（或强制走中继）。

## 1) 部署 coturn（示例）

你需要：
- 开放端口：`3478/udp`、`3478/tcp`，以及中继端口范围（例如 `49152-65535/udp`）
- 服务器有公网 IP，并正确配置安全组/防火墙

`turnserver.conf` 示例（按需调整）：

```
listening-port=3478
fingerprint
lt-cred-mech

realm=your.domain
server-name=your.domain

user=dr:CHANGE_ME

min-port=49152
max-port=65535

# 如果是单网卡公网机器，一般设置为公网 IP
external-ip=YOUR_PUBLIC_IP
```

## 2) 配置 Darkroom 使用 TURN

在 `darkroom/appsettings.json`（或生产环境的配置源）里配置 `WebRtc`：

```
"WebRtc": {
  "IceTransportPolicy": "all",
  "IceServers": [
    { "Urls": [ "stun:stun.cloudflare.com:3478" ] },
    {
      "Urls": [
        "turn:your.domain:3478?transport=udp",
        "turn:your.domain:3478?transport=tcp"
      ],
      "Username": "dr",
      "Credential": "CHANGE_ME"
    }
  ]
}
```

如果你想 **强制所有媒体都走 TURN 中继**（更稳但更耗带宽/延迟更高），把：

```
"IceTransportPolicy": "relay"
```

## 3) 重要提醒

- TURN 账号密码属于客户端可见信息，公网项目建议使用 **动态临时凭证**（TURN REST API/HMAC）来防滥用。
- 多人会议用 Mesh（每人对每人一条连接）上行压力很大，人数一多会明显不稳；更彻底的方案是上 **SFU**（如 LiveKit/Janus/mediasoup/Jitsi）。

