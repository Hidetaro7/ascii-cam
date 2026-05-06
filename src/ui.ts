// UI layer: holds the `state` object, DOM references, event wiring,
// the camera lifecycle, and the render loop. Engine-layer functions are
// imported and called; this module owns all DOM operations.

import {
  BLEND_MODES,
  PRESETS,
  loadUserPresets,
  saveUserPresets,
  findPresetById,
  snapshotPresetValues,
  type State,
  type UserPreset,
} from './presets';

import {
  createMotionState,
  createPixelMotionState,
  resetMotionState,
  resetPixelMotionState,
  ensurePixelMotionSize,
  generateAsciiLines,
  detectMotion,
  findClusters,
  updateTrackedMarkers,
  drawMotionMarkers,
  type Marker,
} from './engine';

// ──────────────────────────────────────────────────────────────────────
// Persistent UI state
// ──────────────────────────────────────────────────────────────────────

const state: State = {
  running: false,
  inverted: false,
  cols: 90,
  contrast: 1.75,
  overlayOpacity: 1,
  blendIndex: 4,   // 'normal'
  motionOnly: true,
};

/** '' = manual / no preset selected. 'builtin-N' or 'user-<ts>' otherwise. */
let activePresetId = 'builtin-0';

let userPresets: UserPreset[] = [];

// ──────────────────────────────────────────────────────────────────────
// DOM references (collected once at boot)
// ──────────────────────────────────────────────────────────────────────

type Els = {
  video: HTMLVideoElement;
  videoOverlay: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  output: HTMLDivElement;
  motionCanvas: HTMLCanvasElement;
  stage: HTMLDivElement;
  dot: HTMLDivElement;
  statusTx: HTMLSpanElement;
  resDisp: HTMLSpanElement;
  fpsDsp: HTMLSpanElement;
  overlayPct: HTMLSpanElement;
  startBtn: HTMLButtonElement;
  invertBtn: HTMLButtonElement;
  motionOnlyBtn: HTMLButtonElement;
  blendBtn: HTMLButtonElement;
  resSlider: HTMLInputElement;
  contrastSlider: HTMLInputElement;
  overlaySlider: HTMLInputElement;
  presetChipsBar: HTMLDivElement;
};

let els: Els;
let ctx: CanvasRenderingContext2D;
let motionCtx: CanvasRenderingContext2D;

// ──────────────────────────────────────────────────────────────────────
// Engine state (created once at boot, reused across frames)
// ──────────────────────────────────────────────────────────────────────

const motion = createMotionState();
const pixelMotion = createPixelMotionState();
let trackedMarkers: Marker[] = [];

// ──────────────────────────────────────────────────────────────────────
// State synchronization to DOM
// ──────────────────────────────────────────────────────────────────────

/** Push the current state to all UI surfaces. Single function for both
 *  user interactions and programmatic changes (e.g. preset clicks). */
function applyState(): void {
  els.invertBtn.classList.toggle('active', state.inverted);
  els.motionOnlyBtn.classList.toggle('active', state.motionOnly);
  const blend = BLEND_MODES[state.blendIndex];
  els.blendBtn.textContent = blend.toUpperCase();
  els.blendBtn.classList.toggle('active', blend !== 'normal');
  els.output.style.mixBlendMode = blend;
  els.videoOverlay.style.opacity = String(state.overlayOpacity);
  els.overlayPct.textContent = Math.round(state.overlayOpacity * 100) + '%';
  els.resSlider.value = String(state.cols);
  els.contrastSlider.value = String(state.contrast);
  els.overlaySlider.value = String(state.overlayOpacity);
  // Sync preset chip highlight
  els.presetChipsBar.querySelectorAll<HTMLElement>('.preset-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.presetId === activePresetId);
  });
}

function applyPresetById(id: string): void {
  const p = findPresetById(id, userPresets);
  if (!p) return;
  activePresetId = id;
  Object.assign(state, p.values);
  applyState();
}

