/**
 * AntiFan Browser Desktop — Clean High-Contrast QR Code Generator (ISO/IEC 18004 Standard)
 * Generates black-on-white SVG QR codes with full 4-cell quiet zone for instantaneous mobile camera scanning.
 */

export function generateQrSvg(text: string, size = 240): string {
  const qr = createQrMatrix(text);
  const moduleCount = qr.length;
  const quietZone = 4;
  const totalCells = moduleCount + quietZone * 2;
  const cellSize = size / totalCells;

  let pathD = '';
  for (let r = 0; r < moduleCount; r++) {
    const row = qr[r];
    if (!row) continue;
    for (let c = 0; c < moduleCount; c++) {
      if (row[c]) {
        const x = (quietZone + c) * cellSize;
        const y = (quietZone + r) * cellSize;
        pathD += `M${x.toFixed(2)},${y.toFixed(2)}h${cellSize.toFixed(2)}v${cellSize.toFixed(2)}h-${cellSize.toFixed(2)}z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="background:#ffffff;border-radius:12px;display:block;box-shadow:0 6px 24px rgba(0,0,0,0.4);">
    <rect width="${size}" height="${size}" fill="#ffffff" rx="12" />
    <path d="${pathD.trim()}" fill="#0a0f1d" />
  </svg>`;
}

// Galois Field GF(256) tables for QR polynomial multiplication
const GF_EXP: number[] = new Array(512).fill(0);
const GF_LOG: number[] = new Array(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
})();

function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  const logSum = (GF_LOG[x] ?? 0) + (GF_LOG[y] ?? 0);
  return GF_EXP[logSum] ?? 0;
}

function computeReedSolomon(data: number[], eccCount: number): number[] {
  let gen = [1];
  for (let i = 0; i < eccCount; i++) {
    const nextGen = new Array(gen.length + 1).fill(0);
    const root = GF_EXP[i] ?? 0;
    for (let j = 0; j < gen.length; j++) {
      const g = gen[j] ?? 0;
      nextGen[j] = (nextGen[j] ?? 0) ^ gfMul(g, root);
      nextGen[j + 1] = (nextGen[j + 1] ?? 0) ^ g;
    }
    gen = nextGen;
  }

  const result = new Array(eccCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result[0] ?? 0);
    result.shift();
    result.push(0);
    for (let i = 0; i < eccCount; i++) {
      result[i] = (result[i] ?? 0) ^ gfMul(gen[i] ?? 0, factor);
    }
  }
  return result;
}

// Level L Standard QR Model 2 Specifications (Versions 1-6)
interface QrVersionSpec {
  version: number;
  totalCodewords: number;
  dataCodewords: number;
  eccCodewords: number;
  blocks: number;
}

const VERSION_SPECS_LEVEL_L: Record<number, QrVersionSpec> = {
  1: { version: 1, totalCodewords: 26, dataCodewords: 19, eccCodewords: 7, blocks: 1 },
  2: { version: 2, totalCodewords: 44, dataCodewords: 34, eccCodewords: 10, blocks: 1 },
  3: { version: 3, totalCodewords: 70, dataCodewords: 55, eccCodewords: 15, blocks: 1 },
  4: { version: 4, totalCodewords: 100, dataCodewords: 80, eccCodewords: 20, blocks: 1 },
  5: { version: 5, totalCodewords: 134, dataCodewords: 108, eccCodewords: 26, blocks: 1 },
  6: { version: 6, totalCodewords: 172, dataCodewords: 136, eccCodewords: 18, blocks: 2 },
};

