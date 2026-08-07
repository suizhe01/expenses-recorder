import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * EXP-13 / AC-3 — the four accepted formats, recognised by their own signature
 * bytes rather than by what the client claims.
 *
 * Written by hand rather than pulling in a detection library: four formats is
 * a short, testable list, and NG-4 rules out anything with a native component.
 */
export const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export type AcceptedType = (typeof ACCEPTED_TYPES)[number];

/** Enough bytes to cover the longest signature we check (HEIC's ftyp brand). */
const SIGNATURE_BYTES = 16;

/** ISO-BMFF brands that mean HEIF/HEIC still imagery. */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/**
 * AC-3. Returns the real type of `head`, or null when the bytes are not one of
 * the four accepted formats.
 *
 * The declared `Content-Type` is never consulted. A client can put anything in
 * that header, and this archive's whole value is that what it holds is what it
 * says it holds.
 */
export function detectImageType(head: Buffer): AcceptedType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'image/png';
  }

  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  // ISO base media format: a length prefix, then 'ftyp', then the brand.
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    if (HEIF_BRANDS.has(head.subarray(8, 12).toString('latin1'))) {
      return 'image/heic';
    }
  }

  return null;
}

/**
 * AC-16. Creates the storage root if it is absent and proves it is writable,
 * so the process never starts in a state where uploads would fail later at
 * request time — the same fail-fast contract config validation already has.
 */
export async function ensureStorageReady(root: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw new Error(
      `RECEIPTS_PATH (${root}) could not be created: ${(error as Error).message}`,
    );
  }

  try {
    await access(root, constants.W_OK);
  } catch {
    throw new Error(`RECEIPTS_PATH (${root}) exists but is not writable`);
  }
}

export type StoredFile = {
  sha256: string;
  byteSize: number;
  contentType: AcceptedType;
  /** Absolute path of the temporary file, still awaiting `commitFile`. */
  tempPath: string;
};

export type StoreFailure =
  | { status: 'too-large' }
  | { status: 'unsupported-type' }
  | { status: 'empty' };

export type StoreResult = { status: 'stored'; file: StoredFile } | StoreFailure;

export function userDirectory(root: string, userId: string): string {
  return join(root, userId);
}

export function filePath(root: string, userId: string, sha256: string): string {
  return join(userDirectory(root, userId), sha256);
}

/**
 * Streams `source` to a temporary file inside the user's directory, hashing and
 * measuring as it goes.
 *
 * AC-5: the bytes land under a temporary name and are only moved into place by
 * `commitFile`, after the stream has completed and been accepted. Writing
 * straight to `<sha256>` would mean an interrupted upload leaves a truncated
 * file under the name of a complete one — and deduplication would then hand
 * that corrupt file back forever, silently.
 *
 * On any rejection the temporary file is removed before returning, so a
 * refused upload leaves nothing behind (AC-3, AC-4).
 */
export async function storeUpload(
  root: string,
  userId: string,
  source: Readable,
  maxBytes: number,
): Promise<StoreResult> {
  const directory = userDirectory(root, userId);
  await mkdir(directory, { recursive: true });

  const tempPath = join(directory, `.tmp-${randomBytes(16).toString('hex')}`);

  const hash = createHash('sha256');
  let byteSize = 0;
  let head = Buffer.alloc(0);
  let tooLarge = false;

  try {
    await pipeline(
      source,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          byteSize += chunk.length;

          if (byteSize > maxBytes) {
            tooLarge = true;
            // Stop consuming immediately rather than writing the rest of a
            // file that is already going to be refused.
            return;
          }

          if (head.length < SIGNATURE_BYTES) {
            head = Buffer.concat([head, chunk]).subarray(0, SIGNATURE_BYTES);
          }

          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tempPath),
    );
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  if (tooLarge) {
    await rm(tempPath, { force: true });
    return { status: 'too-large' };
  }

  if (byteSize === 0) {
    await rm(tempPath, { force: true });
    return { status: 'empty' };
  }

  const contentType = detectImageType(head);

  if (!contentType) {
    await rm(tempPath, { force: true });
    return { status: 'unsupported-type' };
  }

  return {
    status: 'stored',
    file: { sha256: hash.digest('hex'), byteSize, contentType, tempPath },
  };
}

/**
 * AC-5. Moves an accepted temporary file to its final `<sha256>` name.
 *
 * `rename` is atomic within a filesystem, so a reader never observes a partial
 * file under the final name. If the target already exists the contents are by
 * definition identical — the name is the hash of the contents — so overwriting
 * is safe and is what makes AC-7's file reuse work.
 */
export async function commitFile(
  root: string,
  userId: string,
  file: StoredFile,
): Promise<void> {
  await rename(file.tempPath, filePath(root, userId, file.sha256));
}

/** Discards an accepted-but-unneeded temporary file, e.g. on a duplicate. */
export async function discardFile(file: StoredFile): Promise<void> {
  await rm(file.tempPath, { force: true });
}
