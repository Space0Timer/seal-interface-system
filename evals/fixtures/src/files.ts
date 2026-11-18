// Writes the upload batch to disk as sparse files of the exact sizes, so the
// 112 MB file costs no real disk space.
import { closeSync, ftruncateSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPLACEMENT_FILE, UPLOAD_BATCH, type UploadFile } from './data.ts';

function writeSparse(dir: string, file: UploadFile): string {
  const path = join(dir, file.filename);
  try {
    if (statSync(path).size === file.sizeBytes) return path;
  } catch {
    // Missing: create it below.
  }
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, file.sizeBytes);
  } finally {
    closeSync(fd);
  }
  return path;
}

export interface UploadFilePaths {
  batch: string[];
  replacement: string;
}

/** Idempotent. Returns absolute paths in UPLOAD_BATCH order. */
export function writeUploadFiles(dir: string): UploadFilePaths {
  mkdirSync(dir, { recursive: true });
  return {
    batch: UPLOAD_BATCH.map((file) => writeSparse(dir, file)),
    replacement: writeSparse(dir, REPLACEMENT_FILE),
  };
}
