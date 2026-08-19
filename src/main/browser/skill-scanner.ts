/**
 * AntiFan Browser Desktop — Dynamic Skill & Agent Scanner
 * Scans all 100+ installed skills from ~/.gemini/config/skills/,
 * ~/.gemini/config/plugins/, workspace .agents/skills/, and active agents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface AutocompleteItem {
  tag: string;
  desc: string;
  type: 'skill' | 'agent';
}

export class SkillScanner {
  private static instance: SkillScanner;
  private cachedItems: AutocompleteItem[] = [];
  private lastScanTime: number = 0;

  public static getInstance(): SkillScanner {
    if (!this.instance) {
      this.instance = new SkillScanner();
    }
    return this.instance;
  }

  public getAutocompleteItems(workspaceDir?: string): AutocompleteItem[] {
    const now = Date.now();
    // Cache for 10 seconds to keep performance fast
    if (this.cachedItems.length > 0 && now - this.lastScanTime < 10000) {
      return this.cachedItems;
    }

    const itemsMap = new Map<string, AutocompleteItem>();

    // 1. Scan Global Skills from ~/.gemini/config/skills
    const globalSkillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
    this.scanSkillsDir(globalSkillsDir, itemsMap);

    // 2. Scan Global Plugin Skills from ~/.gemini/config/plugins
    const globalPluginsDir = path.join(os.homedir(), '.gemini', 'config', 'plugins');
    if (fs.existsSync(globalPluginsDir)) {
      try {
        const plugins = fs.readdirSync(globalPluginsDir, { withFileTypes: true });
        for (const p of plugins) {
          if (p.isDirectory()) {
            const pluginSkillsDir = path.join(globalPluginsDir, p.name, 'skills');
            this.scanSkillsDir(pluginSkillsDir, itemsMap);
          }
        }
      } catch {}
    }

    // 3. Scan Workspace Skills from .agents/skills, .gemini/skills, .claude/skills
    const ws = workspaceDir || process.cwd();
    const wsDirs = [
      path.join(ws, '.agents', 'skills'),
      path.join(ws, '.gemini', 'skills'),
      path.join(ws, '.claude', 'skills'),
      path.join(ws, '..', '.agents', 'skills'),
      'e:\\Work\\.agents\\skills',
    ];
    for (const d of wsDirs) {
      this.scanSkillsDir(d, itemsMap);
    }

    // 4. Built-in Core Agents
    const coreAgents: Array<{ tag: string; desc: string }> = [
      { tag: '@brainstormer', desc: 'CTO-level advisor challenging assumptions & alternative architectures' },
      { tag: '@code-reviewer', desc: 'Staff engineer production-readiness code & security review' },
      { tag: '@code-simplifier', desc: 'Refactor and simplify code complexity without breaking behavior' },
      { tag: '@debugger', desc: 'Systematic root-cause diagnosis & hypothesis test validation' },
      { tag: '@devops', desc: 'Cloudflare, Docker, CI/CD, and serverless deployment pipeline' },
      { tag: '@frontend-design', desc: 'Pixel-perfect UI design, micro-animations & components' },
      { tag: '@planner', desc: 'Architectural planning, task decomposition & risk management' },
      { tag: '@git', desc: 'Git operations, atomic commits, PR preparation & branching' },
      { tag: '@security-scan', desc: 'Vulnerability assessment, secret audit & OWASP checks' },
      { tag: '@test', desc: 'Test execution, coverage analysis & test-driven development' },
    ];
    for (const a of coreAgents) {
      itemsMap.set(a.tag, { tag: a.tag, desc: a.desc, type: 'agent' });
    }

    this.cachedItems = Array.from(itemsMap.values()).sort((a, b) => a.tag.localeCompare(b.tag));
    this.lastScanTime = now;
    return this.cachedItems;
  }

  private scanSkillsDir(dirPath: string, itemsMap: Map<string, AutocompleteItem>): void {
    if (!fs.existsSync(dirPath)) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const skillName = entry.name;
        const skillTag = `/${skillName}`;
        if (itemsMap.has(skillTag)) continue;

        let desc = 'Skill workflow helper';
        const skillMd = path.join(dirPath, skillName, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          try {
            const content = fs.readFileSync(skillMd, 'utf8');
            // Extract description from YAML frontmatter
            const match = content.match(/description:\s*(.*?)$/m);
            if (match && match[1]) {
              desc = match[1].trim().replace(/^['"]|['"]$/g, '');
            } else {
              // Extract first heading or paragraph
              const lines = content.split('\n').filter((l) => l.trim().length > 0);
              for (const line of lines) {
                if (!line.startsWith('---') && !line.startsWith('#') && line.length > 5) {
                  desc = line.trim().slice(0, 100);
                  break;
                }
              }
            }
          } catch {}
        }

        itemsMap.set(skillTag, {
          tag: skillTag,
          desc,
          type: 'skill',
        });
      }
    } catch {}
  }
}
