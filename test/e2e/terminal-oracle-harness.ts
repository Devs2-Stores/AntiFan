import { Terminal } from '@xterm/xterm';

export interface TerminalOracleSnapshot {
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  activeBufferType: 'normal' | 'alternate';
  lines: string[];
}

export interface SnapshotComparisonResult {
  match: boolean;
  diffs: string[];
}

export class TerminalOracleHarness {
  public readonly term: Terminal;

  constructor(cols = 80, rows = 24) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      convertEol: false,
      scrollback: 10000,
    });
  }

  public feed(data: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.term.write(data, () => {
        resolve();
      });
    });
  }

  public resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  public captureSnapshot(): TerminalOracleSnapshot {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }

    return {
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      activeBufferType: buffer.type === 'alternate' ? 'alternate' : 'normal',
      lines,
    };
  }

  public static compareSnapshots(
    actual: TerminalOracleSnapshot,
    expected: TerminalOracleSnapshot
  ): SnapshotComparisonResult {
    const diffs: string[] = [];

    if (actual.activeBufferType !== expected.activeBufferType) {
      diffs.push(
        `Buffer type mismatch: actual="${actual.activeBufferType}", expected="${expected.activeBufferType}"`
      );
    }

    if (actual.cursorX !== expected.cursorX || actual.cursorY !== expected.cursorY) {
      diffs.push(
        `Cursor mismatch: actual=(${actual.cursorX}, ${actual.cursorY}), expected=(${expected.cursorX}, ${expected.cursorY})`
      );
    }

    if (actual.lines.length !== expected.lines.length) {
      diffs.push(
        `Line count mismatch: actual=${actual.lines.length}, expected=${expected.lines.length}`
      );
    } else {
      for (let i = 0; i < actual.lines.length; i++) {
        const actualLine = actual.lines[i] ?? '';
        const expectedLine = expected.lines[i] ?? '';
        if (actualLine !== expectedLine) {
          diffs.push(
            `Line ${i} mismatch:\n  actual:   "${actualLine}"\n  expected: "${expectedLine}"`
          );
        }
      }
    }

    return {
      match: diffs.length === 0,
      diffs,
    };
  }
}