function renderPresetChips(): void {
  const bar = els.presetChipsBar;
  bar.innerHTML = '';

  // Built-in chips (jumpu-tag = interactive label component)
  PRESETS.forEach((p, i) => {
    const id = 'builtin-' + i;
    const btn = document.createElement('button');
    btn.className = 'preset-chip jumpu-tag';
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
    btn.className = 'preset-chip jumpu-tag user';
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

  // SAVE button (jumpu-text-button = secondary action / link-like)
  const save = document.createElement('button');
  save.id = 'save-preset-btn';
  save.className = 'jumpu-text-button';
  save.textContent = '+ SAVE';
  save.title = 'Save current settings as a preset';
  bar.appendChild(save);
}

// ──────────────────────────────────────────────────────────────────────
// Event wiring
// ──────────────────────────────────────────────────────────────────────

function wireEvents(): void {
  els.startBtn.addEventListener('click', toggleCamera);

  // Preset bar: handles chip click, × delete, and + SAVE button
  els.presetChipsBar.addEventListener('click', e => {
    const target = e.target as HTMLElement;

    // Delete user preset
    const delBtn = target.closest<HTMLElement>('.chip-delete');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.deleteId!;
      const p = userPresets.find(x => x.id === id);
      if (!p) return;
      if (!confirm(`Delete preset "${p.name}"?`)) return;
      userPresets = userPresets.filter(x => x.id !== id);
      saveUserPresets(userPresets);
      if (activePresetId === id) activePresetId = '';
      renderPresetChips();
      applyState();
      return;
    }

    // Save current as new user preset
    if (target.closest('#save-preset-btn')) {
      const name = (prompt('Preset name?') || '').trim();
      if (!name) return;
      const newPreset: UserPreset = {
        id: 'user-' + Date.now(),
        name,
        values: snapshotPresetValues(state),
      };
      userPresets.push(newPreset);
      saveUserPresets(userPresets);
      activePresetId = newPreset.id;
      renderPresetChips();
      applyState();
      return;
    }

    // Apply preset
    const chip = target.closest<HTMLElement>('.preset-chip');
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
    state.cols = parseInt((e.target as HTMLInputElement).value);
    applyState();
  });

  els.contrastSlider.addEventListener('input', e => {
    activePresetId = '';
    state.contrast = parseFloat((e.target as HTMLInputElement).value);
  });

  els.overlaySlider.addEventListener('input', e => {
    activePresetId = '';
    state.overlayOpacity = parseFloat((e.target as HTMLInputElement).value);
    applyState();
  });
}

// ──────────────────────────────────────────────────────────────────────
// Camera lifecycle
// ──────────────────────────────────────────────────────────────────────

async function toggleCamera(): Promise<void> {
  if (state.running) {
    state.running = false;
    [els.video, els.videoOverlay].forEach(v => {
      const stream = v.srcObject as MediaStream | null;
      stream?.getTracks().forEach(t => t.stop());
      v.srcObject = null;
    });
    els.dot.className = '';
    els.statusTx.textContent = 'STANDBY';
    els.startBtn.textContent = '▶ START';
    els.resDisp.textContent = '--';
    els.output.textContent = '[ CAMERA STOPPED ]';
    els.output.style.color = 'var(--dim)';
    resetMotionState(motion);
    resetPixelMotionState(pixelMotion);
    trackedMarkers = [];
    motionCtx.clearRect(0, 0, els.motionCanvas.width, els.motionCanvas.height);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
      audio: false,
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
  } catch (err: any) {
    els.output.textContent = `[ CAMERA ERROR: ${err.message} ]`;
    els.statusTx.textContent = 'ERROR';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Per-frame loop: orchestrates engine + DOM updates
// ──────────────────────────────────────────────────────────────────────

let lastTime = 0;
let frameCount = 0;

function renderLoop(ts: number): void {
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

  ensurePixelMotionSize(pixelMotion, COLS * ROWS);

  // Mirror the camera frame onto the processing canvas
  ctx.save();
  ctx.translate(COLS, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(els.video, 0, 0, COLS, ROWS);
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, COLS, ROWS).data;

  // ASCII generation (also updates per-pixel motion buffers)
  const lines = generateAsciiLines(
    imgData,
    COLS,
    ROWS,
    state.contrast,
    state.inverted,
    state.motionOnly,
    pixelMotion,
    ts,
  );
  els.output.textContent = lines.join('\n');

  // Motion grid → clusters → markers → draw
  els.motionCanvas.width  = els.stage.clientWidth;
  els.motionCanvas.height = els.stage.clientHeight;
  detectMotion(imgData, COLS, ROWS, motion);
  const clusters = findClusters(motion);
  trackedMarkers = updateTrackedMarkers(trackedMarkers, clusters, motion, ts);
  drawMotionMarkers(motionCtx, trackedMarkers, els.motionCanvas.width, els.motionCanvas.height, ts);

  requestAnimationFrame(renderLoop);
}

// ──────────────────────────────────────────────────────────────────────
// Boot: collect DOM refs, load presets, wire events, sync UI
// ──────────────────────────────────────────────────────────────────────

export function boot(): void {
  els = {
    video:          document.getElementById('video')          as HTMLVideoElement,
    videoOverlay:   document.getElementById('video-overlay')  as HTMLVideoElement,
    canvas:         document.getElementById('canvas')         as HTMLCanvasElement,
    output:         document.getElementById('ascii-output')   as HTMLDivElement,
    motionCanvas:   document.getElementById('motion-overlay') as HTMLCanvasElement,
    stage:          document.getElementById('stage')          as HTMLDivElement,
    dot:            document.getElementById('dot')            as HTMLDivElement,
    statusTx:       document.getElementById('status-text')    as HTMLSpanElement,
    resDisp:        document.getElementById('res-display')    as HTMLSpanElement,
    fpsDsp:         document.getElementById('fps-display')    as HTMLSpanElement,
    overlayPct:     document.getElementById('overlay-pct')    as HTMLSpanElement,
    startBtn:       document.getElementById('start-btn')      as HTMLButtonElement,
    invertBtn:      document.getElementById('invert-btn')     as HTMLButtonElement,
    motionOnlyBtn:  document.getElementById('motion-only-btn') as HTMLButtonElement,
    blendBtn:       document.getElementById('blend-btn')      as HTMLButtonElement,
    resSlider:      document.getElementById('res-slider')     as HTMLInputElement,
    contrastSlider: document.getElementById('contrast-slider') as HTMLInputElement,
    overlaySlider:  document.getElementById('overlay-slider') as HTMLInputElement,
    presetChipsBar: document.getElementById('preset-chips')   as HTMLDivElement,
  };

  ctx = els.canvas.getContext('2d', { willReadFrequently: true })!;
  motionCtx = els.motionCanvas.getContext('2d')!;

  userPresets = loadUserPresets();
  wireEvents();
  renderPresetChips();
  applyState();
}
