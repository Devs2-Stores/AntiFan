import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  WorkflowStepSchema,
  WorkflowDefinitionSchema,
  LegacyWorkflowStepSchema,
  LegacyWorkflowDefinitionSchema,
  FileAssertNotContainsStepSchema,
  DevicePresetStepSchema,
  BrowserWaitForSelectorStepSchema,
  WorkflowExecutionResult,
} from '../../src/main/workflow/workflow-schema';
import { WorkflowRegistry, BUILTIN_WORKFLOWS } from '../../src/main/workflow/workflow-registry';
import { normalizeStepParams } from '../../src/main/workflow/workflow-engine';
import { CapabilityError, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

describe('Workflow Schema & Registry Contracts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-wf-schema-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Step Schemas & Discriminated Union', () => {
    it('covers all 19 engine step types in WorkflowStepSchema discriminated union', () => {
      const stepSamples: Array<{ type: string; params: Record<string, unknown> }> = [
        { type: 'browser.navigate', params: { url: 'https://example.com' } },
        { type: 'browser.click', params: { selector: '#btn', ref: '@e1' } },
        { type: 'browser.type', params: { text: 'test input', selector: '#input', clear: true } },
        { type: 'browser.scroll', params: { deltaY: 200, selector: '#scroll' } },
        { type: 'browser.hover', params: { selector: '#menu' } },
        { type: 'browser.highlight', params: { selector: '#btn', color: '#ff0000' } },
        { type: 'browser.wait_for_selector', params: { selector: '.loading-done' } },
        { type: 'browser.screenshot', params: { format: 'png' } },
        { type: 'browser.extract_dom', params: { selector: '#root' } },
        { type: 'browser.set_viewport', params: { width: 1920, height: 1080 } },
        { type: 'browser.set_device_preset', params: { presetId: 'phone-iphone14pro' } },
        { type: 'browser.set_zoom', params: { zoomFactor: 1.5 } },
        { type: 'qa.check_overflow', params: { thresholdPx: 2 } },
        { type: 'qa.check_broken_images', params: {} },
        { type: 'qa.check_console_errors', params: { level: 'error' } },
        { type: 'file.read', params: { path: 'package.json', maxBytes: 1024 } },
        { type: 'file.write', params: { path: 'output.txt', content: 'hello' } },
        { type: 'file.assert_not_contains', params: { path: 'package.json', forbiddenPatterns: ['SECRET'] } },
        { type: 'report.generate', params: { format: 'markdown', title: 'Test Report' } },
      ];

      assert.strictEqual(stepSamples.length, 19, 'Must cover exactly 19 engine step types');

      for (const sample of stepSamples) {
        const parsed = WorkflowStepSchema.safeParse({
          id: `step-${sample.type.replace('.', '-')}`,
          name: `Test ${sample.type}`,
          type: sample.type,
          params: sample.params,
          timeoutMs: 5000,
          retryCount: 0,
          continueOnError: false,
        });
        assert.ok(parsed.success, `Step type '${sample.type}' must parse successfully with valid params`);
      }
    });

    it('rejects steps with invalid or missing required parameters', () => {
      // browser.navigate requires url
      const navResult = WorkflowStepSchema.safeParse({
        id: 's1',
        name: 'Nav',
        type: 'browser.navigate',
        params: {},
      });
      assert.strictEqual(navResult.success, false);

      // browser.set_viewport requires positive integer width and height
      const vpResult = WorkflowStepSchema.safeParse({
        id: 's2',
        name: 'VP',
        type: 'browser.set_viewport',
        params: { width: -100, height: 0 },
      });
      assert.strictEqual(vpResult.success, false);

      // browser.set_zoom requires positive zoomFactor
      const zoomResult = WorkflowStepSchema.safeParse({
        id: 's3',
        name: 'Zoom',
        type: 'browser.set_zoom',
        params: { zoomFactor: -1 },
      });
      assert.strictEqual(zoomResult.success, false);

      // file.write requires path and content
      const writeResult = WorkflowStepSchema.safeParse({
        id: 's4',
        name: 'Write',
        type: 'file.write',
        params: { path: 'foo.txt' },
      });
      assert.strictEqual(writeResult.success, false);
    });

    it('validates FileAssertNotContainsStepSchema with pattern, forbiddenPatterns, or neither', () => {
      // With pattern
      const withPattern = FileAssertNotContainsStepSchema.safeParse({
        id: 's1',
        name: 'Assert',
        type: 'file.assert_not_contains',
        params: { path: 'app.config', pattern: 'AWS_KEY' },
      });
      assert.ok(withPattern.success);

      // With forbiddenPatterns
      const withForbidden = FileAssertNotContainsStepSchema.safeParse({
        id: 's2',
        name: 'Assert',
        type: 'file.assert_not_contains',
        params: { path: 'app.config', forbiddenPatterns: ['AWS_KEY', 'SECRET'] },
      });
      assert.ok(withForbidden.success);

      // Without pattern or forbiddenPatterns -> fails
      const withoutBoth = FileAssertNotContainsStepSchema.safeParse({
        id: 's3',
        name: 'Assert',
        type: 'file.assert_not_contains',
        params: { path: 'app.config' },
      });
      assert.strictEqual(withoutBoth.success, false);

      // With empty forbiddenPatterns -> fails
      const withEmptyForbidden = FileAssertNotContainsStepSchema.safeParse({
        id: 's4',
        name: 'Assert',
        type: 'file.assert_not_contains',
        params: { path: 'app.config', forbiddenPatterns: [] },
      });
      assert.strictEqual(withEmptyForbidden.success, false);
    });

    it('validates DevicePresetStepSchema and BrowserWaitForSelectorStepSchema', () => {
      const presetPass = DevicePresetStepSchema.safeParse({
        id: 's1',
        name: 'Preset',
        type: 'browser.set_device_preset',
        params: { presetId: 'phone-iphone14pro' },
      });
      assert.ok(presetPass.success);

      const presetFail = DevicePresetStepSchema.safeParse({
        id: 's1',
        name: 'Preset',
        type: 'browser.set_device_preset',
        params: {},
      });
      assert.strictEqual(presetFail.success, false);

      const waitPass = BrowserWaitForSelectorStepSchema.safeParse({
        id: 's2',
        name: 'Wait',
        type: 'browser.wait_for_selector',
        params: { selector: '.loaded' },
      });
      assert.ok(waitPass.success);

      const waitFail = BrowserWaitForSelectorStepSchema.safeParse({
        id: 's2',
        name: 'Wait',
        type: 'browser.wait_for_selector',
        params: {},
      });
      assert.strictEqual(waitFail.success, false);
    });

    it('keeps LegacyWorkflowStepSchema separate with unvalidated params', () => {
      const legacyStep = {
        id: 'legacy-1',
        name: 'Legacy Step',
        type: 'browser.navigate' as const,
        params: { arbitraryKey: 12345, missingUrl: true },
      };

      // Strict union rejects missing url
      const unionResult = WorkflowStepSchema.safeParse(legacyStep);
      assert.strictEqual(unionResult.success, false);

      // Legacy schema accepts unvalidated record params
      const legacyResult = LegacyWorkflowStepSchema.safeParse(legacyStep);
      assert.ok(legacyResult.success);
    });
  });

  describe('WorkflowRegistry Built-ins & Preset IDs', () => {
    it('verifies phone-iphone14pro is the only preset id in built-ins', () => {
      const presetsFound: string[] = [];
      for (const builtin of BUILTIN_WORKFLOWS) {
        for (const step of builtin.definition.steps) {
          if (step.type === 'browser.set_device_preset') {
            const presetId = (step.params as Record<string, unknown>)?.presetId;
            if (typeof presetId === 'string') {
              presetsFound.push(presetId);
            }
          }
        }
      }

      assert.deepStrictEqual(presetsFound, ['phone-iphone14pro'], "Only 'phone-iphone14pro' must be used in built-ins");
    });

    it('validates all built-in workflows under WorkflowDefinitionSchema', () => {
      for (const builtin of BUILTIN_WORKFLOWS) {
        const parsed = WorkflowDefinitionSchema.safeParse(builtin.definition);
        assert.ok(parsed.success, `Built-in workflow '${builtin.id}' must satisfy strict WorkflowDefinitionSchema`);
      }
    });
  });

  describe('WorkflowRegistry loadFromDisk fallback & quarantine', () => {
    it('loads modern valid workflows without legacy flag', () => {
      const registry = new WorkflowRegistry(tmpDir);
      const validWorkflow = {
        version: '1.0',
        name: 'Modern Flow',
        description: 'Testing modern parse',
        steps: [
          {
            id: 's1',
            name: 'Nav',
            type: 'browser.navigate',
            params: { url: 'https://example.com' },
            timeoutMs: 5000,
            retryCount: 0,
            continueOnError: false,
          },
        ],
      };

      fs.writeFileSync(path.join(tmpDir, 'modern-flow.json'), JSON.stringify(validWorkflow, null, 2), 'utf-8');

      const reloaded = new WorkflowRegistry(tmpDir);
      const item = reloaded.getById('wf-custom-modern-flow');
      assert.ok(item, 'Modern workflow must be loaded');
      assert.strictEqual(item.name, 'Modern Flow');
      assert.strictEqual(item.legacy, undefined);
    });

    it('loads legacy workflows with legacy: true flag and warning when union schema fails', () => {
      // Legacy workflow has a step missing required param url for browser.navigate
      const legacyWorkflow = {
        version: '1.0',
        name: 'Legacy Custom Flow',
        description: 'Legacy flow with unvalidated params',
        steps: [
          {
            id: 's1',
            name: 'Legacy Nav',
            type: 'browser.navigate',
            params: { targetUrlLegacy: 'https://example.com' },
            timeoutMs: 5000,
            retryCount: 0,
            continueOnError: false,
          },
        ],
      };

      const warnings: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };

      try {
        fs.writeFileSync(path.join(tmpDir, 'legacy-flow.json'), JSON.stringify(legacyWorkflow, null, 2), 'utf-8');

        const reloaded = new WorkflowRegistry(tmpDir);
        const item = reloaded.getById('wf-custom-legacy-flow');
        assert.ok(item, 'Legacy workflow must be loaded via fallback');
        assert.strictEqual(item.name, 'Legacy Custom Flow');
        assert.strictEqual(item.legacy, true, 'Must have legacy: true flag set');
        assert.ok(warnings.some((w) => w.includes('legacy schema')), 'Must emit warning for legacy schema load');
      } finally {
        console.warn = origWarn;
      }
    });

    it('quarantines corrupt JSON files to .invalid instead of silent drop', () => {
      const corruptFile = path.join(tmpDir, 'corrupt.json');
      fs.writeFileSync(corruptFile, 'NOT_VALID_JSON{[[{', 'utf-8');

      const registry = new WorkflowRegistry(tmpDir);
      assert.strictEqual(fs.existsSync(corruptFile), false, 'Original corrupt JSON must be renamed');
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'corrupt.invalid')), true, 'Must quarantine to .invalid');
    });

    it('quarantines double-failing files (fails both modern and legacy schemas) to .invalid', () => {
      // Missing required name and version
      const doubleFailFile = path.join(tmpDir, 'unusable.json');
      fs.writeFileSync(doubleFailFile, JSON.stringify({ invalidStructure: true }), 'utf-8');

      const registry = new WorkflowRegistry(tmpDir);
      assert.strictEqual(fs.existsSync(doubleFailFile), false, 'Double-failing file must not remain as .json');
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'unusable.invalid')), true, 'Must quarantine to .invalid');
    });

    it('supports saving custom workflows with legacy fallback when params are unvalidated', () => {
      const registry = new WorkflowRegistry(tmpDir);
      const saved = registry.saveCustom({
        name: 'Legacy Save Test',
        steps: [
          {
            id: 's1',
            name: 'Custom Nav',
            type: 'browser.navigate',
            params: { unvalidatedOption: 'foo' }, // missing url
            timeoutMs: 5000,
            retryCount: 0,
            continueOnError: false,
          },
        ],
      });

      assert.ok(saved.id);
      assert.strictEqual(saved.legacy, true);
    });
  });

  describe('Lowering Pass normalizeStepParams', () => {
    it('keeps forbiddenPatterns as literal alternatives for file.assert_not_contains', () => {
      const normalized = normalizeStepParams({
        type: 'file.assert_not_contains',
        params: { path: 'package.json', forbiddenPatterns: ['PRIVATE_KEY', 'AWS_SECRET', 'HARAVAN_SECRET'] },
      });

      assert.strictEqual(normalized.path, 'package.json');
      // The capability matches `pattern` with a literal String.includes, so alternation is never
      // fabricated; each alternative is asserted literally by dispatch.
      assert.deepStrictEqual(normalized.forbiddenPatterns, ['PRIVATE_KEY', 'AWS_SECRET', 'HARAVAN_SECRET']);
      assert.strictEqual(normalized.pattern, undefined);
    });

    it('passes an explicit literal pattern through untouched', () => {
      const normalized = normalizeStepParams({
        type: 'file.assert_not_contains',
        params: { path: 'package.json', pattern: 'PRIVATE_KEY' },
      });

      assert.strictEqual(normalized.pattern, 'PRIVATE_KEY');
      assert.strictEqual(normalized.forbiddenPatterns, undefined);
    });

    it('maps legacy preset alias mobile-iphone-14-pro to phone-iphone14pro before validation', () => {
      const normalized = normalizeStepParams({
        type: 'browser.set_device_preset',
        params: { presetId: 'mobile-iphone-14-pro' },
      });

      assert.strictEqual(normalized.presetId, 'phone-iphone14pro');
    });

    it('keeps already-valid presetId phone-iphone14pro', () => {
      const normalized = normalizeStepParams({
        type: 'browser.set_device_preset',
        params: { presetId: 'phone-iphone14pro' },
      });

      assert.strictEqual(normalized.presetId, 'phone-iphone14pro');
    });

    it('throws INVALID_ARGUMENT CapabilityError on genuinely unknown preset id', () => {
      assert.throws(
        () => {
          normalizeStepParams({
            type: 'browser.set_device_preset',
            params: { presetId: 'unknown-nonexistent-device-xyz' },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof CapabilityError);
          assert.strictEqual((err as CapabilityError).code, 'INVALID_ARGUMENT');
          return true;
        }
      );
    });
  });

  describe('WorkflowExecutionResult Status Contract', () => {
    it('allows completed_with_errors as non-failed status', () => {
      const result: WorkflowExecutionResult = {
        workflowName: 'Test Flow',
        runId: 'run-1',
        attemptId: 'att-1',
        target: {
          projectId: makeControlPlaneId('project'),
          workspaceId: makeControlPlaneId('workspace'),
          runtimeId: 'test-runtime',
          browserEpoch: 1,
          documentGeneration: 1,
          tabId: 'tab-1',
        },
        status: 'completed_with_errors',
        totalDurationMs: 1200,
        passedSteps: 2,
        failedSteps: 1,
        skippedSteps: 0,
        stepResults: [],
        artifacts: [],
      };

      assert.strictEqual(result.status, 'completed_with_errors');
    });
  });
});
