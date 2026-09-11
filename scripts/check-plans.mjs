#!/usr/bin/env node
/**
 * Plan registry gate: every `plans/&#42;&#42;/plan.md` declares a status this repository recognizes.
 *
 * The `status:` field was consumed by nothing across ~58 plans, so finished work and abandoned
 * work were indistinguishable. This consumer makes the field load-bearing: an unrecognized
 * spelling fails the gate, and the bucket summary is the number reports quote.
 *
 * Usage: node scripts/check-plans.mjs [--root plans] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

const STATUS_BUCKETS = {
  completed: 'done',
  complete: 'done',
  done: 'done',
  'in-progress': 'active',
  active: 'active',
  pending: 'pending',
  planned: 'pending',
  superseded: 'superseded',
  blocked: 'blocked',
};

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    fields[field[1].toLowerCase()] = field[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

function collectPlanFiles(root) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        visit(fullPath);
      } else if (entry.isFile() && entry.name === 'plan.md') {
        found.push(fullPath);
      }
    }
  };
  visit(root);
  return found.sort();
}

function parseArgs(argv) {
  const options = { root: 'plans', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      options.root = value;
      index += 1;
    } else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length);
    else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const files = collectPlanFiles(options.root);
  const buckets = {};
  const unknown = [];
  let withoutFrontmatter = 0;

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      unknown.push({ file, status: `<unreadable: ${error.message}>` });
      continue;
    }
    const fields = parseFrontmatter(text);
    if (!fields) {
      withoutFrontmatter += 1;
      continue;
    }
    const status = fields.status ?? '';
    const bucket = STATUS_BUCKETS[status];
    if (!bucket) {
      unknown.push({ file, status });
      continue;
    }
    if (!buckets[bucket]) buckets[bucket] = { count: 0, spellings: {} };
    buckets[bucket].count += 1;
    buckets[bucket].spellings[status] = (buckets[bucket].spellings[status] ?? 0) + 1;
  }

  const summary = {
    root: options.root,
    plans: files.length,
    classified: files.length - withoutFrontmatter - unknown.length,
    withoutFrontmatter,
    buckets,
    unknown,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const parts = Object.entries(buckets)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([bucket, entry]) => `${bucket}=${entry.count}`);
    process.stdout.write(`plans=${summary.plans} classified=${summary.classified} no-frontmatter=${summary.withoutFrontmatter} ${parts.join(' ')}\n`);
    for (const entry of unknown) {
      process.stdout.write(`unknown status ${JSON.stringify(entry.status)} in ${entry.file}\n`);
    }
  }

  return unknown.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`check-plans: ${error.message}\n`);
  process.exitCode = 2;
}
