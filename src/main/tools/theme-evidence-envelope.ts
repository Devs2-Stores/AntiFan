/**
 * AntiFan Core — Theme Evidence Envelope Contract
 *
 * Standardized telemetry envelope for all Theme Intelligence capabilities.
 * Guarantees that evidence quality, underlying signals, and timing are explicit,
 * preventing OMP from acting on ungrounded assumptions.
 */

export type EvidenceQuality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ThemeEvidenceEnvelope<T> {
  success: boolean;
  data?: T;
  evidenceQuality: EvidenceQuality;
  signals: Record<string, boolean | 'unknown'>;
  timestamp: number;
  error?: string;
}

export function createThemeEvidenceEnvelope<T>(params: {
  success: boolean;
  data?: T;
  evidenceQuality: EvidenceQuality;
  signals: Record<string, boolean | 'unknown'>;
  error?: string;
  timestamp?: number;
}): ThemeEvidenceEnvelope<T> {
  return {
    success: params.success,
    data: params.data,
    evidenceQuality: params.evidenceQuality,
    signals: params.signals,
    timestamp: params.timestamp || Date.now(),
    error: params.error,
  };
}

export function isThemeEvidenceEnvelope(value: unknown): value is ThemeEvidenceEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasSuccess = typeof obj.success === 'boolean';
  const hasQuality = obj.evidenceQuality === 'HIGH' || obj.evidenceQuality === 'MEDIUM' || obj.evidenceQuality === 'LOW';
  const hasSignals = typeof obj.signals === 'object' && obj.signals !== null;
  const hasTimestamp = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp);

  return hasSuccess && hasQuality && hasSignals && hasTimestamp;
}
