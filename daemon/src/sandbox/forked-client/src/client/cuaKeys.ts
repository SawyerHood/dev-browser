// @ts-nocheck
const KEY_ALIASES: Record<string, string> = {
  alt: "Alt",
  option: "Alt",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  backspace: "Backspace",
  capslock: "CapsLock",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  ctrl: "ControlOrMeta",
  control: "ControlOrMeta",
  del: "Delete",
  delete: "Delete",
  end: "End",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  pagedown: "PageDown",
  pgdn: "PageDown",
  pageup: "PageUp",
  pgup: "PageUp",
  shift: "Shift",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
};

const CHORD_REWRITES: Record<string, string[]> = {
  "ctrl+a": ["ControlOrMeta", "a"],
  "ctrl+c": ["ControlOrMeta", "c"],
  "ctrl+l": ["ControlOrMeta", "l"],
  "ctrl+n": ["ControlOrMeta", "n"],
  "ctrl+v": ["ControlOrMeta", "v"],
  "ctrl+x": ["ControlOrMeta", "x"],
  "ctrl+y": ["ControlOrMeta", "Shift", "z"],
  "ctrl+z": ["ControlOrMeta", "z"],
};

function normalizeKey(key: string): string {
  const lowered = String(key).trim().toLowerCase();
  const alias = KEY_ALIASES[lowered];
  if (alias) return alias;
  if (/^f\d{1,2}$/.test(lowered)) return "F" + lowered.slice(1);
  if (lowered.length === 1) return lowered;
  return key;
}

export function normalizeKeys(keys: string[]): string[] {
  const lowered = keys.map((key) => String(key).trim().toLowerCase());
  const chord = CHORD_REWRITES[lowered.join("+")];
  if (chord) return chord.slice();
  return keys.map(normalizeKey);
}
