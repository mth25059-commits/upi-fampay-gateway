/**
 * QR codes, written out rather than installed.
 *
 * This exists because the alternative was a dependency, and the whole server has
 * one. QR encoding is a closed, fully specified problem — ISO/IEC 18004, no
 * network, no platform quirks, no security surface — so it is the rare case where
 * writing it beats pulling it in.
 *
 * "I wrote it myself" is not doing any load-bearing work in the argument for
 * correctness. It was checked two ways in a throwaway sandbox outside this
 * project, so `package.json` keeps its single dependency:
 *
 *   - Against the `qrcode` package, every byte length from 1 to the version-20
 *     ceiling: 660 symbols, 651 byte-identical, 0 genuine mismatches. The 9 that
 *     differ pick a different mask — see the note on penalty rule 4.
 *   - Round-tripped through `jsqr`, an independent decoder, by painting each
 *     matrix into an RGBA bitmap with a quiet zone and handing it over as pixels:
 *     362 of 362 decoded back to the exact original string, multi-byte UTF-8 and
 *     real UPI URIs included. This is the test that matters, because it is the
 *     only one that exercises the same path a phone camera does.
 *
 * Scope is deliberately narrow: byte mode, error correction level M, versions 1
 * to 20. A UPI request URI is around ninety characters and lands in version 6,
 * so there is a lot of headroom and no reason to carry tables for the other
 * thirty-four versions or the other three correction levels.
 *
 * Level M (15% recovery) rather than H (30%): a screen is not a sticker on a
 * warehouse crate. H would survive damage that cannot happen here, and it pays
 * for that with a denser grid that phone cameras find harder to lock onto.
 *
 * Output is SVG. A QR is a grid of squares, which is what a vector format is
 * for — no PNG encoder, no canvas, and it stays sharp on any screen at any size.
 */

/* ------------------------------- GF(256) --------------------------------- */

/*
 * Reed-Solomon works over GF(256) with the primitive polynomial x^8+x^4+x^3+x^2+1
 * (0x11D), which is what the QR spec fixes. Log/antilog tables turn field
 * multiplication into an addition of exponents, which is the only reason the
 * encoder is fast enough not to think about.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Mirrored so `EXP[a + b]` never needs a modulo.
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `count` error-correction codewords. */
function rsGenerator(count) {
  let poly = [1];
  for (let i = 0; i < count; i += 1) {
    // Multiply by (x - α^i).
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The `count` EC codewords for one data block — polynomial division remainder. */
function rsRemainder(data, count) {
  const gen = rsGenerator(count);
  const out = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[count - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < count; i += 1) out[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return out;
}

/* ---------------------------- version tables ----------------------------- */

/*
 * Per version, at level M: [ecCodewordsPerBlock, blocksInGroup1,
 * dataCodewordsPerBlockInGroup1, blocksInGroup2, dataCodewordsPerBlockInGroup2].
 *
 * Group 2 exists because the block count does not always divide the payload
 * evenly, so the spec splits a version's blocks into two sizes differing by
 * exactly one codeword. Straight from ISO/IEC 18004 table 9 — and `selfTest()`
 * re-derives each row's total codeword count from these five numbers, which is
 * what makes a typo here loud rather than subtle.
 */
const ECC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
  16: [28, 7, 45, 3, 46],
  17: [28, 10, 46, 1, 47],
  18: [26, 9, 43, 4, 44],
  19: [26, 3, 44, 11, 45],
  20: [26, 3, 41, 13, 42],
};

/** Total codewords (data + EC) each symbol holds. Only used to verify ECC_M. */
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
  11: 404, 12: 466, 13: 532, 14: 581, 15: 655, 16: 733, 17: 815, 18: 901,
  19: 991, 20: 1085,
};

/** Row/column centres of the alignment patterns. Version 1 has none. */
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
};

const size = (version) => version * 4 + 17;

function dataCodewords(version) {
  const [, b1, d1, b2, d2] = ECC_M[version];
  return b1 * d1 + b2 * d2;
}

/* ------------------------------ BCH codes -------------------------------- */