function createQrMatrix(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  let spec = VERSION_SPECS_LEVEL_L[1]!;
  for (let v = 1; v <= 6; v++) {
    const s = VERSION_SPECS_LEVEL_L[v]!;
    // Byte mode header: 4 bits mode + 8 bits count = 12 bits = 2 bytes (or 16 bits count for v >= 10)
    const maxCapacity = s.dataCodewords - 2;
    if (data.length <= maxCapacity) {
      spec = s;
      break;
    }
  }

  const { version, dataCodewords, eccCodewords } = spec;
  const size = version * 4 + 17;
  const matrix: (boolean | null)[][] = [];
  for (let i = 0; i < size; i++) {
    matrix.push(new Array(size).fill(null));
  }

  function setCell(r: number, c: number, val: boolean | null) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      const row = matrix[r];
      if (row) row[c] = val;
    }
  }

  function getCell(r: number, c: number): boolean | null {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      const row = matrix[r];
      if (row) return row[c] ?? null;
    }
    return null;
  }

  // 1. Finder Patterns (Top-Left, Top-Right, Bottom-Left)
  function placeFinder(startRow: number, startCol: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = startRow + r;
        const nc = startCol + c;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
          if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
            setCell(nr, nc, r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          } else {
            setCell(nr, nc, false);
          }
        }
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // 2. Alignment Patterns (Version >= 2)
  const alignCoords: Record<number, number[]> = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
  };
  const coords = alignCoords[version] || [];
  for (const r of coords) {
    for (const c of coords) {
      if (getCell(r, c) !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBorder = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          setCell(r + dr, c + dc, isBorder || isCenter);
        }
      }
    }
  }

  // 3. Timing Patterns
  for (let i = 8; i < size - 8; i++) {
    if (getCell(6, i) === null) setCell(6, i, i % 2 === 0);
    if (getCell(i, 6) === null) setCell(i, 6, i % 2 === 0);
  }

  // 4. Dark Module
  setCell(4 * version + 9, 8, true);

  // 5. Reserve Format Info Areas
  for (let i = 0; i < 9; i++) {
    if (getCell(8, i) === null) setCell(8, i, false);
    if (getCell(i, 8) === null) setCell(i, 8, false);
    if (getCell(8, size - 1 - i) === null) setCell(8, size - 1 - i, false);
    if (getCell(size - 1 - i, 8) === null) setCell(size - 1 - i, 8, false);
  }

  // 6. Encode Data (Byte Mode: 0100)
  const bitStream: number[] = [];
  function pushBits(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      bitStream.push((val >> i) & 1);
    }
  }

  pushBits(0b0100, 4); // Byte mode indicator
  pushBits(data.length, 8); // Character count
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b !== undefined) pushBits(b, 8);
  }

  const totalBits = dataCodewords * 8;
  while (bitStream.length < totalBits && bitStream.length % 8 !== 0) {
    bitStream.push(0);
  }
  let padByte = 0xEC;
  while (bitStream.length < totalBits) {
    pushBits(padByte, 8);
    padByte = padByte === 0xEC ? 0x11 : 0xEC;
  }

  const dataBytes: number[] = [];
  for (let i = 0; i < bitStream.length; i += 8) {
    let byteVal = 0;
    for (let b = 0; b < 8; b++) {
      const bit = bitStream[i + b] ?? 0;
      byteVal = (byteVal << 1) | bit;
    }
    dataBytes.push(byteVal);
  }

  // Reed-Solomon Error Correction Codewords
  const eccBytes = computeReedSolomon(dataBytes, eccCodewords);
  const finalCodewords = [...dataBytes, ...eccBytes];

  const finalBits: number[] = [];
  for (const cw of finalCodewords) {
    for (let i = 7; i >= 0; i--) {
      finalBits.push((cw >> i) & 1);
    }
  }

  // 7. Place Data Bits into Matrix (with standard Mask 0: (r + c) % 2 == 0)
  let bitIdx = 0;
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    const rowRange = dir === -1
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rowRange) {
      for (const c of [col, col - 1]) {
        if (getCell(r, c) === null) {
          const rawBit = bitIdx < finalBits.length ? (finalBits[bitIdx++] ?? 0) : 0;
          const mask = (r + c) % 2 === 0;
          setCell(r, c, Boolean(rawBit ^ (mask ? 1 : 0)));
        }
      }
    }
    dir = -dir;
  }

  // 8. Place Format Info for Level L + Mask 0 (Binary: 111011111000100)
  const formatBits = [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0];
  for (let i = 0; i < 6; i++) setCell(8, i, Boolean(formatBits[i]));
  setCell(8, 7, Boolean(formatBits[6]));
  setCell(8, 8, Boolean(formatBits[7]));
  setCell(7, 8, Boolean(formatBits[8]));
  for (let i = 9; i < 15; i++) setCell(14 - i, 8, Boolean(formatBits[i]));

  for (let i = 0; i < 8; i++) setCell(size - 1 - i, 8, Boolean(formatBits[i]));
  for (let i = 8; i < 15; i++) setCell(8, size - 15 + i, Boolean(formatBits[i]));

  return matrix.map(row => row.map(cell => Boolean(cell)));
}
