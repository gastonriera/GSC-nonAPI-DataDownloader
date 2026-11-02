/**
 * Lightweight, zero-dependency ZIP archive writer for browser environments.
 * Implements standard PKZIP 2.0 format (STORE method) compatible with
 * Windows Explorer, macOS Archive Utility, 7-Zip, WinRAR, and Linux unzip.
 */
(function(global) {
  'use strict';

  // Precomputed CRC32 lookup table
  const CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC_TABLE[i] = c >>> 0;
  }

  function crc32(uint8Array) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < uint8Array.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ uint8Array[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dateToDos(date) {
    const d = date || new Date();
    const year = d.getFullYear();
    const dosYear = year >= 1980 ? year - 1980 : 0;
    const dosDate = (dosYear << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    return { dosDate, dosTime };
  }

  class ZipWriter {
    constructor() {
      this.files = [];
    }

    /**
     * Add a file to the ZIP archive.
     * @param {string} filename - Path or name inside zip (e.g. "crawl_stats.csv")
     * @param {string|Uint8Array} content - File content (string or Uint8Array)
     */
    addFile(filename, content) {
      let dataBytes;
      if (typeof content === 'string') {
        const encoder = new TextEncoder();
        dataBytes = encoder.encode(content);
      } else if (content instanceof Uint8Array) {
        dataBytes = content;
      } else {
        throw new Error('Content must be a string or Uint8Array');
      }

      const encoder = new TextEncoder();
      const nameBytes = encoder.encode(filename.replace(/\\/g, '/'));
      const checksum = crc32(dataBytes);
      const { dosDate, dosTime } = dateToDos(new Date());

      this.files.push({
        filename,
        nameBytes,
        dataBytes,
        checksum,
        dosDate,
        dosTime,
        size: dataBytes.length
      });

      return this;
    }

    /**
     * Generate the complete ZIP file as a Blob.
     * @returns {Blob}
     */
    generateBlob() {
      const localHeaders = [];
      const centralHeaders = [];
      let currentOffset = 0;

      // 1. Build Local File Headers & Data
      for (const file of this.files) {
        file.localHeaderOffset = currentOffset;

        // Local header size: 30 bytes + name length
        const localHeader = new Uint8Array(30 + file.nameBytes.length);
        const view = new DataView(localHeader.buffer);

        view.setUint32(0, 0x04034b50, true);  // Local header signature
        view.setUint16(4, 20, true);          // Version needed (2.0)
        view.setUint16(6, 0x0800, true);      // UTF-8 filename flag
        view.setUint16(8, 0, true);           // Compression: 0 (Store)
        view.setUint16(10, file.dosTime, true);
        view.setUint16(12, file.dosDate, true);
        view.setUint32(14, file.checksum, true);
        view.setUint32(18, file.size, true);  // Compressed size
        view.setUint32(22, file.size, true);  // Uncompressed size
        view.setUint16(26, file.nameBytes.length, true);
        view.setUint16(28, 0, true);          // Extra field length

        localHeader.set(file.nameBytes, 30);

        localHeaders.push(localHeader);
        localHeaders.push(file.dataBytes);

        currentOffset += localHeader.length + file.dataBytes.length;
      }

      const centralDirStartOffset = currentOffset;
      let centralDirSize = 0;

      // 2. Build Central Directory Headers
      for (const file of this.files) {
        // Central header size: 46 bytes + name length
        const centralHeader = new Uint8Array(46 + file.nameBytes.length);
        const view = new DataView(centralHeader.buffer);

        view.setUint32(0, 0x02014b50, true);  // Central directory signature
        view.setUint16(4, 0x0314, true);      // Version made by: Unix 2.0
        view.setUint16(6, 20, true);          // Version needed: 2.0
        view.setUint16(8, 0x0800, true);      // UTF-8 filename flag
        view.setUint16(10, 0, true);          // Compression: 0 (Store)
        view.setUint16(12, file.dosTime, true);
        view.setUint16(14, file.dosDate, true);
        view.setUint32(16, file.checksum, true);
        view.setUint32(20, file.size, true);  // Compressed size
        view.setUint32(24, file.size, true);  // Uncompressed size
        view.setUint16(28, file.nameBytes.length, true);
        view.setUint16(30, 0, true);          // Extra field length
        view.setUint16(32, 0, true);          // File comment length
        view.setUint16(34, 0, true);          // Disk number start
        view.setUint16(36, 0, true);          // Internal file attributes
        view.setUint32(38, 0x81A40000, true); // External attributes (regular file rw-r--r--)
        view.setUint32(42, file.localHeaderOffset, true); // Offset of local header

        centralHeader.set(file.nameBytes, 46);

        centralHeaders.push(centralHeader);
        centralDirSize += centralHeader.length;
      }

      // 3. Build End of Central Directory Record (EOCD: 22 bytes)
      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);

      eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
      eocdView.setUint16(4, 0, true);          // Number of this disk
      eocdView.setUint16(6, 0, true);          // Disk where central dir starts
      eocdView.setUint16(8, this.files.length, true);  // Number of records on this disk
      eocdView.setUint16(10, this.files.length, true); // Total number of records
      eocdView.setUint32(12, centralDirSize, true);     // Size of central directory
      eocdView.setUint32(16, centralDirStartOffset, true); // Offset of central directory
      eocdView.setUint16(20, 0, true);         // Comment length

      // 4. Combine all chunks into a single Blob
      const allChunks = [...localHeaders, ...centralHeaders, eocd];
      return new Blob(allChunks, { type: 'application/zip' });
    }
  }

  // Export to global scope (works in Content Script, Service Worker, and Popup)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ZipWriter };
  } else {
    global.ZipWriter = ZipWriter;
  }
})(typeof self !== 'undefined' ? self : this);
