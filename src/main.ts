import './style.css';

// Static config
const CHARSET_DENSE  = '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. ';
const BLEND_MODES = ['screen', 'lighten', 'hard-light', 'overlay', 'normal'];

// Read-only presets  (subset of state keys — 'running' intentionally excluded)
const PRESETS = [
  { name: 'DEFAULT',   inverted: false, cols: 90,  contrast: 1.75, overlayOpacity: 1.0, blendIndex: 4, motionOnly: true  },
  { name: 'CINEMATIC', inverted: false, cols: 80,  contrast: 2.5,  overlayOpacity: 0.5, blendIndex: 0, motionOnly: false },
  { name: 'GLITCH',    inverted: false, cols: 120, contrast: 2.2,  overlayOpacity: 0.7, blendIndex: 2, motionOnly: true  },
  { name: 'SOFT',      inverted: false, cols: 65,  contrast: 1.2,  overlayOpacity: 0.5, blendIndex: 1, motionOnly: false },
  { name: 'MONO',      inverted: true,  cols: 90,  contrast: 2.0,  overlayOpacity: 0.0, blendIndex: 4, motionOnly: false },
];

// Motion detection config (markers)
const GRID_COLS = 16;
const GRID_ROWS = 12;
const MOTION_THRESHOLD = 20;
const SOFT_TRACK_THRESHOLD = 10;
const ACTIVE_LINK_MS = 250;
const MARKER_LINGER_MS = 3000;
const MATCH_DIST = 0.15;

// Motion-only ASCII config
const PIXEL_MOTION_THRESHOLD = 25;
const ASCII_LINGER_MS = 400;

// Tracks the active preset chip's id ('' = custom / manual)
// IDs: 'builtin-0'..'builtin-N' for PRESETS, 'user-<timestamp>' for saved
let activePresetId = 'builtin-0';

// localStorage schema (versioned for future-proofing)
const STORAGE_KEY = 'ascii-cam:userPresets';
const STORAGE_VERSION = 1;
let userPresets = []; // { id, name, values }

function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.presets)) return [];
    return parsed.presets;
  } catch (e) {
    console.warn('Failed to load user presets:', e);
    return [];
  }
}

function saveUserPresets() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      presets: userPresets,
    }));
  } catch (e) {
    console.warn('Failed to save user presets:', e);
  }
}

// User-facing settings (a single source of truth — savable / presetable)
const state = {
  running: false,
  inverted: false,
  cols: 90,
  contrast: 1.75,
  overlayOpacity: 1,
  blendIndex: 4,   // index into BLEND_MODES; default = 'normal'
  motionOnly: true,
};

// DOM references (collected in one place)
const els = {
  video:          document.getElementById('video'),
  videoOverlay:   document.getElementById('video-overlay'),
  canvas:         document.getElementById('canvas'),
  output:         document.getElementById('ascii-output'),
  motionCanvas:   document.getElementById('motion-overlay'),
  stage:          document.getElementById('stage'),
  dot:            document.getElementById('dot'),
  statusTx:       document.getElementById('status-text'),
  resDisp:        document.getElementById('res-display'),
  fpsDsp:         document.getElementById('fps-display'),
  overlayPct:     document.getElementById('overlay-pct'),
  startBtn:       document.getElementById('start-btn'),
  invertBtn:      document.getElementById('invert-btn'),
  motionOnlyBtn:  document.getElementById('motion-only-btn'),
  blendBtn:       document.getElementById('blend-btn'),
  resSlider:      document.getElementById('res-slider'),
  contrastSlider: document.getElementById('contrast-slider'),
  overlaySlider:  document.getElementById('overlay-slider'),
  presetChipsBar: document.getElementById('preset-chips'),
};

const ctx       = els.canvas.getContext('2d', { willReadFrequently: true });
const motionCtx = els.motionCanvas.getContext('2d');

