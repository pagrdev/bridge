import { describe, expect, it } from 'vitest';
import { qr } from '../output.js';
import { encodeQr, QR_MAX_VERSION, qrCapacity } from '../qr.js';

/** Pack a matrix row-major into bits, so a whole QR fits in one comparable string. */
function pack(modules: boolean[][]): string {
  const bits = modules.flat();
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) {
      const at = bytes[i >> 3] ?? 0;
      bytes[i >> 3] = at | (1 << (7 - (i & 7)));
    }
  });
  return bytes.toString('base64');
}

/**
 * Golden matrices produced by the `qrcode` npm package (not a dependency of this repo — it was
 * run once, out of tree, to check this encoder against an independent implementation). Every
 * payload here is pure byte mode, which is the only mode this encoder speaks, so the two agree
 * module for module: data codewords, Reed-Solomon blocks, interleaving, format bits and the
 * chosen mask. Each was also decoded back to its input with `jsQR`.
 */
const GOLDEN: Array<[string, 'L' | 'M', number, string]> = [
  [
    'hello world',
    'L',
    21,
    '/lv8E5Butrt0pduirsEFB/qv4BsA7/Ygrxz7036SwS6y2ABKX/pG8F8hurCF052usqsFYS/tkYA=',
  ],
  [
    'hello world',
    'M',
    21,
    '/lv8ERBuvLt11duqrsFJB/qv4BQAvlPjav9r251IucF84IBUZ/hI0FCvupMN1n4uskkE2c/tqQA=',
  ],
  [
    'y'.repeat(32),
    'L',
    25,
    '/lU/wXyQbqart0VV268a7BZ9B/qq/gGnANNHOxDVU36ho2e8qixrV0HBcaauwVqQrjDWsf4AfEf/qOvwQlFrpm/d11B+6JszBYlQ/vXlgA==',
  ],
  [
    'q'.repeat(78),
    'M',
    37,
    '/hcRE/wWyu7QbpXCIrt0bnd126uJES7BGu7tB/qqqq/gBp7uAKpORECXR6t3Uk/WiIj/wFru4gNmJER0zKV3dSZMCIiP5BCu7iC/VqRHTQgOd1Jf0WiI/uKF7uINOTREdJ4GV3UmGuEIj/26Iu4gUiwER0lgqndSa/2IiP7xhu7iOCcERP0AXXd0Z/jIiOvwQq7tELqOpE/N0u93Bq6q6It/BCXu2C/plEXtgA==',
  ],
  [
    'r'.repeat(108),
    'L',
    41,
    '/hqfKb/BTJBrEG6WhWDLt1kkT5XbpbjymuwVo4axB/qqqqr+ADF7BgD7ttp81Vgjb5TcU9nQNZCCJI6wbbXpOKfJdiNJOU3H7pejWQiIkksG2zdnynyXVKlPlNxmskg1kJOjQrBtvuiSR8l3ixxpTcXtccNZCKihewbb7vbafJd8q22U3Hi70LWQmJuOMG219DjnyXRnSSlNxn+Xo1kJExJLBtqLZ8p8/oBJT5TEf6pJNeqQQ0LwcbuqkkfP9dQceUSO6vHDWOkF4XsHiv722n1uAA==',
  ],
];

describe('qr encoder', () => {
  it.each(GOLDEN)('matches an independent encoder for %j at level %s', (text, ecc, size, b64) => {
    const code = encodeQr(text, ecc);
    expect(code).not.toBeNull();
    expect(code?.size).toBe(size);
    expect(pack(code?.modules ?? [])).toBe(b64);
  });

  it('draws the three finder patterns, the timing rows and nothing outside the grid', () => {
    const code = encodeQr('sms:+15550101234?&body=Hi%20Pagr', 'M');
    if (!code) throw new Error('expected a code');
    expect(code.size).toBe(code.version * 4 + 17);
    const dark = (x: number, y: number) => code.modules[y]?.[x];
    for (const [ox, oy] of [
      [0, 0],
      [code.size - 7, 0],
      [0, code.size - 7],
    ] as const) {
      expect(dark(ox + 0, oy + 0)).toBe(true); // outer ring
      expect(dark(ox + 1, oy + 1)).toBe(false); // the light ring inside it
      expect(dark(ox + 3, oy + 3)).toBe(true); // 3x3 core
    }
    // timing patterns alternate along row and column 6
    for (let i = 8; i < code.size - 8; i++) {
      expect(dark(i, 6)).toBe(i % 2 === 0);
      expect(dark(6, i)).toBe(i % 2 === 0);
    }
    expect(code.modules.every((row) => row.length === code.size)).toBe(true);
  });

  it('picks the smallest version that fits and refuses anything past version 6', () => {
    expect(encodeQr('x'.repeat(qrCapacity(1, 'L')), 'L')?.version).toBe(1);
    expect(encodeQr('x'.repeat(qrCapacity(1, 'L') + 1), 'L')?.version).toBe(2);
    expect(encodeQr('x'.repeat(qrCapacity(QR_MAX_VERSION, 'L')), 'L')?.version).toBe(
      QR_MAX_VERSION,
    );
    // one byte past the last version this encoder draws: the caller prints the URL instead
    expect(encodeQr('x'.repeat(qrCapacity(QR_MAX_VERSION, 'L') + 1), 'L')).toBeNull();
  });

  it('counts UTF-8 bytes, not characters', () => {
    const emoji = '✅'.repeat(qrCapacity(1, 'M')); // three bytes each
    expect(emoji.length).toBe(qrCapacity(1, 'M'));
    expect(encodeQr(emoji, 'M')?.version).toBeGreaterThan(1);
  });
});

describe('qr rendering', () => {
  const strip = (s: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI for the assertion
    s.replace(/\x1b\[[0-9;]*m/g, '');

  it('renders two modules per line with a four-module quiet zone', () => {
    const lines = qr('hello world');
    if (!lines) throw new Error('expected lines');
    const width = 21 + 8;
    expect(lines).toHaveLength(Math.ceil(width / 2));
    for (const line of lines) expect(strip(line)).toHaveLength(width);
    // the quiet zone: the first two rows and the first four columns are light (foreground)
    expect(strip(lines[0] ?? '')).toBe('█'.repeat(width));
    expect(strip(lines[4] ?? '').slice(0, 4)).toBe('████');
    // every line is one colour span: light modules in the foreground, dark in the background
    expect(lines.every((l) => l.startsWith('\x1b[97;40m') && l.endsWith('\x1b[0m'))).toBe(true);
    expect(lines.every((l) => /^[█▀▄ ]+$/.test(strip(l)))).toBe(true);
  });

  it('returns null rather than a wrapped, unscannable code on a narrow terminal', () => {
    expect(qr('hello world', { maxWidth: 28 })).toBeNull();
    expect(qr('hello world', { maxWidth: 29 })).not.toBeNull();
  });

  it('returns null when the payload is too long to draw', () => {
    expect(qr('x'.repeat(500))).toBeNull();
  });
});
