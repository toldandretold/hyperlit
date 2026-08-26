/**
 * Minimal PNG encoder for scroll-restore fixtures.
 *
 * Produces solid-colour RGB PNGs at arbitrary declared dimensions: a few KB
 * on the wire (solid colour deflates to nothing) that decode to a LARGE
 * image — the exact primitive for layout shift when a node renders
 * `<img src>` with no width/height attributes (img{max-width:100%;
 * height:auto} reserves ~zero height until decode).
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {Object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {[number, number, number]} [opts.rgb] fill colour
 * @returns {Buffer} valid PNG bytes
 */
export function makePng({ width, height, rgb = [196, 40, 40] }) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour RGB

  const rowLen = width * 3 + 1;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: none
    // Horizontal stripes so decode problems are visible in screenshots.
    const shade = (Math.floor(y / 40) % 2) === 0 ? 1 : 0.7;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = Math.min(255, Math.round(rgb[0] * shade));
      raw[p + 1] = Math.min(255, Math.round(rgb[1] * shade));
      raw[p + 2] = Math.min(255, Math.round(rgb[2] * shade));
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
