(() => {
  const cfg = window.__darkroom;
  if (!cfg) return;

  const csrfToken =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

  const roomId = cfg.roomId;
  const userId = cfg.userId;
  let isOwner = !!cfg.isOwner;
  const setAdminUrl = cfg.setAdminUrl;
  const rtcConfiguration = (() => {
    const iceServers =
      Array.isArray(cfg.iceServers) && cfg.iceServers.length
        ? cfg.iceServers
        : [{ urls: ['stun:stun.l.google.com:19302'] }];

    const pcCfg = { iceServers };

    const policy = typeof cfg.iceTransportPolicy === 'string' ? cfg.iceTransportPolicy.trim() : '';
    if (policy) {
      pcCfg.iceTransportPolicy = policy;
    }

    return pcCfg;
  })();

  const btnRoomSettings = document.getElementById('btnRoomSettings');
  const memberListEl = document.getElementById('memberList');
  const danmakuLayerEl = document.getElementById('danmakuLayer');
  const chatFormEl = document.getElementById('chatForm');
  const chatInputEl = document.getElementById('chatInput');
  const statusEl = document.getElementById('realtimeStatus');

  const btnToggleMic = document.getElementById('btnToggleMic');
  const btnToggleCam = document.getElementById('btnToggleCam');
  const btnToggleChat = document.getElementById('btnToggleChat');
  const btnDanmakuHistory = document.getElementById('btnDanmakuHistory');
  const btnSwitchCam = document.getElementById('btnSwitchCam');
  const camZoomWrap = document.getElementById('camZoomWrap');
  const camZoomInput = document.getElementById('camZoom');
  const stageEl = document.getElementById('stage');
  const localVideo = document.getElementById('localVideo');
  const remoteVideos = document.getElementById('remoteVideos');
  const localTileEl = document.getElementById('tile_local');
  const localInitialsEl = document.getElementById('localInitials');
  const localTileStatusEl = document.getElementById('localTileStatus');
  const danmakuHistoryPanelEl = document.getElementById('danmakuHistoryPanel');
  const danmakuHistoryListEl = document.getElementById('danmakuHistoryList');
  const btnCloseDanmakuHistory = document.getElementById('btnCloseDanmakuHistory');

  const peers = new Map(); // peerUserId -> { pc, audioTransceiver, videoTransceiver, isPolite, makingOffer, needsNegotiation, negotiationTimer }
  const pendingIce = new Map(); // peerUserId -> RTCIceCandidateInit[]
  const remoteStreams = new Map(); // peerUserId -> MediaStream
  const remoteTiles = new Map(); // peerUserId -> { tile, video, audio, nameEl, micEl, camEl, vuEl, placeholderEl, initialsEl }
  const memberStateById = new Map(); // userId -> latest MemberDto
  const speakingUsers = new Set(); // userId

  let audioCtx = null;
  let speakingTimer = null;
  const audioDetectors = new Map(); // peerUserId -> { trackId, analyser, data, source, gain, lastLoudAt, speaking }

  let localAudioTrack = null;
  let localVideoTrack = null;
  let hasAnnouncedOwner = isOwner;
  let dummyAudioTrack = null;
  let dummyVideoTrack = null;
  let dummyVideoCanvas = null;
  let dummyVideoTimer = null;
  let dummyAudioSource = null;
  let dummyAudioGain = null;
  let dummyAudioDest = null;

  let danmakuHidden = false;
  let uiHidden = false;
  let historyOpen = false;
  let preferredFacingMode = localStorage.getItem('dr.facingMode') || 'user'; // user | environment
  let localTileMicIcon = null;
  let localTileCamIcon = null;
  let localTileVuMeter = null;

  function isSecureContextForMedia() {
    if (typeof window.isSecureContext === 'boolean') {
      return window.isSecureContext;
    }

    const protocol = window.location?.protocol || '';
    const hostname = window.location?.hostname || '';
    if (protocol === 'https:') return true;
    if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
      return true;
    }

    return false;
  }

  function getUserMediaCompat(constraints) {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices && typeof mediaDevices.getUserMedia === 'function') {
      return mediaDevices.getUserMedia(constraints);
    }

    const legacy =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia ||
      navigator.msGetUserMedia;

    if (typeof legacy === 'function') {
      return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
    }

    return null;
  }

  function setStatus(text, variant) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('text-secondary', 'text-success', 'text-warning', 'text-danger');
    switch (variant) {
      case 'success':
        statusEl.classList.add('text-success');
        break;
      case 'warning':
        statusEl.classList.add('text-warning');
        break;
      case 'danger':
        statusEl.classList.add('text-danger');
        break;
      default:
        statusEl.classList.add('text-secondary');
        break;
    }
  }

  function applyOwnerUi() {
    btnRoomSettings?.classList.toggle('d-none', !isOwner);
  }

  function tryPlayMedia(el) {
    if (!el || typeof el.play !== 'function') return;
    try {
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    } catch {}
  }

  function tryPlayAllMedia() {
    tryPlayMedia(localVideo);

    for (const tile of remoteTiles.values()) {
      tryPlayMedia(tile.video);
      tryPlayMedia(tile.audio);
    }
  }

  function updateOwnership(members) {
    const me = (members || []).find((m) => m.userId === userId);
    const nextIsOwner = !!me && me.role === 'Owner';
    if (nextIsOwner !== isOwner) {
      isOwner = nextIsOwner;
      applyOwnerUi();
    }

    if (isOwner && !hasAnnouncedOwner) {
      hasAnnouncedOwner = true;
      setStatus('实时连接：已连接（你是房主）', 'success');
    }
  }

  if (typeof window.signalR === 'undefined') {
    setStatus('实时连接：SignalR 脚本加载失败（请检查网络/刷新）', 'danger');
    return;
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  const ICON_SVGS = {
    mic: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="M5 3a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0V3z"></path>
  <path d="M3.5 6.5a.5.5 0 0 1 1 0v1a3.5 3.5 0 0 0 7 0v-1a.5.5 0 0 1 1 0v1a4.5 4.5 0 0 1-4 4.474V14h1a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h1v-2.026a4.5 4.5 0 0 1-4-4.474v-1z"></path>
</svg>`,
    cam: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="M0 5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V5z"></path>
  <path d="M11 5.5 16 3v10l-5-2.5v-5z"></path>
</svg>`,
  };

  function createTileIcon(kind, title) {
    const span = el('span', `tile-icon ${kind}`);
    span.innerHTML = ICON_SVGS[kind] || '';
    if (title) span.title = title;
    return span;
  }

  function setTileIconState(iconEl, on) {
    iconEl?.classList.toggle('off', !on);
  }

  function createVuMeter(size) {
    const wrap = el('span', `vu-meter${size ? ` ${size}` : ''}`);
    const fill = el('span', 'vu-fill');
    wrap.appendChild(fill);
    wrap.style.setProperty('--vu', '0');
    return wrap;
  }

  function setVuLevel(peerUserId, level) {
    const vu = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;

    const tileMeter = peerUserId === userId ? localTileVuMeter : remoteTiles.get(peerUserId)?.vuEl;
    tileMeter?.style.setProperty('--vu', String(vu));

    const listMeter = document.getElementById(`vu_${peerUserId}`);
    listMeter?.style.setProperty('--vu', String(vu));
  }

  function initLocalTileUi() {
    if (!localTileEl || !localTileStatusEl) return;

    if (localTileStatusEl.childElementCount === 0) {
      localTileMicIcon = createTileIcon('mic', '麦克风');
      localTileCamIcon = createTileIcon('cam', '摄像头');
      localTileVuMeter = createVuMeter();
      setTileIconState(localTileMicIcon, false);
      setTileIconState(localTileCamIcon, false);
      localTileStatusEl.appendChild(localTileMicIcon);
      localTileStatusEl.appendChild(localTileCamIcon);
      localTileStatusEl.appendChild(localTileVuMeter);
    }

    if (localInitialsEl && !localInitialsEl.textContent) {
      localInitialsEl.textContent = '?';
    }
  }

  function initials(displayName) {
    const name = (displayName || '').trim();
    if (!name) return '?';
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts.length ? parts[0] : name;
    return Array.from(first)[0] || '?';
  }

  function ensureRemoteEmptyTile() {
    if (!remoteVideos) return null;
    let empty = document.getElementById('remoteEmpty');
    if (empty) return empty;
    empty = el('div', 'video-empty text-secondary');
    empty.id = 'remoteEmpty';
    empty.textContent = '暂无其它成员';
    remoteVideos.appendChild(empty);
    return empty;
  }

  function ensureRemoteTile(peerUserId) {
    if (!remoteVideos) return null;
    let tile = remoteTiles.get(peerUserId);
    if (tile) return tile;

    const wrap = el('div', 'video-tile participant-tile cam-off');
    wrap.id = `tile_${peerUserId}`;
    wrap.dataset.userId = peerUserId;

    const video = el('video', 'remote-video');
    video.id = `remote_${peerUserId}`;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('click', () => tryPlayAllMedia());

    const audio = el('audio', 'remote-audio');
    audio.id = `audio_${peerUserId}`;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.preload = 'auto';

    const placeholderEl = el('div', 'tile-placeholder');
    const initialsEl = el('div', 'tile-initials');
    initialsEl.textContent = '?';
    placeholderEl.appendChild(initialsEl);

    const overlay = el('div', 'tile-overlay');
    const nameEl = el('div', 'tile-name');
    nameEl.textContent = '成员';
    const status = el('div', 'tile-status');
    const micEl = createTileIcon('mic', '麦克风');
    const camEl = createTileIcon('cam', '摄像头');
    const vuEl = createVuMeter();
    setTileIconState(micEl, false);
    setTileIconState(camEl, false);
    status.appendChild(micEl);
    status.appendChild(camEl);
    status.appendChild(vuEl);
    overlay.appendChild(nameEl);
    overlay.appendChild(status);

    wrap.appendChild(video);
    wrap.appendChild(audio);
    wrap.appendChild(placeholderEl);
    wrap.appendChild(overlay);

    const empty = document.getElementById('remoteEmpty');
    if (empty) {
      remoteVideos.insertBefore(wrap, empty);
    } else {
      remoteVideos.appendChild(wrap);
    }

    tile = { tile: wrap, video, audio, nameEl, micEl, camEl, vuEl, placeholderEl, initialsEl };
    remoteTiles.set(peerUserId, tile);
    return tile;
  }

  function presenceVersionOf(member) {
    const v = member?.presenceVersion ?? member?.PresenceVersion ?? 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function resetPeerConnection(peerUserId, reason) {
    const peer = peers.get(peerUserId);
    if (peer) {
      try {
        peer.pc.ontrack = null;
        peer.pc.onicecandidate = null;
        peer.pc.onnegotiationneeded = null;
        peer.pc.close();
      } catch {}
      peers.delete(peerUserId);
    }

    pendingIce.delete(peerUserId);
    teardownSpeakingDetector(peerUserId);

    const stream = remoteStreams.get(peerUserId);
    if (stream) {
      remoteStreams.delete(peerUserId);
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
    }

    const tile = remoteTiles.get(peerUserId);
    if (tile) {
      try {
        tile.video.srcObject = null;
      } catch {}
      try {
        tile.audio.srcObject = null;
      } catch {}
    }

    updateRemoteTileVisual(peerUserId);
    updateStageMode();

    if (reason) {
      console.debug(`[rtc] reset ${peerUserId}: ${reason}`);
    }
  }

  function updateRemoteTileVisual(peerUserId) {
    const state = memberStateById.get(peerUserId) || null;
    const stream = remoteStreams.get(peerUserId) || null;
    const hasVideoTrack =
      !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);

    const tile = remoteTiles.get(peerUserId);
    if (!tile) return;

    const camOn = state ? !!state.camOn : hasVideoTrack;
    tile.tile.classList.toggle('cam-off', !(camOn && hasVideoTrack));
    updateStageMode();
  }

  function syncRemoteTiles(members) {
    ensureRemoteEmptyTile();

    const wanted = new Set();
    const prevStates = new Map(memberStateById);
    memberStateById.clear();

    for (const m of members || []) {
      if (!m?.userId) continue;
      memberStateById.set(m.userId, m);

      if (m.userId === userId) continue;
      wanted.add(m.userId);

      const prev = prevStates.get(m.userId) || null;
      const nextOnline = !!m.isOnline;
      const sessionChanged =
        nextOnline &&
        !!prev &&
        presenceVersionOf(prev) > 0 &&
        presenceVersionOf(m) > 0 &&
        presenceVersionOf(prev) !== presenceVersionOf(m);

      if (sessionChanged) {
        resetPeerConnection(m.userId, 'presenceVersion changed');
      }

      const tile = ensureRemoteTile(m.userId);
      if (!tile) continue;

      tile.nameEl.textContent = m.displayName || '匿名';
      tile.initialsEl.textContent = initials(m.displayName);
      setTileIconState(tile.micEl, !!m.micOn);
      if (!m.micOn) tile.micEl.classList.remove('speaking');
      setTileIconState(tile.camEl, !!m.camOn);
      updateRemoteTileVisual(m.userId);

      const stream = remoteStreams.get(m.userId) || null;
      if (stream) {
        if (m.micOn) {
          ensureSpeakingDetector(m.userId, stream);
        } else {
          teardownSpeakingDetector(m.userId);
        }
      } else if (!m.micOn) {
        teardownSpeakingDetector(m.userId);
      }

      const prevMic = prev ? !!prev.micOn : false;
      const prevCam = prev ? !!prev.camOn : false;
      const nextMic = !!m.micOn;
      const nextCam = !!m.camOn;

      const becameOnline = nextOnline && !(prev ? !!prev.isOnline : false);
      if (nextOnline && (!peers.has(m.userId) || becameOnline || sessionChanged)) {
        callPeer(m.userId).catch(() => {});
      } else if ((nextMic && !prevMic) || (nextCam && !prevCam)) {
        tryPlayAllMedia();
      }
    }

    for (const id of Array.from(remoteTiles.keys())) {
      if (!wanted.has(id)) {
        removeRemote(id);
      }
    }

    const empty = document.getElementById('remoteEmpty');
    empty?.classList.toggle('d-none', wanted.size > 0);

    const me = memberStateById.get(userId);
    if (me && localInitialsEl) {
      localInitialsEl.textContent = initials(me.displayName);
    }

    updateLocalTileUi();
    updateStageMode();
  }

  function isSmallScreen() {
    return !!window.matchMedia && window.matchMedia('(max-width: 991.98px)').matches;
  }

  function setDanmakuHidden(next, persist = true) {
    danmakuHidden = !!next;
    stageEl?.classList.toggle('danmaku-hidden', danmakuHidden);
    if (btnToggleChat) btnToggleChat.textContent = `弹幕：${danmakuHidden ? '隐藏' : '显示'}`;
    if (persist) localStorage.setItem('dr.danmakuHidden', danmakuHidden ? '1' : '0');
  }

  function setUiHidden(next) {
    uiHidden = !!next;
    stageEl?.classList.toggle('ui-hidden', uiHidden);
  }

  function remoteHasAnyVideo() {
    for (const [peerUserId, stream] of remoteStreams) {
      const state = memberStateById.get(peerUserId);
      const camOn = state ? !!state.camOn : true;
      if (!camOn) continue;

      if (stream?.getVideoTracks?.()?.some((t) => t.readyState === 'live' && !t.muted)) {
        return true;
      }
    }
    return false;
  }

  function localVideoLive() {
    return !!localVideoTrack && localVideoTrack.readyState === 'live' && localVideoTrack.enabled;
  }

  function updateStageMode() {
    const anyVideo = localVideoLive() || remoteHasAnyVideo();
    stageEl?.classList.toggle('audio-only', !anyVideo);
    remoteVideos?.classList.toggle('audio-only', !anyVideo);
  }

  function updateLocalMirror() {
    const actual = localVideoTrack?.getSettings?.()?.facingMode;
    const shouldMirror = actual ? actual !== 'environment' : preferredFacingMode !== 'environment';
    localVideo?.classList.toggle('mirrored', shouldMirror);
  }

  function updateLocalTileUi() {
    initLocalTileUi();

    setTileIconState(localTileMicIcon, myMicOn());
    setTileIconState(localTileCamIcon, myCamOn());

    if (!myMicOn()) {
      localTileMicIcon?.classList.remove('speaking');
    }

    localTileEl?.classList.toggle('cam-off', !localVideoLive());
    updateLocalMirror();
  }

  function updateSwitchCamButton() {
    if (!btnSwitchCam) return;
    const label = preferredFacingMode === 'environment' ? '后置' : '前置';
    btnSwitchCam.textContent = `切换摄像头：${label}`;
    const show = isSmallScreen() || (navigator.maxTouchPoints || 0) > 0;
    btnSwitchCam.classList.toggle('d-none', !show);
  }

  function hideZoomUi() {
    camZoomWrap?.classList.add('d-none');
    camZoomWrap?.classList.remove('d-flex');
  }

  function syncZoomUi() {
    if (!camZoomWrap || !camZoomInput) return;
    if (!localVideoTrack || typeof localVideoTrack.getCapabilities !== 'function') {
      hideZoomUi();
      return;
    }

    const caps = localVideoTrack.getCapabilities();
    const zoom = caps?.zoom;
    if (!zoom || typeof zoom !== 'object') {
      hideZoomUi();
      return;
    }

    const min = Number.isFinite(zoom.min) ? zoom.min : 1;
    const max = Number.isFinite(zoom.max) ? zoom.max : 1;
    const step = Number.isFinite(zoom.step) && zoom.step > 0 ? zoom.step : 0.1;

    if (max <= min) {
      hideZoomUi();
      return;
    }

    const settings = localVideoTrack.getSettings?.() || {};
    const value = Number.isFinite(settings.zoom) ? settings.zoom : min;

    camZoomInput.min = String(min);
    camZoomInput.max = String(max);
    camZoomInput.step = String(step);
    camZoomInput.value = String(value);

    camZoomWrap.classList.remove('d-none');
    camZoomWrap.classList.add('d-flex');
  }

  async function applyZoomFromUi() {
    if (!camZoomInput || !localVideoTrack) return;
    const zoom = Number(camZoomInput.value);
    if (!Number.isFinite(zoom)) return;

    try {
      await localVideoTrack.applyConstraints({ advanced: [{ zoom }] });
    } catch {
      try {
        await localVideoTrack.applyConstraints({ zoom });
      } catch {}
    }
  }

  function getAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    if (!audioCtx) {
      audioCtx = new Ctx();
      audioCtx.resume?.().catch(() => {});
      if (audioCtx.state !== 'running') {
        const resume = () => audioCtx?.resume().catch(() => {});
        document.addEventListener('click', resume, { once: true, capture: true });
        document.addEventListener('touchstart', resume, { once: true, capture: true });
      }
    }

    return audioCtx;
  }

  function setSpeaking(peerUserId, speaking) {
    const state = memberStateById.get(peerUserId);
    const micOn = peerUserId === userId ? myMicOn() : state ? !!state.micOn : true;
    const effective = !!speaking && micOn;

    if (effective) {
      speakingUsers.add(peerUserId);
    } else {
      speakingUsers.delete(peerUserId);
    }

    const tileEl = peerUserId === userId ? localTileEl : remoteTiles.get(peerUserId)?.tile;
    tileEl?.classList.toggle('speaking', effective);

    const tileMic = peerUserId === userId ? localTileMicIcon : remoteTiles.get(peerUserId)?.micEl;
    tileMic?.classList.toggle('speaking', effective);

    if (peerUserId === userId) {
      btnToggleMic?.classList.toggle('speaking', effective);
    }

    const listMic = document.getElementById(`mic_${peerUserId}`);
    listMic?.classList.toggle('speaking', effective);

    const dot = document.getElementById(`spk_${peerUserId}`);
    dot?.classList.toggle('d-none', !effective);
  }

  function teardownSpeakingDetector(peerUserId) {
    const d = audioDetectors.get(peerUserId);
    if (!d) return;
    audioDetectors.delete(peerUserId);

    try {
      d.source?.disconnect();
    } catch {}
    try {
      d.analyser?.disconnect();
    } catch {}
    try {
      d.gain?.disconnect();
    } catch {}

    setSpeaking(peerUserId, false);
    setVuLevel(peerUserId, 0);

    if (audioDetectors.size === 0 && speakingTimer) {
      clearInterval(speakingTimer);
      speakingTimer = null;
    }
  }

  function ensureSpeakingDetector(peerUserId, stream) {
    const track = stream?.getAudioTracks?.()?.find((t) => t.readyState === 'live') || null;
    if (!track) {
      teardownSpeakingDetector(peerUserId);
      return;
    }

    const existing = audioDetectors.get(peerUserId);
    if (existing && existing.trackId === track.id) {
      return;
    }

    teardownSpeakingDetector(peerUserId);

    const ctx = getAudioContext();
    if (!ctx) return;
    ctx.resume?.().catch(() => {});

    let source;
    try {
      source = ctx.createMediaStreamSource(new MediaStream([track]));
    } catch {
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    const data = new Uint8Array(analyser.fftSize);
    audioDetectors.set(peerUserId, {
      trackId: track.id,
      analyser,
      data,
      source,
      gain,
      lastLoudAt: 0,
      speaking: false,
      vu: 0,
    });

    if (!speakingTimer) {
      speakingTimer = window.setInterval(() => {
        const now = performance.now();
        for (const [id, d] of audioDetectors) {
          const state = memberStateById.get(id);
          const micOn = id === userId ? myMicOn() : state ? !!state.micOn : true;
          if (!micOn) {
            if (d.speaking) {
              d.speaking = false;
              setSpeaking(id, false);
            }
            if (d.vu !== 0) {
              d.vu = 0;
              setVuLevel(id, 0);
            }
            continue;
          }

          let rms = 0;
          try {
            d.analyser.getByteTimeDomainData(d.data);
            let sum = 0;
            for (let i = 0; i < d.data.length; i++) {
              const v = (d.data[i] - 128) / 128;
              sum += v * v;
            }
            rms = Math.sqrt(sum / d.data.length);
          } catch {
            continue;
          }

          const scaled = Math.min(1, Math.max(0, rms * 12));
          d.vu = d.vu * 0.55 + scaled * 0.45;
          setVuLevel(id, d.vu);

          const loud = rms > 0.02;
          if (loud) d.lastLoudAt = now;

          const speaking = now - d.lastLoudAt < 300;
          if (speaking !== d.speaking) {
            d.speaking = speaking;
            setSpeaking(id, speaking);
          }
        }

        if (audioDetectors.size === 0) {
          clearInterval(speakingTimer);
          speakingTimer = null;
        }
      }, 120);
    }
  }

  function setButtonState(button, on, label) {
    if (!button) return;
    button.textContent = `${label}：${on ? '开启' : '关闭'}`;
    button.classList.toggle('btn-outline-primary', !on);
    button.classList.toggle('btn-primary', on);
  }

  async function ensureAudioTrack() {
    if (localAudioTrack) return localAudioTrack;
    if (!isSecureContextForMedia()) {
      throw new Error(`当前页面不是安全上下文，麦克风需要使用 https（证书需被信任）或 localhost 访问。当前地址：${location.origin}`);
    }

    const p = getUserMediaCompat({ audio: true, video: false });
    if (!p) {
      throw new Error('浏览器不支持麦克风（getUserMedia 不可用），请使用最新版 Chrome/Edge/Safari');
    }

    const stream = await p;
    localAudioTrack = stream.getAudioTracks()[0] || null;
    if (localAudioTrack) localAudioTrack.enabled = true;
    return localAudioTrack;
  }

  async function ensureVideoTrack() {
    if (localVideoTrack) return localVideoTrack;
    if (!isSecureContextForMedia()) {
      throw new Error(`当前页面不是安全上下文，摄像头需要使用 https（证书需被信任）或 localhost 访问。当前地址：${location.origin}`);
    }

    const facing =
      preferredFacingMode === 'environment' || preferredFacingMode === 'user' ? preferredFacingMode : 'user';

    const p1 = getUserMediaCompat({ audio: false, video: { facingMode: { ideal: facing } } });
    if (!p1) {
      throw new Error('浏览器不支持摄像头（getUserMedia 不可用），请使用最新版 Chrome/Edge/Safari');
    }

    let stream = null;
    try {
      stream = await p1;
    } catch (e) {
      const p2 = getUserMediaCompat({ audio: false, video: true });
      if (!p2) throw e;
      stream = await p2;
    }

    localVideoTrack = stream.getVideoTracks()[0] || null;
    if (localVideoTrack) localVideoTrack.enabled = true;
    if (localVideoTrack && localVideo) {
      const ms = new MediaStream([localVideoTrack]);
      localVideo.srcObject = ms;
    }

    syncZoomUi();
    updateLocalTileUi();
    updateStageMode();
    return localVideoTrack;
  }

  async function replaceTrackSafe(sender, track) {
    if (!sender || typeof sender.replaceTrack !== 'function') return;
    try {
      const p = sender.replaceTrack(track || null);
      if (p && typeof p.then === 'function') {
        await p.catch(() => {});
      }
    } catch {}
  }

  function ensureDummyAudioTrack() {
    if (dummyAudioTrack && dummyAudioTrack.readyState === 'live') {
      return dummyAudioTrack;
    }

    const ctx = getAudioContext();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') {
      return null;
    }

    try {
      dummyAudioDest = ctx.createMediaStreamDestination();
      dummyAudioGain = ctx.createGain();
      dummyAudioGain.gain.value = 0;

      if (typeof ctx.createConstantSource === 'function') {
        dummyAudioSource = ctx.createConstantSource();
        dummyAudioSource.offset.value = 0;
      } else {
        dummyAudioSource = ctx.createOscillator();
        dummyAudioSource.frequency.value = 440;
      }

      dummyAudioSource.connect(dummyAudioGain);
      dummyAudioGain.connect(dummyAudioDest);
      dummyAudioSource.start?.();

      dummyAudioTrack = dummyAudioDest.stream.getAudioTracks()?.[0] || null;
      return dummyAudioTrack;
    } catch {
      dummyAudioTrack = null;
      return null;
    }
  }

  function ensureDummyVideoTrack() {
    if (dummyVideoTrack && dummyVideoTrack.readyState === 'live') {
      return dummyVideoTrack;
    }

    if (!document?.createElement) return null;

    const canvas = dummyVideoCanvas || document.createElement('canvas');
    dummyVideoCanvas = canvas;
    canvas.width = 640;
    canvas.height = 360;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const draw = () => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };

    draw();
    if (dummyVideoTimer) window.clearInterval(dummyVideoTimer);
    dummyVideoTimer = window.setInterval(draw, 1000);

    if (typeof canvas.captureStream !== 'function') return null;
    const stream = canvas.captureStream(1);
    dummyVideoTrack = stream?.getVideoTracks?.()?.[0] || null;
    if (dummyVideoTrack) {
      try {
        dummyVideoTrack.enabled = true;
      } catch {}
    }
    return dummyVideoTrack;
  }

  function outgoingAudioTrack() {
    if (localAudioTrack && localAudioTrack.readyState === 'live') return localAudioTrack;
    return ensureDummyAudioTrack();
  }

  function outgoingVideoTrack() {
    if (localVideoTrack && localVideoTrack.readyState === 'live') return localVideoTrack;
    return ensureDummyVideoTrack();
  }

  async function updateAllSenders() {
    const ops = [];
    for (const peer of peers.values()) {
      if (peer.audioTransceiver?.sender) {
        ops.push(replaceTrackSafe(peer.audioTransceiver.sender, outgoingAudioTrack()));
      }
      if (peer.videoTransceiver?.sender) {
        ops.push(replaceTrackSafe(peer.videoTransceiver.sender, outgoingVideoTrack()));
      }
    }
    await Promise.all(ops);
  }

  function myMicOn() {
    return !!localAudioTrack && localAudioTrack.readyState === 'live' && localAudioTrack.enabled;
  }

  function myCamOn() {
    return !!localVideoTrack && localVideoTrack.readyState === 'live' && localVideoTrack.enabled;
  }

  async function broadcastMyMediaState() {
    if (connection?.state !== signalR.HubConnectionState.Connected) return;
    await connection.invoke('UpdateMediaState', roomId, myMicOn(), myCamOn()).catch(() => {});
  }

  function comparePeerIds(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'en', { sensitivity: 'base' });
  }

  async function forceSendRecv(peer) {
    if (!peer?.pc) return;

    await replaceTrackSafe(peer.audioTransceiver?.sender, outgoingAudioTrack());
    await replaceTrackSafe(peer.videoTransceiver?.sender, outgoingVideoTrack());

    const transceivers = peer.pc.getTransceivers?.() || [];
    for (const t of transceivers) {
      const kind = t?.receiver?.track?.kind || t?.sender?.track?.kind || null;
      if (kind !== 'audio' && kind !== 'video') continue;
      try {
        t.direction = 'sendrecv';
      } catch {}
    }

    try {
      if (peer.audioTransceiver) peer.audioTransceiver.direction = 'sendrecv';
    } catch {}
    try {
      if (peer.videoTransceiver) peer.videoTransceiver.direction = 'sendrecv';
    } catch {}
  }

  async function negotiate(peerUserId) {
    const peer = peers.get(peerUserId);
    if (!peer) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    if (peer.makingOffer) {
      peer.needsNegotiation = true;
      return;
    }

    if (peer.pc.signalingState !== 'stable') {
      peer.needsNegotiation = true;
      scheduleNegotiation(peerUserId);
      return;
    }

    peer.makingOffer = true;
    try {
      await forceSendRecv(peer);
      const offer = peer.wantsIceRestart
        ? await peer.pc.createOffer({ iceRestart: true })
        : await peer.pc.createOffer();
      peer.wantsIceRestart = false;
      await peer.pc.setLocalDescription(offer);
      await connection.invoke('SendOffer', roomId, peerUserId, peer.pc.localDescription);
    } catch (e) {
      console.error(e);
    } finally {
      peer.makingOffer = false;
      if (peer.needsNegotiation) {
        peer.needsNegotiation = false;
        scheduleNegotiation(peerUserId);
      }
    }
  }

  function scheduleNegotiation(peerUserId) {
    const peer = peers.get(peerUserId);
    if (!peer) return;
    if (peer.negotiationTimer) return;

    peer.negotiationTimer = window.setTimeout(() => {
      peer.negotiationTimer = null;
      negotiate(peerUserId);
    }, 60);
  }

  function scheduleNegotiationForAllPeers() {
    for (const peerUserId of peers.keys()) {
      scheduleNegotiation(peerUserId);
    }
  }

  function buildPeerConnection(peerUserId) {
    const pc = new RTCPeerConnection(rtcConfiguration);

    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });

    audioTransceiver.sender.replaceTrack(outgoingAudioTrack());
    videoTransceiver.sender.replaceTrack(outgoingVideoTrack());

    pc.onnegotiationneeded = () => {
      const schedule = () => scheduleNegotiation(peerUserId);
      if (peers.has(peerUserId)) {
        schedule();
      } else {
        window.setTimeout(schedule, 0);
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        connection
          .invoke('SendIceCandidate', roomId, peerUserId, {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
          })
          .catch(() => {});
      }
    };

    pc.ontrack = (e) => {
      const incomingStream = e.streams?.[0] || null;
      let stream = remoteStreams.get(peerUserId) || null;

      if (!stream) {
        stream = incomingStream || new MediaStream();
        remoteStreams.set(peerUserId, stream);
      }

      if (incomingStream && incomingStream !== stream) {
        for (const t of incomingStream.getTracks()) {
          if (!stream.getTracks().some((x) => x.id === t.id)) {
            stream.addTrack(t);
          }
        }
      }

      if (e.track && !stream.getTracks().some((t) => t.id === e.track.id)) {
        for (const old of stream.getTracks()) {
          if (old.kind === e.track.kind && old.id !== e.track.id) {
            try {
              stream.removeTrack(old);
            } catch {}
          }
        }
        stream.addTrack(e.track);

        const refresh = () => attachRemoteStream(peerUserId, stream);
        try {
          e.track.addEventListener('unmute', refresh);
          e.track.addEventListener('mute', refresh);
          e.track.addEventListener('ended', refresh);
        } catch {}
      }

      attachRemoteStream(peerUserId, stream);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        const peer = peers.get(peerUserId);
        if (peer) {
          peer.wantsIceRestart = true;
          scheduleNegotiation(peerUserId);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        const peer = peers.get(peerUserId);
        if (peer) {
          peer.wantsIceRestart = true;
          scheduleNegotiation(peerUserId);
        }
      }
    };

    const isPolite = comparePeerIds(userId, peerUserId) < 0;
    return {
      pc,
      audioTransceiver,
      videoTransceiver,
      isPolite,
      makingOffer: false,
      needsNegotiation: false,
      wantsIceRestart: false,
      negotiationTimer: null,
    };
  }

  function attachRemoteStream(peerUserId, stream) {
    ensureRemoteEmptyTile();
    const tile = ensureRemoteTile(peerUserId);
    const video = tile?.video || document.getElementById(`remote_${peerUserId}`);
    const audio = tile?.audio || document.getElementById(`audio_${peerUserId}`);

    if (!video && !audio) return;

    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }

    if (audio && audio.srcObject !== stream) {
      audio.srcObject = stream;
      audio.play?.().catch(() => {});
    }

    updateRemoteTileVisual(peerUserId);

    const state = memberStateById.get(peerUserId);
    const micOn = state ? !!state.micOn : true;
    if (micOn) {
      ensureSpeakingDetector(peerUserId, stream);
    } else {
      teardownSpeakingDetector(peerUserId);
    }
  }

  function removeRemote(peerUserId) {
    const peer = peers.get(peerUserId);
    if (peer) {
      try {
        peer.pc.close();
      } catch {}
      peers.delete(peerUserId);
    }

    pendingIce.delete(peerUserId);
    teardownSpeakingDetector(peerUserId);

    const stream = remoteStreams.get(peerUserId);
    if (stream) {
      remoteStreams.delete(peerUserId);
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {}
      }
    }

    const tile = remoteTiles.get(peerUserId);
    if (tile) {
      try {
        tile.tile.remove();
      } catch {}
      remoteTiles.delete(peerUserId);
    } else {
      const tileEl = document.getElementById(`tile_${peerUserId}`);
      if (tileEl) tileEl.remove();

      const video = document.getElementById(`remote_${peerUserId}`);
      if (video) video.remove();
    }

    const empty = document.getElementById('remoteEmpty');
    empty?.classList.toggle('d-none', remoteTiles.size > 0);
    updateStageMode();
  }

  const DANMAKU_SPEED_PX_PER_SEC = 120;
  const DANMAKU_GAP_PX = 24;
  const DANMAKU_LANE_HEIGHT_PX = 34;
  let danmakuLaneState = []; // { availableAt: number }[]

  function syncDanmakuLanes(laneCount) {
    if (danmakuLaneState.length === laneCount) return;
    const next = new Array(laneCount);
    for (let i = 0; i < laneCount; i++) {
      next[i] = danmakuLaneState[i] || { availableAt: 0 };
    }
    danmakuLaneState = next;
  }

  function pickDanmakuLane(now, laneCount) {
    syncDanmakuLanes(laneCount);

    let bestIdx = 0;
    let bestAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < laneCount; i++) {
      const at = danmakuLaneState[i].availableAt || 0;
      if (at <= now) return { idx: i, startAt: now };
      if (at < bestAt) {
        bestAt = at;
        bestIdx = i;
      }
    }

    return { idx: bestIdx, startAt: bestAt };
  }

  function animateDanmaku(item, distancePx, durationMs) {
    if (!item || !Number.isFinite(distancePx) || !Number.isFinite(durationMs)) return;

    if (typeof item.animate === 'function') {
      const anim = item.animate(
        [{ transform: 'translateX(0px)' }, { transform: `translateX(-${distancePx}px)` }],
        {
          duration: Math.max(800, durationMs),
          easing: 'linear',
          fill: 'forwards',
        },
      );
      anim.onfinish = () => item.remove();
      return;
    }

    item.style.transition = `transform ${Math.max(800, durationMs)}ms linear`;
    requestAnimationFrame(() => {
      item.style.transform = `translateX(-${distancePx}px)`;
    });
    window.setTimeout(() => item.remove(), Math.max(900, durationMs) + 120);
  }

  const DANMAKU_HISTORY_LIMIT = 200;

  function normalizeChatMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;

    const userIdValue = msg.userId ?? msg.UserId ?? null;
    if (!userIdValue) return null;

    return {
      userId: String(userIdValue),
      displayName: String(msg.displayName ?? msg.DisplayName ?? ''),
      content: String(msg.content ?? msg.Content ?? ''),
      sentAt: msg.sentAt ?? msg.SentAt ?? null,
    };
  }

  function formatChatTime(sentAt) {
    if (!sentAt) return '';
    try {
      const d = new Date(sentAt);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function isNearBottom(scrollEl, thresholdPx = 56) {
    if (!scrollEl) return true;
    const remaining = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return remaining < thresholdPx;
  }

  function appendDanmakuHistory(rawMsg) {
    const msg = normalizeChatMessage(rawMsg);
    if (!msg) return;

    const displayName = (msg.displayName || '').trim() || '匿名';
    const content = (msg.content || '').trim();
    if (!content) return;

    if (!danmakuHistoryListEl) return;
    const mine = msg.userId === userId;

    const stickToBottom = historyOpen && isNearBottom(danmakuHistoryListEl);

    const item = el('div', `danmaku-history-item${mine ? ' mine' : ''}`);
    const meta = el('div', 'meta');
    const nameEl = el('span', 'name');
    nameEl.textContent = displayName;
    const timeEl = el('span', 'time');
    timeEl.textContent = formatChatTime(msg.sentAt);
    meta.appendChild(nameEl);
    meta.appendChild(timeEl);

    const contentEl = el('div', 'content');
    contentEl.textContent = content;

    item.appendChild(meta);
    item.appendChild(contentEl);
    danmakuHistoryListEl.appendChild(item);

    while (danmakuHistoryListEl.childElementCount > DANMAKU_HISTORY_LIMIT) {
      danmakuHistoryListEl.firstElementChild?.remove();
    }

    if (stickToBottom) {
      requestAnimationFrame(() => {
        danmakuHistoryListEl.scrollTop = danmakuHistoryListEl.scrollHeight;
      });
    }
  }

  function setHistoryOpen(next) {
    historyOpen = !!next;
    danmakuHistoryPanelEl?.classList.toggle('d-none', !historyOpen);
    danmakuHistoryPanelEl?.setAttribute('aria-hidden', historyOpen ? 'false' : 'true');

    if (historyOpen && danmakuHistoryListEl) {
      requestAnimationFrame(() => {
        danmakuHistoryListEl.scrollTop = danmakuHistoryListEl.scrollHeight;
      });
    }
  }

  function spawnDanmaku(rawMsg) {
    appendDanmakuHistory(rawMsg);

    if (danmakuHidden) return;
    if (!danmakuLayerEl) return;

    const msg = normalizeChatMessage(rawMsg);
    if (!msg) return;

    const layerWidth = danmakuLayerEl.clientWidth || 0;
    const layerHeight = danmakuLayerEl.clientHeight || 0;
    if (layerWidth <= 0 || layerHeight <= 0) return;

    const laneCount = Math.max(1, Math.floor(layerHeight / DANMAKU_LANE_HEIGHT_PX));
    const now = performance.now();
    const { idx: laneIdx, startAt } = pickDanmakuLane(now, laneCount);

    const mine = msg.userId === userId;
    const name = (msg.displayName || '').trim() || '匿名';
    const content = (msg.content || '').trim();
    if (!content) return;

    const item = el('div', `danmaku-item${mine ? ' mine' : ''}`);
    item.textContent = `${name}：${content}`;
    item.style.top = `${laneIdx * DANMAKU_LANE_HEIGHT_PX}px`;
    item.style.left = `${layerWidth}px`;
    item.style.opacity = '0';
    item.style.willChange = 'transform';

    danmakuLayerEl.appendChild(item);

    requestAnimationFrame(() => {
      const itemWidth = item.offsetWidth || 0;
      const distancePx = layerWidth + itemWidth + DANMAKU_GAP_PX;
      const speed = DANMAKU_SPEED_PX_PER_SEC / 1000;
      const durationMs = distancePx / speed;
      const safeDelayMs = (itemWidth + DANMAKU_GAP_PX) / speed;

      danmakuLaneState[laneIdx].availableAt = startAt + safeDelayMs;

      const delayMs = Math.max(0, startAt - performance.now());
      window.setTimeout(() => {
        item.style.opacity = '1';
        animateDanmaku(item, distancePx, durationMs);
      }, delayMs);
    });
  }

  async function postJson(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        RequestVerificationToken: csrfToken,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '请求失败');
      throw new Error(text || '请求失败');
    }
  }

  function renderMembers(members) {
    if (!memberListEl) return;
    memberListEl.innerHTML = '';

    for (const m of members || []) {
      const item = el('div', 'list-group-item d-flex align-items-center justify-content-between gap-2');
      item.dataset.userId = m.userId;
      item.id = `member_${m.userId}`;

      const left = el('div', 'text-truncate');
      const name = el('div', 'text-truncate');
      name.textContent = m.displayName || '匿名';

      const badges = el('div', 'd-flex gap-1 flex-wrap');
      if (m.isOnline) {
        const b = el('span', 'badge text-bg-success');
        b.textContent = '在线';
        badges.appendChild(b);
      } else {
        const b = el('span', 'badge text-bg-secondary');
        b.textContent = '离线';
        badges.appendChild(b);
      }

      if (m.role === 'Owner') {
        const b = el('span', 'badge text-bg-warning');
        b.textContent = '房主';
        badges.appendChild(b);
      } else if (m.role === 'Admin') {
        const b = el('span', 'badge text-bg-info');
        b.textContent = '管理员';
        badges.appendChild(b);
      }

      left.appendChild(name);
      left.appendChild(badges);

      item.appendChild(left);

      const right = el('div', 'd-flex align-items-center gap-2 flex-shrink-0');

      const media = el('div', 'd-flex align-items-center gap-1');
      const mic = createTileIcon('mic', '麦克风');
      mic.classList.add('sm');
      mic.id = `mic_${m.userId}`;
      setTileIconState(mic, !!m.micOn);
      if (!m.micOn) mic.classList.remove('speaking');
      const cam = createTileIcon('cam', '摄像头');
      cam.classList.add('sm');
      setTileIconState(cam, !!m.camOn);
      const vu = createVuMeter('sm');
      vu.id = `vu_${m.userId}`;
      media.appendChild(mic);
      media.appendChild(cam);
      media.appendChild(vu);
      right.appendChild(media);

      const speaking = el('span', 'speaking-dot d-none');
      speaking.id = `spk_${m.userId}`;
      right.appendChild(speaking);

      if (isOwner && m.userId !== userId && m.role !== 'Owner') {
        const btn = el('button', 'btn btn-outline-secondary btn-sm text-nowrap');
        const makeAdmin = m.role !== 'Admin';
        btn.textContent = makeAdmin ? '设为管理员' : '取消管理员';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await postJson(setAdminUrl, {
              roomId,
              targetUserId: m.userId,
              makeAdmin,
            });
          } catch (e) {
            alert(e?.message || '操作失败');
          } finally {
            btn.disabled = false;
          }
        });
        right.appendChild(btn);
      }

      item.appendChild(right);
      memberListEl.appendChild(item);
    }

    for (const id of speakingUsers) {
      document.getElementById(`spk_${id}`)?.classList.remove('d-none');
      document.getElementById(`mic_${id}`)?.classList.add('speaking');
    }
  }

  const connection = new signalR.HubConnectionBuilder()
    .withUrl('/hubs/room')
    .withAutomaticReconnect()
    .build();

  connection.onreconnecting(() => setStatus('实时连接：重连中...', 'warning'));
  let syncingAfterReconnect = false;
  async function syncRoomAfterReconnect() {
    if (syncingAfterReconnect) return;
    syncingAfterReconnect = true;
    try {
      setStatus('实时连接：已连接（同步房间中...）', 'warning');
      const peersToCall = await connection.invoke(cfg.joinHubMethod || 'JoinRoom', roomId, userId);
      await broadcastMyMediaState();
      for (const p of peersToCall || []) {
        if (!p?.userId || p.userId === userId) continue;
        if (!peers.has(p.userId)) {
          await callPeer(p.userId);
        } else {
          scheduleNegotiation(p.userId);
        }
      }
      scheduleNegotiationForAllPeers();
      setStatus('实时连接：已连接', 'success');
    } catch (e) {
      console.error(e);
      setStatus('实时连接：已连接（同步失败）', 'warning');
    } finally {
      syncingAfterReconnect = false;
    }
  }

  connection.onreconnected(() => {
    syncRoomAfterReconnect().catch(() => {});
  });
  connection.onclose(() => setStatus('实时连接：已断开（刷新页面重试）', 'danger'));

  connection.on('ReceiveChatMessage', (msg) => spawnDanmaku(msg));
  connection.on('MembersUpdated', (members) => {
    updateOwnership(members);
    syncRemoteTiles(members);
    renderMembers(members);
  });
  connection.on('PeerLeft', (peerUserId) => removeRemote(peerUserId));

  connection.on('ReceiveOffer', async (evt) => {
    const fromUserId = evt?.fromUserId;
    const desc = evt?.payload;
    if (!fromUserId || !desc) return;

    let peer = peers.get(fromUserId);
    if (!peer) {
      peer = buildPeerConnection(fromUserId);
      peers.set(fromUserId, peer);
    }

    const offerCollision =
      desc.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');

    if (offerCollision && !peer.isPolite) {
      return;
    }

    try {
      if (offerCollision) {
        await peer.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      }

      await peer.pc.setRemoteDescription(desc);
      await forceSendRecv(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await connection.invoke('SendAnswer', roomId, fromUserId, peer.pc.localDescription);
    } catch (e) {
      console.error(e);
      return;
    }

    const queued = pendingIce.get(fromUserId) || [];
    pendingIce.delete(fromUserId);
    for (const c of queued) {
      await peer.pc.addIceCandidate(c).catch(() => {});
    }
  });

  connection.on('ReceiveAnswer', async (evt) => {
    const fromUserId = evt?.fromUserId;
    const desc = evt?.payload;
    if (!fromUserId || !desc) return;

    const peer = peers.get(fromUserId);
    if (!peer) return;

    await peer.pc.setRemoteDescription(desc);

    const queued = pendingIce.get(fromUserId) || [];
    pendingIce.delete(fromUserId);
    for (const c of queued) {
      await peer.pc.addIceCandidate(c).catch(() => {});
    }
  });

  connection.on('ReceiveIceCandidate', async (evt) => {
    const fromUserId = evt?.fromUserId;
    const c = evt?.payload;
    if (!fromUserId || !c) return;

    const peer = peers.get(fromUserId);
    if (!peer || !peer.pc.remoteDescription) {
      const list = pendingIce.get(fromUserId) || [];
      list.push(c);
      pendingIce.set(fromUserId, list);
      return;
    }

    await peer.pc.addIceCandidate(c).catch(() => {});
  });

  async function start() {
    try {
      setStatus('实时连接：连接中...', 'warning');
      await connection.start();
      const peersToCall = await connection.invoke(cfg.joinHubMethod || 'JoinRoom', roomId, userId);
      await broadcastMyMediaState();
      for (const p of peersToCall || []) {
        if (!p.userId || p.userId === userId) continue;
        await callPeer(p.userId);
      }
      setStatus('实时连接：已连接', 'success');
    } catch (e) {
      console.error(e);
      setStatus('实时连接：连接失败（请返回列表重新加入）', 'danger');
      alert('连接失败，请刷新重试。');
    }
  }

  async function callPeer(peerUserId) {
    if (peers.has(peerUserId)) return;

    const peer = buildPeerConnection(peerUserId);
    peers.set(peerUserId, peer);
    await negotiate(peerUserId);
  }

  chatFormEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (connection.state !== signalR.HubConnectionState.Connected) {
      setStatus('实时连接：未连接（请刷新页面重试）', 'danger');
      return;
    }
    const text = (chatInputEl?.value || '').trim();
    if (!text) return;
    chatInputEl.value = '';
    await connection.invoke('SendChatMessage', roomId, text).catch((err) => {
      console.error(err);
      setStatus('实时连接：发送失败（请稍后重试）', 'danger');
    });
  });

  btnToggleMic?.addEventListener('click', async () => {
    try {
      if (!localAudioTrack) {
        await ensureAudioTrack();
        await updateAllSenders();
        scheduleNegotiationForAllPeers();
        setButtonState(btnToggleMic, true, '麦克风');
        ensureSpeakingDetector(userId, new MediaStream([localAudioTrack]));
        updateLocalTileUi();
        await broadcastMyMediaState();
        return;
      }

      const oldTrack = localAudioTrack;
      localAudioTrack = null;
      await updateAllSenders();
      try {
        oldTrack?.stop?.();
      } catch {}
      setButtonState(btnToggleMic, false, '麦克风');
      teardownSpeakingDetector(userId);
      updateLocalTileUi();
      await broadcastMyMediaState();
    } catch (e) {
      const name = e?.name || 'Error';
      const msg = e?.message || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        alert('无法开启麦克风：权限被拒绝。请在浏览器地址栏的权限设置中允许麦克风后刷新页面。');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        alert('无法开启麦克风：未检测到麦克风设备。');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        alert('无法开启麦克风：设备可能被占用（例如系统/会议软件正在使用）。');
      } else if (name === 'SecurityError') {
        alert('无法开启麦克风：当前地址不安全。请使用 https 或 localhost 访问。');
      } else if (msg) {
        alert(`无法开启麦克风：${msg}`);
      } else {
        alert('无法开启麦克风：请检查浏览器权限/是否为 https 或 localhost。');
      }
    }
  });

  btnToggleCam?.addEventListener('click', async () => {
    try {
      if (!localVideoTrack) {
        await ensureVideoTrack();
        await updateAllSenders();
        scheduleNegotiationForAllPeers();
        setButtonState(btnToggleCam, true, '摄像头');
        updateLocalTileUi();
        await broadcastMyMediaState();
        return;
      }

      const oldTrack = localVideoTrack;
      localVideoTrack = null;
      if (localVideo) localVideo.srcObject = null;
      await updateAllSenders();
      try {
        oldTrack?.stop?.();
      } catch {}
      hideZoomUi();
      setButtonState(btnToggleCam, false, '摄像头');
      updateLocalTileUi();
      updateStageMode();
      await broadcastMyMediaState();
    } catch (e) {
      const name = e?.name || 'Error';
      const msg = e?.message || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        alert('无法开启摄像头：权限被拒绝。请在浏览器地址栏的权限设置中允许摄像头后刷新页面。');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        alert('无法开启摄像头：未检测到摄像头设备。');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        alert('无法开启摄像头：设备可能被占用（例如会议软件正在使用）。');
      } else if (name === 'SecurityError') {
        alert('无法开启摄像头：当前地址不安全。请使用 https 或 localhost 访问。');
      } else if (msg) {
        alert(`无法开启摄像头：${msg}`);
      } else {
        alert('无法开启摄像头：请检查浏览器权限/是否为 https 或 localhost。');
      }
    }
  });

  initLocalTileUi();
  ensureRemoteEmptyTile();

  setButtonState(btnToggleMic, false, '麦克风');
  setButtonState(btnToggleCam, false, '摄像头');
  updateSwitchCamButton();
  window.addEventListener('resize', () => updateSwitchCamButton());

  let lastPlayKickAt = 0;
  function kickPlayback(throttleMs = 400) {
    const now = performance.now();
    if (now - lastPlayKickAt < throttleMs) return;
    lastPlayKickAt = now;
    tryPlayAllMedia();
  }

  const unlock = () => kickPlayback(0);
  document.addEventListener('click', unlock, { capture: true });
  document.addEventListener('touchstart', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  window.addEventListener('focus', () => kickPlayback());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) kickPlayback();
  });

  const danmakuPref =
    localStorage.getItem('dr.danmakuHidden') ?? localStorage.getItem('dr.chatHidden') ?? '0';
  setDanmakuHidden(danmakuPref === '1', false);
  updateLocalTileUi();
  updateStageMode();

  for (const m of cfg.recentMessages || []) {
    appendDanmakuHistory(m);
  }

  camZoomInput?.addEventListener('input', () => applyZoomFromUi().catch(() => {}));

  btnSwitchCam?.addEventListener('click', async () => {
    preferredFacingMode = preferredFacingMode === 'environment' ? 'user' : 'environment';
    localStorage.setItem('dr.facingMode', preferredFacingMode);
    updateSwitchCamButton();

    if (!localVideoTrack) {
      updateLocalMirror();
      return;
    }

    const oldTrack = localVideoTrack;
    localVideoTrack = null;
    if (localVideo) localVideo.srcObject = null;
    hideZoomUi();
    await updateAllSenders();
    try {
      oldTrack?.stop?.();
    } catch {}

    try {
      await ensureVideoTrack();
      await updateAllSenders();
      scheduleNegotiationForAllPeers();
      setButtonState(btnToggleCam, true, '摄像头');
      updateLocalTileUi();
      await broadcastMyMediaState();
    } catch (e) {
      console.error(e);
      setButtonState(btnToggleCam, false, '摄像头');
      updateLocalTileUi();
      await broadcastMyMediaState();
      alert(`切换摄像头失败：${e?.message || '请稍后重试'}`);
    }
  });

  btnToggleChat?.addEventListener('click', () => setDanmakuHidden(!danmakuHidden));
  btnDanmakuHistory?.addEventListener('click', () => setHistoryOpen(!historyOpen));
  btnCloseDanmakuHistory?.addEventListener('click', () => setHistoryOpen(false));

  stageEl?.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (danmakuHistoryPanelEl?.contains(target)) return;
    if (target.closest('button, input, textarea, select, a, form')) return;
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setUiHidden(!uiHidden);
  });

  window.addEventListener('beforeunload', () => {
    try {
      localAudioTrack?.stop?.();
    } catch {}
    try {
      localVideoTrack?.stop?.();
    } catch {}
  });

  applyOwnerUi();
  start();
})();