// Runtime motion buffers (not user-facing settings)
const prevBlockLum = new Float32Array(GRID_COLS * GRID_ROWS);
const gridActive   = new Uint8Array(GRID_COLS * GRID_ROWS);
const gridDiff     = new Float32Array(GRID_COLS * GRID_ROWS);
let motionInitialized = false;
let trackedMarkers = []; // {x, y, diff, cells, lastSeen, lastActive}
let prevPixelLum = null;
let pixelLastMove = null;
let pixelArraySize = 0;
let pixelMotionInitialized = false;

// Push current state to all UI surfaces. Single function for both
// user interactions and programmatic changes (e.g. presets).
function applyState() {
  els.invertBtn.classList.toggle('active', state.inverted);
  els.motionOnlyBtn.classList.toggle('active', state.motionOnly);
  const blend = BLEND_MODES[state.blendIndex];
  els.blendBtn.textContent = blend.toUpperCase();
  els.blendBtn.classList.toggle('active', blend !== 'normal');
  els.output.style.mixBlendMode = blend;
  els.videoOverlay.style.opacity = state.overlayOpacity;
  els.overlayPct.textContent = Math.round(state.overlayOpacity * 100) + '%';
  els.resSlider.value = state.cols;
  els.contrastSlider.value = state.contrast;
  els.overlaySlider.value = state.overlayOpacity;
  // Sync preset chip highlight
  els.presetChipsBar.querySelectorAll('.preset-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.presetId === activePresetId);
  });
}

// Extract savable values from current state (excludes 'running')
function snapshotPresetValues() {
  return {
    inverted:       state.inverted,
    cols:           state.cols,
    contrast:       state.contrast,
    overlayOpacity: state.overlayOpacity,
    blendIndex:     state.blendIndex,
    motionOnly:     state.motionOnly,
  };
}

function findPresetById(id) {
  if (id.startsWith('builtin-')) {
    const i = parseInt(id.slice('builtin-'.length), 10);
    return PRESETS[i] ? { name: PRESETS[i].name, values: PRESETS[i] } : null;
  }
  if (id.startsWith('user-')) {
    return userPresets.find(p => p.id === id) || null;
  }
  return null;
}

function applyPresetById(id) {
  const p = findPresetById(id);
  if (!p) return;
  activePresetId = id;
  // Strip 'name' if present (only built-ins have it inline)
  const { name: _name, ...values } = p.values;
  Object.assign(state, values);
  applyState();
}

function renderPresetChips() {
  const bar = els.presetChipsBar;
  bar.innerHTML = '';

  // Built-in chips
  PRESETS.forEach((p, i) => {
    const id = 'builtin-' + i;
    const btn = document.createElement('button');
    btn.className = 'preset-chip';
    btn.dataset.presetId = id;
    btn.textContent = p.name;
    if (id === activePresetId) btn.classList.add('active');
    bar.appendChild(btn);
  });

  // Divider only when user presets exist
  if (userPresets.length > 0) {
    const div = document.createElement('span');
    div.className = 'chip-divider';
    bar.appendChild(div);
  }

  // User chips
  userPresets.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'preset-chip user';
    btn.dataset.presetId = p.id;
    btn.textContent = p.name;
    if (p.id === activePresetId) btn.classList.add('active');
    const del = document.createElement('span');
    del.className = 'chip-delete';
    del.dataset.deleteId = p.id;
    del.textContent = '×';
    del.title = 'Delete preset';
    btn.appendChild(del);
    bar.appendChild(btn);
  });

  // SAVE button
  const save = document.createElement('button');
  save.id = 'save-preset-btn';
  save.textContent = '+ SAVE';
  save.title = 'Save current settings as a preset';
  bar.appendChild(save);
}

els.startBtn.addEventListener('click', toggleCamera);

