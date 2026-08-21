// Minimal ZIP writer. No dependency and no shell-out: `zip` is absent on Windows and
// PowerShell's Compress-Archive would pin the build to one platform, so the archive is
// assembled here from zlib's raw deflate.
//
// Deliberately supports only what a release needs: a flat set of deflated files, no
// directories, no zip64, no encryption. Anything larger than 4 GB or 65535 files throws
// rather than emitting a silently-truncated archive.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS packed date/time — 2-second resolution, and the epoch is 1980, so anything
// earlier is clamped rather than wrapping into a nonsense year.
function dosStamp(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a ZIP archive in memory.
 * @param {Array<{name: string, data: Buffer, mtime?: Date}>} entries flat file list
 * @returns {Buffer} the complete archive
 */
export function zipSync(entries) {
  if (entries.length > 0xffff) throw new Error('too many entries for a non-zip64 archive');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, mtime } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Store the raw bytes when deflate makes them bigger — true for already-compressed
    // payloads, and a 'compressed' entry larger than its source is just waste.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    if (data.length > 0xffffffff || body.length > 0xffffffff) {
      throw new Error(`${name} exceeds the 4 GB non-zip64 limit`);
    }
    const crc = crc32(data);
    const { time, date } = dosStamp(mtime || new Date());

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra field length
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);          // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    // Regular file, mode 0644. The >>>0 matters: `<<` yields a *signed* 32-bit int and
    // this value has bit 31 set, so without it writeUInt32LE gets a negative number.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);    // offset of the local header
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with the central directory
  end.writeUInt16LE(entries.length, 8);   // entries on this disk
  end.writeUInt16LE(entries.length, 10);  // entries total
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);          // central directory offset
  end.writeUInt16LE(0, 20);               // comment length
  return Buffer.concat([...locals, cd, end]);
}
