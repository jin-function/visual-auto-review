const encoder = new TextEncoder();
const table = Uint32Array.from({length: 256}, (_, number) => {
    let value = number;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
export function crc32(bytes) {
    let result = 0xffffffff;
    for (const byte of bytes) result = table[(result ^ byte) & 255] ^ (result >>> 8);
    return (result ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
    const chunks = [], directory = [], names = new Set();
    let offset = 0, directorySize = 0;
    for (const file of files) {
        if (names.has(file.name) || file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('내보낼 파일 경로가 올바르지 않습니다.');
        names.add(file.name);
        const name = encoder.encode(file.name), bytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
        if (name.length > 65535 || bytes.length > 128 * 1024 * 1024 || offset + bytes.length > 300 * 1024 * 1024 || names.size > 6000) throw new Error('내보낼 파일이 너무 큽니다.');
        const crc = crc32(bytes), local = new Uint8Array(30), lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
        lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true);
        lv.setUint32(22, bytes.length, true); lv.setUint16(26, name.length, true);
        chunks.push(local, name, bytes);
        const central = new Uint8Array(46), cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
        cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
        cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
        directory.push(central, name); directorySize += central.length + name.length;
        offset += local.length + name.length + bytes.length;
    }
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, names.size, true); ev.setUint16(10, names.size, true);
    ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
    return new Blob([...chunks, ...directory, end], {type: 'application/zip'});
}