// Preset bar: handles chip click, × delete, and + SAVE button
els.presetChipsBar.addEventListener('click', e => {
  // Delete user preset
  const delBtn = e.target.closest('.chip-delete');
  if (delBtn) {
    e.stopPropagation();
    const id = delBtn.dataset.deleteId;
    const p = userPresets.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    userPresets = userPresets.filter(x => x.id !== id);
    saveUserPresets();
    if (activePresetId === id) activePresetId = '';
    renderPresetChips();
    applyState();
    return;
  }

  // Save current as new user preset
  if (e.target.closest('#save-preset-btn')) {
    const name = (prompt('Preset name?') || '').trim();
    if (!name) return;
    const newPreset = {
      id: 'user-' + Date.now(),
      name,
      values: snapshotPresetValues(),
    };
    userPresets.push(newPreset);
    saveUserPresets();
    activePresetId = newPreset.id;
    renderPresetChips();
    applyState();
    return;
  }

  // Apply preset
  const chip = e.target.closest('.preset-chip');
  if (!chip || !chip.dataset.presetId) return;
  applyPresetById(chip.dataset.presetId);
});

els.invertBtn.addEventListener('click', () => {
  activePresetId = '';
  state.inverted = !state.inverted;
  applyState();
});

els.motionOnlyBtn.addEventListener('click', () => {
  activePresetId = '';
  state.motionOnly = !state.motionOnly;
  applyState();
});

els.blendBtn.addEventListener('click', () => {
  activePresetId = '';
  state.blendIndex = (state.blendIndex + 1) % BLEND_MODES.length;
  applyState();
});

els.resSlider.addEventListener('input', e => {
  activePresetId = '';
  state.cols = parseInt(e.target.value);
  applyState();
});

els.contrastSlider.addEventListener('input', e => {
  activePresetId = '';
  state.contrast = parseFloat(e.target.value);
});

els.overlaySlider.addEventListener('input', e => {
  activePresetId = '';
  state.overlayOpacity = parseFloat(e.target.value);
  applyState();
});

async function toggleCamera() {
  if (state.running) {
    state.running = false;
    [els.video, els.videoOverlay].forEach(v => {
      v.srcObject?.getTracks().forEach(t => t.stop());
      v.srcObject = null;
    });
    els.dot.className = '';
    els.statusTx.textContent = 'STANDBY';
    els.startBtn.textContent = '▶ START';
    els.resDisp.textContent = '--';
    els.output.textContent = '[ CAMERA STOPPED ]';
    els.output.style.color = 'var(--dim)';
    motionInitialized = false;
    gridActive.fill(0);
    gridDiff.fill(0);
    prevBlockLum.fill(0);
    trackedMarkers = [];
    pixelMotionInitialized = false;
    if (prevPixelLum) prevPixelLum.fill(0);
    if (pixelLastMove) pixelLastMove.fill(0);
    motionCtx.clearRect(0, 0, els.motionCanvas.width, els.motionCanvas.height);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
    // 処理用とオーバーレイ用に同じストリームをセット
    els.video.srcObject = stream;
    els.videoOverlay.srcObject = stream;
    await Promise.all([els.video.play(), els.videoOverlay.play()]);
    // 実解像度の表示
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    console.log('Camera negotiated:', settings);
    els.resDisp.textContent = `${settings.width}×${settings.height}`;
    state.running = true;
    els.dot.className = 'live';
    els.statusTx.textContent = 'LIVE';
    els.output.style.color = 'var(--fg)';
    els.startBtn.textContent = '■ STOP';
    requestAnimationFrame(renderLoop);
  } catch(err) {
    els.output.textContent = `[ CAMERA ERROR: ${err.message} ]`;
    els.statusTx.textContent = 'ERROR';
  }
}

let lastTime = 0;
let frameCount = 0;

