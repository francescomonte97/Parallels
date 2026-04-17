(function initParticlesBackground() {
  const host = document.getElementById('particles-js');
  if (!host) return;

  const PARTICLE_THEME_KEY = 'lipu_particle_theme';
  const DEFAULT_THEME = {
    id: 'default',
    name: 'Default',
    bg: ['#070b14', '#090d18', '#101626'],
    particle: [246, 247, 251],
    line: [226, 232, 240],
    accent: [140, 231, 212],
    reply: [154, 174, 255],
    audio: [255, 196, 122]
  };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  host.appendChild(canvas);

  const pointer = {
    x: 0,
    y: 0,
    active: false
  };

  const tilt = {
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    enabled: false,
    requested: false
  };

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let particles = [];
  let thinking = false;
  let scanning = false;
  let pulse = null;
  let theme = loadStoredTheme();
  let mobileMode = false;
  let orientationListenerAttached = false;

  function clampColorChannel(value, fallback = 255) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(255, Math.round(number)));
  }

  function normalizeRgb(value, fallback) {
    if (!Array.isArray(value) || value.length < 3) return [...fallback];
    return [
      clampColorChannel(value[0], fallback[0]),
      clampColorChannel(value[1], fallback[1]),
      clampColorChannel(value[2], fallback[2])
    ];
  }

  function normalizeTheme(value = {}) {
    const source = value && typeof value === 'object' ? value : {};

    return {
      id: String(source.id || DEFAULT_THEME.id).trim() || DEFAULT_THEME.id,
      name: String(source.name || DEFAULT_THEME.name).trim() || DEFAULT_THEME.name,
      bg: [...DEFAULT_THEME.bg],
      particle: normalizeRgb(source.particle, DEFAULT_THEME.particle),
      line: normalizeRgb(source.line, DEFAULT_THEME.line),
      accent: normalizeRgb(source.accent, DEFAULT_THEME.accent),
      reply: normalizeRgb(source.reply, DEFAULT_THEME.reply),
      audio: normalizeRgb(source.audio, DEFAULT_THEME.audio)
    };
  }

  function loadStoredTheme() {
    try {
      const raw = window.localStorage?.getItem(PARTICLE_THEME_KEY);
      return raw ? normalizeTheme(JSON.parse(raw)) : normalizeTheme(DEFAULT_THEME);
    } catch (err) {
      console.warn('Tema particles non valido, uso default:', err);
      return normalizeTheme(DEFAULT_THEME);
    }
  }

  function rgba(rgb, alpha) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
  }

  function rgbaPrefix(rgb) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},`;
  }

  function isMobileLike() {
    return window.matchMedia?.('(max-width: 768px), (pointer: coarse)')?.matches || false;
  }

  function getParticleCount() {
    const area = width * height;
    const divisor = mobileMode ? 6000 : 4200;
    const base = Math.round(area / divisor);
    return mobileMode
      ? Math.max(64, Math.min(118, base))
      : Math.max(72, Math.min(190, base));
  }

  function createParticle() {
    const size = Math.random() * 1.8 + 0.65;
    const speed = Math.random() * 0.34 + 0.08;
    const angle = Math.random() * Math.PI * 2;

    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size,
      alpha: Math.random() * 0.42 + 0.22,
      phase: Math.random() * Math.PI * 2
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function createPulse(type = 'send') {
    const originMap = {
      send: { x: width * 0.5, y: height * 0.92, strength: 1.45, color: rgbaPrefix(theme.accent) },
      reply: { x: width * 0.24, y: height * 0.18, strength: 0.82, color: rgbaPrefix(theme.reply) },
      audio: { x: width * 0.18, y: height * 0.88, strength: 1.08, color: rgbaPrefix(theme.audio) }
    };

    const config = originMap[type] || originMap.send;
    pulse = {
      ...config,
      radius: 0,
      maxRadius: Math.max(width, height) * 0.78,
      age: 0,
      duration: type === 'reply' ? 54 : 64
    };
  }

  function drawPulse() {
    if (!pulse) return 0;

    pulse.age += 1;
    const progress = clamp(pulse.age / pulse.duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    pulse.radius = eased * pulse.maxRadius;
    const alpha = (1 - progress) * 0.34 * pulse.strength;

    ctx.beginPath();
    ctx.arc(pulse.x, pulse.y, pulse.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `${pulse.color}${alpha})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pulse.x, pulse.y, pulse.radius * 0.48, 0, Math.PI * 2);
    ctx.strokeStyle = `${pulse.color}${alpha * 0.42})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();

    if (progress >= 1) {
      pulse = null;
      return 0;
    }

    return alpha;
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    mobileMode = isMobileLike();
    pixelRatio = Math.min(window.devicePixelRatio || 1, mobileMode ? 1.35 : 2);

    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const targetCount = getParticleCount();
    if (particles.length > targetCount) {
      particles = particles.slice(0, targetCount);
    }

    while (particles.length < targetCount) {
      particles.push(createParticle());
    }
  }

  function drawBackground() {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, theme.bg[0]);
    gradient.addColorStop(0.55, theme.bg[1]);
    gradient.addColorStop(1, theme.bg[2]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    if (thinking) {
      const thinkingGlow = ctx.createRadialGradient(width * 0.5, height * 0.44, 0, width * 0.5, height * 0.44, width * 0.62);
      thinkingGlow.addColorStop(0, rgba(theme.accent, 0.042));
      thinkingGlow.addColorStop(0.42, rgba(theme.reply, 0.030));
      thinkingGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = thinkingGlow;
      ctx.fillRect(0, 0, width, height);
    }

    if (scanning) {
      const scanAlpha = 0.025 + Math.sin(Date.now() / 180) * 0.018;
      const scanGlow = ctx.createRadialGradient(width * 0.5, height * 0.52, 0, width * 0.5, height * 0.52, width * 0.70);
      scanGlow.addColorStop(0, rgba(theme.accent, Math.max(0.006, scanAlpha)));
      scanGlow.addColorStop(0.48, rgba(theme.reply, Math.max(0.004, scanAlpha * 0.62)));
      scanGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = scanGlow;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function updateTilt() {
    tilt.x += (tilt.targetX - tilt.x) * 0.055;
    tilt.y += (tilt.targetY - tilt.y) * 0.055;
  }

  function drawParticleConnections(pulseAlpha, thinkingLineBoost) {
    const maxDistance = thinking ? (mobileMode ? 146 : 138) : scanning ? (mobileMode ? 136 : 124) : (mobileMode ? 124 : 112);
    const maxDistanceSq = maxDistance * maxDistance;
    const cellSize = maxDistance;
    const grid = new Map();
    const maxConnections = mobileMode ? 620 : 1200;
    let drawnConnections = 0;

    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      const cellX = Math.floor(p.x / cellSize);
      const cellY = Math.floor(p.y / cellSize);
      const key = `${cellX}:${cellY}`;
      const bucket = grid.get(key);

      if (bucket) {
        bucket.push(i);
      } else {
        grid.set(key, [i]);
      }
    }

    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];
      const cellX = Math.floor(a.x / cellSize);
      const cellY = Math.floor(a.y / cellSize);

      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.get(`${cellX + ox}:${cellY + oy}`);
          if (!bucket) continue;

          for (const j of bucket) {
            if (j <= i) continue;
            if (drawnConnections >= maxConnections) return;

            const b = particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distanceSq = dx * dx + dy * dy;

            if (distanceSq > maxDistanceSq) continue;

            const distance = Math.sqrt(distanceSq);

            const opacity = (1 - distance / maxDistance) * (0.24 + thinkingLineBoost + pulseAlpha * (mobileMode ? 0.30 : 0.36));
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = rgba(theme.line, opacity);
            ctx.lineWidth = thinking ? 0.9 : mobileMode ? 0.78 : 0.75;
            ctx.stroke();
            drawnConnections += 1;
          }
        }
      }
    }
  }

  function step() {
    if (document.hidden) {
      requestAnimationFrame(step);
      return;
    }

    updateTilt();
    drawBackground();
    const pulseAlpha = drawPulse();
    const scanWave = scanning ? (0.5 + Math.sin(Date.now() / 150) * 0.5) : 0;
    const thinkingBoost = thinking ? (mobileMode ? 1.28 : 1.32) : scanning ? (mobileMode ? 1.12 + scanWave * 0.11 : 1.14 + scanWave * 0.12) : 1;
    const thinkingLineBoost = thinking ? (mobileMode ? 0.09 : 0.10) : scanning ? (mobileMode ? 0.048 + scanWave * 0.07 : 0.05 + scanWave * 0.08) : 0;
    const tiltForce = mobileMode ? 0.18 : 0.08;

    for (const particle of particles) {
      particle.phase += 0.015;
      particle.x += particle.vx * thinkingBoost + Math.cos(particle.phase) * (thinking ? 0.045 : 0.012) + tilt.x * tiltForce;
      particle.y += particle.vy * thinkingBoost + Math.sin(particle.phase) * (thinking ? 0.045 : 0.012) + tilt.y * tiltForce;

      if (particle.x < -8) particle.x = width + 8;
      if (particle.x > width + 8) particle.x = -8;
      if (particle.y < -8) particle.y = height + 8;
      if (particle.y > height + 8) particle.y = -8;

      if (pointer.active) {
        const dx = pointer.x - particle.x;
        const dy = pointer.y - particle.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const pointerRadius = mobileMode ? 92 : 130;

        if (distance < pointerRadius && distance > 1) {
          particle.x -= (dx / distance) * (mobileMode ? 0.08 : 0.14);
          particle.y -= (dy / distance) * (mobileMode ? 0.08 : 0.14);
        }
      }

      if (pulse) {
        const dx = particle.x - pulse.x;
        const dy = particle.y - pulse.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const ringDistance = Math.abs(distance - pulse.radius);
        const ringWidth = mobileMode ? 72 : 78;

        if (ringDistance < ringWidth && distance > 1) {
          const force = (1 - ringDistance / ringWidth) * (mobileMode ? 0.62 : 0.72) * pulse.strength;
          particle.x += (dx / distance) * force;
          particle.y += (dy / distance) * force;
        }
      }
    }

    drawParticleConnections(pulseAlpha, thinkingLineBoost);

    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];

      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2);
      ctx.fillStyle = rgba(theme.particle, clamp(a.alpha + pulseAlpha * 0.32 + (thinking ? 0.08 : 0) + (scanning ? scanWave * 0.10 : 0), 0, 0.82));
      ctx.fill();
    }

    requestAnimationFrame(step);
  }

  function getOrientationAngle() {
    const angle = window.screen?.orientation?.angle;
    if (Number.isFinite(angle)) return angle;
    return Number(window.orientation) || 0;
  }

  function handleDeviceOrientation(event) {
    if (!mobileMode) return;

    const gamma = Number(event.gamma);
    const beta = Number(event.beta);
    if (!Number.isFinite(gamma) || !Number.isFinite(beta)) return;

    const x = clamp(gamma / 26, -1, 1);
    const y = clamp(beta / 34, -1, 1);
    const angle = getOrientationAngle();

    if (angle === 90) {
      tilt.targetX = y;
      tilt.targetY = -x;
    } else if (angle === -90 || angle === 270) {
      tilt.targetX = -y;
      tilt.targetY = x;
    } else if (Math.abs(angle) === 180) {
      tilt.targetX = -x;
      tilt.targetY = -y;
    } else {
      tilt.targetX = x;
      tilt.targetY = y;
    }

    tilt.enabled = true;
  }

  function attachOrientationListener() {
    if (orientationListenerAttached || !('DeviceOrientationEvent' in window)) return;
    window.addEventListener('deviceorientation', handleDeviceOrientation, { passive: true });
    orientationListenerAttached = true;
  }

  async function requestTiltAccess() {
    if (tilt.requested || !mobileMode || !('DeviceOrientationEvent' in window)) return;
    tilt.requested = true;

    const permissionRequest = window.DeviceOrientationEvent?.requestPermission;
    if (typeof permissionRequest !== 'function') {
      attachOrientationListener();
      return;
    }

    try {
      const permission = await permissionRequest.call(window.DeviceOrientationEvent);
      if (permission === 'granted') {
        attachOrientationListener();
      }
    } catch (err) {
      tilt.targetX = 0;
      tilt.targetY = 0;
    }
  }

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  window.addEventListener('pointermove', event => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  });
  window.addEventListener('pointerleave', () => {
    pointer.active = false;
  });
  window.addEventListener('pointerdown', requestTiltAccess, { once: true, passive: true });
  window.addEventListener('touchstart', requestTiltAccess, { once: true, passive: true });
  window.addEventListener('click', requestTiltAccess, { once: true, passive: true });

  window.lipuParticles = {
    pulse: createPulse,
    setTheme(nextTheme) {
      theme = normalizeTheme(nextTheme);
    },
    getTheme() {
      return normalizeTheme(theme);
    },
    getDefaultTheme() {
      return normalizeTheme(DEFAULT_THEME);
    },
    setThinking(active) {
      thinking = Boolean(active);
    },
    setScanning(active) {
      scanning = Boolean(active);
    }
  };

  resize();
  step();
})();
