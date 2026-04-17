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

  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let particles = [];
  let thinking = false;
  let pulse = null;
  let theme = loadStoredTheme();

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

  function getParticleCount() {
    const area = width * height;
    const base = Math.round(area / 4200);
    return Math.max(72, Math.min(190, base));
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
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

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
  }

  function step() {
    drawBackground();
    const pulseAlpha = drawPulse();
    const thinkingBoost = thinking ? 1.32 : 1;
    const thinkingLineBoost = thinking ? 0.10 : 0;

    for (const particle of particles) {
      particle.phase += 0.015;
      particle.x += particle.vx * thinkingBoost + Math.cos(particle.phase) * (thinking ? 0.045 : 0.012);
      particle.y += particle.vy * thinkingBoost + Math.sin(particle.phase) * (thinking ? 0.045 : 0.012);

      if (particle.x < -8) particle.x = width + 8;
      if (particle.x > width + 8) particle.x = -8;
      if (particle.y < -8) particle.y = height + 8;
      if (particle.y > height + 8) particle.y = -8;

      if (pointer.active) {
        const dx = pointer.x - particle.x;
        const dy = pointer.y - particle.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < 130 && distance > 1) {
          particle.x -= (dx / distance) * 0.14;
          particle.y -= (dy / distance) * 0.14;
        }
      }

      if (pulse) {
        const dx = particle.x - pulse.x;
        const dy = particle.y - pulse.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const ringDistance = Math.abs(distance - pulse.radius);

        if (ringDistance < 78 && distance > 1) {
          const force = (1 - ringDistance / 78) * 0.72 * pulse.strength;
          particle.x += (dx / distance) * force;
          particle.y += (dy / distance) * force;
        }
      }
    }

    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];

      ctx.beginPath();
      ctx.arc(a.x, a.y, a.size, 0, Math.PI * 2);
      ctx.fillStyle = rgba(theme.particle, clamp(a.alpha + pulseAlpha * 0.32 + (thinking ? 0.08 : 0), 0, 0.82));
      ctx.fill();

      for (let j = i + 1; j < particles.length; j += 1) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const maxDistance = thinking ? 138 : 112;
        if (distance > maxDistance) continue;

        const opacity = (1 - distance / maxDistance) * (0.18 + thinkingLineBoost + pulseAlpha * 0.34);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = rgba(theme.line, opacity);
        ctx.lineWidth = thinking ? 0.9 : 0.75;
        ctx.stroke();
      }
    }

    requestAnimationFrame(step);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', event => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  });
  window.addEventListener('pointerleave', () => {
    pointer.active = false;
  });

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
    }
  };

  resize();
  step();
})();