function renderLoop(ts) {
  if (!state.running) return;

  frameCount++;
  if (ts - lastTime > 1000) {
    els.fpsDsp.textContent = `${Math.round(frameCount * 1000 / (ts - lastTime))} FPS`;
    frameCount = 0;
    lastTime = ts;
  }

  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) { requestAnimationFrame(renderLoop); return; }

  const COLS = state.cols;
  const aspect = 0.55;
  const ROWS = Math.floor(COLS * (vh / vw) * aspect);

  els.canvas.width  = COLS;
  els.canvas.height = ROWS;

  // Resize per-pixel motion buffers if needed
  const pixCount = COLS * ROWS;
  if (pixCount !== pixelArraySize) {
    prevPixelLum  = new Float32Array(pixCount);
    pixelLastMove = new Float64Array(pixCount);
    pixelArraySize = pixCount;
    pixelMotionInitialized = false;
  }

  ctx.save();
  ctx.translate(COLS, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(els.video, 0, 0, COLS, ROWS);
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;
  const charset = CHARSET_DENSE;
  const clen = charset.length - 1;

  const lines = [];
  for (let row = 0; row < ROWS; row++) {
    let line = '';
    for (let col = 0; col < COLS; col++) {
      const i = (row * COLS + col) * 4;
      const r = imgData[i], g = imgData[i+1], b = imgData[i+2];
      const lum = 0.299*r + 0.587*g + 0.114*b;

      // Per-pixel motion tracking (raw luminance, before contrast)
      const pi = row * COLS + col;
      if (pixelMotionInitialized) {
        if (Math.abs(lum - prevPixelLum[pi]) > PIXEL_MOTION_THRESHOLD) {
          pixelLastMove[pi] = ts;
        }
      }
      prevPixelLum[pi] = lum;

      // Apply contrast for ASCII mapping
      let lumC = ((lum / 255 - 0.5) * state.contrast + 0.5) * 255;
      lumC = Math.max(0, Math.min(255, lumC));
      let idx = Math.floor((lumC / 255) * clen);
      if (!state.inverted) idx = clen - idx;

      if (state.motionOnly && (ts - pixelLastMove[pi] > ASCII_LINGER_MS)) {
        line += ' ';
      } else {
        line += charset[idx];
      }
    }
    lines.push(line);
  }
  pixelMotionInitialized = true;

  els.output.textContent = lines.join('\n');

  // Motion detection & markers
  els.motionCanvas.width  = els.stage.clientWidth;
  els.motionCanvas.height = els.stage.clientHeight;
  detectMotion(imgData, COLS, ROWS);
  updateTrackedMarkers(ts);
  drawMotionMarkers(ts);

  requestAnimationFrame(renderLoop);
}

function detectMotion(imgData, frameCols, frameRows) {
  const bw = frameCols / GRID_COLS;
  const bh = frameRows / GRID_ROWS;
  gridActive.fill(0);

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      let sum = 0, count = 0;
      const x0 = Math.floor(gx * bw);
      const y0 = Math.floor(gy * bh);
      const x1 = Math.floor((gx + 1) * bw);
      const y1 = Math.floor((gy + 1) * bh);

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * frameCols + x) * 4;
          sum += 0.299 * imgData[i] + 0.587 * imgData[i+1] + 0.114 * imgData[i+2];
          count++;
        }
      }

      const avg = count > 0 ? sum / count : 0;
      const idx = gy * GRID_COLS + gx;

      if (motionInitialized) {
        const diff = Math.abs(avg - prevBlockLum[idx]);
        gridDiff[idx] = diff;
        if (diff > MOTION_THRESHOLD) {
          gridActive[idx] = 1;
        }
      }

      prevBlockLum[idx] = avg;
    }
  }
  motionInitialized = true;
}

function findClusters() {
  const visited = new Uint8Array(GRID_COLS * GRID_ROWS);
  const clusters = [];

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const idx = gy * GRID_COLS + gx;
      if (!gridActive[idx] || visited[idx]) continue;

      const queue = [{gx, gy}];
      visited[idx] = 1;
      let sumX = 0, sumY = 0, sumDiff = 0, count = 0;

      while (queue.length > 0) {
        const {gx: cx, gy: cy} = queue.shift();
        sumX += cx; sumY += cy;
        sumDiff += gridDiff[cy * GRID_COLS + cx];
        count++;

        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
          const ni = ny * GRID_COLS + nx;
          if (!gridActive[ni] || visited[ni]) continue;
          visited[ni] = 1;
          queue.push({gx: nx, gy: ny});
        }
      }

      clusters.push({
        x: (sumX / count + 0.5) / GRID_COLS,
        y: (sumY / count + 0.5) / GRID_ROWS,
        diff: sumDiff / count,
        cells: count
      });
    }
  }
  return clusters;
}

