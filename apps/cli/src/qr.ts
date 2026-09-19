/**
 * A minimal QR encoder, in-process and dependency-free.
 *
 * The bridge ships with five runtime dependencies on purpose (zod, ws, keyring, commander,
 * picocolors), and a QR code printed once during `pagr connect` is not worth a sixth. This is
 * model-2 QR, byte mode only, versions 1–6 — enough for an `sms:` deep link (134 characters at
 * error-correction level L, 108 at M) and no more. Anything longer returns `null` and the caller
 * falls back to printing the URL, which is the honest outcome: a QR too dense to scan off a
 * terminal is worse than a line of text.
 *
 * Capping at version 6 removes the whole version-information block (only versions 7+ carry it)
 * and keeps the alignment-pattern table to a single extra centre, so every branch below is
 * exercised by the payloads we actually print.
 *
 * The algorithm is the one in ISO/IEC 18004: build the bit stream, split it into blocks, append
 * Reed-Solomon codewords over GF(256), interleave, draw the function patterns, lay the data in a
 * zigzag, then pick the mask with the lowest penalty.
 */

export type QrEcc = 'L' | 'M';

export const QR_MAX_VERSION = 6;

export interface QrCode {
  /** Modules per side, 4·version + 17. Does not include the quiet zone. */
  size: number;
  /** `modules[y][x]` — true is a dark module. */
  modules: boolean[][];
  version: number;
  ecc: QrEcc;
}

// Error-correction codewords per block, and blocks per code, indexed by version (1-based).
// Tabular in the standard; there is no formula. Only the versions this encoder can reach.
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18],
  M: [-1, 10, 16, 26, 18, 24, 16],
};
const ECC_BLOCKS: Record<QrEcc, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2],
  M: [-1, 1, 1, 1, 2, 2, 4],
};
/** The two-bit code each level gets in the format information. */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0 };

const at = (a: readonly number[], i: number): number => a[i] ?? 0;

/** Total data + ECC codewords a version holds, from the module count the standard defines. */
function rawCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    modules -= (25 * numAlign - 10) * numAlign - 55;
    // versions >= 7 also carry 36 version-information modules; unreachable here by design
  }
  return Math.floor(modules / 8);
}

/** Codewords left for the message once the error correction is subtracted. */
function dataCodewords(version: number, ecc: QrEcc): number {
  return (
    rawCodewords(version) - at(ECC_CODEWORDS_PER_BLOCK[ecc], version) * at(ECC_BLOCKS[ecc], version)
  );
}

/** Bytes of UTF-8 payload a version can carry: the data codewords less the 12-bit header. */
export function qrCapacity(version: number, ecc: QrEcc): number {
  return Math.floor((dataCodewords(version, ecc) * 8 - 12) / 8);
}

// ---------------------------------------------------------------------------
// GF(256) / Reed-Solomon
// ---------------------------------------------------------------------------

/** Multiply in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D), the field QR uses. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Coefficients of the generator polynomial of the given degree, highest power omitted. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(at(result, j), root);
      result[j] = at(result, j) ^ at(result, j + 1);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The ECC codewords for one block: the remainder of the data divided by the generator. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ at(result, 0);
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++)
      result[i] = at(result, i) ^ gfMul(at(divisor, i), factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// bit stream
// ---------------------------------------------------------------------------

function messageCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(bytes.length, 8); // versions 1–9 use an 8-bit character count in byte mode
  for (const b of bytes) append(b, 8);

  const capacityBits = dataCodewords(version, ecc) * 8;
  append(0, Math.min(4, capacityBits - bits.length)); // terminator
  append(0, (8 - (bits.length % 8)) % 8); // pad to a whole codeword
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | at(bits, i + j);
    codewords.push(byte);
  }
  return codewords;
}

/** Split into blocks, append each block's ECC, then interleave as the standard requires. */
function interleave(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = at(ECC_BLOCKS[ecc], version);
  const eccLen = at(ECC_CODEWORDS_PER_BLOCK[ecc], version);
  const raw = rawCodewords(version);
  const numShort = numBlocks - (raw % numBlocks);
  const shortDataLen = Math.floor(raw / numBlocks) - eccLen;
  const divisor = rsDivisor(eccLen);

  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortDataLen + (i < numShort ? 0 : 1);
    const block = data.slice(k, k + len);
    k += len;
    blocks.push(block);
    eccBlocks.push(rsRemainder(block, divisor));
  }

  const result: number[] = [];
  for (let i = 0; i < shortDataLen + 1; i++)
    for (let b = 0; b < numBlocks; b++) {
      const block = blocks[b];
      if (!block) continue;
      if (i < block.length) result.push(at(block, i));
    }
  for (let i = 0; i < eccLen; i++) for (const block of eccBlocks) result.push(at(block, i));
  return result;
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  get(x: number, y: number): boolean {
    return this.modules[y]?.[x] ?? false;
  }

  isFunction(x: number, y: number): boolean {
    return this.reserved[y]?.[x] ?? false;
  }

  set(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    if (row) row[x] = dark;
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.set(x, y, dark);
    const row = this.reserved[y];
    if (row) row[x] = true;
  }
}

