import fs from "node:fs";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const MAX_END_RECORD_SEARCH = 65_557;

export interface ZipCompletionInspection {
  valid: boolean;
  reason: string | null;
}

function invalid(reason: string): ZipCompletionInspection {
  return { valid: false, reason };
}

function safeNumber(value: bigint) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function inspectZipCompletion(filePath: string): ZipCompletionInspection {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const size = fs.fstatSync(descriptor).size;
    if (size < 4) {
      return invalid("ZIP header is missing or invalid.");
    }

    const first = Buffer.alloc(4);
    fs.readSync(descriptor, first, 0, first.length, 0);
    const firstSignature = first.readUInt32LE(0);
    if (firstSignature !== LOCAL_FILE_HEADER && firstSignature !== END_OF_CENTRAL_DIRECTORY) {
      return invalid("ZIP header is missing or invalid.");
    }

    const tailSize = Math.min(size, MAX_END_RECORD_SEARCH);
    const tailOffset = size - tailSize;
    const tail = Buffer.alloc(tailSize);
    fs.readSync(descriptor, tail, 0, tail.length, tailOffset);

    let endOffsetInTail = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) {
        continue;
      }
      const commentLength = tail.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === tail.length) {
        endOffsetInTail = offset;
        break;
      }
    }

    if (endOffsetInTail < 0) {
      return invalid("End of ZIP central directory is missing. The download is incomplete.");
    }

    const endOffset = tailOffset + endOffsetInTail;
    const diskNumber = tail.readUInt16LE(endOffsetInTail + 4);
    const centralDisk = tail.readUInt16LE(endOffsetInTail + 6);
    const entriesOnDisk = tail.readUInt16LE(endOffsetInTail + 8);
    const totalEntries = tail.readUInt16LE(endOffsetInTail + 10);
    const centralSize = tail.readUInt32LE(endOffsetInTail + 12);
    const centralOffset = tail.readUInt32LE(endOffsetInTail + 16);

    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
      return invalid("Multi-part ZIP metadata is incomplete or unsupported.");
    }

    const usesZip64 = totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
    let resolvedEntries = totalEntries;
    let resolvedCentralSize = centralSize;
    let resolvedCentralOffset = centralOffset;
    let centralBoundary = endOffset;

    if (usesZip64) {
      const locatorOffset = endOffset - 20;
      if (locatorOffset < 0) {
        return invalid("ZIP64 end locator is missing. The download is incomplete.");
      }
      const locator = Buffer.alloc(20);
      fs.readSync(descriptor, locator, 0, locator.length, locatorOffset);
      if (locator.readUInt32LE(0) !== ZIP64_END_LOCATOR) {
        return invalid("ZIP64 end locator is missing. The download is incomplete.");
      }
      const zip64EndOffset = safeNumber(locator.readBigUInt64LE(8));
      if (zip64EndOffset === null || zip64EndOffset < 0 || zip64EndOffset + 56 > locatorOffset) {
        return invalid("ZIP64 central directory metadata is invalid.");
      }
      const zip64End = Buffer.alloc(56);
      fs.readSync(descriptor, zip64End, 0, zip64End.length, zip64EndOffset);
      if (zip64End.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
        return invalid("ZIP64 end record is missing. The download is incomplete.");
      }
      const zip64Entries = safeNumber(zip64End.readBigUInt64LE(32));
      const zip64CentralSize = safeNumber(zip64End.readBigUInt64LE(40));
      const zip64CentralOffset = safeNumber(zip64End.readBigUInt64LE(48));
      if (zip64Entries === null || zip64CentralSize === null || zip64CentralOffset === null) {
        return invalid("ZIP64 central directory is too large to validate safely.");
      }
      resolvedEntries = zip64Entries;
      resolvedCentralSize = zip64CentralSize;
      resolvedCentralOffset = zip64CentralOffset;
      centralBoundary = zip64EndOffset;
    }

    if (resolvedCentralOffset + resolvedCentralSize > centralBoundary) {
      return invalid("ZIP central directory is truncated or points outside the file.");
    }
    if (resolvedEntries > 0) {
      const signature = Buffer.alloc(4);
      fs.readSync(descriptor, signature, 0, signature.length, resolvedCentralOffset);
      if (signature.readUInt32LE(0) !== CENTRAL_DIRECTORY_HEADER) {
        return invalid("ZIP central directory entries are missing or invalid.");
      }
    }

    return { valid: true, reason: null };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
  }
}
