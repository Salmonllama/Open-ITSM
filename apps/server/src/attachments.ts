import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Ticket attachments on the attachments volume, never in the database. Files are named by a
 * random ID under year/month folders; the database row holds the original name.
 */
export class AttachmentStore {
  readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  /** Writes a file and returns its key and SHA-256. The write is atomic (temp, then rename). */
  async save(data: Buffer): Promise<{ key: string; sha256: string }> {
    const now = new Date();
    const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${folder}/${randomUUID()}`;
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.part`;
    await writeFile(temp, data, { mode: 0o640 });
    await rename(temp, file);
    return { key, sha256: createHash('sha256').update(data).digest('hex') };
  }

  read(key: string) {
    return createReadStream(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /** Keys come from the database, but a path outside the folder is refused all the same. */
  private resolve(key: string): string {
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep))
      throw new Error('attachment key escapes its folder');
    return file;
  }
}

/** A file name safe to store and show: no folders, control characters or reserved characters. */
export function cleanFileName(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .trim()
    .slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : 'attachment';
}

/** A Content-Disposition header that downloads the file under its name in any browser. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
