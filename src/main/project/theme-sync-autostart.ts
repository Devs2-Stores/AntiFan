import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSpaceManifest, type SpaceTerminalSpec } from './space-manifest';
import {
  readHaravanBinding,
  readSapoBinding,
  themeSyncSpecId,
  type ThemeSyncPlatform,
} from './sync-identity';

/**
 * What a project window starts by itself when it opens: the theme watcher its platform needs, in a
 * split pane under a terminal the window already has. The command is fixed here, in app code - it
 * is never read from the project folder, which is why this path needs no confirmation.
 */
const WATCHER_COMMANDS: Readonly<Record<ThemeSyncPlatform, { label: string; command: string }>> = {
  haravan: { label: 'hrv theme dev', command: 'hrv theme dev' },
  sapo: { label: 'sapo theme dev', command: 'sapo theme dev' },
  shopify: { label: 'shopify theme dev', command: 'shopify theme dev' },
};

/** Order the panes appear in: Haravan beside Sapo, Shopify last. */
const PLATFORM_ORDER: readonly ThemeSyncPlatform[] = ['haravan', 'sapo', 'shopify'];

/**
 * The platforms a folder is a theme for, judged only by files the platform's own tooling or the
 * workspace intake wrote. A Haravan or Sapo folder counts only with a readable binding (a garbled
 * file means the CLI has nothing to push to); Shopify keeps no binding file, so it counts by its
 * `shopify.theme.toml` or the intake's `platform: "shopify"`.
 */
export function detectThemeSyncPlatforms(folder: string): ThemeSyncPlatform[] {
  const found = new Set<ThemeSyncPlatform>();
  if (readHaravanBinding(folder)) found.add('haravan');
  if (readSapoBinding(folder)) found.add('sapo');
  if (declaresShopify(folder)) found.add('shopify');
  return PLATFORM_ORDER.filter((platform) => found.has(platform));
}

function declaresShopify(folder: string): boolean {
  if (fs.existsSync(path.join(folder, 'shopify.theme.toml'))) return true;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(folder, '.workspace-context.json'), 'utf8'));
    return !!parsed && typeof parsed === 'object' && 'platform' in parsed && parsed.platform === 'shopify';
  } catch {
    return false;
  }
}

/** A command that runs a theme watcher (`hrv theme dev`, `sapo theme watch`, `shopify theme dev`). */
const THEME_WATCHER_COMMAND = /\btheme\s+(dev|watch)\b/;

/**
 * True when the folder's own Space already says how its watcher runs: a `sync` terminal or a
 * terminal whose command is a theme watcher. A Space of bare shells (what `Space init` writes from
 * the open tabs) or of agents (`omp`, `claude`) declares no watcher, so it must not suppress the
 * autostart; neither does a missing or invalid file.
 */
export function spaceDeclaresWatcher(folder: string): boolean {
  const read = readSpaceManifest(folder);
  if (!read.found || !read.parse.ok) return false;
  return read.parse.manifest.terminals.some(
    (terminal) => terminal.role === 'sync' || THEME_WATCHER_COMMAND.test(terminal.command ?? ''),
  );
}

/**
 * The split panes to start under the window's base terminal, or none when the folder is not a
 * theme or its Space already owns the watcher.
 */
export function planThemeSyncAutostart(folder: string): SpaceTerminalSpec[] {
  if (spaceDeclaresWatcher(folder)) return [];
  return detectThemeSyncPlatforms(folder).map((platform) => ({
    id: themeSyncSpecId(platform),
    label: WATCHER_COMMANDS[platform].label,
    command: WATCHER_COMMANDS[platform].command,
    role: 'sync',
    idlePolicy: 'never',
  }));
}
