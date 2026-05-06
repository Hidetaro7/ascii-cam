// ASCII generation, motion detection, and marker drawing.
// Pure functions + canvas drawing helpers (canvas contexts are passed in).
// This module is framework-agnostic and DOM-document-independent: it never
// looks up elements; callers pass in ImageData and rendering contexts.

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type Cluster = {
  x: number;       // normalized [0,1]
  y: number;       // normalized [0,1]
  diff: number;
  cells: number;
};

export type Marker = Cluster & {
  lastSeen: number;    // ms timestamp
  lastActive: number;  // ms timestamp of last "real cluster" hit
};

/** Block-grid motion buffers. Mutated in place by detectMotion. */
export type MotionState = {
  prevBlockLum: Float32Array;
  gridActive: Uint8Array;
  gridDiff: Float32Array;
  initialized: boolean;
};

/** Per-pixel motion buffers used to gate "motion only" ASCII rendering. */
export type PixelMotionState = {
  prevPixelLum: Float32Array;
  pixelLastMove: Float64Array;
  size: number;
  initialized: boolean;
};

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

export const CHARSET_DENSE =
  '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. ';

// Motion grid (block-level)
export const GRID_COLS = 16;
export const GRID_ROWS = 12;
const MOTION_THRESHOLD = 20;
const SOFT_TRACK_THRESHOLD = 10;
const ACTIVE_LINK_MS = 250;
const MARKER_LINGER_MS = 3000;
const MATCH_DIST = 0.15;

// Per-pixel motion (for motion-only ASCII)
const PIXEL_MOTION_THRESHOLD = 25;
const ASCII_LINGER_MS = 400;

// ──────────────────────────────────────────────────────────────────────
// State factories
// ──────────────────────────────────────────────────────────────────────

export function createMotionState(): MotionState {
  return {
    prevBlockLum: new Float32Array(GRID_COLS * GRID_ROWS),
    gridActive:   new Uint8Array(GRID_COLS * GRID_ROWS),
    gridDiff:     new Float32Array(GRID_COLS * GRID_ROWS),
    initialized: false,
  };
}

export function createPixelMotionState(): PixelMotionState {
  return {
    prevPixelLum:  new Float32Array(0),
    pixelLastMove: new Float64Array(0),
    size: 0,
    initialized: false,
  };
}

/** Reset motion buffers (used when camera stops). */
export function resetMotionState(s: MotionState): void {
  s.prevBlockLum.fill(0);
  s.gridActive.fill(0);
  s.gridDiff.fill(0);
  s.initialized = false;
}

export function resetPixelMotionState(s: PixelMotionState): void {
  s.prevPixelLum.fill(0);
  s.pixelLastMove.fill(0);
  s.initialized = false;
}

/** Resize per-pixel buffers when the processing canvas changes size. */
export function ensurePixelMotionSize(s: PixelMotionState, pixCount: number): void {
  if (pixCount === s.size) return;
  s.prevPixelLum  = new Float32Array(pixCount);
  s.pixelLastMove = new Float64Array(pixCount);
  s.size = pixCount;
  s.initialized = false;
}

// ──────────────────────────────────────────────────────────────────────
// ASCII generation (also updates per-pixel motion)
// ──────────────────────────────────────────────────────────────────────

export function generateAsciiLines(
  imgData: Uint8ClampedArray,
  cols: number,
  rows: number,
  contrast: number,
  inverted: boolean,
  motionOnly: boolean,
  pixelMotion: PixelMotionState,
  ts: number,
): string[] {
  const charset = CHARSET_DENSE;
  const clen = charset.length - 1;
  const lines: string[] = [];

  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;

      // Per-pixel motion tracking (raw luminance, before contrast)
      const pi = row * cols + col;
      if (pixelMotion.initialized) {
        if (Math.abs(lum - pixelMotion.prevPixelLum[pi]) > PIXEL_MOTION_THRESHOLD) {
          pixelMotion.pixelLastMove[pi] = ts;
        }
      }
      pixelMotion.prevPixelLum[pi] = lum;

      // Apply contrast for ASCII mapping
      let lumC = ((lum / 255 - 0.5) * contrast + 0.5) * 255;
      lumC = Math.max(0, Math.min(255, lumC));
      let idx = Math.floor((lumC / 255) * clen);
      if (!inverted) idx = clen - idx;

      if (motionOnly && (ts - pixelMotion.pixelLastMove[pi] > ASCII_LINGER_MS)) {
        line += ' ';
      } else {
        line += charset[idx];
      }
    }
    lines.push(line);
  }
  pixelMotion.initialized = true;

  return lines;
}

// ──────────────────────────────────────────────────────────────────────
// Block-grid motion detection
// ──────────────────────────────────────────────────────────────────────

