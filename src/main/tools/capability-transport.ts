import { CapabilityCatalogue } from './capability-catalogue';
import { CapabilityRequestContext } from '../../shared/control-plane-contracts';

export interface CapabilityTransportResponse { ok: boolean; data?: unknown; error?: { code: string; message: string }; }

export class CapabilityTransportAdapter {
  constructor(private readonly catalogue: CapabilityCatalogue) {}

  list(context?: Pick<CapabilityRequestContext, 'grant'>): ReturnType<CapabilityCatalogue['list']> { return this.catalogue.list(context); }

  async dispatch(name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<CapabilityTransportResponse> {
    try { return { ok: true, data: await this.catalogue.dispatch(name, params, context) }; } catch (error) { const typed = error as { code?: string; message?: string }; return { ok: false, error: { code: typed.code || 'CAPABILITY_ERROR', message: typed.message || String(error) } }; }
  }
}
