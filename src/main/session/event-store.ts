import * as fs from 'node:fs';
import * as path from 'node:path';
import { ControlPlaneEvent, SESSION_FORMAT_VERSION, makeControlPlaneId } from '../../shared/control-plane-contracts';

export interface EventStoreHeader {
  formatVersion: number;
  projectId: string;
  workspaceId: string;
  createdAt: number;
}

export interface EventStoreOptions {
  filePath: string;
  projectId: string;
  workspaceId: string;
  maxEventBytes?: number;
  fsSeam?: EventStoreFs;
}

interface EventStoreFs {
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  readFileSync: typeof fs.readFileSync;
  writeFileSync: typeof fs.writeFileSync;
  appendFileSync: typeof fs.appendFileSync;
  renameSync: typeof fs.renameSync;
}

export class EventStore {
  private readonly fs: EventStoreFs;
  private readonly maxEventBytes: number;
  private readonly header: EventStoreHeader;
  private nextSequence = 1;

  constructor(private readonly options: EventStoreOptions) {
    this.fs = options.fsSeam || fs;
    this.maxEventBytes = options.maxEventBytes ?? 1024 * 1024;
    this.header = { formatVersion: SESSION_FORMAT_VERSION, projectId: options.projectId, workspaceId: options.workspaceId, createdAt: Date.now() };
    this.ensureInitialized();
    this.nextSequence = this.replay().reduce((max, event) => Math.max(max, event.sequence + 1), 1);
  }

  get filePath(): string { return this.options.filePath; }

  private ensureInitialized(): void {
    const dir = path.dirname(this.options.filePath);
    if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
    if (this.fs.existsSync(this.options.filePath)) {
      const first = this.readLines()[0];
      if (!first) throw new Error('Event store is empty and cannot be recovered');
      const existing = JSON.parse(first) as EventStoreHeader;
      if (existing.formatVersion !== SESSION_FORMAT_VERSION) throw new Error(`Unsupported event store format version: ${existing.formatVersion}`);
      if (existing.projectId !== this.options.projectId || existing.workspaceId !== this.options.workspaceId) throw new Error('Event store lineage does not match Project/Workspace');
      return;
    }
    this.fs.writeFileSync(this.options.filePath, `${JSON.stringify(this.header)}\n`, 'utf8');
  }

  private readLines(): string[] {
    return this.fs.readFileSync(this.options.filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  }

  append<T>(event: Omit<ControlPlaneEvent<T>, 'formatVersion' | 'id' | 'sequence'>): ControlPlaneEvent<T> {
    const record: ControlPlaneEvent<T> = { ...event, formatVersion: SESSION_FORMAT_VERSION, id: makeControlPlaneId('event'), sequence: this.nextSequence++ };
    const line = JSON.stringify(record);
    if (Buffer.byteLength(line, 'utf8') > this.maxEventBytes) throw new Error(`Event exceeds ${this.maxEventBytes} byte limit`);
    this.fs.appendFileSync(this.options.filePath, `${line}\n`, 'utf8');
    return record;
  }

  replay(): ControlPlaneEvent[] {
    const lines = this.readLines();
    const header = lines.shift();
    if (!header) throw new Error('Event store header is missing');
    const parsedHeader = JSON.parse(header) as EventStoreHeader;
    if (parsedHeader.formatVersion !== SESSION_FORMAT_VERSION) throw new Error(`Unsupported event store format version: ${parsedHeader.formatVersion}`);
    const events: ControlPlaneEvent[] = [];
    let validLineCount = 0;
    for (const [index, line] of lines.entries()) {
      try {
        const event = JSON.parse(line) as ControlPlaneEvent;
        if (event.formatVersion !== SESSION_FORMAT_VERSION || typeof event.sequence !== 'number' || typeof event.type !== 'string') throw new Error('Invalid event record');
        events.push(event);
        validLineCount = index + 1;
      } catch (error) {
        if (index === lines.length - 1) {
          const repaired = [header, ...lines.slice(0, validLineCount)].join('\n') + '\n';
          this.fs.writeFileSync(this.options.filePath, repaired, 'utf8');
          break;
        }
        throw new Error(`Event store contains corrupt data: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return events.sort((a, b) => a.sequence - b.sequence);
  }

  checkpoint(): void {
    const lines = this.readLines();
    const tempPath = `${this.options.filePath}.tmp-${process.pid}-${Date.now()}`;
    this.fs.writeFileSync(tempPath, `${lines.join('\n')}\n`, 'utf8');
    this.fs.renameSync(tempPath, this.options.filePath);
  }
}
