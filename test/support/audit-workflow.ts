import { ThemeQaWorkflow, type ThemeQaReport, type ThemeQaValidateInput } from '../../src/main/qa/theme-qa-workflow';

/**
 * A workflow that grades under the audit profile unless a call names one. The repair-coordinator
 * tests pin stop criteria and differential rollback against a deliberately sparse host, where the
 * number of evidence gaps must stay under the test's control; build-strict adds gaps for every
 * capability that host does not have.
 */
export class AuditProfileWorkflow extends ThemeQaWorkflow {
  override validate(input: ThemeQaValidateInput): Promise<ThemeQaReport> {
    return super.validate({ profile: 'audit', ...input });
  }
}