function updateTrackedMarkers(ts) {
  const clusters = findClusters();
  const used = new Uint8Array(clusters.length);

  // Match existing markers to nearest cluster
  for (const m of trackedMarkers) {
    let bestIdx = -1, bestDist = MATCH_DIST;
    for (let i = 0; i < clusters.length; i++) {
      if (used[i]) continue;
      const dx = m.x - clusters[i].x;
      const dy = m.y - clusters[i].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      const c = clusters[bestIdx];
      m.x = c.x; m.y = c.y;
      m.diff = c.diff; m.cells = c.cells;
      m.lastSeen = ts;
      m.lastActive = ts;
      used[bestIdx] = 1;
    } else {
      // Soft tracking: follow highest diff cell in neighborhood
      const gx = Math.floor(m.x * GRID_COLS);
      const gy = Math.floor(m.y * GRID_ROWS);
      const r = 2; // search radius in grid cells
      let bestDiff = 0, bx = gx, by = gy;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
          const d = gridDiff[ny * GRID_COLS + nx];
          if (d > bestDiff) { bestDiff = d; bx = nx; by = ny; }
        }
      }
      if (bestDiff >= SOFT_TRACK_THRESHOLD) {
        m.x = (bx + 0.5) / GRID_COLS;
        m.y = (by + 0.5) / GRID_ROWS;
        m.diff = bestDiff;
      }
    }
  }

  // Create new markers for unmatched clusters
  for (let i = 0; i < clusters.length; i++) {
    if (used[i]) continue;
    const c = clusters[i];
    trackedMarkers.push({ x: c.x, y: c.y, diff: c.diff, cells: c.cells, lastSeen: ts, lastActive: ts });
  }

  // Remove expired markers
  trackedMarkers = trackedMarkers.filter(m => ts - m.lastSeen <= MARKER_LINGER_MS);
}

function drawMotionMarkers(ts) {
  const w = els.motionCanvas.width;
  const h = els.motionCanvas.height;
  motionCtx.clearRect(0, 0, w, h);

  if (trackedMarkers.length === 0) return;

  const pts = trackedMarkers.map(m => ({
    px: m.x * w, py: m.y * h,
    diff: m.diff, cells: m.cells,
    active: ts - m.lastActive <= ACTIVE_LINK_MS
  }));

  // Connecting lines: only between currently-active markers
  motionCtx.strokeStyle = '#fff';
  motionCtx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) {
    if (!pts[i].active) continue;
    for (let j = i + 1; j < pts.length; j++) {
      if (!pts[j].active) continue;
      motionCtx.beginPath();
      motionCtx.moveTo(pts[i].px, pts[i].py);
      motionCtx.lineTo(pts[j].px, pts[j].py);
      motionCtx.stroke();
    }
  }

  // Square markers
  const markerSize = Math.max(3, w / GRID_COLS * 0.075);
  const half = markerSize / 2;
  motionCtx.lineWidth = 1.5;
  for (const p of pts) {
    motionCtx.strokeRect(p.px - half, p.py - half, markerSize, markerSize);
  }

  // Data labels
  const fontSize = 16;
  motionCtx.font = `${fontSize}px 'Share Tech Mono', monospace`;
  motionCtx.fillStyle = '#fff';
  motionCtx.textBaseline = 'top';
  for (const p of pts) {
    const val = (p.diff * p.cells + p.px * 0.1 + p.py * 0.07) % 1000;
    motionCtx.fillText(val.toFixed(1), p.px + half + 3, p.py - half);
  }
}

// Boot: load saved user presets, build chip row, sync UI
userPresets = loadUserPresets();
renderPresetChips();
applyState();
