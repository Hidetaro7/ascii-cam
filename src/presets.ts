// Preset data, storage I/O, and shared user-settings types.
// No DOM access here — pure data + localStorage.

/** User-facing settings. Single source of truth for the running app state. */
export type State = {
  running: boolean;
  inverted: boolean;
  cols: number;
  contrast: number;
  overlayOpacity: number;
  blendIndex: number;
  motionOnly: boolean;
};

/** Subset of State that gets persisted in presets (excludes runtime flags). */
export type PresetValues = Omit<State, 'running'>;

/** Built-in preset shape: values + a display name (inlined). */
export type BuiltinPreset = PresetValues & { name: string };

/** User-saved preset shape. */
export type UserPreset = {
  id: string;          // 'user-<timestamp>'
  name: string;
  values: PresetValues;
};

/** ASCII output's mix-blend-mode options. state.blendIndex indexes into this. */
export const BLEND_MODES = ['screen', 'lighten', 'hard-light', 'overlay', 'normal'] as const;

/** Built-in (read-only) presets. */
export const PRESETS: BuiltinPreset[] = [
  { name: 'DEFAULT',   inverted: false, cols: 90,  contrast: 1.75, overlayOpacity: 1.0, blendIndex: 4, motionOnly: true  },
  { name: 'CINEMATIC', inverted: false, cols: 80,  contrast: 2.5,  overlayOpacity: 0.5, blendIndex: 0, motionOnly: false },
  { name: 'GLITCH',    inverted: false, cols: 120, contrast: 2.2,  overlayOpacity: 0.7, blendIndex: 2, motionOnly: true  },
  { name: 'SOFT',      inverted: false, cols: 65,  contrast: 1.2,  overlayOpacity: 0.5, blendIndex: 1, motionOnly: false },
  { name: 'MONO',      inverted: true,  cols: 90,  contrast: 2.0,  overlayOpacity: 0.0, blendIndex: 4, motionOnly: false },
];

/** localStorage schema (versioned for future migrations). */
const STORAGE_KEY = 'ascii-cam:userPresets';
const STORAGE_VERSION = 1;

export function loadUserPresets(): UserPreset[] {
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

export function saveUserPresets(userPresets: UserPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      presets: userPresets,
    }));
  } catch (e) {
    console.warn('Failed to save user presets:', e);
  }
}

/** Look up a preset by id across both built-in and user collections. */
export function findPresetById(
  id: string,
  userPresets: UserPreset[],
): { name: string; values: PresetValues } | null {
  if (id.startsWith('builtin-')) {
    const i = parseInt(id.slice('builtin-'.length), 10);
    const p = PRESETS[i];
    if (!p) return null;
    const { name, ...values } = p;
    return { name, values };
  }
  if (id.startsWith('user-')) {
    return userPresets.find(p => p.id === id) || null;
  }
  return null;
}

/** Extract savable values from current state (excludes 'running'). */
export function snapshotPresetValues(state: State): PresetValues {
  return {
    inverted:       state.inverted,
    cols:           state.cols,
    contrast:       state.contrast,
    overlayOpacity: state.overlayOpacity,
    blendIndex:     state.blendIndex,
    motionOnly:     state.motionOnly,
  };
}
