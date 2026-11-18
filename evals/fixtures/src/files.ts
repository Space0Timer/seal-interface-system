// Writes the upload files to disk as sparse files of the exact sizes, so the
// 112 MB file costs no real disk space.
//
//   <root>/upload-files/        the 12-file batch: select all of it at once
//   <root>/replacement-files/   the valid replacement for the oversized file
//
// The replacement lives in its own folder so "select everything in
// upload-files/" always produces the same 12-file batch.
import { closeSync, ftruncateSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPLACEMENT_FILE, UPLOAD_BATCH, type UploadFile } from './data.ts';

function writeSparse(dir: string, file: UploadFile): string {
  mkdirSync(dir, { recursive: true });
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
  batchDir: string;
  batch: string[];
  replacementDir: string;
  replacement: string;
}

/** Idempotent. `batch` is in UPLOAD_BATCH order. */
export function writeUploadFiles(root: string): UploadFilePaths {
  const batchDir = join(root, 'upload-files');
  const replacementDir = join(root, 'replacement-files');
  return {
    batchDir,
    batch: UPLOAD_BATCH.map((file) => writeSparse(batchDir, file)),
    replacementDir,
    replacement: writeSparse(replacementDir, REPLACEMENT_FILE),
  };
}
