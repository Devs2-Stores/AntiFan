/**
 * Centralized Keyboard Event Normalizer for Electron WebContents
 * Maps human/agent key strings and modifiers to strict Electron InputEvent descriptors.
 */

export type ElectronModifier = 'control' | 'shift' | 'alt' | 'meta';

export interface NormalizedKeyInfo {
  keyCode: string;
  isPrintable: boolean;
  text?: string;
}

export interface KeyboardInputEventDescriptor {
  type: 'keyDown' | 'char' | 'keyUp';
  keyCode: string;
  modifiers: ElectronModifier[];
}

const NAMED_KEY_MAP: Record<string, { keyCode: string; isPrintable: boolean; text?: string }> = {
  // Navigation & Control
  enter: { keyCode: 'Return', isPrintable: false },
  return: { keyCode: 'Return', isPrintable: false },
  escape: { keyCode: 'Escape', isPrintable: false },
  esc: { keyCode: 'Escape', isPrintable: false },
  tab: { keyCode: 'Tab', isPrintable: false },
  backspace: { keyCode: 'Backspace', isPrintable: false },
  delete: { keyCode: 'Delete', isPrintable: false },
  del: { keyCode: 'Delete', isPrintable: false },
  insert: { keyCode: 'Insert', isPrintable: false },
  home: { keyCode: 'Home', isPrintable: false },
  end: { keyCode: 'End', isPrintable: false },
  pageup: { keyCode: 'PageUp', isPrintable: false },
  pagedown: { keyCode: 'PageDown', isPrintable: false },
  arrowup: { keyCode: 'Up', isPrintable: false },
  up: { keyCode: 'Up', isPrintable: false },
  arrowdown: { keyCode: 'Down', isPrintable: false },
  down: { keyCode: 'Down', isPrintable: false },
  arrowleft: { keyCode: 'Left', isPrintable: false },
  left: { keyCode: 'Left', isPrintable: false },
  arrowright: { keyCode: 'Right', isPrintable: false },
  right: { keyCode: 'Right', isPrintable: false },
  space: { keyCode: 'Space', isPrintable: true, text: ' ' },
  spacebar: { keyCode: 'Space', isPrintable: true, text: ' ' },
  plus: { keyCode: '+', isPrintable: true, text: '+' },
  // Function Keys
  f1: { keyCode: 'F1', isPrintable: false },
  f2: { keyCode: 'F2', isPrintable: false },
  f3: { keyCode: 'F3', isPrintable: false },
  f4: { keyCode: 'F4', isPrintable: false },
  f5: { keyCode: 'F5', isPrintable: false },
  f6: { keyCode: 'F6', isPrintable: false },
  f7: { keyCode: 'F7', isPrintable: false },
  f8: { keyCode: 'F8', isPrintable: false },
  f9: { keyCode: 'F9', isPrintable: false },
  f10: { keyCode: 'F10', isPrintable: false },
  f11: { keyCode: 'F11', isPrintable: false },
  f12: { keyCode: 'F12', isPrintable: false },
};

const MODIFIER_MAP: Record<string, ElectronModifier> = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  windows: 'meta',
};

export function normalizeKey(rawKey: string): NormalizedKeyInfo {
  if (typeof rawKey !== 'string' || rawKey.trim().length === 0) {
    throw new Error('Key must be a non-empty string');
  }

  const trimmed = rawKey.trim();
  const lower = trimmed.toLowerCase();

  // 1. Check named keys
  if (NAMED_KEY_MAP[lower]) {
    return { ...NAMED_KEY_MAP[lower] };
  }

  // 2. Single printable character (e.g. 'a', 'Z', '1', '!', '@')
  if (trimmed.length === 1) {
    return {
      keyCode: trimmed,
      isPrintable: true,
      text: trimmed,
    };
  }

  throw new Error(`Unknown or unsupported key: "${rawKey}"`);
}

export function normalizeModifiers(modifiers?: string[]): ElectronModifier[] {
  if (!modifiers || !Array.isArray(modifiers) || modifiers.length === 0) {
    return [];
  }

  const resultSet = new Set<ElectronModifier>();
  for (const rawMod of modifiers) {
    if (typeof rawMod !== 'string' || rawMod.trim().length === 0) {
      throw new Error('Modifier must be a non-empty string');
    }
    const normalized = MODIFIER_MAP[rawMod.trim().toLowerCase()];
    if (!normalized) {
      throw new Error(`Unknown modifier: "${rawMod}". Allowed: control, shift, alt, meta`);
    }
    resultSet.add(normalized);
  }

  return Array.from(resultSet);
}

export function parseKeyCombo(rawInput: string): { key: string; modifiers: ElectronModifier[] } {
  if (typeof rawInput !== 'string' || rawInput.trim().length === 0) {
    throw new Error('Key must be a non-empty string');
  }

  const trimmed = rawInput.trim();
  if (trimmed === '+') {
    return { key: '+', modifiers: [] };
  }

  // Handle trailing plus key e.g. "Control++", "Shift+Alt++", "++"
  if (trimmed.endsWith('++')) {
    const modPrefix = trimmed.slice(0, -2);
    const modParts = modPrefix.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
    return {
      key: '+',
      modifiers: normalizeModifiers(modParts),
    };
  }

  // Malformed hanging combination e.g. "Ctrl+", "Shift+"
  if (trimmed.endsWith('+')) {
    throw new Error(`Incomplete or malformed key combination: "${rawInput}"`);
  }

  if (trimmed.includes('+')) {
    const parts = trimmed.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) {
      return { key: '+', modifiers: [] };
    }
    const rawKey = parts[parts.length - 1] ?? '+';
    const rawMods = parts.slice(0, -1);
    return {
      key: rawKey,
      modifiers: normalizeModifiers(rawMods),
    };
  }
  return {
    key: trimmed,
    modifiers: [],
  };
}

export function buildKeyboardInputEvents(rawKey: string, rawModifiers?: string[]): KeyboardInputEventDescriptor[] {
  const parsed = parseKeyCombo(rawKey);
  const keyInfo = normalizeKey(parsed.key);
  const explicitModifiers = normalizeModifiers(rawModifiers);
  const allModifiers = Array.from(new Set([...parsed.modifiers, ...explicitModifiers]));

  const events: KeyboardInputEventDescriptor[] = [
    { type: 'keyDown', keyCode: keyInfo.keyCode, modifiers: allModifiers },
  ];

  // If printable and no control/meta modifier (which make it a command shortcut like Ctrl+C)
  const isShortcut = allModifiers.includes('control') || allModifiers.includes('meta');
  if (keyInfo.isPrintable && !isShortcut) {
    events.push({
      type: 'char',
      keyCode: keyInfo.text || keyInfo.keyCode,
      modifiers: allModifiers,
    });
  }

  events.push({ type: 'keyUp', keyCode: keyInfo.keyCode, modifiers: allModifiers });

  return events;
}
