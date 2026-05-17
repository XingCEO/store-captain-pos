/*
 * Minimal pure-JS QR code generator.
 * Byte mode only, ECC levels L/M/Q/H, versions 1-10 (covers up to 213 bytes at level M).
 * Implements ISO/IEC 18004:2015 byte-mode encoding, RS error correction over GF(256)
 * with primitive 0x11D, mask selection by penalty score, BCH(15,5) format info.
 *
 * Exposes globalThis.QRCode = { generate(text, opts), toSVG(text, opts) }.
 * No external dependencies. Suitable for offline use.
 */
(function (root) {
  'use strict';

  // ============================================================
  // GF(256) tables — generated from primitive polynomial 0x11D
  // ============================================================
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[(LOG[a] + LOG[b]) % 255];
  }

  function rsGenPoly(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1);
      for (var j = 0; j < next.length; j++) next[j] = 0;
      for (var k = 0; k < poly.length; k++) {
        next[k] ^= poly[k];
        next[k + 1] ^= gfMul(poly[k], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEcc(data, eccLen) {
    var gen = rsGenPoly(eccLen);
    var remainder = new Array(eccLen);
    for (var i = 0; i < eccLen; i++) remainder[i] = 0;
    for (var j = 0; j < data.length; j++) {
      var factor = (data[j] ^ remainder[0]) & 0xff;
      for (var k = 0; k < eccLen - 1; k++) remainder[k] = remainder[k + 1];
      remainder[eccLen - 1] = 0;
      if (factor !== 0) {
        for (var m = 0; m < eccLen; m++) {
          remainder[m] ^= gfMul(gen[m + 1], factor);
        }
      }
    }
    return remainder;
  }

  // ============================================================
  // Capacity table for versions 1-10
  // Each entry: [totalDataCodewords, eccCodewordsPerBlock,
  //              group1Blocks, group1DataPerBlock,
  //              group2Blocks, group2DataPerBlock]
  // Source: ISO/IEC 18004 Tables 7 and 9
  // ============================================================
  var CAPACITY = {
    1:  { L: [19,  7,  1, 19,  0,  0], M: [16, 10, 1, 16, 0,  0], Q: [13, 13, 1, 13, 0,  0], H: [9,  17, 1,  9, 0,  0] },
    2:  { L: [34, 10,  1, 34,  0,  0], M: [28, 16, 1, 28, 0,  0], Q: [22, 22, 1, 22, 0,  0], H: [16, 28, 1, 16, 0,  0] },
    3:  { L: [55, 15,  1, 55,  0,  0], M: [44, 26, 1, 44, 0,  0], Q: [34, 18, 2, 17, 0,  0], H: [26, 22, 2, 13, 0,  0] },
    4:  { L: [80, 20,  1, 80,  0,  0], M: [64, 18, 2, 32, 0,  0], Q: [48, 26, 2, 24, 0,  0], H: [36, 16, 4,  9, 0,  0] },
    5:  { L: [108, 26, 1, 108, 0,  0], M: [86, 24, 2, 43, 0,  0], Q: [62, 18, 2, 15, 2, 16], H: [46, 22, 2, 11, 2, 12] },
    6:  { L: [136, 18, 2, 68,  0,  0], M: [108, 16, 4, 27, 0,  0], Q: [76, 24, 4, 19, 0,  0], H: [60, 28, 4, 15, 0,  0] },
    7:  { L: [156, 20, 2, 78,  0,  0], M: [124, 18, 4, 31, 0,  0], Q: [88, 18, 2, 14, 4, 15], H: [66, 26, 4, 13, 1, 14] },
    8:  { L: [194, 24, 2, 97,  0,  0], M: [154, 22, 2, 38, 2, 39], Q: [110, 22, 4, 18, 2, 19], H: [86, 26, 4, 14, 2, 15] },
    9:  { L: [232, 30, 2, 116, 0,  0], M: [182, 22, 3, 36, 2, 37], Q: [132, 20, 4, 16, 4, 17], H: [100, 24, 4, 12, 4, 13] },
    10: { L: [274, 18, 2, 68,  2, 69], M: [216, 26, 4, 43, 1, 44], Q: [154, 24, 6, 19, 2, 20], H: [122, 28, 6, 15, 2, 16] },
  };

  var ALIGN_CENTERS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  var ECC_BITS = { L: 0x1, M: 0x0, Q: 0x3, H: 0x2 };
  var FORMAT_MASK = 0x5412; // 101010000010010

  // ============================================================
  // Encoding
  // ============================================================
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if ((c & 0xFC00) === 0xD800 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xFC00) === 0xDC00) {
        c = 0x10000 + ((c & 0x3FF) << 10) + (str.charCodeAt(++i) & 0x3FF);
        out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function pickVersion(byteLen, eccLevel) {
    for (var v = 1; v <= 10; v++) {
      var totalData = CAPACITY[v][eccLevel][0];
      var ccBits = v <= 9 ? 8 : 16;
      var requiredBits = 4 + ccBits + byteLen * 8 + 4; // mode + count + data + terminator
      var requiredBytes = Math.ceil(requiredBits / 8);
      if (requiredBytes <= totalData) return v;
    }
    throw new Error('QR payload too large for versions 1-10 at ECC ' + eccLevel);
  }

  function buildDataCodewords(bytes, version, eccLevel) {
    var totalData = CAPACITY[version][eccLevel][0];
    var ccBits = version <= 9 ? 8 : 16;
    var bits = [];
    function put(val, n) {
      for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }
    put(0x4, 4); // byte mode
    put(bytes.length, ccBits);
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    // terminator (up to 4 bits)
    var capacityBits = totalData * 8;
    var termLen = Math.min(4, capacityBits - bits.length);
    for (var t = 0; t < termLen; t++) bits.push(0);
    // byte align
    while (bits.length % 8 !== 0) bits.push(0);
    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      data.push(byte);
    }
    var pads = [0xEC, 0x11];
    var pi = 0;
    while (data.length < totalData) {
      data.push(pads[pi++ % 2]);
    }
    return data;
  }

  function interleave(data, version, eccLevel) {
    var cap = CAPACITY[version][eccLevel];
    var eccPerBlock = cap[1];
    var g1n = cap[2], g1d = cap[3];
    var g2n = cap[4], g2d = cap[5];
    var blocks = [];
    var eccBlocks = [];
    var off = 0;
    for (var i = 0; i < g1n; i++) {
      var blk = data.slice(off, off + g1d);
      off += g1d;
      blocks.push(blk);
      eccBlocks.push(rsEcc(blk, eccPerBlock));
    }
    for (var j = 0; j < g2n; j++) {
      var blk2 = data.slice(off, off + g2d);
      off += g2d;
      blocks.push(blk2);
      eccBlocks.push(rsEcc(blk2, eccPerBlock));
    }
    var out = [];
    var maxData = Math.max(g1d, g2d);
    for (var c = 0; c < maxData; c++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (c < blocks[bi].length) out.push(blocks[bi][c]);
      }
    }
    for (var e = 0; e < eccPerBlock; e++) {
      for (var ei = 0; ei < eccBlocks.length; ei++) {
        out.push(eccBlocks[ei][e]);
      }
    }
    return out;
  }

  // ============================================================
  // Matrix
  // ============================================================
  function makeGrid(size, fill) {
    var g = new Array(size);
    for (var r = 0; r < size; r++) {
      g[r] = new Array(size);
      for (var c = 0; c < size; c++) g[r][c] = fill;
    }
    return g;
  }

  function placeFunctionPatterns(matrix, fn, size, version) {
    function setFinder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var r = r0 + dr, c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          var border = dr === -1 || dr === 7 || dc === -1 || dc === 7;
          var outer = (dr === 0 || dr === 6) && dc >= 0 && dc <= 6;
          var side = (dc === 0 || dc === 6) && dr >= 0 && dr <= 6;
          var inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          matrix[r][c] = border ? 0 : (outer || side || inner ? 1 : 0);
          fn[r][c] = true;
        }
      }
    }
    setFinder(0, 0);
    setFinder(0, size - 7);
    setFinder(size - 7, 0);
    // timing patterns
    for (var i = 8; i < size - 8; i++) {
      matrix[6][i] = i % 2 === 0 ? 1 : 0;
      matrix[i][6] = i % 2 === 0 ? 1 : 0;
      fn[6][i] = true;
      fn[i][6] = true;
    }
    // alignment patterns
    var centers = ALIGN_CENTERS[version];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var ra = centers[a], cb = centers[b];
        if (ra === 6 && cb === 6) continue;
        if (ra === 6 && cb === size - 7) continue;
        if (ra === size - 7 && cb === 6) continue;
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            var rr = ra + dr2, cc = cb + dc2;
            var isBorder = Math.abs(dr2) === 2 || Math.abs(dc2) === 2;
            var isCenter = dr2 === 0 && dc2 === 0;
            matrix[rr][cc] = isBorder || isCenter ? 1 : 0;
            fn[rr][cc] = true;
          }
        }
      }
    }
    // dark module
    matrix[size - 8][8] = 1;
    fn[size - 8][8] = true;
    // reserve format info zones (around finders)
    for (var k = 0; k <= 8; k++) {
      fn[8][k] = true;
      fn[k][8] = true;
    }
    for (var m = 0; m < 8; m++) {
      fn[8][size - 1 - m] = true;
      fn[size - 1 - m][8] = true;
    }
    // Version info for v>=7 (18-bit BCH-encoded version, two copies)
    if (version >= 7) {
      var vrem = version;
      for (var vi = 0; vi < 12; vi++) {
        vrem = (vrem << 1) ^ (((vrem >>> 11) & 1) * 0x1F25);
      }
      var vbits = (version << 12) | (vrem & 0xFFF);
      for (var vbi = 0; vbi < 18; vbi++) {
        var bit = (vbits >> vbi) & 1;
        var a = size - 11 + (vbi % 3);
        var b = Math.floor(vbi / 3);
        // (col a, row b) → matrix[b][a]
        matrix[b][a] = bit;
        fn[b][a] = true;
        // (col b, row a) → matrix[a][b]
        matrix[a][b] = bit;
        fn[a][b] = true;
      }
    }
  }

  function placeData(matrix, fn, size, codewords) {
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    function readBit(i) {
      return (codewords[i >> 3] >> (7 - (i & 7))) & 1;
    }
    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var i = 0; i < size; i++) {
        var row = upward ? size - 1 - i : i;
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (fn[row][cc]) continue;
          var bit = bitIndex < totalBits ? readBit(bitIndex) : 0;
          matrix[row][cc] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }
  }

  function applyMask(matrix, fn, size, maskId) {
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (fn[r][c]) continue;
        var invert = false;
        switch (maskId) {
          case 0: invert = (r + c) % 2 === 0; break;
          case 1: invert = r % 2 === 0; break;
          case 2: invert = c % 3 === 0; break;
          case 3: invert = (r + c) % 3 === 0; break;
          case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
          case 5: invert = (r * c) % 2 + (r * c) % 3 === 0; break;
          case 6: invert = ((r * c) % 2 + (r * c) % 3) % 2 === 0; break;
          case 7: invert = ((r + c) % 2 + (r * c) % 3) % 2 === 0; break;
        }
        if (invert) matrix[r][c] ^= 1;
      }
    }
  }

  function computePenalty(matrix, size) {
    var pen = 0;
    // rule 1 — runs of 5+
    for (var r = 0; r < size; r++) {
      var run = 1;
      for (var c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c - 1]) {
          run++;
          if (run === 5) pen += 3;
          else if (run > 5) pen += 1;
        } else run = 1;
      }
    }
    for (var c2 = 0; c2 < size; c2++) {
      var run2 = 1;
      for (var r2 = 1; r2 < size; r2++) {
        if (matrix[r2][c2] === matrix[r2 - 1][c2]) {
          run2++;
          if (run2 === 5) pen += 3;
          else if (run2 > 5) pen += 1;
        } else run2 = 1;
      }
    }
    // rule 2 — 2x2 same
    for (var r3 = 0; r3 < size - 1; r3++) {
      for (var c3 = 0; c3 < size - 1; c3++) {
        var v = matrix[r3][c3];
        if (matrix[r3][c3 + 1] === v && matrix[r3 + 1][c3] === v && matrix[r3 + 1][c3 + 1] === v) pen += 3;
      }
    }
    // rule 3 — 1011101 patterns
    var pat = [1, 0, 1, 1, 1, 0, 1];
    function matchRow(rr, cc) {
      for (var k = 0; k < 7; k++) if (matrix[rr][cc + k] !== pat[k]) return false;
      return true;
    }
    function matchCol(rr, cc) {
      for (var k = 0; k < 7; k++) if (matrix[rr + k][cc] !== pat[k]) return false;
      return true;
    }
    for (var r4 = 0; r4 < size; r4++) {
      for (var c4 = 0; c4 <= size - 7; c4++) {
        if (!matchRow(r4, c4)) continue;
        var leftZeros = c4 >= 4;
        var rightZeros = c4 + 7 + 4 <= size;
        if (leftZeros) {
          var ok = true;
          for (var z = 1; z <= 4; z++) if (matrix[r4][c4 - z] !== 0) { ok = false; break; }
          if (ok) pen += 40;
        }
        if (rightZeros) {
          var ok2 = true;
          for (var z2 = 0; z2 < 4; z2++) if (matrix[r4][c4 + 7 + z2] !== 0) { ok2 = false; break; }
          if (ok2) pen += 40;
        }
      }
    }
    for (var c5 = 0; c5 < size; c5++) {
      for (var r5 = 0; r5 <= size - 7; r5++) {
        if (!matchCol(r5, c5)) continue;
        var topZeros = r5 >= 4;
        var botZeros = r5 + 7 + 4 <= size;
        if (topZeros) {
          var ok3 = true;
          for (var z3 = 1; z3 <= 4; z3++) if (matrix[r5 - z3][c5] !== 0) { ok3 = false; break; }
          if (ok3) pen += 40;
        }
        if (botZeros) {
          var ok4 = true;
          for (var z4 = 0; z4 < 4; z4++) if (matrix[r5 + 7 + z4][c5] !== 0) { ok4 = false; break; }
          if (ok4) pen += 40;
        }
      }
    }
    // rule 4 — dark ratio
    var dark = 0;
    for (var rr2 = 0; rr2 < size; rr2++) for (var cc2 = 0; cc2 < size; cc2++) if (matrix[rr2][cc2]) dark++;
    var ratio = (dark * 100) / (size * size);
    pen += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return pen;
  }

  function placeFormat(matrix, size, eccLevel, maskId) {
    var data = (ECC_BITS[eccLevel] << 3) | maskId;
    var rem = data << 10;
    for (var i = 14; i >= 10; i--) {
      if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    }
    var fmt = (((data << 10) | (rem & 0x3FF)) ^ FORMAT_MASK) & 0x7FFF;
    // First copy near top-left finder (per ISO/IEC 18004 §8.9 / Annex E Figure 25):
    // bits 0..5 → col 8, rows 0..5
    // bit 6      → col 8, row 7 (skip timing row 6)
    // bit 7      → col 8, row 8
    // bit 8      → col 7, row 8 (skip timing col 6)
    // bits 9..14 → col (5..0), row 8
    for (var k = 0; k <= 5; k++) matrix[k][8] = (fmt >> k) & 1;
    matrix[7][8] = (fmt >> 6) & 1;
    matrix[8][8] = (fmt >> 7) & 1;
    matrix[8][7] = (fmt >> 8) & 1;
    for (var j = 0; j < 6; j++) matrix[8][5 - j] = (fmt >> (9 + j)) & 1;
    // Second copy (bottom-left vertical + top-right horizontal):
    // bits 0..7   → row 8, cols (size-1..size-8) (top-right horizontal)
    // bits 8..14  → col 8, rows (size-7..size-1) (bottom-left vertical)
    for (var b = 0; b < 8; b++) matrix[8][size - 1 - b] = (fmt >> b) & 1;
    for (var t = 8; t < 15; t++) matrix[size - 15 + t][8] = (fmt >> t) & 1;
    matrix[size - 8][8] = 1; // dark module always set
  }

  // ============================================================
  // Public API
  // ============================================================
  function generate(text, opts) {
    opts = opts || {};
    var eccLevel = opts.ecc || 'M';
    if (!ECC_BITS.hasOwnProperty(eccLevel)) throw new Error('Invalid ECC level: ' + eccLevel);
    var bytes = utf8Bytes(String(text));
    var version = pickVersion(bytes.length, eccLevel);
    var size = version * 4 + 17;
    var dataCw = buildDataCodewords(bytes, version, eccLevel);
    var codewords = interleave(dataCw, version, eccLevel);
    var fn = makeGrid(size, false);
    var base = makeGrid(size, 0);
    placeFunctionPatterns(base, fn, size, version);
    placeData(base, fn, size, codewords);
    var best = null;
    var bestPenalty = Infinity;
    for (var m = 0; m < 8; m++) {
      var copy = new Array(size);
      for (var r = 0; r < size; r++) copy[r] = base[r].slice();
      applyMask(copy, fn, size, m);
      placeFormat(copy, size, eccLevel, m);
      var pen = computePenalty(copy, size);
      if (pen < bestPenalty) {
        bestPenalty = pen;
        best = copy;
      }
    }
    return { matrix: best, size: size, version: version, eccLevel: eccLevel };
  }

  function toSVG(text, opts) {
    opts = opts || {};
    var result = generate(text, opts);
    var matrix = result.matrix;
    var size = result.size;
    var scale = opts.scale || 4;
    var margin = opts.margin == null ? 4 : opts.margin;
    var dim = (size + margin * 2) * scale;
    var bg = opts.background || '#ffffff';
    var fg = opts.foreground || '#0f1419';
    var path = '';
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (matrix[r][c]) {
          var x = (c + margin) * scale;
          var y = (r + margin) * scale;
          path += 'M' + x + ' ' + y + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code: ' +
      String(text).replace(/[<>&"']/g, '') +
      '"><rect width="' + dim + '" height="' + dim + '" fill="' + bg + '"/>' +
      '<path d="' + path + '" fill="' + fg + '"/></svg>';
  }

  root.QRCode = { generate: generate, toSVG: toSVG };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
