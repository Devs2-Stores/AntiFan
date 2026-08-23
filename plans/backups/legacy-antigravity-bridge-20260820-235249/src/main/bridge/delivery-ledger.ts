/**
 * delivery-ledger.ts
 *
 * Durable ledger for recording and persisting Antigravity command delivery states
 * across window reloads, session switches, and application restarts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BridgeDeliveryState, AntigravityResultV2 } from '../../shared/contracts';

export interface DeliveryRecord {
  commandId: string;
  messageId: string;
  sessionId?: string;
  workspaceUri: string;
  promptText: string;
  promptDigest: string;
  deliveryState: BridgeDeliveryState;
  receipt?: AntigravityResultV2;
  createdAtEpochMs: number;
  updatedAtEpochMs: number;
}

export class DeliveryLedger {
  private static instance: DeliveryLedger | null = null;
  private readonly ledgerPath: string;
  private records = new Map<string, DeliveryRecord>();
  private readonly maxRecords = 200;

  constructor(customPath?: string) {
    this.ledgerPath = customPath || path.join(os.homedir(), '.gemini', 'antigravity', 'delivery-ledger.json');
    this.load();
  }

  public static getInstance(): DeliveryLedger {
    if (!DeliveryLedger.instance) {
      DeliveryLedger.instance = new DeliveryLedger();
    }
    return DeliveryLedger.instance;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.ledgerPath)) {
        const raw = fs.readFileSync(this.ledgerPath, 'utf8');
        const data: DeliveryRecord[] = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item && typeof item.commandId === 'string') {
              this.records.set(item.commandId, item);
            }
          }
        }
      }
    } catch {}
  }

  public save(): void {
    try {
      const dir = path.dirname(this.ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.records.values())
        .sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs)
        .slice(0, this.maxRecords);

      const tmpPath = `${this.ledgerPath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.ledgerPath);
    } catch {}
  }

  public record(item: Omit<DeliveryRecord, 'updatedAtEpochMs'>): void {
    const full: DeliveryRecord = {
      ...item,
      updatedAtEpochMs: Date.now(),
    };
    this.records.set(item.commandId, full);
    this.save();
  }

  public updateStatus(commandId: string, deliveryState: BridgeDeliveryState, receipt?: AntigravityResultV2): void {
    const existing = this.records.get(commandId);
    if (existing) {
      existing.deliveryState = deliveryState;
      if (receipt) existing.receipt = receipt;
      existing.updatedAtEpochMs = Date.now();
      this.records.set(commandId, existing);
      this.save();
    }
  }

  public getByCommandId(commandId: string): DeliveryRecord | undefined {
    return this.records.get(commandId);
  }

  public getByPromptDigest(digest: string): DeliveryRecord | undefined {
    for (const r of this.records.values()) {
      if (r.promptDigest === digest) return r;
    }
    return undefined;
  }

  public getRecentRecords(limit = 50): DeliveryRecord[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs)
      .slice(0, limit);
  }
}