export function detectMotion(
  imgData: Uint8ClampedArray,
  frameCols: number,
  frameRows: number,
  s: MotionState,
): void {
  const bw = frameCols / GRID_COLS;
  const bh = frameRows / GRID_ROWS;
  s.gridActive.fill(0);

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
          sum += 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
          count++;
        }
      }

      const avg = count > 0 ? sum / count : 0;
      const idx = gy * GRID_COLS + gx;

      if (s.initialized) {
        const diff = Math.abs(avg - s.prevBlockLum[idx]);
        s.gridDiff[idx] = diff;
        if (diff > MOTION_THRESHOLD) {
          s.gridActive[idx] = 1;
        }
      }

      s.prevBlockLum[idx] = avg;
    }
  }
  s.initialized = true;
}

/** Flood-fill over active grid cells to produce normalized cluster centers. */
export function findClusters(s: MotionState): Cluster[] {
  const visited = new Uint8Array(GRID_COLS * GRID_ROWS);
  const clusters: Cluster[] = [];

  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const idx = gy * GRID_COLS + gx;
      if (!s.gridActive[idx] || visited[idx]) continue;

      const queue: { gx: number; gy: number }[] = [{ gx, gy }];
      visited[idx] = 1;
      let sumX = 0, sumY = 0, sumDiff = 0, count = 0;

      while (queue.length > 0) {
        const { gx: cx, gy: cy } = queue.shift()!;
        sumX += cx; sumY += cy;
        sumDiff += s.gridDiff[cy * GRID_COLS + cx];
        count++;

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
          const ni = ny * GRID_COLS + nx;
          if (!s.gridActive[ni] || visited[ni]) continue;
          visited[ni] = 1;
          queue.push({ gx: nx, gy: ny });
        }
      }

      clusters.push({
        x: (sumX / count + 0.5) / GRID_COLS,
        y: (sumY / count + 0.5) / GRID_ROWS,
        diff: sumDiff / count,
        cells: count,
      });
    }
  }
  return clusters;
}

/**
 * Match existing markers to clusters; soft-track unmatched markers via the
 * highest-diff cell in the neighborhood; spawn markers for new clusters;
 * drop expired markers. Returns the new marker array.
 */
export function updateTrackedMarkers(
  prevMarkers: Marker[],
  clusters: Cluster[],
  s: MotionState,
  ts: number,
): Marker[] {
  const markers = prevMarkers.slice();
  const used = new Uint8Array(clusters.length);

  for (const m of markers) {
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
      // Soft tracking: follow highest-diff cell in 5×5 neighborhood
      const gx = Math.floor(m.x * GRID_COLS);
      const gy = Math.floor(m.y * GRID_ROWS);
      const r = 2;
      let bestDiff = 0, bx = gx, by = gy;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
          const d = s.gridDiff[ny * GRID_COLS + nx];
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

  // Spawn markers for unmatched clusters
  for (let i = 0; i < clusters.length; i++) {
    if (used[i]) continue;
    const c = clusters[i];
    markers.push({ x: c.x, y: c.y, diff: c.diff, cells: c.cells, lastSeen: ts, lastActive: ts });
  }

  // Drop expired markers
  return markers.filter(m => ts - m.lastSeen <= MARKER_LINGER_MS);
}

// ──────────────────────────────────────────────────────────────────────
// Marker rendering (canvas)
// ──────────────────────────────────────────────────────────────────────

export function drawMotionMarkers(
  ctx: CanvasRenderingContext2D,
  markers: Marker[],
  w: number,
  h: number,
  ts: number,
): void {
  ctx.clearRect(0, 0, w, h);
  if (markers.length === 0) return;

  const pts = markers.map(m => ({
    px: m.x * w, py: m.y * h,
    diff: m.diff, cells: m.cells,
    active: ts - m.lastActive <= ACTIVE_LINK_MS,
  }));

  // Connecting lines: only between currently-active markers
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  for (let i = 0; i < pts.length; i++) {
    if (!pts[i].active) continue;
    for (let j = i + 1; j < pts.length; j++) {
      if (!pts[j].active) continue;
      ctx.beginPath();
      ctx.moveTo(pts[i].px, pts[i].py);
      ctx.lineTo(pts[j].px, pts[j].py);
      ctx.stroke();
    }
  }

  // Square markers
  const markerSize = Math.max(3, w / GRID_COLS * 0.075);
  const half = markerSize / 2;
  ctx.lineWidth = 1.5;
  for (const p of pts) {
    ctx.strokeRect(p.px - half, p.py - half, markerSize, markerSize);
  }

  // Data labels
  const fontSize = 16;
  ctx.font = `${fontSize}px 'Share Tech Mono', monospace`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  for (const p of pts) {
    const val = (p.diff * p.cells + p.px * 0.1 + p.py * 0.07) % 1000;
    ctx.fillText(val.toFixed(1), p.px + half + 3, p.py - half);
  }
}