/*
 * The format and version strips carry their own error correction, because a
 * reader has to trust them before it can decode anything else. Both are BCH
 * remainders, computed rather than tabulated — a 20-row table of 18-bit strings
 * is 20 more chances to fat-finger a digit.
 */
function bch(value, generator, degree) {
  const genWidth = 32 - Math.clz32(generator);
  let rest = value << degree;
  // Long division in GF(2): clear the highest set bit until what is left is
  // narrower than the divisor. What remains is the remainder.
  while (32 - Math.clz32(rest) >= genWidth) {
    rest ^= generator << (32 - Math.clz32(rest) - genWidth);
  }
  return rest;
}

/** 15 bits: 5 of level+mask, 10 of BCH, XORed so an all-zero strip is invalid. */
function formatBits(mask) {
  // Level M is `00` in the two high bits, so the payload is just the mask index.
  const data = mask & 0b111;
  return (((data << 10) | bch(data, 0x537, 10)) ^ 0x5412) & 0x7fff;
}

/** 18 bits, present from version 7 on. Below that the reader infers the size. */
const versionBits = (version) => ((version << 12) | bch(version, 0x1f25, 12)) & 0x3ffff;

/* ------------------------------ bit buffer ------------------------------- */

class Bits {
  constructor() {
    this.bytes = [];
    this.length = 0;
  }

  push(value, width) {
    for (let i = width - 1; i >= 0; i -= 1) {
      const bit = (value >>> i) & 1;
      if (this.length % 8 === 0) this.bytes.push(0);
      if (bit) this.bytes[this.bytes.length - 1] |= 0x80 >>> this.length % 8;
      this.length += 1;
    }
  }
}

/* ------------------------------- encoding -------------------------------- */

/** Smallest version that fits `byteLength` bytes in byte mode at level M. */
function chooseVersion(byteLength) {
  for (let v = 1; v <= 20; v += 1) {
    // 4 bits of mode indicator, then the character count: 8 bits up to version
    // 9, 16 bits from version 10 on.
    const header = 4 + (v <= 9 ? 8 : 16);
    if (dataCodewords(v) * 8 >= header + byteLength * 8) return v;
  }
  return null;
}

/**
 * Text to the final codeword stream: mode header, payload, terminator, pad
 * bytes, then Reed-Solomon per block and interleaving.
 *
 * The interleave is the part worth naming. Blocks are not written to the grid
 * one after another — they are woven a codeword at a time, so a scratch or a
 * thumb over one part of the symbol spreads its damage across every block
 * instead of destroying one outright. That is what makes the error correction
 * worth having.
 */
function encode(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const version = chooseVersion(payload.length);
  if (!version) {
    throw new Error(`${payload.length} bytes is too long for a version 20 QR at level M.`);
  }

  const [ecPerBlock, blocks1, data1, blocks2, data2] = ECC_M[version];
  const capacity = dataCodewords(version);

  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(payload.length, version <= 9 ? 8 : 16);
  for (const byte of payload) bits.push(byte, 8);
  // Terminator, up to four zero bits, then zeros to the byte boundary.
  bits.push(0, Math.min(4, capacity * 8 - bits.length));
  if (bits.length % 8) bits.push(0, 8 - (bits.length % 8));

  const stream = Buffer.alloc(capacity);
  Buffer.from(bits.bytes).copy(stream);
  // Fixed alternating pad bytes from the spec, not zeros — they keep the tail of
  // a short message from turning into a large blank region.
  for (let i = bits.bytes.length; i < capacity; i += 1) {
    stream[i] = (i - bits.bytes.length) % 2 === 0 ? 0xec : 0x11;
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (const [count, width] of [[blocks1, data1], [blocks2, data2]]) {
    for (let b = 0; b < count; b += 1) {
      const block = stream.subarray(at, at + width);
      at += width;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, ecPerBlock));
    }
  }

  const out = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }

  return { version, codewords: Uint8Array.from(out) };
}

/* -------------------------------- matrix --------------------------------- */

