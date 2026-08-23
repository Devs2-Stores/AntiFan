import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { AuthoritativeReceipt, ReceiptBinding } from '../../shared/control-plane-contracts';

export interface ReceiptStoreOptions { filePath: string; maxRecords?: number; }

export class ReceiptStore {
  private readonly records = new Map<string, AuthoritativeReceipt>();
  private readonly maxRecords: number;

  constructor(private readonly options: ReceiptStoreOptions) {
    this.maxRecords = options.maxRecords ?? 500;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.options.filePath)) return;
    const raw = fs.readFileSync(this.options.filePath, 'utf8');
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const receipt = JSON.parse(line) as AuthoritativeReceipt;
      if (receipt.formatVersion !== 1 || !receipt.id || !receipt.binding) throw new Error('Invalid receipt store record');
      this.records.set(receipt.id, receipt);
    }
  }

  put(binding: ReceiptBinding, state: AuthoritativeReceipt['state'], deliveryState: AuthoritativeReceipt['deliveryState'], details: Pick<AuthoritativeReceipt, 'errorCode' | 'errorMessage'> = {}): AuthoritativeReceipt {
    const existing = Array.from(this.records.values()).find((item) => item.binding.commandId === binding.commandId);
    if (existing) {
      if (!sameBinding(existing.binding, binding)) throw new Error('Receipt binding mismatch');
      if (existing.state === 'completed' || existing.state === 'failed') return { ...existing };
    }
    const now = Date.now();
    const receipt: AuthoritativeReceipt = existing ? { ...existing, state, deliveryState, completedAt: state === 'unknown' ? undefined : now, ...details } : {
      formatVersion: 1,
      id: `receipt-${crypto.randomUUID()}`,
      binding: { ...binding },
      state,
      deliveryState,
      createdAt: now,
      completedAt: state === 'unknown' ? undefined : now,
      ...details,
    };
    this.records.set(receipt.id, receipt);
    this.persist();
    return { ...receipt, binding: { ...receipt.binding } };
  }

  findByCommand(commandId: string): AuthoritativeReceipt | undefined {
    const receipt = Array.from(this.records.values()).find((item) => item.binding.commandId === commandId);
    return receipt ? { ...receipt, binding: { ...receipt.binding } } : undefined;
  }

  reconcile(binding: ReceiptBinding, receipt: AuthoritativeReceipt): AuthoritativeReceipt {
    if (!sameBinding(binding, receipt.binding)) throw new Error('Late receipt binding mismatch');
    return this.put(binding, receipt.state, receipt.deliveryState, { errorCode: receipt.errorCode, errorMessage: receipt.errorMessage });
  }

  listPending(): AuthoritativeReceipt[] { return Array.from(this.records.values()).filter((item) => item.state === 'unknown' || item.state === 'accepted').map((item) => ({ ...item, binding: { ...item.binding } })); }

  private persist(): void {
    const dir = path.dirname(this.options.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rows = Array.from(this.records.values()).slice(-this.maxRecords);
    const temp = `${this.options.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, rows.map((item) => JSON.stringify(item)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    fs.renameSync(temp, this.options.filePath);
  }
}

function sameBinding(a: ReceiptBinding, b: ReceiptBinding): boolean {
  return a.commandId === b.commandId && a.promptDigest === b.promptDigest && a.projectId === b.projectId && a.workspaceId === b.workspaceId && a.canonicalWorkspace.toLowerCase() === b.canonicalWorkspace.toLowerCase() && a.hostInstanceId === b.hostInstanceId && a.hostEpoch === b.hostEpoch && a.attemptId === b.attemptId && a.backendSessionRef === b.backendSessionRef;
}