/** Centres of the alignment patterns; the three that collide with finders are skipped later. */
function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array<number>(numAlign).fill(6);
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

function drawFunctionPatterns(m: Matrix, ecc: QrEcc): void {
  for (let i = 0; i < m.size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  for (const [x, y] of [
    [3, 3],
    [m.size - 4, 3],
    [3, m.size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < m.size && yy >= 0 && yy < m.size)
          m.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }

  const align = alignmentPositions(m.version, m.size);
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          m.setFunction(
            at(align, i) + dx,
            at(align, j) + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
    }

  drawFormatBits(m, ecc, 0); // reserves the cells; rewritten with the chosen mask
}

function drawFormatBits(m: Matrix, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) m.setFunction(m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, m.size - 15 + i, bit(i));
  m.setFunction(8, m.size - 8, true); // the always-dark module
}

function drawCodewords(m: Matrix, codewords: readonly number[]): void {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern is not a data column
    for (let vert = 0; vert < m.size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.isFunction(x, y) && i < codewords.length * 8) {
          m.set(x, y, ((at(codewords, i >>> 3) >>> (7 - (i & 7))) & 1) !== 0);
          i++;
        }
      }
  }
}

function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++)
      if (!m.isFunction(x, y) && maskCondition(mask, x, y)) m.set(x, y, !m.get(x, y));
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function finderPatterns(history: readonly number[]): number {
  const n = at(history, 1);
  const core =
    n > 0 &&
    at(history, 2) === n &&
    at(history, 3) === n * 3 &&
    at(history, 4) === n &&
    at(history, 5) === n;
  return (
    (core && at(history, 0) >= n * 4 && at(history, 6) >= n ? 1 : 0) +
    (core && at(history, 6) >= n * 4 && at(history, 0) >= n ? 1 : 0)
  );
}

function pushHistory(run: number, history: number[], size: number): void {
  if (at(history, 0) === 0) run += size; // the quiet zone counts as light
  history.pop();
  history.unshift(run);
}

function terminateRun(dark: boolean, run: number, history: number[], size: number): number {
  if (dark) {
    pushHistory(run, history, size);
    run = 0;
  }
  pushHistory(run + size, history, size);
  return finderPatterns(history);
}

/** Lower is better. The four rules in the standard, used only to choose between masks. */
function penalty(m: Matrix): number {
  let result = 0;
  let dark = 0;
  for (const outer of [0, 1]) {
    for (let a = 0; a < m.size; a++) {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < m.size; b++) {
        const value = outer === 0 ? m.get(b, a) : m.get(a, b);
        if (outer === 0 && value) dark++;
        if (value === runColor) {
          run++;
          if (run === 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          pushHistory(run, history, m.size);
          if (!runColor) result += finderPatterns(history) * PENALTY_N3;
          runColor = value;
          run = 1;
        }
      }
      result += terminateRun(runColor, run, history, m.size) * PENALTY_N3;
    }
  }
  for (let y = 0; y < m.size - 1; y++)
    for (let x = 0; x < m.size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1))
        result += PENALTY_N2;
    }
  const total = m.size * m.size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + k * PENALTY_N4;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Encode `text` as a QR code, or `null` when it does not fit in version 6 at this level.
 * Callers treat `null` as "print the URL instead", never as an error.
 *
 * `forceMask` skips the mask-selection heuristic and uses the one given. Nothing in the CLI
 * passes it: it exists so this encoder can be diffed module-for-module against a reference
 * implementation, which is how the golden vectors in `qr.test.ts` were checked.
 */
export function encodeQr(text: string, ecc: QrEcc = 'M', forceMask?: number): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v++)
    if (bytes.length <= qrCapacity(v, ecc)) {
      version = v;
      break;
    }
  if (version === 0) return null;

  const codewords = interleave(messageCodewords(bytes, version, ecc), version, ecc);
  const m = new Matrix(version);
  drawFunctionPatterns(m, ecc);
  drawCodewords(m, codewords);

  let best = forceMask ?? 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; forceMask === undefined && mask < 8; mask++) {
    applyMask(m, mask);
    drawFormatBits(m, ecc, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(m, mask); // masking is an XOR: applying it twice undoes it
  }
  applyMask(m, best);
  drawFormatBits(m, ecc, best);
  return { size: m.size, modules: m.modules, version, ecc };
}