/*
 * Two planes over the same grid: `cells` is dark/light, `fixed` marks the modules
 * that belong to the finder, timing, alignment and format structures. Only
 * unfixed modules carry data and only unfixed modules get masked — every bug in a
 * hand-written encoder that produces a scannable-looking but unreadable symbol
 * comes down to blurring that line.
 */
function blank(version) {
  const n = size(version);
  return { n, cells: new Int8Array(n * n).fill(-1), fixed: new Uint8Array(n * n) };
}

function drawPatterns(m, version) {
  const { n, cells, fixed } = m;
  const put = (r, c, v) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    cells[r * n + c] = v;
    fixed[r * n + c] = 1;
  };

  // Finders, plus the one-module light separator that isolates each of them.
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        put(r0 + dr, c0 + dc, inside && ring !== 2 ? 1 : 0);
      }
    }
  }

  // Timing: the alternating spine that tells a reader the module pitch.
  for (let i = 8; i < n - 8; i += 1) {
    const v = i % 2 === 0 ? 1 : 0;
    put(6, i, v);
    put(i, 6, v);
  }

  // Alignment, skipping the three centres that would sit on a finder.
  const centres = ALIGNMENT[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
        }
      }
    }
  }

  // Reserve the format strips. Real values go in after the mask is chosen, but
  // they must be off-limits to data placement before that.
  //
  // Index 6 is skipped in both directions. The format strip steps over the
  // timing line — (6,8) and (8,6) are timing modules, not format modules — so
  // blanking them here would leave two dark modules light for good, since
  // `drawFormat` rightly never writes those positions either.
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue;
    put(8, i, 0);
    put(i, 8, 0);
  }
  for (let i = 0; i < 8; i += 1) put(8, n - 1 - i, 0);
  for (let i = 0; i < 8; i += 1) put(n - 1 - i, 8, 0);
  put(n - 8, 8, 1); // the one module that is always dark

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (bits >>> i) & 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      put(b, a, bit);
      put(a, b, bit);
    }
  }
}

/**
 * Codewords into the grid: two-module-wide columns walked right to left, snaking
 * up then down, skipping the vertical timing line and anything already fixed.
 *
 * The direction is derived from the column index rather than toggled by a flag.
 * A flag looks equivalent and is not: column 6 is the timing spine, so the walk
 * shifts from 6 to 5 mid-loop, and a toggle would fall out of step there and
 * mirror the second half of the symbol.
 */
function drawData(m, codewords) {
  const { n, cells, fixed } = m;
  let bit = 0;

  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? n - 1 - vert : vert;
        if (fixed[row * n + col]) continue;
        const byte = codewords[bit >>> 3];
        // Past the end of the stream the remainder bits are light, per the spec.
        cells[row * n + col] = byte === undefined ? 0 : (byte >>> (7 - (bit & 7))) & 1;
        bit += 1;
      }
    }
  }
}

/* --------------------------------- masking ------------------------------- */

/*
 * Eight fixed patterns from the spec. Data alone tends to produce large blank
 * regions or accidental finder look-alikes, either of which a camera reads
 * wrongly; XORing one of these over it breaks up both. All eight are tried and
 * the least-bad one wins, which is the actual reason a QR encoder cannot just
 * emit the grid and stop.
 */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const { n, cells, fixed } = m;
  const fn = MASKS[mask];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!fixed[r * n + c] && fn(r, c)) cells[r * n + c] ^= 1;
    }
  }
}

function drawFormat(m, mask) {
  const { n, cells, fixed } = m;
  const bits = formatBits(mask);
  const put = (r, c, v) => {
    cells[r * n + c] = v;
    fixed[r * n + c] = 1;
  };
  const bit = (i) => (bits >>> i) & 1;

  for (let i = 0; i <= 5; i += 1) put(i, 8, bit(i));
  put(7, 8, bit(6));
  put(8, 8, bit(7));
  put(8, 7, bit(8));
  for (let i = 9; i < 15; i += 1) put(8, 14 - i, bit(i));

  for (let i = 0; i < 8; i += 1) put(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i += 1) put(n - 15 + i, 8, bit(i));
}

/* -------------------------------- scoring -------------------------------- */

