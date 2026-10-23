/**
 * Which project a project-less terminal is adopted into, decided from its recorded folder.
 * The resolver is pure, so every case feeds it paths directly and reads the decision back.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideTerminalProjectAdoption, type TerminalAdoptionDecision } from '../../src/main/project/terminal-project-adoption';

const WORK_ROOT = 'E:\\Work';
const HOME = 'C:\\Users\\Admin';
const opts = { workRoot: WORK_ROOT, homeDir: HOME };

const lux = { projectId: 'lux', workspacePaths: ['E:\\Work\\Lux Shoes'] };
const luxHaravan = { projectId: 'lux-haravan', workspacePaths: ['E:\\Work\\Lux Shoes\\Haravan'] };
const antifan = { projectId: 'antifan', workspacePaths: ['E:\\Work\\apps\\AntiFan'] };

function refusal(decision: TerminalAdoptionDecision) {
  assert.equal(decision.kind, 'refuse');
  if (decision.kind !== 'refuse') throw new Error('unreachable');
  return decision;
}

describe('decideTerminalProjectAdoption: existing project', () => {
  it('adopts into the project whose workspace is the cwd itself', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes', [lux], opts);
    assert.deepEqual(decision, { kind: 'existing', projectId: 'lux', workspacePath: 'E:\\Work\\Lux Shoes' });
  });

  it('adopts a terminal in a subfolder into the nearest parent project instead of minting one', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan\\sections', [lux], opts);
    assert.equal(decision.kind, 'existing');
    assert.equal(decision.kind === 'existing' && decision.projectId, 'lux');
  });

  it('prefers the longest containing workspace when projects are nested', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan\\assets', [lux, luxHaravan], opts);
    assert.equal(decision.kind === 'existing' && decision.projectId, 'lux-haravan');
    const outer = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Sapo', [luxHaravan, lux], opts);
    assert.equal(outer.kind === 'existing' && outer.projectId, 'lux');
  });

  it('matches regardless of case, separator style, trailing separators and dot segments', () => {
    for (const spelling of [
      'e:\\work\\lux shoes\\Haravan',
      'E:/Work/Lux Shoes/Haravan/',
      'E:\\Work\\Lux Shoes\\Haravan\\\\',
      'E:\\Work\\apps\\..\\Lux Shoes\\.\\Haravan',
      '\\\\?\\E:\\Work\\Lux Shoes\\Haravan',
    ]) {
      const decision = decideTerminalProjectAdoption(spelling, [lux], opts);
      assert.equal(decision.kind === 'existing' && decision.projectId, 'lux', spelling);
    }
  });

  it('matches a workspace path spelled differently from the cwd', () => {
    const project = { projectId: 'p', workspacePaths: ['e:/work/Lux Shoes/'] };
    const decision = decideTerminalProjectAdoption('E:\\Work\\LUX SHOES\\Haravan', [project], opts);
    assert.equal(decision.kind === 'existing' && decision.projectId, 'p');
  });

  it('never matches a sibling whose name only shares a prefix', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux', [lux], opts);
    assert.equal(decision.kind, 'create');
    const inside = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes 2\\src', [lux], opts);
    assert.equal(inside.kind, 'create');
  });

  it('considers every workspace path of a project', () => {
    const multi = { projectId: 'multi', workspacePaths: ['E:\\Work\\one', 'E:\\Work\\two'] };
    const decision = decideTerminalProjectAdoption('E:\\Work\\two\\src', [multi, lux], opts);
    assert.deepEqual(decision, { kind: 'existing', projectId: 'multi', workspacePath: 'E:\\Work\\two' });
  });

  it('adopts into a known project even when its workspace sits outside the work root', () => {
    const outside = { projectId: 'ext', workspacePaths: ['D:\\Repos\\thing'] };
    const decision = decideTerminalProjectAdoption('D:\\Repos\\thing\\src', [outside], opts);
    assert.equal(decision.kind === 'existing' && decision.projectId, 'ext');
  });

  it('lets a project at the work root, the home folder or a drive root answer only for that exact folder', () => {
    const broad = [
      { projectId: 'at-work-root', workspacePaths: [WORK_ROOT] },
      { projectId: 'at-home', workspacePaths: [HOME] },
      { projectId: 'at-drive', workspacePaths: ['D:\\'] },
    ];
    assert.deepEqual(decideTerminalProjectAdoption('e:/work/', broad, opts), { kind: 'existing', projectId: 'at-work-root', workspacePath: WORK_ROOT });
    assert.deepEqual(decideTerminalProjectAdoption('C:\\Users\\Admin', broad, opts), { kind: 'existing', projectId: 'at-home', workspacePath: HOME });
    assert.deepEqual(decideTerminalProjectAdoption('D:\\', broad, opts), { kind: 'existing', projectId: 'at-drive', workspacePath: 'D:\\' });

    // Beneath them nothing is absorbed: the ordinary rules decide.
    assert.deepEqual(decideTerminalProjectAdoption('E:\\Work\\Fresh', broad, opts), { kind: 'create', folder: 'E:\\Work\\Fresh' });
    assert.equal(refusal(decideTerminalProjectAdoption('C:\\Users\\Admin\\Documents', broad, opts)).reason, 'OUTSIDE_WORK_ROOT');
    assert.equal(refusal(decideTerminalProjectAdoption('D:\\Repos\\thing', broad, opts)).reason, 'OUTSIDE_WORK_ROOT');
  });

  it('still lets a narrower project beneath a broad one claim its own terminals', () => {
    const projects = [{ projectId: 'at-work-root', workspacePaths: [WORK_ROOT] }, lux];
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan', projects, opts);
    assert.equal(decision.kind === 'existing' && decision.projectId, 'lux');
  });

  it('ignores projects with unusable workspace paths', () => {
    const junk = { projectId: 'junk', workspacePaths: ['', 'relative\\dir', '\\rooted-on-current-drive'] };
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes', [junk], opts);
    assert.equal(decision.kind, 'create');
  });

  it('does not ask for a grouping-folder verdict when an existing project already owns the folder', () => {
    let asked = 0;
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan', [lux], {
      ...opts,
      holdsSeveralProjects: () => { asked += 1; return true; },
    });
    assert.equal(decision.kind, 'existing');
    assert.equal(asked, 0);
  });
});

describe('decideTerminalProjectAdoption: create', () => {
  it('creates a project for a folder strictly inside the work root with no project under it', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\New Client', [lux, antifan], opts);
    assert.deepEqual(decision, { kind: 'create', folder: 'E:\\Work\\New Client' });
  });

  it('creates for a deep folder and keeps the caller\'s letter case and normalized separators', () => {
    const decision = decideTerminalProjectAdoption('E:/Work/Clients/Acme/', [lux], opts);
    assert.deepEqual(decision, { kind: 'create', folder: 'E:\\Work\\Clients\\Acme' });
  });

  it('accepts a work root spelled with a different case or trailing separator', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\Fresh', [], { workRoot: 'e:/work/', homeDir: HOME });
    assert.equal(decision.kind, 'create');
  });

  it('creates for a folder the grouping check clears and passes the check the canonical folder', () => {
    const asked: string[] = [];
    const decision = decideTerminalProjectAdoption('e:/Work/Clients/Acme/', [], {
      ...opts,
      holdsSeveralProjects: (folder) => { asked.push(folder); return false; },
    });
    assert.deepEqual(decision, { kind: 'create', folder: 'e:\\Work\\Clients\\Acme' });
    assert.deepEqual(asked, ['e:\\Work\\Clients\\Acme']);
  });
});

describe('decideTerminalProjectAdoption: refusals', () => {
  it('refuses a missing or non-absolute cwd', () => {
    assert.equal(refusal(decideTerminalProjectAdoption(undefined, [lux], opts)).reason, 'NO_CWD');
    assert.equal(refusal(decideTerminalProjectAdoption('   ', [lux], opts)).reason, 'NO_CWD');
    assert.equal(refusal(decideTerminalProjectAdoption('Lux Shoes', [lux], opts)).reason, 'NO_CWD');
    assert.equal(refusal(decideTerminalProjectAdoption('\\Work\\Lux Shoes', [lux], opts)).reason, 'NO_CWD');
    assert.equal(refusal(decideTerminalProjectAdoption('E:Work', [lux], opts)).reason, 'NO_CWD');
  });

  it('refuses the work root itself, however it is spelled', () => {
    for (const spelling of ['E:\\Work', 'e:/work/', 'E:\\Work\\apps\\..']) {
      const decision = refusal(decideTerminalProjectAdoption(spelling, [lux], opts));
      assert.equal(decision.reason, 'WORK_ROOT', spelling);
      assert.equal(decision.folder.toLowerCase(), 'e:\\work');
    }
  });

  it('refuses a drive root', () => {
    for (const spelling of ['E:\\', 'E:/', 'c:\\']) {
      assert.equal(refusal(decideTerminalProjectAdoption(spelling, [lux], opts)).reason, 'DRIVE_ROOT', spelling);
    }
    assert.equal(refusal(decideTerminalProjectAdoption('\\\\server\\share', [lux], opts)).reason, 'DRIVE_ROOT');
  });

  it('refuses the user home directory', () => {
    assert.equal(refusal(decideTerminalProjectAdoption('c:/users/admin/', [lux], opts)).reason, 'HOME_DIR');
  });

  it('refuses a home directory that lies inside the work root', () => {
    const decision = decideTerminalProjectAdoption('E:\\Work\\home', [], { workRoot: WORK_ROOT, homeDir: 'E:\\Work\\home' });
    assert.equal(refusal(decision).reason, 'HOME_DIR');
  });

  it('refuses folders outside the work root, including look-alike prefixes', () => {
    for (const spelling of ['C:\\Users\\Admin\\Documents', 'D:\\Work\\thing', 'E:\\Workshop\\thing', 'E:\\Other']) {
      assert.equal(refusal(decideTerminalProjectAdoption(spelling, [lux], opts)).reason, 'OUTSIDE_WORK_ROOT', spelling);
    }
  });

  it('refuses a grouping folder that contains at least one project', () => {
    const apps = refusal(decideTerminalProjectAdoption('E:\\Work\\apps', [antifan], opts));
    assert.equal(apps.reason, 'CONTAINS_PROJECTS');
    const themes = refusal(decideTerminalProjectAdoption('E:/work/Lux Shoes/', [luxHaravan], opts));
    assert.equal(themes.reason, 'CONTAINS_PROJECTS');
  });

  it('refuses an unregistered grouping folder with the typed reason and a message that names it', () => {
    const decision = refusal(decideTerminalProjectAdoption('E:\\Work\\themes', [], { ...opts, holdsSeveralProjects: () => true }));
    assert.equal(decision.reason, 'GROUPING_FOLDER');
    assert.equal(decision.folder, 'E:\\Work\\themes');
    assert.match(decision.message, /E:\\Work\\themes/);
    assert.match(decision.message, /Terminal Manager/);
  });

  it('does not run the grouping check for folders that are refused for another reason', () => {
    const never = (): boolean => { throw new Error('the grouping check must not run'); };
    for (const spelling of ['E:\\Work', 'D:\\Repos\\thing', 'C:\\Users\\Admin', 'E:\\']) {
      assert.doesNotThrow(() => decideTerminalProjectAdoption(spelling, [], { ...opts, holdsSeveralProjects: never }), spelling);
    }
  });

  it('prefers an enclosing project over the grouping-folder refusal', () => {
    // The cwd is inside `lux` and also encloses `luxHaravan`: the enclosing project owns it.
    const decision = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan', [lux, luxHaravan], opts);
    assert.equal(decision.kind === 'existing' && decision.projectId, 'lux-haravan');
    const between = decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Sapo', [lux, luxHaravan], opts);
    assert.equal(between.kind === 'existing' && between.projectId, 'lux');
  });

  it('gives actionable English messages that name the folder', () => {
    const decision = refusal(decideTerminalProjectAdoption('E:\\Work\\apps', [antifan], opts));
    assert.match(decision.message, /E:\\Work\\apps/);
    assert.match(decision.message, /Terminal Manager/);
    assert.equal(decision.folder, 'E:\\Work\\apps');
    assert.match(refusal(decideTerminalProjectAdoption(undefined, [], opts)).message, /project/);
  });

  it('does not mutate its inputs', () => {
    const projects = [{ projectId: 'lux', workspacePaths: ['E:\\Work\\Lux Shoes'] as readonly string[] }];
    const snapshot = JSON.stringify(projects);
    decideTerminalProjectAdoption('E:\\Work\\Lux Shoes\\Haravan', projects, opts);
    assert.equal(JSON.stringify(projects), snapshot);
  });
});
