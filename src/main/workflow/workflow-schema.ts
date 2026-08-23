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

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: StepTypeSchema,
  params: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  retryCount: z.number().int().min(0).max(5).default(0),
  continueOnError: z.boolean().default(false),
});

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowDefinitionSchema = z.object({
  version: z.literal('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(WorkflowStepSchema).min(1).max(100),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

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
  status: 'passed' | 'failed' | 'interrupted';
  totalDurationMs: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  stepResults: WorkflowStepResult[];
  artifacts: ArtifactRef[];
}

export type WorkflowEventListener = (event: {
  type: 'workflow:start' | 'step:start' | 'step:end' | 'workflow:end';
  stepId?: string;
  stepName?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  artifact?: ArtifactRef;
  result?: WorkflowExecutionResult;
}) => void;
