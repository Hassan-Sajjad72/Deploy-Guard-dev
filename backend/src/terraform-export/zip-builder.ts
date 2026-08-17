const table = (() => { const values: number[] = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; values[n] = c >>> 0; } return values; })();
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
export function buildDeterministicZip(files: Array<{ path: string; content: Buffer }>) {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = Buffer.from(file.path.replace(/\\/g, "/")); const crc = crc32(file.content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(file.content.length, 18); local.writeUInt32LE(file.content.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, file.content);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(file.content.length, 20); directory.writeUInt32LE(file.content.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name); offset += local.length + name.length + file.content.length;
  }
  const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, centralBuffer, end]);
}
