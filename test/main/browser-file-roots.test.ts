import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import type { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { extraFileRoots, extraRootNameRefusal } from '../../src/main/qa/diagnostics-filter';
import { CapabilityError, type BrowserTarget, type CapabilityRequestContext, type RuntimeLease } from '../../src/shared/control-plane-contracts';

const projectId = 'proj-roots';
const workspaceId = 'ws-roots';

const lease: RuntimeLease = {
  token: 'lease-tok',
  expiresAt: Date.now() + 60_000,
  runtimeId: 'run-1',
  projectId,
  workspaceId,
  protocolVersion: 1,
  hostEpoch: 1,
  ownerPid: process.pid,
  issuedAt: Date.now(),
};

const target: BrowserTarget = { projectId, workspaceId, runtimeId: 'run-1', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 };

const context: CapabilityRequestContext = {
  lease, leaseToken: 'lease-tok', projectId, workspaceId, runId: 'run-1', attemptId: 'att-1', browserTarget: target, grant: 'write',
};

describe('extra file roots for expressionFile, saveTo and dump_dom outputPath', () => {
  let tmp = '';
  let workspace = '';
  let jobsRoot = '';
  let job = '';
  let staged = '';
  const saved: Record<string, string | undefined> = {};

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-file-roots-')));
    workspace = path.join(tmp, 'ws');
    jobsRoot = path.join(tmp, 'leader');
    job = path.join(jobsRoot, 'job1');
    fs.mkdirSync(workspace);
    fs.mkdirSync(job, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'leader-evil', 'job'), { recursive: true });
    staged = path.join(workspace, '.staged.png');
    fs.writeFileSync(staged, 'PNGBYTES');
    for (const key of ['LEADER_JOBS_ROOT', 'ANTIFAN_EXTRA_FILE_ROOTS']) saved[key] = process.env[key];
    process.env.LEADER_JOBS_ROOT = jobsRoot;
    delete process.env.ANTIFAN_EXTRA_FILE_ROOTS;
  });

  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let workspaceOverride: string | undefined;
  let registryThrows = false;

  function surface(): CapabilityCatalogue {
    const port = {
      evalChecked: async (_target: unknown, expression: string) => ({ value: expression }),
      dumpDom: async (_target: unknown, outputPath: string) => ({ written: outputPath }),
      screenshot: async () => ({ artifactRef: { path: staged }, tabId: 'tab-1' }),
    } as unknown as BrowserControlPort;
    const workspaceRegistry = {
      get: () => {
        if (registryThrows) throw new Error('registry offline');
        return { id: workspaceId, projectId, rootPath: workspaceOverride ?? workspace, state: 'attached', createdAt: 0, updatedAt: 0 };
      },
    };
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: 'run-1',
      hostEpoch: 1,
      workspaceRegistry,
    } as unknown as ConstructorParameters<typeof CapabilityCatalogue>[0]);
    registerBrowserCapabilities(catalogue, port);
    return catalogue;
  }

  const read = (expressionFile: string) => surface().get('anti.browser.evaluate')!.execute({ expressionFile }, context);
  const save = (saveTo: string) => surface().get('anti.screenshot.viewport')!.execute({ saveTo }, context) as Promise<{ savedTo?: string }>;
  const dump = (outputPath: string) => surface().get('browser.dump_dom')!.execute({ outputPath }, context);
  const refused = (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT';

  describe('expressionFile', () => {
    it('reads a probe kept in a Leader job folder', async () => {
      fs.writeFileSync(path.join(job, 'probe.js'), '1 + 1');
      assert.equal(await read(path.join(job, 'probe.js')), '1 + 1');
    });

    it('refuses a file directly in the jobs root', async () => {
      fs.writeFileSync(path.join(jobsRoot, 'top.js'), '1');
      await assert.rejects(async () => read(path.join(jobsRoot, 'top.js')), refused);
    });

    it('refuses traversal out of the jobs root and a sibling prefix', async () => {
      fs.writeFileSync(path.join(tmp, 'x.js'), '1');
      fs.writeFileSync(path.join(tmp, 'leader-evil', 'job', 'x.js'), '1');
      await assert.rejects(async () => read(path.join(jobsRoot, '..', 'x.js')), refused);
      await assert.rejects(async () => read(path.join(`${jobsRoot}-evil`, 'job', 'x.js')), refused);
    });

    it('refuses protected names under a job folder', async () => {
      fs.mkdirSync(path.join(job, '.git'), { recursive: true });
      fs.writeFileSync(path.join(job, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(job, '.git', 'config'), '[core]');
      fs.writeFileSync(path.join(job, 'key.pem'), 'pem');
      for (const file of [path.join(job, '.env'), path.join(job, '.git', 'config'), path.join(job, 'key.pem')]) {
        await assert.rejects(async () => read(file), refused, file);
      }
    });

    it('refuses a directory and a file above the size cap', async () => {
      fs.mkdirSync(path.join(job, 'sub.js'), { recursive: true });
      fs.writeFileSync(path.join(job, 'big.js'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      await assert.rejects(async () => read(path.join(job, 'sub.js')), refused);
      await assert.rejects(async () => read(path.join(job, 'big.js')), refused);
    });

    it('refuses a junction inside the job folder that points outside the root', async (t) => {
      const outside = path.join(tmp, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'leak.js'), 'leak');
      try {
        fs.symlinkSync(outside, path.join(job, 'link'), 'junction');
      } catch (err) {
        t.skip(`this platform refused to create a junction: ${(err as Error).message}`);
        return;
      }
      await assert.rejects(async () => read(path.join(job, 'link', 'leak.js')), refused);
    });

    it('keeps reading a workspace-relative file exactly as before', async () => {
      fs.writeFileSync(path.join(workspace, 'probe.js'), '2 + 2');
      assert.equal(await read('probe.js'), '2 + 2');
    });

    it('a named workspace the registry cannot resolve is refused, never read from the app cwd', async () => {
      const probe = path.join(process.cwd(), `.k04-probe-${process.pid}.js`);
      fs.writeFileSync(probe, '3 + 3');
      registryThrows = true;
      try {
        await assert.rejects(
          async () => read(path.basename(probe)),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH',
        );
        await assert.rejects(
          async () => save('shot.png'),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH',
        );
        await assert.rejects(
          async () => surface().get('anti.agent.file_upload')!.execute({ selector: 'input', filePaths: [probe] }, context),
          (err: unknown) => err instanceof CapabilityError && err.code === 'WORKSPACE_MISMATCH',
        );
      } finally {
        registryThrows = false;
        fs.rmSync(probe, { force: true });
      }
    });
  });

  describe('saveTo and outputPath', () => {
    it('saveTo writes a screenshot into a job folder', async () => {
      const file = path.join(job, 'shot.png');
      const result = await save(file);
      assert.equal(path.resolve(result.savedTo!).toLowerCase(), file.toLowerCase());
      assert.equal(fs.readFileSync(file, 'utf8'), 'PNGBYTES');
    });

    it('dump_dom outputPath accepts a job folder file', async () => {
      const file = path.join(job, 'dom.html');
      const result = await dump(file) as { written: string };
      assert.equal(path.resolve(result.written).toLowerCase(), file.toLowerCase());
    });

    it('overwrites an existing evidence file', async () => {
      fs.writeFileSync(path.join(job, 'again.png'), 'old');
      await save(path.join(job, 'again.png'));
      assert.equal(fs.readFileSync(path.join(job, 'again.png'), 'utf8'), 'PNGBYTES');
    });

    it('refuses the files a Leader job owns, even when they do not exist yet', async () => {
      for (const name of ['job.json', 'JOB.JSON', 'a.report.md', 'a.prompt.md', 'a.followup.md', 'A.Report.MD']) {
        await assert.rejects(async () => save(path.join(job, name)), refused, name);
        assert.equal(fs.existsSync(path.join(job, name)), false, name);
      }
    });

    it('refuses overwriting an existing text file and leaves it unchanged', async () => {
      for (const name of ['notes.md', 'old.json', 'old.txt', 'old.csv']) {
        fs.writeFileSync(path.join(job, name), 'keep');
        await assert.rejects(async () => save(path.join(job, name)), refused, name);
        assert.equal(fs.readFileSync(path.join(job, name), 'utf8'), 'keep', name);
      }
    });

    it('creates a new text file and overwrites an existing image or html file', async () => {
      const created = path.join(job, 'dom.json');
      await save(created);
      assert.equal(fs.readFileSync(created, 'utf8'), 'PNGBYTES');
      fs.writeFileSync(path.join(job, 'shot.png'), 'old');
      await save(path.join(job, 'shot.png'));
      assert.equal(fs.readFileSync(path.join(job, 'shot.png'), 'utf8'), 'PNGBYTES');
      fs.writeFileSync(path.join(job, 'page.html'), 'old');
      await dump(path.join(job, 'page.html'));
    });

    it('refuses a file directly in the jobs root, traversal and a sibling prefix', async () => {
      await assert.rejects(async () => save(path.join(jobsRoot, 'top.png')), refused);
      await assert.rejects(async () => save(path.join(jobsRoot, '..', 'x.png')), refused);
      await assert.rejects(async () => save(path.join(`${jobsRoot}-evil`, 'job', 'x.png')), refused);
      await assert.rejects(async () => dump(path.join(jobsRoot, 'top.html')), refused);
    });

    it('refuses protected names', async () => {
      await assert.rejects(async () => save(path.join(job, '.env')), refused);
      await assert.rejects(async () => save(path.join(job, '.git', 'config')), refused);
      await assert.rejects(async () => save(path.join(job, 'key.pem')), refused);
    });

    it('refuses a script extension and overwriting an existing script', async () => {
      fs.writeFileSync(path.join(job, 'existing.js'), 'keep');
      await assert.rejects(async () => save(path.join(job, 'run.js')), refused);
      await assert.rejects(async () => save(path.join(job, 'existing.js')), refused);
      assert.equal(fs.readFileSync(path.join(job, 'existing.js'), 'utf8'), 'keep');
    });

    it('never creates a missing folder', async () => {
      await assert.rejects(async () => save(path.join(job, 'missing-folder', 'a.png')), refused);
      assert.equal(fs.existsSync(path.join(job, 'missing-folder')), false);
    });

    it('refuses a write through a junction that points outside the root', async (t) => {
      const outside = path.join(tmp, 'outside-write');
      fs.mkdirSync(outside);
      try {
        fs.symlinkSync(outside, path.join(job, 'wlink'), 'junction');
      } catch (err) {
        t.skip(`this platform refused to create a junction: ${(err as Error).message}`);
        return;
      }
      await assert.rejects(async () => save(path.join(job, 'wlink', 'a.png')), refused);
      assert.equal(fs.existsSync(path.join(outside, 'a.png')), false);
    });

    it('lists the accepted roots in the refusal', async () => {
      await assert.rejects(
        async () => save(path.join(tmp, 'nowhere', 'a.png')),
        (err: unknown) => refused(err) && (err as Error).message.includes(jobsRoot) && (err as Error).message.includes(workspace)
      );
    });

    it('keeps writing inside the workspace root exactly as before', async () => {
      const result = await save(path.join('shots', 'ws.png'));
      assert.equal(fs.readFileSync(result.savedTo!, 'utf8'), 'PNGBYTES');
      assert.ok(path.resolve(result.savedTo!).startsWith(workspace + path.sep));
      await assert.rejects(async () => save(path.join(tmp, 'escape.png')), (err: unknown) => refused(err) && /outside workspace root/.test((err as Error).message));
    });
  });

  describe('a workspace root that is, or contains, a Leader job folder', () => {
    for (const [label, root] of [['the job folder', () => job], ['the jobs root', () => jobsRoot]] as const) {
      it(`refuses ledger names and leaves them untouched when the workspace is ${label}`, async () => {
        workspaceOverride = root();
        try {
          const rel = (name: string) => path.relative(root(), path.join(job, name));
          fs.writeFileSync(path.join(job, 'job.json'), 'ledger');
          fs.writeFileSync(path.join(job, 'x.report.md'), 'report');
          await assert.rejects(async () => save(rel('job.json')), refused);
          await assert.rejects(async () => dump(rel('x.report.md')), refused);
          await assert.rejects(async () => save(rel('b.prompt.md')), refused);
          assert.equal(fs.readFileSync(path.join(job, 'job.json'), 'utf8'), 'ledger');
          assert.equal(fs.readFileSync(path.join(job, 'x.report.md'), 'utf8'), 'report');
          // Every other workspace write is unchanged: no extension list, no no-overwrite rule.
          fs.writeFileSync(path.join(job, 'notes.md'), 'old');
          await save(rel('shot.png'));
          await dump(rel('probe.js'));
          await dump(rel('notes.md'));
        } finally {
          workspaceOverride = undefined;
        }
      });
    }

    it('a workspace outside every extra root may still write a file named job.json', async () => {
      const result = await save('job.json');
      assert.equal(fs.readFileSync(path.join(workspace, 'job.json'), 'utf8'), 'PNGBYTES');
      assert.ok(result.savedTo);
    });
  });

  describe('ANTIFAN_EXTRA_FILE_ROOTS', () => {
    it('adds an absolute root and an unset variable adds none', async () => {
      const extra = path.join(tmp, 'extra');
      fs.mkdirSync(path.join(extra, 'j'), { recursive: true });
      fs.writeFileSync(path.join(extra, 'j', 'p.js'), '3');
      await assert.rejects(async () => read(path.join(extra, 'j', 'p.js')), refused);
      assert.deepEqual(extraFileRoots({ LEADER_JOBS_ROOT: jobsRoot }), [path.resolve(jobsRoot)]);

      process.env.ANTIFAN_EXTRA_FILE_ROOTS = `relative/dir;${extra}`;
      try {
        assert.deepEqual(extraFileRoots(process.env), [path.resolve(jobsRoot), path.resolve(extra)]);
        assert.equal(await read(path.join(extra, 'j', 'p.js')), '3');
      } finally {
        delete process.env.ANTIFAN_EXTRA_FILE_ROOTS;
      }
      await assert.rejects(async () => read(path.join(extra, 'j', 'p.js')), refused);
    });

    it('defaults the jobs root when LEADER_JOBS_ROOT is unset', () => {
      assert.deepEqual(extraFileRoots({}), [path.resolve('E:/Work/scratch/leader')]);
    });
  });

  describe('extraRootNameRefusal', () => {
    it('applies the name rules', () => {
      assert.ok(extraRootNameRefusal(['a.json'], 'read'));
      assert.ok(extraRootNameRefusal(['job', 'node_modules', 'x.json'], 'read'));
      assert.ok(extraRootNameRefusal(['job', '.git.', 'x.json'], 'read'));
      assert.ok(extraRootNameRefusal(['job', '.env.local'], 'read'));
      assert.ok(extraRootNameRefusal(['job', 'id_rsa'], 'read'));
      assert.ok(extraRootNameRefusal(['job', 'a.PFX'], 'read'));
      assert.ok(extraRootNameRefusal(['job', 'a.js'], 'write'));
      assert.equal(extraRootNameRefusal(['job', 'a.js'], 'read'), null);
      assert.equal(extraRootNameRefusal(['job', 'a.PNG'], 'write'), null);
    });
  });
});
