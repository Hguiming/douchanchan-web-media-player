(() => {
  'use strict';

  const mediaModal = document.getElementById('mediaModal');
  const mediaContainer = document.getElementById('mediaContainer');
  let reportItems = Array.isArray(window.DCC_PLAYER_ITEMS) ? window.DCC_PLAYER_ITEMS : [];

  if (!mediaModal || !mediaContainer) {
    throw new Error('DCC Player: missing #mediaModal or #mediaContainer');
  }

  let currentGroupIndex = -1;
  let currentMediaIndex = 0;
  let currentFiles = [];
  let currentAudio = null;
  let currentAudioGroupIndex = -1;
  let audioStatusTimer = null;
  // 音乐跑马灯使用持久时间轴：同组切换媒体即使顶部按钮 DOM 重建，
  // 也从原来的滚动相位继续，而不是重新从开头刷新。
  let audioMarqueeEpoch = 0;
  let audioMarqueeKey = '';
  const AUDIO_MARQUEE_DURATION_MS = 7000;
  let zoomStatusTimer = null;
  let mediaTitleFeedbackTimer = null;
  let mediaCaptionVisible = true;
  // 虚化背景默认关闭；在一次播放器打开期间保持开关状态，切换媒体/组别时只更新背景源。
  let blurBackgroundEnabled = false;
  let currentBlurBackgroundKey = '';
  let currentBlurBackgroundSource = '';
  let currentImageZoom = 1;
  let currentImageBaseScale = 1;
  let currentImagePanX = 0;
  let currentImagePanY = 0;
  let currentMediaDirection = 'left';
  let currentGroupDirection = '';
  // 默认所有媒体切换使用滑动；仅视频自然结束且下一媒体为图片时临时使用 dissolve。
  let currentMediaTransition = 'slide';
  let imageDragState = null;
  // 单击图片切换自动播放：独立记录指针轨迹，避免与拖拽状态互相干扰。
  let imageClickState = null;
  let currentImageElement = null;
  let currentImageViewport = null;
  let dragRaf = 0;
  let mediaAutoAdvanceTimer = 0;
  let mediaAutoAdvanceStartedAt = 0;
  let videoProgressRaf = 0;
  let mediaButtonFeedbackTimer = 0;
  let mediaProgressFeedbackTimer = 0;
  let fullscreenActive = false;
  // 每个作品组独立记忆自动播放开关；未进入过关闭状态的组默认开启。
  const autoPlayDisabledGroups = new Set();
  let volumeDragState = null;

  const MIN_IMAGE_ZOOM = 0.1;
  const MAX_IMAGE_ZOOM = 20;
  const IMAGE_ZOOM_STEP = 0.1;

  function normalizeFileEntry(entry) {
    if (typeof entry === 'string') return { name: entry, missing: false };
    return { name: String(entry?.name || ''), missing: Boolean(entry?.missing) };
  }

  function fileUrl(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    if (/^(?:https?:|blob:|data:|file:)/i.test(raw)) return raw;
    const clean = raw.replace(/^\.\//, '');
    const encoded = clean.split('/').map(part => encodeURIComponent(part)).join('/');
    return new URL('./' + encoded, document.baseURI).href;
  }

  function classifyMedia(name) {
    const ext = String(name).split('.').pop()?.toLowerCase() || '';
    if (['mp4', 'webm', 'ogv', 'mov', 'm4v'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'opus', 'ogg'].includes(ext)) return 'audio';
    return 'other';
  }

  function getGroupFiles(item) {
    return (item?.filenames || [])
      .map(normalizeFileEntry)
      .filter(file => file.name && !file.missing)
      .filter(file => ['image', 'video'].includes(classifyMedia(file.name)));
  }

  function getGroupAudio(item) {
    return (item?.filenames || [])
      .map(normalizeFileEntry)
      .find(file => file.name && !file.missing && classifyMedia(file.name) === 'audio') || null;
  }

  function visibleGroupIndices() {
    return reportItems.map((_, index) => index);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMediaTitleHtml(value) {
    const text = String(value || '');
    let html = '';
    let cursor = 0;
    const re = /#[^\s]*/g;
    let match;
    while ((match = re.exec(text))) {
      html += escapeHtml(text.slice(cursor, match.index));
      html += `<span class="media-caption-hashtag">${escapeHtml(match[0])}</span>`;
      cursor = match.index + match[0].length;
    }
    html += escapeHtml(text.slice(cursor));
    return html.replace(/\n/g, '<br>');
  }

  function formatMediaPublishDate(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
      }).formatToParts(date);
      const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
      if (map.year && map.month && map.day) return `${map.year}年${map.month}月${map.day}日`;
    } catch (_) {}
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function ensureAudioElement() {
    if (!currentAudio) {
      currentAudio = document.createElement('audio');
      currentAudio.id = 'persistentGroupAudio';
      currentAudio.controls = false;
      currentAudio.loop = true;
      currentAudio.preload = 'auto';
      currentAudio.volume = 0.8;
      currentAudio.style.position = 'fixed';
      currentAudio.style.left = '-10000px';
      currentAudio.style.top = '-10000px';
      currentAudio.addEventListener('play', () => updateAudioButton(true));
      currentAudio.addEventListener('pause', () => updateAudioButton(false));
      currentAudio.addEventListener('error', () => showAudioStatus('音乐加载失败：' + (currentAudio?.dataset?.filename || '未知文件')));
      document.body.appendChild(currentAudio);
    }
    return currentAudio;
  }

  function clearAudioStatusTimer() {
    if (audioStatusTimer) {
      clearTimeout(audioStatusTimer);
      audioStatusTimer = null;
    }
  }

  function showAudioStatus(text, autoHideMs = 0) {
    clearAudioStatusTimer();
    const el = document.getElementById('audioStatus');
    if (!el) return;
    el.textContent = text || '';
    if (text && autoHideMs > 0) {
      audioStatusTimer = setTimeout(() => {
        const current = document.getElementById('audioStatus');
        if (current) current.textContent = '';
        audioStatusTimer = null;
      }, autoHideMs);
    }
  }

  function showPlayingAudioStatus() {
    // v6：不再在画面右下角显示“正在播放”提示；当前音乐文件名改到音乐按钮内滚动。
    clearAudioStatusTimer();
    const el = document.getElementById('audioStatus');
    if (el) el.textContent = '';
    updateAudioButton(true);
  }

  function clearZoomStatusTimer() {
    if (zoomStatusTimer) {
      clearTimeout(zoomStatusTimer);
      zoomStatusTimer = null;
    }
  }

  function hideZoomStatus() {
    clearZoomStatusTimer();
    const el = document.getElementById('zoomStatus');
    if (el) el.textContent = '';
  }

  function showZoomStatus() {
    clearZoomStatusTimer();
    const el = document.getElementById('zoomStatus');
    if (!el) return;
    el.textContent = `缩放${Math.round(currentImageZoom * 100)}%`;
    zoomStatusTimer = setTimeout(() => {
      const current = document.getElementById('zoomStatus');
      if (current) current.textContent = '';
      zoomStatusTimer = null;
    }, 800);
  }

  function clearTransientMediaStatus() {
    clearAudioStatusTimer();
    clearZoomStatusTimer();
    const audioEl = document.getElementById('audioStatus');
    const zoomEl = document.getElementById('zoomStatus');
    if (audioEl) audioEl.textContent = '';
    if (zoomEl) zoomEl.textContent = '';
  }

  function updateMediaCaptionVisibility() {
    const caption = document.querySelector('.media-group-caption:not(.media-caption-outgoing)');
    if (caption) caption.classList.toggle('is-hidden', !mediaCaptionVisible);
    const toggle = document.getElementById('mediaTitleToggle');
    if (toggle) toggle.setAttribute('aria-pressed', String(mediaCaptionVisible));
  }

  function flashMediaTitleToggle() {
    const toggle = document.getElementById('mediaTitleToggle');
    if (!toggle) return;
    if (mediaTitleFeedbackTimer) clearTimeout(mediaTitleFeedbackTimer);
    toggle.classList.remove('is-activated');
    void toggle.offsetWidth;
    toggle.classList.add('is-activated');
    mediaTitleFeedbackTimer = setTimeout(() => {
      const current = document.getElementById('mediaTitleToggle');
      if (current) current.classList.remove('is-activated');
      mediaTitleFeedbackTimer = null;
    }, 180);
  }

  function toggleMediaCaptionVisibility() {
    if (fullscreenActive) return;
    mediaCaptionVisible = !mediaCaptionVisible;
    updateMediaCaptionVisibility();
    flashMediaTitleToggle();
  }

  function fitMediaCaptionOverflow() {
    const caption = document.querySelector('.media-group-caption:not(.media-caption-outgoing)');
    if (!caption || fullscreenActive) return;
    const title = caption.querySelector('.media-caption-title');
    if (!title) return;

    // 从左下角当前基线向上，作者+日期+标题整体最多占视口高度的 3/7。
    // 超出时由 JS 截断标题并明确追加三个英文句点“...”，而不是依赖浏览器的单字符省略号。
    const maxHeight = Math.max(1, Math.floor(window.innerHeight * 3 / 7));
    caption.style.maxHeight = `${maxHeight}px`;
    title.style.display = 'block';
    title.style.webkitLineClamp = 'unset';
    title.style.maxHeight = 'none';

    const fullTitle = String(reportItems[currentGroupIndex]?.title || '无标题');
    title.innerHTML = formatMediaTitleHtml(fullTitle);
    if (caption.scrollHeight <= maxHeight) return;

    let low = 0;
    let high = fullTitle.length;
    let best = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = fullTitle.slice(0, mid).replace(/\s+$/g, '');
      title.innerHTML = formatMediaTitleHtml(candidate + '...');
      if (caption.scrollHeight <= maxHeight) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    title.innerHTML = formatMediaTitleHtml((best || '') + '...');
  }

  function updateVolumeUI() {
    const audio = ensureAudioElement();
    const range = document.getElementById('volumeRange');
    const label = document.getElementById('volumeValue');
    if (range) range.value = String(Math.round(audio.volume * 100));
    if (label) label.textContent = Math.round(audio.volume * 100) + '%';
  }

  function setAudioVolume(value) {
    const audio = ensureAudioElement();
    const v = Math.max(0, Math.min(1, Number(value) / 100));
    audio.volume = v;
    updateVolumeUI();
  }

  function updateAutoPlayButtonUI() {
    const enabled = !autoPlayDisabledGroups.has(currentGroupIndex);
    document.querySelectorAll('.auto-play-toggle').forEach(btn => {
      btn.textContent = enabled ? '↻ 自动播放：开' : '↻ 自动播放：关';
      btn.setAttribute('aria-pressed', String(enabled));
      btn.title = enabled ? '关闭当前组别自动播放' : '开启当前组别自动播放';
    });
  }

  function flashAutoPlayButton() {
    document.querySelectorAll('.auto-play-toggle').forEach(btn => {
      btn.classList.remove('is-activated');
      void btn.offsetWidth;
      btn.classList.add('is-activated');
      window.setTimeout(() => btn.classList.remove('is-activated'), 150);
    });
  }

  function updateBlurBackgroundButtonUI() {
    document.querySelectorAll('.blur-background-toggle').forEach(btn => {
      btn.textContent = blurBackgroundEnabled ? '◉ 虚化背景：开' : '○ 虚化背景：关';
      btn.setAttribute('aria-pressed', String(blurBackgroundEnabled));
      btn.title = blurBackgroundEnabled ? '关闭当前媒体虚化背景' : '开启当前媒体虚化背景';
    });
  }

  function flashBlurBackgroundButton() {
    document.querySelectorAll('.blur-background-toggle').forEach(btn => {
      btn.classList.remove('is-activated');
      void btn.offsetWidth;
      btn.classList.add('is-activated');
      window.setTimeout(() => btn.classList.remove('is-activated'), 150);
    });
  }

  function getCurrentBlurBackgroundLayer() {
    // 离场 media-main 会暂时与当前页面共存；只从当前 #mediaMain 内取虚化层。
    return mediaContainer.querySelector('#mediaMain .media-blur-background');
  }

  function removeBlurVideoSource(layer) {
    if (!layer) return;
    layer.querySelectorAll('.media-blur-video-source').forEach(video => {
      try { video.pause(); } catch (_) {}
      video.removeAttribute('src');
      try { video.load(); } catch (_) {}
      video.remove();
    });
  }

  function applyBlurBackgroundLayer(targetLayer = null, sourceOverride = null) {
    const layer = targetLayer || getCurrentBlurBackgroundLayer();
    if (!layer) return;
    const rawSource = sourceOverride == null ? currentBlurBackgroundSource : sourceOverride;
    const source = blurBackgroundEnabled ? rawSource : '';
    if (source) {
      layer.style.backgroundImage = `url(${JSON.stringify(source)})`;
    } else {
      layer.style.backgroundImage = 'none';
    }
    const hasVideoFrameLayer = Boolean(layer.querySelector('.media-blur-video-source'));
    layer.classList.toggle('is-enabled', Boolean(blurBackgroundEnabled && (source || hasVideoFrameLayer)));
  }

  function mountVideoFirstFrameBlurBackground(layer, mediaName) {
    if (!layer || !mediaName) return null;
    removeBlurVideoSource(layer);
    layer.style.backgroundImage = 'none';

    const bgVideo = document.createElement('video');
    bgVideo.className = 'media-blur-video-source';
    bgVideo.muted = true;
    bgVideo.defaultMuted = true;
    bgVideo.volume = 0;
    bgVideo.autoplay = false;
    bgVideo.controls = false;
    bgVideo.loop = false;
    bgVideo.playsInline = true;
    bgVideo.preload = 'auto';
    bgVideo.setAttribute('aria-hidden', 'true');
    bgVideo.tabIndex = -1;

    let frameLocked = false;
    const lockFirstFrame = () => {
      if (!bgVideo.isConnected || frameLocked) return;
      if (bgVideo.readyState < 2 || !bgVideo.videoWidth || !bgVideo.videoHeight) return;
      frameLocked = true;
      try { bgVideo.pause(); } catch (_) {}
      // loadeddata 对应媒体时间轴起点；若浏览器报告了极小的非零时间也不再继续播放，
      // 保证背景永远是一张静止的首帧，而不是第二路同步播放的视频。
      try {
        if (Math.abs(Number(bgVideo.currentTime) || 0) > 0.04) bgVideo.currentTime = 0;
      } catch (_) {}
      bgVideo.dataset.firstFrameReady = '1';
      applyBlurBackgroundLayer(layer, '');
    };

    bgVideo.addEventListener('loadeddata', lockFirstFrame);
    bgVideo.addEventListener('canplay', lockFirstFrame);
    bgVideo.addEventListener('seeked', lockFirstFrame);
    bgVideo.addEventListener('error', () => {
      // 背景副本失败时保持纯黑，但不影响前景视频本身的播放。
      bgVideo.dataset.firstFrameFailed = '1';
    });

    layer.appendChild(bgVideo);
    bgVideo.src = fileUrl(mediaName);
    try { bgVideo.load(); } catch (_) {}

    // 某些浏览器对本地视频不会立刻派发 canplay；双 RAF 后再检查一次 readyState。
    requestAnimationFrame(() => requestAnimationFrame(lockFirstFrame));
    return bgVideo;
  }

  function prepareBlurBackgroundForCurrentMedia() {
    const media = currentFiles[currentMediaIndex];
    const type = media ? classifyMedia(media.name) : '';
    const key = media ? `${currentGroupIndex}:${currentMediaIndex}:${media.name}` : '';
    const layer = getCurrentBlurBackgroundLayer();

    currentBlurBackgroundKey = key;
    currentBlurBackgroundSource = '';

    if (!layer) return;
    if (type === 'image') {
      removeBlurVideoSource(layer);
      currentBlurBackgroundSource = fileUrl(media.name);
      applyBlurBackgroundLayer(layer);
    } else if (type === 'video') {
      // 视频背景直接使用独立的视频副本停在第一帧，避免 file:// 下 Canvas 导出被安全策略拦截。
      mountVideoFirstFrameBlurBackground(layer, media.name);
      applyBlurBackgroundLayer(layer, '');
    } else {
      removeBlurVideoSource(layer);
      applyBlurBackgroundLayer(layer, '');
    }
  }

  function toggleBlurBackground() {
    blurBackgroundEnabled = !blurBackgroundEnabled;
    flashBlurBackgroundButton();
    updateBlurBackgroundButtonUI();
    // 背景媒体源始终跟随当前媒体准备；开关只控制可见性，不重新创建视频副本，
    // 因此开启时可直接显示已经解码好的首帧。
    const layer = getCurrentBlurBackgroundLayer();
    if (!layer) return;
    const media = currentFiles[currentMediaIndex];
    const type = media ? classifyMedia(media.name) : '';
    if (type === 'video' && !layer.querySelector('.media-blur-video-source')) {
      mountVideoFirstFrameBlurBackground(layer, media.name);
    }
    applyBlurBackgroundLayer(layer);
  }

  function forceAutoPlayEnabledForCurrentGroup() {
    const wasDisabled = autoPlayDisabledGroups.has(currentGroupIndex);
    if (wasDisabled) autoPlayDisabledGroups.delete(currentGroupIndex);
    updateAutoPlayButtonUI();
    const currentVideo = getCurrentVideoElement();
    if (currentVideo) {
      currentVideo.loop = currentFiles.length <= 1;
    }
    if (wasDisabled) scheduleMediaAutoAdvance();
  }

  function toggleAutoPlay() {
    const disabled = autoPlayDisabledGroups.has(currentGroupIndex);
    if (disabled) autoPlayDisabledGroups.delete(currentGroupIndex);
    else autoPlayDisabledGroups.add(currentGroupIndex);
    flashAutoPlayButton();
    updateAutoPlayButtonUI();
    const currentVideo = getCurrentVideoElement();
    if (currentVideo) {
      currentVideo.loop = (currentFiles.length <= 1) || !isAutoPlayEnabledForCurrentGroup();
    }
    if (disabled) {
      // 从关闭切换为开启：重新启动当前组的自动播放。
      scheduleMediaAutoAdvance();
    } else {
      // 从开启切换为关闭：只停止“自动切换”，视频进度 RAF 与循环播放继续。
      clearMediaAutoAdvanceTimer();
      if (currentVideo) {
        const duration = Number(currentVideo.duration);
        const progress = Number.isFinite(duration) && duration > 0 ? currentVideo.currentTime / duration : 0;
        updateMediaAutoProgress(progress, currentVideo.paused);
        startVideoProgressLoop(currentVideo);
      } else {
        updateMediaAutoProgress(0, true);
      }
    }
  }

  function isAutoPlayEnabledForCurrentGroup() {
    return !autoPlayDisabledGroups.has(currentGroupIndex);
  }

  function bindVolumeRangeInteractions() {
    const range = document.getElementById('volumeRange');
    if (!range || range.dataset.dragBound === '1') return;
    range.dataset.dragBound = '1';
    const valueFromPointer = clientX => {
      const rect = range.getBoundingClientRect();
      const ratio = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
      return Math.round(ratio * 100);
    };
    range.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      volumeDragState = { pointerId: event.pointerId };
      range.setPointerCapture?.(event.pointerId);
      const value = valueFromPointer(event.clientX);
      range.value = String(value);
      setAudioVolume(value);
      event.preventDefault();
    });
    range.addEventListener('pointermove', event => {
      if (!volumeDragState || volumeDragState.pointerId !== event.pointerId) return;
      const value = valueFromPointer(event.clientX);
      range.value = String(value);
      setAudioVolume(value);
      event.preventDefault();
    });
    const endVolumeDrag = event => {
      if (!volumeDragState || volumeDragState.pointerId !== event.pointerId) return;
      volumeDragState = null;
      try { range.releasePointerCapture?.(event.pointerId); } catch (_) {}
    };
    range.addEventListener('pointerup', endVolumeDrag);
    range.addEventListener('pointercancel', endVolumeDrag);
    range.addEventListener('lostpointercapture', () => { volumeDragState = null; });
  }

  function startGroupAudio(item, restart = false) {
    const entry = getGroupAudio(item);
    if (!entry) {
      if (currentAudio) currentAudio.pause();
      currentAudioGroupIndex = -1;
      // 本组没有 MP3 时不再显示任何“没有音乐”的提示。
      showAudioStatus('');
      updateAudioButton(false);
      updateVolumeUI();
      return;
    }

    const audio = ensureAudioElement();
    const src = fileUrl(entry.name);
    const sameGroup = currentAudioGroupIndex === currentGroupIndex;
    const sameSrc = audio.src === src;

    if (!sameSrc || !sameGroup) {
      audio.pause();
      audio.src = src;
      audio.dataset.filename = entry.name;
      currentAudioGroupIndex = currentGroupIndex;
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          updateAudioButton(true);
          showPlayingAudioStatus();
        }).catch(() => {
          updateAudioButton(false);
          showAudioStatus('浏览器阻止了自动播放，请点击“音乐”按钮开始播放');
        });
      } else {
        updateAudioButton(true);
        showPlayingAudioStatus();
      }
    } else if (restart) {
      // 打开作品组时重新播放；组内换图永远不会进入这里。
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          updateAudioButton(true);
          showPlayingAudioStatus();
        }).catch(() => {});
      } else {
        updateAudioButton(true);
        showPlayingAudioStatus();
      }
    }
    updateVolumeUI();
  }

  function updateAudioButton(playing) {
    const btn = document.getElementById('audioToggleBtn');
    if (!btn) return;

    const filename = currentAudio?.dataset?.filename || '音乐播放中';
    const playingText = `正在播放：${filename}`;
    const marqueeKey = `${currentAudioGroupIndex}|${filename}`;

    // 同一个按钮、同一首音乐且仍在播放时，不重建跑马灯 DOM，避免无意义刷新。
    if (playing && btn.classList.contains('is-playing') && btn.dataset.marqueeKey === marqueeKey && btn.querySelector('.audio-btn-scroll')) {
      btn.setAttribute('aria-pressed', 'true');
      btn.title = playingText;
      btn.setAttribute('aria-label', playingText);
      return;
    }

    // 每次先恢复“播放音乐”的自然形制并测量，再锁定该尺寸。
    // 同一个 JS 任务内完成，浏览器不会把中间状态绘制出来，因此播放/暂停时按钮不会跳宽。
    btn.classList.remove('is-playing');
    btn.style.width = '';
    btn.style.minWidth = '';
    btn.style.maxWidth = '';
    btn.textContent = '♫ 播放音乐';
    const baseWidth = Math.ceil(btn.getBoundingClientRect().width || 0);
    if (baseWidth > 0) {
      const width = `${baseWidth}px`;
      btn.style.width = width;
      btn.style.minWidth = width;
      btn.style.maxWidth = width;
    }

    btn.setAttribute('aria-pressed', String(Boolean(playing)));
    if (playing) {
      // 只有真正换歌/换组，或上一轮播放已经结束时才建立新的跑马灯时间轴。
      // 同组换媒体造成按钮 DOM 重建时沿用旧 epoch，并用负 animation-delay 恢复原滚动相位。
      if (audioMarqueeKey !== marqueeKey || !audioMarqueeEpoch) {
        audioMarqueeKey = marqueeKey;
        audioMarqueeEpoch = performance.now();
      }
      btn.classList.add('is-playing');
      btn.dataset.marqueeKey = marqueeKey;
      const safePlayingText = escapeHtml(playingText);
      // 每一轮末尾保留两个英文空格，让下一轮内容无缝接续但不紧贴。
      const loopPlayingText = `${safePlayingText}&nbsp;&nbsp;`;
      btn.innerHTML = `<span class="audio-btn-scroll"><span class="audio-btn-scroll-copy">${loopPlayingText}</span><span class="audio-btn-scroll-copy" aria-hidden="true">${loopPlayingText}</span></span>`;
      const track = btn.querySelector('.audio-btn-scroll');
      if (track) {
        const elapsed = Math.max(0, performance.now() - audioMarqueeEpoch);
        const phase = elapsed % AUDIO_MARQUEE_DURATION_MS;
        track.style.animationDuration = `${AUDIO_MARQUEE_DURATION_MS}ms`;
        track.style.animationDelay = `${-phase}ms`;
      }
      btn.title = playingText;
      btn.setAttribute('aria-label', playingText);
    } else {
      // 真正暂停后，下次重新播放从头开始；同组切媒体不会走到这里。
      audioMarqueeEpoch = 0;
      audioMarqueeKey = '';
      delete btn.dataset.marqueeKey;
      btn.title = '播放本组音乐';
      btn.setAttribute('aria-label', '播放本组音乐');
    }
  }

  function toggleAudio() {
    const audio = ensureAudioElement();
    if (!audio.src) {
      const item = reportItems[currentGroupIndex];
      startGroupAudio(item, true);
      return;
    }
    if (audio.paused) {
      audio.play().then(() => {
        updateAudioButton(true);
        showPlayingAudioStatus();
      }).catch(() => showAudioStatus('无法播放音乐，请确认 MP3 文件与 HTML 位于同一目录'));
    } else {
      audio.pause();
    }
  }

  const MEDIA_AUTO_ADVANCE_MS = 2700;

  function stopVideoProgressLoop() {
    if (videoProgressRaf) {
      cancelAnimationFrame(videoProgressRaf);
      videoProgressRaf = 0;
    }
  }

  function clearMediaAutoAdvanceTimer() {
    // 自动切换计时器与视频进度 RAF 必须独立。
    // 自动播放关闭时仍要让视频进度持续驱动当前线段。
    if (mediaAutoAdvanceTimer) {
      cancelAnimationFrame(mediaAutoAdvanceTimer);
      mediaAutoAdvanceTimer = 0;
    }
    mediaAutoAdvanceStartedAt = 0;
  }

  function isImageInAutoPlayState() {
    const media = currentFiles[currentMediaIndex];
    return Boolean(
      media &&
      classifyMedia(media.name) === 'image' &&
      currentImageZoom <= 1.5001 &&
      !imageDragState
    );
  }

  function getCurrentVideoElement() { return document.querySelector('#mediaMain .media-content-viewport video'); }

  function updateMediaAutoProgress(progress = null, paused = false) {
    const wrap = document.getElementById('mediaAutoProgress');
    if (!wrap) return;
    const segments = Array.from(wrap.querySelectorAll('.media-auto-progress-segment'));
    const media = currentFiles[currentMediaIndex];
    const type = media ? classifyMedia(media.name) : '';
    const video = type === 'video' ? getCurrentVideoElement() : null;
    const eligible = currentFiles.length > 1 && (
      (type === 'image' && isImageInAutoPlayState()) ||
      (type === 'video' && Boolean(video))
    );
    wrap.classList.toggle('is-visible', !fullscreenActive && currentFiles.length > 1);
    segments.forEach((segment, index) => {
      segment.classList.toggle('is-complete', index < currentMediaIndex);
      segment.classList.toggle('is-current', index === currentMediaIndex && eligible);
      segment.classList.toggle('is-paused', index === currentMediaIndex && paused);
      if (index === currentMediaIndex && eligible) {
        const value = Math.max(0, Math.min(1, progress == null ? 0 : progress));
        segment.style.setProperty('--media-progress', `${value * 100}%`);
      } else {
        segment.style.removeProperty('--media-progress');
      }
    });
  }

  function flashMediaProgressSegment(index) {
    const wrap = document.getElementById('mediaAutoProgress');
    if (!wrap) return;
    const segment = wrap.querySelector(`.media-auto-progress-segment[data-progress-index="${index}"]`);
    if (!segment) return;
    if (mediaProgressFeedbackTimer) clearTimeout(mediaProgressFeedbackTimer);
    wrap.querySelectorAll('.media-auto-progress-segment.is-activated').forEach(el => el.classList.remove('is-activated'));
    segment.classList.remove('is-activated');
    void segment.offsetWidth;
    segment.classList.add('is-activated');
    mediaProgressFeedbackTimer = setTimeout(() => {
      segment.classList.remove('is-activated');
      mediaProgressFeedbackTimer = 0;
    }, 220);
  }

  function bindMediaAutoProgressInteractions() {
    const wrap = document.getElementById('mediaAutoProgress');
    if (!wrap || wrap.dataset.interactionsBound === '1') return;
    wrap.dataset.interactionsBound = '1';

    const tooltip = document.getElementById('mediaProgressTooltip');
    const updateTooltip = (segment, event) => {
      if (!tooltip || !segment) return;
      const index = Number(segment.dataset.progressIndex);
      if (!Number.isInteger(index)) return;
      tooltip.textContent = `媒体 ${index + 1} / ${currentFiles.length}`;
      tooltip.style.left = `${event.clientX}px`;
      tooltip.style.top = `${event.clientY}px`;
      tooltip.classList.add('is-visible');
    };
    const hideTooltip = () => tooltip?.classList.remove('is-visible');

    wrap.addEventListener('pointerover', event => {
      const segment = event.target.closest?.('.media-auto-progress-segment');
      if (!segment || !wrap.contains(segment)) return;
      segment.classList.add('is-hovered');
      updateTooltip(segment, event);
    });

    wrap.addEventListener('pointermove', event => {
      const segment = event.target.closest?.('.media-auto-progress-segment');
      if (!segment || !wrap.contains(segment)) {
        hideTooltip();
        return;
      }
      updateTooltip(segment, event);
    });

    wrap.addEventListener('pointerout', event => {
      const segment = event.target.closest?.('.media-auto-progress-segment');
      if (!segment || !wrap.contains(segment)) return;
      const related = event.relatedTarget;
      if (related && segment.contains(related)) return;
      segment.classList.remove('is-hovered');
      hideTooltip();
    });

    wrap.addEventListener('pointerleave', hideTooltip);

    wrap.addEventListener('click', event => {
      const segment = event.target.closest?.('.media-auto-progress-segment');
      if (!segment || !wrap.contains(segment)) return;
      const targetIndex = Number(segment.dataset.progressIndex);
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= currentFiles.length) return;

      event.preventDefault();
      event.stopPropagation();
      hideTooltip();
      flashMediaProgressSegment(targetIndex);

      if (targetIndex === currentMediaIndex) return;
      const direction = targetIndex > currentMediaIndex ? 'left' : 'right';
      showMediaAt(targetIndex, direction);
    });
  }

  function stopMediaAutoAdvance(reason = '') {
    clearMediaAutoAdvanceTimer();
    updateMediaAutoProgress(0, true);
  }

  function scheduleMediaAutoAdvance() {
    clearMediaAutoAdvanceTimer();
    mediaAutoAdvanceStartedAt = 0;
    // 自动播放开关关闭时，任何重新渲染、切换尺寸或媒体状态变化
    // 都不能偷偷重新启动当前组的自动播放。
    if (!isAutoPlayEnabledForCurrentGroup()) {
      const currentMedia = currentFiles[currentMediaIndex];
      const currentType = currentMedia ? classifyMedia(currentMedia.name) : '';
      // 视频的线段进度由独立 RAF 持续更新；关闭自动播放只停止“切换媒体”。
      if (currentType !== 'video') updateMediaAutoProgress(0, true);
      return;
    }
    if (mediaModal.style.display !== 'block' || currentFiles.length <= 1 || !isAutoPlayEnabledForCurrentGroup()) {
      updateMediaAutoProgress(0, true);
      return;
    }
    const media = currentFiles[currentMediaIndex];
    const type = media ? classifyMedia(media.name) : '';

    if (type === 'image') {
      if (!isImageInAutoPlayState()) {
        updateMediaAutoProgress(0, true);
        return;
      }
      mediaAutoAdvanceStartedAt = performance.now();
      const tickImage = () => {
        if (!mediaAutoAdvanceStartedAt) return;
        if (!isImageInAutoPlayState() || mediaModal.style.display !== 'block') {
          stopMediaAutoAdvance('image-state');
          return;
        }
        const progress = Math.min(1, (performance.now() - mediaAutoAdvanceStartedAt) / MEDIA_AUTO_ADVANCE_MS);
        updateMediaAutoProgress(progress, false);
        if (progress >= 1) {
          mediaAutoAdvanceTimer = 0;
          mediaAutoAdvanceStartedAt = 0;
          showNextMedia();
          return;
        }
        mediaAutoAdvanceTimer = requestAnimationFrame(tickImage);
      };
      updateMediaAutoProgress(0, false);
      mediaAutoAdvanceTimer = requestAnimationFrame(tickImage);
      return;
    }

    if (type === 'video') {
      const video = getCurrentVideoElement();
      if (!video) {
        updateMediaAutoProgress(0, true);
        return;
      }
      const tickVideo = () => {
        if (mediaModal.style.display !== 'block' || currentFiles[currentMediaIndex] !== media) return;
        const duration = Number(video.duration);
        const progress = Number.isFinite(duration) && duration > 0 ? video.currentTime / duration : 0;
        updateMediaAutoProgress(progress, video.paused);
        mediaAutoAdvanceTimer = requestAnimationFrame(tickVideo);
      };
      updateMediaAutoProgress(0, video.paused);
      mediaAutoAdvanceTimer = requestAnimationFrame(tickVideo);
    }
  }

  function flashMediaButton(ariaLabel) {
    const stage = document.querySelector('.media-stage');
    if (!stage) return;
    const btn = Array.from(stage.querySelectorAll('.media-nav')).find(el => el.getAttribute('aria-label') === ariaLabel);
    if (!btn || btn.disabled || btn.classList.contains('media-media-btn-hidden')) return;
    if (mediaButtonFeedbackTimer) clearTimeout(mediaButtonFeedbackTimer);
    stage.querySelectorAll('.media-nav.is-activated').forEach(el => el.classList.remove('is-activated'));
    btn.classList.add('is-activated');
    // 强制浏览器提交一次样式，使连续快速按键也每次都能看到独立反馈。
    void btn.offsetWidth;
    mediaButtonFeedbackTimer = setTimeout(() => {
      btn.classList.remove('is-activated');
      mediaButtonFeedbackTimer = 0;
    }, 220);
  }

  function fitImageToViewport(img) {
    // 只允许“当前 mediaMain 中仍连接的图片”更新全局图片状态。
    // 组别快速反向切换时，上一组图片的 load/rAF 回调可能晚到；
    // 若它继续使用新的 #mediaMain 计算缩放，就会造成一次天然尺寸/错误缩放的放大闪现。
    if (!img || !img.isConnected || !img.naturalWidth || !img.naturalHeight) return;
    const currentMain = document.getElementById('mediaMain');
    const ownMain = img.closest('.media-main');
    if (!currentMain || ownMain !== currentMain) return;
    const viewport = currentMain.querySelector('.media-content-viewport');
    if (!viewport) return;
    currentImageElement = img;
    currentImageViewport = viewport;
    const rect = viewport.getBoundingClientRect();
    const pad = 8;
    const vw = Math.max(1, rect.width - pad * 2);
    const vh = Math.max(1, rect.height - pad * 2);
    currentImageBaseScale = Math.min(vw / img.naturalWidth, vh / img.naturalHeight, 1);
    currentImageZoom = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    img.classList.remove('media-image-recentering');
    applyImageZoom();
    // 图片在完成第一次自适应之前保持隐藏，避免天然像素尺寸先闪现一帧。
    img.style.visibility = 'visible';
  }

  function applyImageTransform() {
    const img = currentImageElement;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const scale = currentImageBaseScale * currentImageZoom;
    img.style.transform = `translate3d(calc(-50% + ${currentImagePanX}px), calc(-50% + ${currentImagePanY}px), 0) scale(${scale})`;
  }

  function applyImageZoom() {
    const img = currentImageElement || document.querySelector('#mediaMain img');
    const viewport = currentImageViewport || document.querySelector('#mediaMain .media-content-viewport');
    if (!img || !viewport || !img.naturalWidth || !img.naturalHeight) return;
    currentImageElement = img;
    currentImageViewport = viewport;

    const baseScale = currentImageBaseScale || 1;
    const renderedW = img.naturalWidth * baseScale * currentImageZoom;
    const renderedH = img.naturalHeight * baseScale * currentImageZoom;
    const rect = viewport.getBoundingClientRect();
    const canDrag = currentImageZoom <= 1.0001 || renderedW > rect.width + 0.5 || renderedH > rect.height + 0.5;

    // 图片尺寸仍以原始像素设置，再通过 transform 控制显示比例。
    img.style.width = img.naturalWidth + 'px';
    img.style.height = img.naturalHeight + 'px';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    applyImageTransform();
    img.classList.toggle('is-draggable', canDrag);
    img.classList.toggle('is-dragging', Boolean(imageDragState));

    updateFullscreenNavVisibility(currentImageZoom > 1.0001 || renderedW > rect.width + 0.5 || renderedH > rect.height + 0.5);

  }

  function updateFullscreenNavVisibility(imageIsZoomedBeyondFit) {
    if (!fullscreenActive) return;
    const stage = currentImageViewport?.closest('.media-stage') || document.querySelector('.media-stage');
    if (!stage) return;
    // 全屏放大图片时仍保留左右媒体切换按钮。
    stage.querySelectorAll('.media-nav.media-media-btn').forEach(btn => {
      btn.classList.remove('media-nav-hidden-by-zoom');
    });
  }

  function recenterImageWithElasticMotion() {
    const img = currentImageElement;
    if (!img) return;
    if (currentImageZoom > 1.0001) return;
    const needsRecentering = Math.abs(currentImagePanX) >= 0.5 || Math.abs(currentImagePanY) >= 0.5;
    currentImagePanX = 0;
    currentImagePanY = 0;
    img.classList.remove('media-image-recentering');
    if (needsRecentering) {
      void img.offsetWidth;
      img.classList.add('media-image-recentering');
    }
    applyImageTransform();
    window.setTimeout(() => img.classList.remove('media-image-recentering'), 500);
    scheduleMediaAutoAdvance();
  }

  function zoomImage(deltaY, clientX = null, clientY = null) {
    const media = currentFiles[currentMediaIndex];
    if (!media || classifyMedia(media.name) !== 'image') return false;
    const img = currentImageElement || document.querySelector('#mediaMain img');
    const viewport = currentImageViewport || document.querySelector('#mediaMain .media-content-viewport');
    if (!img || !viewport || !img.naturalWidth) return false;

    const oldZoom = currentImageZoom;
    stopMediaAutoAdvance('zoom');
    const factor = deltaY > 0 ? 0.90 : 1.10;
    const nextZoom = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, oldZoom * factor));
    if (Math.abs(nextZoom - oldZoom) < 0.0001) return true;

    // 只要发生了实际缩放，本组图片自动播放默认立即关闭。
    // 之后用户仍可在缩放 <=150% 时单击图片重新开启/关闭。
    if (!autoPlayDisabledGroups.has(currentGroupIndex)) {
      autoPlayDisabledGroups.add(currentGroupIndex);
      updateAutoPlayButtonUI();
    }

    // 鼠标在图片上：以鼠标位置为缩放参考点；鼠标不在图片上：
    // 横向固定在图片中轴线，纵向仍使用鼠标纵坐标。
    const viewportRect = viewport.getBoundingClientRect();
    const imageRect = img.getBoundingClientRect();
    const overImage = clientX != null && clientY != null &&
      clientX >= imageRect.left && clientX <= imageRect.right &&
      clientY >= imageRect.top && clientY <= imageRect.bottom;
    const centerX = viewportRect.left + viewportRect.width / 2;
    const fallbackY = clientY == null ? viewportRect.top + viewportRect.height / 2 : clientY;
    const px = overImage ? clientX : centerX;
    const py = overImage ? clientY : fallbackY;
    const cursorOffsetX = px - centerX - currentImagePanX;
    const cursorOffsetY = py - (viewportRect.top + viewportRect.height / 2) - currentImagePanY;
    const ratio = nextZoom / oldZoom;

    const reaches100 = Math.abs(nextZoom - 1) < 0.005;
    currentImageZoom = reaches100 ? 1 : nextZoom;
    if (reaches100) {
      // 回到 100% 时用弹性过渡归中，而不是瞬间跳回。
      recenterImageWithElasticMotion();
    } else {
      img.classList.remove('media-image-recentering');
      currentImagePanX += cursorOffsetX * (1 - ratio);
      currentImagePanY += cursorOffsetY * (1 - ratio);
      applyImageZoom();
    }
    showZoomStatus();
    return true;
  }

  function addImageDragHandlers(img) {
    const IMAGE_CLICK_MOVE_THRESHOLD = 6;

    img.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const viewport = currentImageViewport || document.querySelector('#mediaMain .media-content-viewport');
      if (!viewport || !img.naturalWidth) return;

      // 无论当前图片是否可拖拽，都先记录一次“可能的单击”。
      // 只有 pointerup 仍在当前图片上、移动未超过阈值且缩放 <=150% 时才真正切换自动播放。
      imageClickState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        image: img
      };

      const rect = viewport.getBoundingClientRect();
      const scale = currentImageBaseScale * currentImageZoom;
      const renderedW = img.naturalWidth * scale;
      const renderedH = img.naturalHeight * scale;
      const canDrag = currentImageZoom <= 1.0001 || renderedW > rect.width + 0.5 || renderedH > rect.height + 0.5;
      if (!canDrag) return;

      currentImageElement = img;
      currentImageViewport = viewport;
      stopMediaAutoAdvance('drag');
      img.classList.remove('media-image-recentering');
      imageDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: currentImagePanX,
        originY: currentImagePanY
      };
      img.setPointerCapture?.(event.pointerId);
      img.classList.add('is-dragging');
      event.preventDefault();
    });

    img.addEventListener('pointermove', event => {
      if (imageClickState && imageClickState.pointerId === event.pointerId) {
        const dx = event.clientX - imageClickState.startX;
        const dy = event.clientY - imageClickState.startY;
        if (Math.hypot(dx, dy) > IMAGE_CLICK_MOVE_THRESHOLD) imageClickState.moved = true;
      }

      if (!imageDragState || imageDragState.pointerId !== event.pointerId) return;
      currentImagePanX = imageDragState.originX + (event.clientX - imageDragState.startX);
      currentImagePanY = imageDragState.originY + (event.clientY - imageDragState.startY);
      if (!dragRaf) {
        dragRaf = requestAnimationFrame(() => {
          dragRaf = 0;
          applyImageTransform();
        });
      }
      event.preventDefault();
    });

    const finishImagePointer = (event, allowClick) => {
      const clickState = imageClickState && imageClickState.pointerId === event.pointerId
        ? imageClickState
        : null;

      if (imageDragState && imageDragState.pointerId === event.pointerId) {
        try { img.releasePointerCapture?.(event.pointerId); } catch (_) {}
        img.classList.remove('is-dragging');
        imageDragState = null;
        if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
        if (currentImageZoom <= 1.0001) {
          recenterImageWithElasticMotion();
        } else {
          applyImageTransform();
          // 若用户已经在 <=150% 的缩放状态下重新开启自动播放，
          // 拖拽只临时暂停计时，松手后继续，不改变开关状态。
          if (currentImageZoom <= 1.5001 && isAutoPlayEnabledForCurrentGroup()) {
            scheduleMediaAutoAdvance();
          }
        }
      }

      if (clickState) imageClickState = null;
      if (!allowClick || !clickState || clickState.moved) return;
      if (clickState.image !== img || !img.isConnected) return;
      if (currentImageZoom > 1.5001) return;

      // 只允许“图片本体上的单击”触发。pointerup 若已落到图片可视区域外则忽略。
      const imageRect = img.getBoundingClientRect();
      const releasedOnImage = event.clientX >= imageRect.left && event.clientX <= imageRect.right &&
        event.clientY >= imageRect.top && event.clientY <= imageRect.bottom;
      if (!releasedOnImage) return;
      const media = currentFiles[currentMediaIndex];
      if (!media || classifyMedia(media.name) !== 'image') return;
      if (img !== (currentImageElement || document.querySelector('#mediaMain img'))) return;

      // 缩放操作已默认关闭自动播放；在 <=150% 时，这个单击可以重新开启，
      // 再次单击则关闭，不再受“必须回到 100%”的旧判定限制。
      toggleAutoPlay();
    };

    img.addEventListener('pointerup', event => finishImagePointer(event, true));
    img.addEventListener('pointercancel', event => finishImagePointer(event, false));
    img.addEventListener('lostpointercapture', event => {
      // 某些浏览器 pointerup 后会继续派发 lostpointercapture；此时 clickState 已清空，不会重复触发。
      finishImagePointer(event, false);
    });
  }

  function openModalByGroup(index) {
    const groups = visibleGroupIndices();
    if (!groups.length) return;
    const targetIndex = Number(index);
    const actualIndex = Number.isInteger(targetIndex) && reportItems[targetIndex]
      ? targetIndex
      : groups[0];

    currentGroupIndex = actualIndex;
    currentFiles = getGroupFiles(reportItems[actualIndex]);
    currentMediaIndex = 0;
    currentImageZoom = 1;
    currentImageBaseScale = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    currentImageElement = null;
    currentImageViewport = null;
    imageDragState = null;
    imageClickState = null;
    currentMediaDirection = '';
    currentGroupDirection = '';
    currentMediaTransition = 'slide';
    // 每次重新打开播放器都从默认纯黑背景开始。
    blurBackgroundEnabled = false;
    currentBlurBackgroundKey = '';
    currentBlurBackgroundSource = '';
    autoPlayDisabledGroups.clear();
    clearMediaAutoAdvanceTimer();
    if (mediaButtonFeedbackTimer) {
      clearTimeout(mediaButtonFeedbackTimer);
      mediaButtonFeedbackTimer = 0;
    }
    if (mediaProgressFeedbackTimer) {
      clearTimeout(mediaProgressFeedbackTimer);
      mediaProgressFeedbackTimer = 0;
    }

    mediaContainer.innerHTML = '';
    mediaModal.style.display = 'block';
    mediaModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    renderViewer();
    startGroupAudio(reportItems[actualIndex], true);
  }

  function renderViewer() {
    const item = reportItems[currentGroupIndex] || {};
    const title = String(item.title || '无标题');
    const author = String(item.author || '');
    const publishDate = formatMediaPublishDate(item.create_time);
    const groupPosition = `${currentGroupIndex + 1} / ${reportItems.length}`;
    const directionClass = currentGroupDirection || currentMediaDirection || '';
    const mediaTransition = (currentMediaTransition === 'dissolve' && currentMediaDirection && !currentGroupDirection)
      ? 'dissolve'
      : 'slide';
    const media = currentFiles[currentMediaIndex];
    const mediaPosition = `${media ? currentMediaIndex + 1 : 0} / ${currentFiles.length}`;
    const hasMultipleMedia = currentFiles.length > 1;
    const hasGroupAudio = Boolean(getGroupAudio(item));
    clearMediaAutoAdvanceTimer();
    stopVideoProgressLoop();
    const previousMain = mediaContainer.querySelector('#mediaMain');
    const previousCaption = mediaContainer.querySelector('.media-group-caption:not(.media-caption-outgoing)');
    const previousMediaName = previousMain?.dataset?.mediaName || '';
    const outgoingDirection = currentMediaDirection || currentGroupDirection || '';
    const previousVideo = previousMain?.querySelector('.media-content-viewport video');
    const previousVideoTime = previousVideo && Number.isFinite(previousVideo.currentTime)
      ? previousVideo.currentTime
      : null;
    const previousVideoPaused = previousVideo ? previousVideo.paused : null;
    let outgoingMediaClone = null;
    let outgoingCaptionClone = null;
    if (previousCaption && currentGroupDirection) {
      outgoingCaptionClone = previousCaption.cloneNode(true);
      outgoingCaptionClone.classList.remove('media-slide', 'media-slide-out', 'media-caption-enter', 'left', 'right', 'group-up', 'group-down');
      outgoingCaptionClone.classList.add('media-caption-outgoing', currentGroupDirection);
    }
    if (previousMain && outgoingDirection && previousMediaName && media) {
      outgoingMediaClone = previousMain.cloneNode(true);
      // 离场副本必须严格裁剪为整屏视口；即使原图已放大、平移，也只能跟随整页一起离场，
      // 不能让放大图片从 .media-main 外部溢出并残留在屏幕上。
      outgoingMediaClone.style.overflow = 'hidden';
      outgoingMediaClone.removeAttribute('id');
      // 虚化背景现在属于 media-main；离场副本保留旧背景画面一起移动，
      // 但移除内部 id，避免与新页面当前背景层产生重复 id。
      outgoingMediaClone.querySelector('#mediaBlurBackground')?.removeAttribute('id');
      // cloneNode() 不保留 <video> 已解码出的当前帧。若旧媒体使用视频首帧虚化背景，
      // 将真正的背景视频节点直接移动到离场副本中，保持首帧在动画期间连续可见。
      const originalBlurVideo = previousMain.querySelector('.media-blur-video-source');
      const clonedBlurVideo = outgoingMediaClone.querySelector('.media-blur-video-source');
      if (originalBlurVideo && clonedBlurVideo) {
        clonedBlurVideo.replaceWith(originalBlurVideo);
      }
      outgoingMediaClone.classList.remove('media-slide', 'media-dissolve', 'media-slide-out', 'media-dissolve-out', 'left', 'right', 'group-up', 'group-down');
      if (mediaTransition === 'dissolve') {
        outgoingMediaClone.classList.add('media-dissolve-out');
      } else {
        outgoingMediaClone.classList.add('media-slide-out', outgoingDirection);
      }
      outgoingMediaClone.querySelectorAll('button, input').forEach(el => el.remove());
      const clonedVideo = outgoingMediaClone.querySelector('.media-content-viewport video');
      if (clonedVideo) {
        // 组别纵向切换时，直接把当前视频帧“冻结”为画布快照再参与离场动画。
        // 克隆一个新的 <video> 会重新走加载/解码流程，动画开始瞬间可能出现黑帧或闪烁。
        // Canvas 快照保持用户眼前的精确画面与当前播放位置，从动画第一帧起就连续无跳变。
        try {
          // 必须从仍连接在页面、正在解码显示的原视频截取当前帧。
          // cloneNode() 得到的视频没有原元素的解码状态，长视频切组时尤其容易截成黑帧。
          if (!previousVideo || previousVideo.readyState < 2 || !previousVideo.videoWidth || !previousVideo.videoHeight) {
            throw new Error('original video frame unavailable');
          }
          const rect = previousVideo.getBoundingClientRect();
          if (!rect.width || !rect.height) throw new Error('original video rect unavailable');
          const snapshot = document.createElement('canvas');
          const cssWidth = Math.max(1, Math.round(rect.width));
          const cssHeight = Math.max(1, Math.round(rect.height));
          const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
          snapshot.width = Math.max(1, Math.round(cssWidth * ratio));
          snapshot.height = Math.max(1, Math.round(cssHeight * ratio));
          snapshot.className = 'media-video-snapshot';
          snapshot.style.position = 'absolute';
          snapshot.style.left = '50%';
          snapshot.style.top = '50%';
          snapshot.style.width = cssWidth + 'px';
          snapshot.style.height = cssHeight + 'px';
          snapshot.style.transform = 'translate3d(-50%, -50%, 0)';
          snapshot.style.background = '#000';
          snapshot.style.borderRadius = '14px';
          snapshot.style.boxShadow = '0 22px 70px rgba(0, 0, 0, 0.35)';
          snapshot.style.objectFit = 'contain';
          const ctx = snapshot.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('canvas context unavailable');
          ctx.drawImage(previousVideo, 0, 0, snapshot.width, snapshot.height);
          clonedVideo.replaceWith(snapshot);
        } catch (_) {
          // 个别浏览器若当前帧暂不可读取，则回退到原视频副本，并尽量保持原时间点。
          clonedVideo.controls = false;
          clonedVideo.autoplay = false;
          clonedVideo.loop = false;
          clonedVideo.pause?.();
          if (previousVideoTime != null) {
            try { clonedVideo.currentTime = previousVideoTime; } catch (_) {}
            clonedVideo.addEventListener('loadedmetadata', () => {
              try { clonedVideo.currentTime = previousVideoTime; } catch (_) {}
            }, { once: true });
          }
          if (previousVideoPaused === false && previousVideoTime != null) {
            try { clonedVideo.pause(); } catch (_) {}
          }
        }
      }
    }

    mediaContainer.innerHTML = `
      <div class="media-viewer ${hasMultipleMedia ? 'has-progress' : ''}">
        <div class="media-topbar">
          <div class="media-title-wrap">
            <button type="button" class="media-title media-title-toggle" id="mediaTitleToggle" onclick="toggleMediaCaptionVisibility()" aria-pressed="${mediaCaptionVisible ? 'true' : 'false'}">第 ${groupPosition} 组 · 媒体 ${mediaPosition}</button>
          </div>
          <div class="media-toolbar">
            <button type="button" class="viewer-btn blur-background-toggle" id="blurBackgroundToggleBtn" onclick="toggleBlurBackground()" aria-pressed="false">○ 虚化背景：关</button>
            ${hasMultipleMedia ? '<button type="button" class="viewer-btn auto-play-toggle" id="autoPlayToggleBtn" onclick="toggleAutoPlay()" aria-pressed="true">↻ 自动播放：开</button>' : ''}
            <button type="button" class="viewer-btn" id="restoreGroupFirstBtn" onclick="restoreGroupFirstMedia()">↶ 初始</button>
            <button type="button" class="viewer-btn" id="restoreImageBtn" onclick="restoreCurrentImagePosition()">⌖ 图片初始位置</button>
            ${hasGroupAudio ? '<button type="button" class="viewer-btn audio-toggle-btn" id="audioToggleBtn" onclick="toggleAudio()" aria-pressed="false">♫ 播放音乐</button>' : ''}
            <label class="volume-control" title="音乐音量">
              <span>音量</span>
              <input id="volumeRange" type="range" min="0" max="100" step="1" value="80" oninput="setAudioVolume(this.value)">
              <span id="volumeValue">80%</span>
            </label>
            <button type="button" class="viewer-btn" onclick="toggleFullscreen()">⛶ 全屏</button>
          </div>
        </div>

        <div class="media-stage">
          <div class="media-fullscreen-tools" aria-label="全屏工具">
            <button type="button" class="viewer-btn blur-background-toggle" id="fullscreenBlurBackgroundToggleBtn" onclick="toggleBlurBackground()" aria-pressed="false">○ 虚化背景：关</button>
            ${hasMultipleMedia ? '<button type="button" class="viewer-btn auto-play-toggle" id="fullscreenAutoPlayToggleBtn" onclick="toggleAutoPlay()" aria-pressed="true">↻ 自动播放：开</button>' : ''}
            <button type="button" class="viewer-btn" id="fullscreenRestoreGroupFirstBtn" onclick="restoreGroupFirstMedia()">↶ 初始</button>
            <button type="button" class="viewer-btn" id="fullscreenRestoreImageBtn" onclick="restoreCurrentImagePosition()">⌖ 图片初始位置</button>
          </div>
          <button type="button" class="media-nav media-media-btn ${hasMultipleMedia ? '' : 'media-media-btn-hidden'}" aria-label="上一张" onclick="showPreviousMedia(); flashMediaButton('上一张')">‹</button>

          <div class="media-main ${mediaTransition === 'dissolve' ? 'media-dissolve' : 'media-slide'} ${mediaTransition === 'dissolve' ? '' : escapeHtml(directionClass)}" id="mediaMain" data-media-name="${escapeHtml(media?.name || '')}">
            <div class="media-blur-background" id="mediaBlurBackground" aria-hidden="true"></div>
            <div class="media-content-viewport">
              ${media ? '' : '<div class="media-empty">本组没有可浏览的图片或视频文件</div>'}
            </div>
          </div>

          <div class="media-group-caption ${currentGroupDirection ? `media-caption-enter ${escapeHtml(currentGroupDirection)}` : ''} ${mediaCaptionVisible ? '' : 'is-hidden'}" aria-label="当前作品信息">
            <div class="media-caption-author">@${escapeHtml(author)}${publishDate ? ` <span class="media-caption-date">${escapeHtml(publishDate)}</span>` : ''}</div>
            <div class="media-caption-title">${formatMediaTitleHtml(title)}</div>
          </div>

          <div class="media-right-controls" aria-label="媒体与组别切换">
            <button type="button" class="media-nav media-group-btn" aria-label="上一组" onclick="showPreviousGroup(); flashMediaButton('上一组')">↑</button>
            <button type="button" class="media-nav media-media-btn ${hasMultipleMedia ? '' : 'media-media-btn-hidden'}" aria-label="下一张" onclick="showNextMedia(); flashMediaButton('下一张')">›</button>
            <button type="button" class="media-nav media-group-btn" aria-label="下一组" onclick="showNextGroup(); flashMediaButton('下一组')">↓</button>
          </div>
        </div>

        <div class="media-floating-status" aria-live="polite">
          <div id="zoomStatus" class="media-floating-status-text"></div>
          <div id="audioStatus" class="media-floating-status-text"></div>
        </div>
        <div class="media-auto-progress" id="mediaAutoProgress" aria-hidden="true">
          ${Array.from({ length: currentFiles.length }, (_, index) => `<span class="media-auto-progress-segment${index === currentMediaIndex ? ' is-current' : ''}" data-progress-index="${index}" aria-label="媒体 ${index + 1} / ${currentFiles.length}"></span>`).join('')}
        </div>
        <div class="media-progress-tooltip" id="mediaProgressTooltip" role="tooltip" aria-hidden="true"></div>
      </div>
    `;

    bindMediaAutoProgressInteractions();
    bindVolumeRangeInteractions();
    updateAutoPlayButtonUI();

    // 虚化背景层已放入当前 media-main；渲染后同步新媒体背景源，
    // 旧媒体副本中的旧背景会随离场动画一起移动。
    updateBlurBackgroundButtonUI();
    prepareBlurBackgroundForCurrentMedia();

    // 当前图片与下一张图片同时运动：下一张进入视口，当前图片同步离场。
    if (outgoingMediaClone || outgoingCaptionClone) {
      const stage = mediaContainer.querySelector('.media-stage');
      if (stage) {
        if (outgoingMediaClone) {
          stage.insertBefore(outgoingMediaClone, stage.firstElementChild?.nextElementSibling || stage.firstElementChild);
        }
        if (outgoingCaptionClone) stage.appendChild(outgoingCaptionClone);
      }
    }
    updateMediaCaptionVisibility();
    requestAnimationFrame(fitMediaCaptionOverflow);

    // 强制浏览器提交初始布局后再启动动画，避免快速连续切换时动画被合并掉。
    const animatedMain = document.getElementById('mediaMain');
    if (animatedMain && directionClass && (currentFiles.length > 1 || currentGroupDirection)) {
      void animatedMain.offsetWidth;
      animatedMain.classList.add(mediaTransition === 'dissolve' ? 'media-dissolve' : 'media-slide');
    }
    if (outgoingMediaClone) {
      window.setTimeout(() => outgoingMediaClone.remove(), 460);
    }
    if (outgoingCaptionClone) {
      window.setTimeout(() => outgoingCaptionClone.remove(), 460);
    }

    if (media) {
      const viewport = document.querySelector('#mediaMain .media-content-viewport');
      const type = classifyMedia(media.name);
      if (viewport) {
        if (type === 'image') {
          const img = document.createElement('img');
          img.alt = title;
          img.draggable = false;
          // 等 JS 根据当前视口完成首帧自适应后再显示，避免首次反向切组时
          // 天然尺寸图片短暂以放大状态闪现。
          img.style.visibility = 'hidden';
          img.addEventListener('load', () => {
            requestAnimationFrame(() => fitImageToViewport(img));
          });
          img.addEventListener('error', () => {
            viewport.innerHTML = `<div class="media-empty">图片无法加载：<br><br>${escapeHtml(media.name)}</div>`;
          });
          viewport.appendChild(img);
          addImageDragHandlers(img);
          img.src = fileUrl(media.name);
        } else if (type === 'video') {
          const video = document.createElement('video');
          video.controls = true;
          video.playsInline = true;
          video.autoplay = true;
          video.muted = false;
          video.defaultMuted = false;
          video.volume = 1;
          // 视频循环规则：
          // 1) 当前组只有一个媒体时，无论自动播放开关状态如何，都循环；
          // 2) 当前组有多个媒体时：自动播放开启 -> 播放结束后切换下一媒体；
          //    自动播放关闭 -> 当前视频循环播放。
          video.loop = (currentFiles.length <= 1) || !isAutoPlayEnabledForCurrentGroup();
          video.preload = 'auto';
          // 先绑定所有首帧/播放事件，再设置 src；本地媒体可能命中缓存，
          // 若过早设置 src，loadeddata/canplay 可能在监听器安装前已经触发。
          const videoSourceUrl = fileUrl(media.name);

          // 视频画面独立点击层：避免原生 controls 出现后浏览器内部控制层
          // 拦截/改变 video 本身的点击事件。该透明层只覆盖视频画面，
          // 最底部原生进度条区域留给浏览器自身处理。
          const videoClickSurface = document.createElement('div');
          videoClickSurface.className = 'media-video-click-surface';
          videoClickSurface.setAttribute('aria-hidden', 'true');
          videoClickSurface.style.position = 'fixed';
          videoClickSurface.style.zIndex = '4';
          videoClickSurface.style.pointerEvents = 'auto';
          videoClickSurface.style.background = 'transparent';
          videoClickSurface.style.display = 'none';
          document.body.appendChild(videoClickSurface);

          const syncVideoClickSurface = () => {
            if (!video.isConnected || !video.controls) {
              // 原生控制条隐藏时必须让真实 <video> 直接接收点击；
              // 透明层只在 controls 可见期间覆盖视频主体。
              videoClickSurface.style.display = 'none';
              return;
            }
            const rect = video.getBoundingClientRect();
            if (!rect.width || !rect.height) {
              videoClickSurface.style.display = 'none';
              return;
            }
            // 留出底部 72px 给原生 controls；主体区域由透明层处理。
            const nativeControlsHeight = Math.min(72, Math.max(52, rect.height * 0.16));
            const bodyHeight = Math.max(1, rect.height - nativeControlsHeight);
            videoClickSurface.style.left = `${rect.left}px`;
            videoClickSurface.style.top = `${rect.top}px`;
            videoClickSurface.style.width = `${rect.width}px`;
            videoClickSurface.style.height = `${bodyHeight}px`;
            videoClickSurface.style.display = 'block';
          };

          let videoControlsTimer = 0;
          const showVideoControls = () => {
            video.controls = true;
            requestAnimationFrame(syncVideoClickSurface);
            if (videoControlsTimer) clearTimeout(videoControlsTimer);
            videoControlsTimer = setTimeout(() => {
              video.controls = false;
              videoClickSurface.style.display = 'none';
              videoControlsTimer = 0;
            }, 2000);
          };

          const toggleVideoPlayback = () => {
            if (video.paused) {
              const p = video.play();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            } else {
              video.pause();
            }
            showVideoControls();
            requestAnimationFrame(syncVideoClickSurface);
          };

          // controls 可见时由透明层负责视频主体点击，避免原生控制层抢占事件；
          // controls 隐藏时透明层撤掉，由 video 本身接收点击。
          videoClickSurface.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleVideoPlayback();
          });

          video.addEventListener('click', event => {
            if (videoClickSurface.style.display !== 'none') return;
            // controls 隐藏时，直接切换播放状态。
            event.preventDefault();
            toggleVideoPlayback();
          });

          video.addEventListener('play', () => { showVideoControls(); requestAnimationFrame(syncVideoClickSurface); });
          video.addEventListener('pause', () => { showVideoControls(); requestAnimationFrame(syncVideoClickSurface); });
          video.addEventListener('loadedmetadata', () => { showVideoControls(); requestAnimationFrame(syncVideoClickSurface); });
          video.addEventListener('canplay', () => {
            showVideoControls();
            if (video.paused) {
              video.muted = false;
              const p = video.play();
              if (p && typeof p.catch === 'function') {
                p.catch(() => {
                  // 浏览器若因自动播放策略拒绝带声音播放，不偷偷静音；
                  // 用户点击视频后即可正常以声音播放。
                });
              }
            }
          }, { once: true });

          // 鼠标移动到视频下方区域时重新显示进度条，并在 2 秒后自动隐藏。
          video.addEventListener('mousemove', event => {
            const rect = video.getBoundingClientRect();
            if (event.clientY >= rect.bottom - 96) showVideoControls();
          });
          video.addEventListener('pointermove', event => {
            const rect = video.getBoundingClientRect();
            if (event.clientY >= rect.bottom - 96) showVideoControls();
          });

          video.addEventListener('ended', () => {
            const multiMedia = currentFiles.length > 1;
            const autoPlayEnabled = isAutoPlayEnabledForCurrentGroup();

            if (multiMedia && autoPlayEnabled) {
              // 自动播放开启：视频自然播放结束后进入当前组下一媒体。
              // 只有“视频 -> 图片”的这一条自动路径采用溶解；
              // “视频 -> 视频”以及所有手动切换仍使用原来的滑入/滑出。
              const nextIndex = (currentMediaIndex + 1) % currentFiles.length;
              const nextMedia = currentFiles[nextIndex];
              const nextType = nextMedia ? classifyMedia(nextMedia.name) : '';
              showMediaAt(nextIndex, 'left', nextType === 'image' ? 'dissolve' : 'slide');
              return;
            }

            // 自动播放关闭，或当前组只有一个媒体：循环当前视频。
            // loop=true 为主机制；这里作为部分浏览器环境的额外保险。
            try { video.currentTime = 0; } catch (_) {}
            const p = video.play();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          });

          video.addEventListener('error', () => {
            if (videoControlsTimer) clearTimeout(videoControlsTimer);
            videoClickSurface.remove();
            viewport.innerHTML = `<div class="media-empty">视频无法加载：<br><br>${escapeHtml(media.name)}</div>`;
          });
          viewport.appendChild(video);
          video.src = videoSourceUrl;
          requestAnimationFrame(syncVideoClickSurface);
          // 无论自动播放开关状态如何，视频自身的进度都持续同步到当前线段。
          // 自动播放关闭时不启动“切换媒体”计时器，但仍保留独立的视频进度 RAF。
          startVideoProgressLoop(video);
          video.addEventListener('play', () => updateMediaAutoProgress(null, false));
          video.addEventListener('pause', () => updateMediaAutoProgress(null, true));
          video.addEventListener('loadedmetadata', () => updateMediaAutoProgress(0, video.paused));
          video.addEventListener('durationchange', () => updateMediaAutoProgress(null, video.paused));
          video.addEventListener('seeked', () => updateMediaAutoProgress(null, video.paused));
          showVideoControls();
        }
      }
    }

    if (media && currentFiles.length > 1) {
      scheduleMediaAutoAdvance();
    } else {
      stopMediaAutoAdvance('render');
      updateMediaAutoProgress(0, true);
    }
    updateVolumeUI();
    if (currentAudio && !currentAudio.paused) updateAudioButton(true);
    updateFullscreenNavVisibility(false);
    // dissolve 是一次性过渡标记；渲染完成后恢复默认，后续手动操作始终使用滑动。
    currentMediaTransition = 'slide';
  }

  function startVideoProgressLoop(video) {
    stopVideoProgressLoop();
    const tick = () => {
      if (!video.isConnected) {
        videoProgressRaf = 0;
        return;
      }
      const duration = Number(video.duration);
      const currentTime = Number(video.currentTime) || 0;
      const progress = Number.isFinite(duration) && duration > 0
        ? Math.max(0, Math.min(1, currentTime / duration))
        : 0;
      updateMediaAutoProgress(progress, video.paused);
      videoProgressRaf = requestAnimationFrame(tick);
    };
    videoProgressRaf = requestAnimationFrame(tick);
  }

  function flashViewerButton(id) {
    const ids = [id];
    if (id === 'restoreGroupFirstBtn') ids.push('fullscreenRestoreGroupFirstBtn');
    if (id === 'restoreImageBtn') ids.push('fullscreenRestoreImageBtn');

    ids.forEach(targetId => {
      const btn = document.getElementById(targetId);
      if (!btn) return;
      btn.classList.remove('is-activated');
      void btn.offsetWidth;
      btn.classList.add('is-activated');
      window.setTimeout(() => btn.classList.remove('is-activated'), 150);
    });
  }

  function restoreCurrentImagePosition() {
    flashViewerButton('restoreImageBtn');
    // “图片初始位置”同时强制开启当前组自动播放；若本来已开启则保持不变。
    forceAutoPlayEnabledForCurrentGroup();
    const media = currentFiles[currentMediaIndex];
    if (!media || classifyMedia(media.name) !== 'image') return;
    const img = currentImageElement || document.querySelector('#mediaMain img');
    if (!img || !img.naturalWidth) return;
    stopMediaAutoAdvance('restore-image');
    currentImageZoom = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    img.classList.remove('media-image-recentering');
    void img.offsetWidth;
    img.classList.add('media-image-recentering');
    applyImageZoom();
    window.setTimeout(() => {
      if (img.isConnected) img.classList.remove('media-image-recentering');
      scheduleMediaAutoAdvance();
    }, 500);
  }

  function restoreGroupFirstMedia() {
    flashViewerButton('restoreGroupFirstBtn');
    // “初始”同时强制开启当前组自动播放；若本来已开启则保持不变。
    forceAutoPlayEnabledForCurrentGroup();
    if (currentFiles.length <= 1 || currentMediaIndex === 0) {
      // 已经位于当前组第一个媒体时，只重置图片位置，不调用
      // restoreCurrentImagePosition()，避免“初始”和“图片初始位置”同时闪烁。
      if (currentMediaIndex === 0 && currentFiles.length) {
        const media = currentFiles[currentMediaIndex];
        if (classifyMedia(media.name) === 'image') {
          const img = currentImageElement || document.querySelector('#mediaMain img');
          if (img && img.naturalWidth) {
            stopMediaAutoAdvance('restore-group-first');
            currentImageZoom = 1;
            currentImagePanX = 0;
            currentImagePanY = 0;
            img.classList.remove('media-image-recentering');
            void img.offsetWidth;
            img.classList.add('media-image-recentering');
            applyImageZoom();
            window.setTimeout(() => {
              if (img.isConnected) img.classList.remove('media-image-recentering');
              scheduleMediaAutoAdvance();
            }, 500);
          }
        }
      }
      return;
    }
    showMediaAt(0, 'left');
  }

  function showMediaAt(index, directionClass = 'left', transition = 'slide') {
    if (currentFiles.length <= 1) return;
    currentMediaIndex = (index + currentFiles.length) % currentFiles.length;
    // 方向只由“用户/自动操作方向”决定，而不是由索引大小比较决定。
    // 因此最后一张 → 第一张循环时，下一张依然从同一方向进入。
    currentMediaDirection = directionClass === 'right' ? 'right' : 'left';
    currentGroupDirection = '';
    currentMediaTransition = transition === 'dissolve' ? 'dissolve' : 'slide';
    currentImageZoom = 1;
    currentImageBaseScale = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    currentImageElement = null;
    currentImageViewport = null;
    imageDragState = null;
    imageClickState = null;
    renderViewer();
    // 注意：这里绝不调用 startGroupAudio()，音乐保持原进度继续播放。
  }

  function showPreviousMedia() { showMediaAt(currentMediaIndex - 1, 'right'); }
  function showNextMedia() { showMediaAt(currentMediaIndex + 1, 'left'); }

  function switchToGroup(index, direction) {
    const item = reportItems[index];
    if (!item) return;
    // 切组瞬间清除上一组仍在显示的音乐/缩放提示，且取消旧定时器，避免影响新组提示。
    clearTransientMediaStatus();
    currentGroupIndex = index;
    currentFiles = getGroupFiles(item);
    currentMediaIndex = 0;
    currentImageZoom = 1;
    currentImageBaseScale = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    currentImageElement = null;
    currentImageViewport = null;
    imageDragState = null;
    imageClickState = null;
    currentMediaDirection = '';
    currentMediaTransition = 'slide';
    // 组别切换必须使用纵向动画：下一组从下方进入，上一组从上方进入。
    currentGroupDirection = direction > 0 ? 'group-up' : 'group-down';
    renderViewer();
    updateAutoPlayButtonUI();
    // 不重建播放器；仅当作品组真正变化时切换音频。
    startGroupAudio(item, true);
  }

  function moveGroup(direction) {
    const groups = visibleGroupIndices();
    if (!groups.length) return;
    let p = groups.indexOf(currentGroupIndex);
    if (p < 0) p = 0;
    const next = (p + direction + groups.length) % groups.length;
    switchToGroup(groups[next], direction);
  }

  function showPreviousGroup() { moveGroup(-1); }
  function showNextGroup() { moveGroup(1); }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await mediaModal.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('全屏切换失败：', error);
    }
  }

  function closeModal() {
    clearMediaAutoAdvanceTimer();
    stopVideoProgressLoop();
    clearAudioStatusTimer();
    clearZoomStatusTimer();
    if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = '';
      currentAudio.remove();
    }
    currentAudio = null;
    currentAudioGroupIndex = -1;
    mediaModal.style.display = 'none';
    mediaModal.setAttribute('aria-hidden', 'true');
    mediaContainer.innerHTML = '';
    document.body.style.overflow = '';
    currentGroupIndex = -1;
    currentMediaIndex = 0;
    blurBackgroundEnabled = false;
    currentBlurBackgroundKey = '';
    currentBlurBackgroundSource = '';
    currentImageZoom = 1;
    currentImageBaseScale = 1;
    currentImagePanX = 0;
    currentImagePanY = 0;
    currentImageElement = null;
    currentImageViewport = null;
    imageDragState = null;
    imageClickState = null;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; }
    currentFiles = [];
  }

  mediaModal.addEventListener('click', event => {
    if (mediaModal.style.display !== 'block') return;
    const target = event.target;
    if (target && target.closest && target.closest('a[href]')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  mediaModal.addEventListener('wheel', event => {
    if (mediaModal.style.display !== 'block') return;
    const target = event.target;
    if (target.closest && target.closest('input,button,video')) return;
    if (zoomImage(event.deltaY, event.clientX, event.clientY)) event.preventDefault();
  }, { passive: false });

  // 鼠标侧键/肩键/滚轮按下：统一在 document 捕获阶段处理。
  // 3 = 下一组，4 = 上一组，1 = 滚轮按下（图片初始位置）。
  document.addEventListener('mousedown', event => {
    if (mediaModal.style.display !== 'block') return;
    if (event.button === 3) {
      event.preventDefault();
      showNextGroup();
      flashMediaButton('下一组');
    } else if (event.button === 4) {
      event.preventDefault();
      showPreviousGroup();
      flashMediaButton('上一组');
    } else if (event.button === 1) {
      const media = currentFiles[currentMediaIndex];
      if (media && classifyMedia(media.name) === 'image') {
        event.preventDefault();
        restoreCurrentImagePosition();
      }
    }
  }, true);

  document.addEventListener('auxclick', event => {
    if (mediaModal.style.display !== 'block') return;
    if (event.button === 1 || event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  }, true);

  // 必须用捕获阶段监听方向键。视频获得焦点、尤其原生 controls 正在显示时，
  // 浏览器可能先把方向键作为媒体控件操作；捕获阶段可以先完成网页导航和反馈。
  document.addEventListener('keydown', event => {
    if (mediaModal.style.display !== 'block') return;
    if (event.key === 'Escape') {
      if (document.fullscreenElement) return;
      closeModal();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      showPreviousMedia();
      flashMediaButton('上一张');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      showNextMedia();
      flashMediaButton('下一张');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      showPreviousGroup();
      flashMediaButton('上一组');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      showNextGroup();
      flashMediaButton('下一组');
    }
  }, true);

  document.addEventListener('fullscreenchange', () => {
    fullscreenActive = Boolean(document.fullscreenElement);
    clearMediaAutoAdvanceTimer();
    // 全屏前后查看区域尺寸会发生变化，重新计算“自适应基准”，并将图片回到真正的中心。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const img = document.querySelector('#mediaMain img');
        if (img && img.naturalWidth) {
          const savedZoom = currentImageZoom || 1;
          fitImageToViewport(img);
          currentImageZoom = savedZoom;
          currentImagePanX = 0;
          currentImagePanY = 0;
          applyImageZoom();
          scheduleMediaAutoAdvance();
        } else {
          updateFullscreenNavVisibility(false);
          scheduleMediaAutoAdvance();
        }
      });
    });
  });

  window.addEventListener('resize', () => {
    requestAnimationFrame(fitMediaCaptionOverflow);
    const currentVideo = document.querySelector('#mediaMain video');
    const clickSurface = document.querySelector('.media-video-click-surface');
    if (currentVideo && clickSurface) {
      const rect = currentVideo.getBoundingClientRect();
      const nativeControlsHeight = Math.min(72, Math.max(52, rect.height * 0.16));
      clickSurface.style.left = `${rect.left}px`;
      clickSurface.style.top = `${rect.top}px`;
      clickSurface.style.width = `${rect.width}px`;
      clickSurface.style.height = `${Math.max(1, rect.height - nativeControlsHeight)}px`;
      // resize 时也必须遵守 controls 的实际状态：隐藏时不能让透明层重新挡住 video。
      clickSurface.style.display = (currentVideo.controls && rect.width && rect.height) ? 'block' : 'none';
    }
    const img = document.querySelector('#mediaMain img');
    if (img && img.naturalWidth) {
      stopMediaAutoAdvance('resize');
      fitImageToViewport(img);
    }
    const currentMedia = currentFiles[currentMediaIndex];
    if (currentMedia && currentFiles.length > 1) {
      scheduleMediaAutoAdvance();
    }
  });
    

  window.DCCPlayer = Object.freeze({
    open(index = 0) { openModalByGroup(index); },
    close() { closeModal(); },
    setItems(items) {
      reportItems = Array.isArray(items) ? items : [];
      if (mediaModal.style.display === 'block') closeModal();
    },
    getItems() { return reportItems.slice(); }
  });
})();
