/* Minimal QR Code generator — canvas-based, zero dependencies
   Based on https://github.com/nicedoc/qr — simplified for Docker Dash
   Generates QR codes for otpauth:// URIs (MFA enrollment) */
'use strict';

const QR = (() => {
  // QR code data encoding (numeric, alphanumeric, byte)
  const EC_L = 1;

  // Polynomial and Galois field math for Reed-Solomon error correction
  const GF256 = (() => {
    const exp = new Uint8Array(512);
    const log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
    return { exp, log };
  })();

  function polyMul(a, b) {
    const result = new Uint8Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++)
        result[i + j] ^= GF256.exp[(GF256.log[a[i]] + GF256.log[b[j]]) % 255];
    return result;
  }

  function rsEncode(data, ecLen) {
    let gen = new Uint8Array([1]);
    for (let i = 0; i < ecLen; i++)
      gen = polyMul(gen, new Uint8Array([1, GF256.exp[i]]));
    const msg = new Uint8Array(data.length + ecLen);
    msg.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0)
        for (let j = 0; j < gen.length; j++)
          msg[i + j] ^= GF256.exp[(GF256.log[gen[j]] + GF256.log[coef]) % 255];
    }
    return msg.slice(data.length);
  }

  // Version/capacity tables for byte mode, EC level L
  const VERSIONS = [
    { v: 1, cap: 17, ecPerBlock: 7, blocks: 1, dataPerBlock: 19 },
    { v: 2, cap: 32, ecPerBlock: 10, blocks: 1, dataPerBlock: 34 },
    { v: 3, cap: 53, ecPerBlock: 15, blocks: 1, dataPerBlock: 55 },
    { v: 4, cap: 78, ecPerBlock: 20, blocks: 1, dataPerBlock: 80 },
    { v: 5, cap: 106, ecPerBlock: 26, blocks: 1, dataPerBlock: 108 },
    { v: 6, cap: 134, ecPerBlock: 18, blocks: 2, dataPerBlock: 68 },
    { v: 7, cap: 154, ecPerBlock: 20, blocks: 2, dataPerBlock: 78 },
    { v: 8, cap: 192, ecPerBlock: 24, blocks: 2, dataPerBlock: 97 },
    { v: 9, cap: 230, ecPerBlock: 30, blocks: 2, dataPerBlock: 116 },
    { v: 10, cap: 271, ecPerBlock: 18, blocks: 2, dataPerBlock: 68 },
  ];

  function selectVersion(len) {
    for (const v of VERSIONS) if (len <= v.cap) return v;
    return VERSIONS[VERSIONS.length - 1]; // fallback
  }

  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    const ver = selectVersion(bytes.length);
    const totalData = ver.blocks * ver.dataPerBlock;

    // Mode indicator (0100 = byte) + character count
    const bits = [];
    const pushBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    pushBits(0b0100, 4); // Byte mode
    pushBits(bytes.length, ver.v >= 10 ? 16 : 8); // Character count

    for (const b of bytes) pushBits(b, 8);
    pushBits(0, 4); // Terminator

    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Pad to total capacity
    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (bits.length < totalData * 8) {
      pushBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    // Convert bits to bytes
    const dataBytes = new Uint8Array(totalData);
    for (let i = 0; i < totalData; i++) {
      let byte = 0;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i * 8 + b] || 0);
      dataBytes[i] = byte;
    }

    // Split into blocks and add EC
    const blockSize = ver.dataPerBlock;
    const allData = [];
    const allEc = [];
    for (let i = 0; i < ver.blocks; i++) {
      const block = dataBytes.slice(i * blockSize, (i + 1) * blockSize);
      allData.push(block);
      allEc.push(rsEncode(block, ver.ecPerBlock));
    }

    // Interleave
    const result = [];
    const maxData = Math.max(...allData.map(b => b.length));
    for (let i = 0; i < maxData; i++)
      for (const block of allData) if (i < block.length) result.push(block[i]);
    const maxEc = Math.max(...allEc.map(b => b.length));
    for (let i = 0; i < maxEc; i++)
      for (const block of allEc) if (i < block.length) result.push(block[i]);

    return { data: result, version: ver.v };
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const matrix = Array.from({ length: size }, () => new Uint8Array(size));
    const reserved = Array.from({ length: size }, () => new Uint8Array(size));

    // Finder patterns
    const drawFinder = (r, c) => {
      for (let dr = -1; dr <= 7; dr++)
        for (let dc = -1; dc <= 7; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inOuter = dr === -1 || dr === 7 || dc === -1 || dc === 7;
          const inRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          matrix[rr][cc] = (!inOuter && (inRing || inCore)) ? 1 : 0;
          reserved[rr][cc] = 1;
        }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      matrix[6][i] = matrix[i][6] = (i % 2 === 0) ? 1 : 0;
      reserved[6][i] = reserved[i][6] = 1;
    }

    // Dark module
    matrix[size - 8][8] = 1;
    reserved[size - 8][8] = 1;

    // Reserve format info areas
    for (let i = 0; i < 9; i++) {
      reserved[8][i] = reserved[i][8] = 1;
      if (i < 8) { reserved[8][size - 1 - i] = 1; reserved[size - 1 - i][8] = 1; }
    }

    // Alignment patterns (version 2+)
    if (version >= 2) {
      const pos = [6, size - 7];
      if (version >= 7) pos.splice(1, 0, Math.round((6 + size - 7) / 2));
      for (const r of pos) for (const c of pos) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            matrix[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
            reserved[r + dr][c + dc] = 1;
          }
      }
    }

    return { matrix, reserved, size };
  }

  function placeData(matrix, reserved, size, data) {
    let bitIdx = 0;
    const totalBits = data.length * 8;
    let upward = true;

    for (let col = size - 1; col >= 0; col -= 2) {
      if (col === 6) col = 5; // Skip timing column
      const rows = upward ? Array.from({ length: size }, (_, i) => size - 1 - i) : Array.from({ length: size }, (_, i) => i);
      for (const row of rows) {
        for (let dc = 0; dc <= 1; dc++) {
          const c = col - dc;
          if (c < 0 || reserved[row][c]) continue;
          if (bitIdx < totalBits) {
            const byteIdx = Math.floor(bitIdx / 8);
            const bitPos = 7 - (bitIdx % 8);
            matrix[row][c] = (data[byteIdx] >> bitPos) & 1;
            bitIdx++;
          }
        }
      }
      upward = !upward;
    }
  }

  function applyMask(matrix, reserved, size) {
    // Mask 0: (row + col) % 2 === 0
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!reserved[r][c] && (r + c) % 2 === 0)
          matrix[r][c] ^= 1;

    // Write format info for mask 0, EC level L
    const formatBits = 0b111011111000100; // Pre-computed for L, mask 0
    for (let i = 0; i < 15; i++) {
      const bit = (formatBits >> (14 - i)) & 1;
      // Horizontal
      const hc = i < 8 ? (i < 6 ? i : i + 1) : size - 15 + i;
      matrix[8][hc] = bit;
      // Vertical
      const vr = i < 8 ? (i < 6 ? size - 1 - i : size - i) : 14 - i < 6 ? 14 - i : 15 - i;
      matrix[vr][8] = bit;
    }
  }

  function render(canvas, text, moduleSize = 4) {
    const { data, version } = encodeData(text);
    const { matrix, reserved, size } = createMatrix(version);
    placeData(matrix, reserved, size, data);
    applyMask(matrix, reserved, size);

    const quiet = 4; // Quiet zone
    const totalSize = (size + quiet * 2) * moduleSize;
    canvas.width = totalSize;
    canvas.height = totalSize;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalSize, totalSize);
    ctx.fillStyle = '#000000';

    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (matrix[r][c])
          ctx.fillRect((c + quiet) * moduleSize, (r + quiet) * moduleSize, moduleSize, moduleSize);
  }

  return { render };
})();

window.QR = QR;
