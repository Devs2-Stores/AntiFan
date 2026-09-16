import { z } from 'zod';
import { ArtifactRef, BrowserTarget } from '../../shared/control-plane-contracts';

export const StepTypeSchema = z.enum([
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'browser.hover',
  'browser.highlight',
  'browser.wait_for_selector',
  'browser.screenshot',
  'browser.extract_dom',
  'browser.set_viewport',
  'browser.set_device_preset',
  'browser.set_zoom',
  'qa.check_overflow',
  'qa.check_broken_images',
  'qa.check_console_errors',
  'file.read',
  'file.write',
  'file.assert_not_contains',
  'report.generate',
]);

export type WorkflowStepType = z.infer<typeof StepTypeSchema>;

export const BaseWorkflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  retryCount: z.number().int().min(0).max(5).default(0),
  continueOnError: z.boolean().default(false),
});

// 1. browser.navigate
export const BrowserNavigateParamsSchema = z
  .object({
    url: z.string().min(1),
  })
  .passthrough();

export const BrowserNavigateStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.navigate'),
  params: BrowserNavigateParamsSchema,
});

// 2. browser.click
export const BrowserClickParamsSchema = z
  .object({
    selector: z.string().optional(),
    ref: z.union([z.string(), z.number()]).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    label: z.string().optional(),
  })
  .passthrough()
  .default({});

export const BrowserClickStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.click'),
  params: BrowserClickParamsSchema,
});

// 3. browser.type
export const BrowserTypeParamsSchema = z
  .object({
    text: z.string(),
    selector: z.string().optional(),
    clear: z.boolean().optional(),
  })
  .passthrough();

export const BrowserTypeStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.type'),
  params: BrowserTypeParamsSchema,
});

// 4. browser.scroll
export const BrowserScrollParamsSchema = z
  .object({
    deltaY: z.number().optional(),
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    durationMs: z.number().optional(),
  })
  .passthrough()
  .default({});

export const BrowserScrollStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.scroll'),
  params: BrowserScrollParamsSchema,
});

// 5. browser.hover
export const BrowserHoverParamsSchema = z
  .object({
    selector: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    label: z.string().optional(),
  })
  .passthrough()
  .default({});

export const BrowserHoverStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.hover'),
  params: BrowserHoverParamsSchema,
});

// 6. browser.highlight
export const BrowserHighlightParamsSchema = z
  .object({
    selector: z.string().min(1),
    label: z.string().optional(),
    color: z.string().optional(),
  })
  .passthrough();

export const BrowserHighlightStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.highlight'),
  params: BrowserHighlightParamsSchema,
});

// 7. browser.wait_for_selector
export const BrowserWaitForSelectorParamsSchema = z
  .object({
    selector: z.string().min(1),
  })
  .passthrough();

export const BrowserWaitForSelectorStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.wait_for_selector'),
  params: BrowserWaitForSelectorParamsSchema,
});

// 8. browser.screenshot
export const BrowserScreenshotParamsSchema = z
  .object({
    format: z.string().optional(),
  })
  .passthrough()
  .default({});

export const BrowserScreenshotStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.screenshot'),
  params: BrowserScreenshotParamsSchema,
});

// 9. browser.extract_dom
export const BrowserExtractDomParamsSchema = z
  .object({
    selector: z.string().optional(),
  })
  .passthrough()
  .default({});

export const BrowserExtractDomStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.extract_dom'),
  params: BrowserExtractDomParamsSchema,
});

// 10. browser.set_viewport
export const BrowserSetViewportParamsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mobile: z.boolean().optional(),
    deviceScaleFactor: z.number().positive().optional(),
  })
  .passthrough();

export const BrowserSetViewportStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.set_viewport'),
  params: BrowserSetViewportParamsSchema,
});

// 11. browser.set_device_preset
export const DevicePresetParamsSchema = z
  .object({
    presetId: z.string().min(1),
  })
  .passthrough();

export const DevicePresetStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.set_device_preset'),
  params: DevicePresetParamsSchema,
});

export const BrowserSetDevicePresetStepSchema = DevicePresetStepSchema;

// 12. browser.set_zoom
export const BrowserSetZoomParamsSchema = z
  .object({
    zoomFactor: z.number().positive(),
  })
  .passthrough();

export const BrowserSetZoomStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('browser.set_zoom'),
  params: BrowserSetZoomParamsSchema,
});

// 13. qa.check_overflow
export const QaCheckOverflowParamsSchema = z
  .object({
    thresholdPx: z.number().optional(),
  })
  .passthrough()
  .default({});

export const QaCheckOverflowStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('qa.check_overflow'),
  params: QaCheckOverflowParamsSchema,
});

// 14. qa.check_broken_images
export const QaCheckBrokenImagesParamsSchema = z.object({}).passthrough().default({});

export const QaCheckBrokenImagesStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('qa.check_broken_images'),
  params: QaCheckBrokenImagesParamsSchema,
});

// 15. qa.check_console_errors
export const QaCheckConsoleErrorsParamsSchema = z
  .object({
    level: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough()
  .default({});

export const QaCheckConsoleErrorsStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('qa.check_console_errors'),
  params: QaCheckConsoleErrorsParamsSchema,
});

// 16. file.read
export const FileReadParamsSchema = z
  .object({
    path: z.string().min(1),
    maxBytes: z.number().int().positive().optional(),
  })
  .passthrough();

export const FileReadStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('file.read'),
  params: FileReadParamsSchema,
});

// 17. file.write
export const FileWriteParamsSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
  })
  .passthrough();

export const FileWriteStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('file.write'),
  params: FileWriteParamsSchema,
});

// 18. file.assert_not_contains
export const FileAssertNotContainsParamsSchema = z
  .object({
    path: z.string().min(1),
    pattern: z.string().min(1).optional(),
    forbiddenPatterns: z.array(z.string().min(1)).min(1).optional(),
  })
  .passthrough()
  .refine(
    (data) => Boolean(data.pattern || (data.forbiddenPatterns && data.forbiddenPatterns.length > 0)),
    {
      message: 'file.assert_not_contains requires pattern or forbiddenPatterns',
    }
  );

export const FileAssertNotContainsStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('file.assert_not_contains'),
  params: FileAssertNotContainsParamsSchema,
});

// 19. report.generate
export const ReportGenerateParamsSchema = z
  .object({
    format: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough()
  .default({});

export const ReportGenerateStepSchema = BaseWorkflowStepSchema.extend({
  type: z.literal('report.generate'),
  params: ReportGenerateParamsSchema,
});

/**
 * Discriminated union of all supported typed workflow step schemas.
 * Covers every step 'type' the engine executes.
 */
export const WorkflowStepSchema = z.discriminatedUnion('type', [
  BrowserNavigateStepSchema,
  BrowserClickStepSchema,
  BrowserTypeStepSchema,
  BrowserScrollStepSchema,
  BrowserHoverStepSchema,
  BrowserHighlightStepSchema,
  BrowserWaitForSelectorStepSchema,
  BrowserScreenshotStepSchema,
  BrowserExtractDomStepSchema,
  BrowserSetViewportStepSchema,
  DevicePresetStepSchema,
  BrowserSetZoomStepSchema,
  QaCheckOverflowStepSchema,
  QaCheckBrokenImagesStepSchema,
  QaCheckConsoleErrorsStepSchema,
  FileReadStepSchema,
  FileWriteStepSchema,
  FileAssertNotContainsStepSchema,
  ReportGenerateStepSchema,
]);

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  version: z.literal('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(100),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * LegacyWorkflowStepSchema: separate schema with unvalidated params (z.record(z.unknown())),
 * intentionally kept OUT of the discriminated union.
 * Used for backwards-compatible loading of existing workflows on disk with a warning.
 */
export const LegacyWorkflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: StepTypeSchema,
  params: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  retryCount: z.number().int().min(0).max(5).default(0),
  continueOnError: z.boolean().default(false),
});

export type LegacyWorkflowStep = z.infer<typeof LegacyWorkflowStepSchema>;

export const LegacyWorkflowDefinitionSchema = z.object({
  version: z.literal('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(LegacyWorkflowStepSchema).min(1).max(100),
});

export type LegacyWorkflowDefinition = z.infer<typeof LegacyWorkflowDefinitionSchema>;

export interface WorkflowStepResult {
  stepId: string;
  stepName: string;
  type: WorkflowStepType;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  data?: unknown;
  error?: string;
  artifacts?: ArtifactRef[];
}

export interface WorkflowExecutionResult {
  workflowName: string;
  runId: string;
  attemptId: string;
  target: BrowserTarget;
  /**
   * Run execution status:
   * - 'passed': All steps executed and passed successfully.
   * - 'completed_with_errors': Non-failed run where one or more steps encountered errors,
   *   but continueOnError: true allowed the workflow to complete without termination.
   *   Treated as a non-failed outcome in UI/toolbars.
   * - 'failed': A fatal step failure halted execution (continueOnError: false).
   * - 'interrupted': Workflow was aborted or cancelled mid-execution.
   */
  status: 'passed' | 'failed' | 'interrupted' | 'completed_with_errors';
  totalDurationMs: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  stepResults: WorkflowStepResult[];
  artifacts: ArtifactRef[];
}

export type WorkflowEventListener = (event: {
  type: 'workflow:start' | 'step:start' | 'step:end' | 'step:retry' | 'workflow:end';
  stepId?: string;
  stepName?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  artifact?: ArtifactRef;
  result?: WorkflowExecutionResult;
  attempt?: number;
  delayMs?: number;
}) => void;