/** The four penalty rules. Lower is better; the weights are from the spec. */
function penalty(m) {
  const { n, cells } = m;
  const at = (r, c) => cells[r * n + c];
  let score = 0;

  // Rule 1 — runs of five or more of one colour in a line.
  for (let i = 0; i < n; i += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < n; j += 1) {
        const prev = horizontal ? at(i, j - 1) : at(j - 1, i);
        const cur = horizontal ? at(i, j) : at(j, i);
        if (cur === prev) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
  }

  // Rule 2 — every 2x2 block of a single colour.
  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3 — the 1:1:3:1:1 finder signature with four light modules beside it,
  // anywhere in the data. This is the pattern a reader hunts for to orient
  // itself, so a copy of it in the payload is actively misleading.
  const NEEDLES = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j + 11 <= n; j += 1) {
      for (const needle of NEEDLES) {
        let row = true;
        let col = true;
        for (let k = 0; k < 11; k += 1) {
          if (at(i, j + k) !== needle[k]) row = false;
          if (at(j + k, i) !== needle[k]) col = false;
          if (!row && !col) break;
        }
        if (row) score += 40;
        if (col) score += 40;
      }
    }
  }

  // Rule 4 — drift away from an even split of dark and light.
  //
  // The spec is symmetric: k is the integer part of |percent - 50| / 5, so
  // anything between 45% and 55% scores nothing. The `qrcode` package instead
  // computes ceil(percent / 5) - 10, which quietly penalises every grid above
  // 50% dark while letting the mirror-image case below 50% off free. That is
  // the sole reason our mask choice differs from that package on 9 of 660
  // symbols; rules 1 to 3 reproduce its own scoring functions exactly, and on
  // those 9 it is our pick that minimises the spec's score. Kept as written.
  let dark = 0;
  for (let i = 0; i < n * n; i += 1) dark += cells[i];
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ------------------------------ public API ------------------------------- */

/**
 * Text to a finished grid. Every mask is applied, scored and undone, then the
 * winner is applied for real — the XOR is its own inverse, which is what makes
 * trying eight of them on one grid cheap.
 */
export function matrix(text) {
  const { version, codewords } = encode(text);
  const m = blank(version);
  drawPatterns(m, version);
  drawData(m, codewords);

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(m, mask);
  }
  applyMask(m, best);
  drawFormat(m, best);

  return { size: m.n, version, mask: best, cells: m.cells };
}

/**
 * An SVG string, one `<path>` for every dark module.
 *
 * No width or height attribute on purpose — only a viewBox — so CSS decides how
 * big it renders and the same markup serves a phone and a desktop. `crispEdges`
 * matters more than it sounds: with normal antialiasing the module borders blur
 * into each other at small sizes and cameras start missing the code.
 *
 * The quiet zone is four modules, which the spec requires and readers genuinely
 * enforce. It is part of the viewBox rather than left to the page's padding,
 * because a QR flush against a coloured panel is a QR that does not scan.
 */
export function toSvg(text, { margin = 4, dark = '#0e0f10', light = '#ffffff' } = {}) {
  const { size: n, cells } = matrix(text);
  const span = n + margin * 2;

  const parts = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (cells[r * n + c] === 1) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Payment QR code">` +
    `<rect width="${span}" height="${span}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/>` +
    `</svg>`
  );
}

/**
 * Checks the hand-typed tables against themselves. Called at import in
 * development, because a single wrong digit in ECC_M produces a QR that looks
 * plausible, scans on one phone, and fails on another.
 */
export function selfTest() {
  const problems = [];
  for (const version of Object.keys(ECC_M).map(Number)) {
    const [ec, b1, d1, b2, d2] = ECC_M[version];
    const total = b1 * (d1 + ec) + b2 * (d2 + ec);
    if (total !== TOTAL_CODEWORDS[version]) {
      problems.push(`v${version}: table gives ${total} codewords, spec says ${TOTAL_CODEWORDS[version]}`);
    }
    // Group 2 blocks always hold exactly one more data codeword than group 1.
    if (b2 && d2 !== d1 + 1) problems.push(`v${version}: group sizes ${d1}/${d2} differ by more than one`);
  }
  return problems;
}
