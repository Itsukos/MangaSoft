import fs from 'node:fs/promises';
import path from 'node:path';
import StreamZip from 'node-stream-zip';

export const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
export const ARCHIVE_RE = /\.(cbz|zip)$/i;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
};
export const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

const usableEntry = (name) => {
  const base = name.split('/').pop();
  return IMG_RE.test(name) && !name.startsWith('__MACOSX/') && !base.startsWith('.');
};

const cache = new Map(); // archive/folder path -> sorted page names (whole file)

export function clearPageCache() { cache.clear(); }

const CH_TAG = /(?:^|[\s_\-\[(])c(?:h(?:apter)?)?[ ._-]?(\d{1,4}(?:\.\d)?)(?=[\s_\-\])(.]|$)/i;

/**
 * Detect chapters inside a volume from page file names such as
 * "Title - c003 (v01) - p052.png". Returns [{ number, start, end }], or null when the
 * names carry fewer than two distinct chapter tags or the groups are interleaved.
 */
export function splitByChapterTag(names) {
  const tags = names.map((n) => { const m = n.split('/').pop().match(CH_TAG); return m ? parseFloat(m[1]) : null; });
  if (new Set(tags.filter((t) => t !== null)).size < 2) return null;
  // untagged pages (credits, extras) join the chapter before them; leading ones join the first
  let last = tags.find((t) => t !== null);
  const filled = tags.map((t) => (t === null ? last : (last = t)));
  const groups = [];
  for (let i = 0; i < filled.length; i++) {
    const g = groups[groups.length - 1];
    if (g && g.number === filled[i]) g.end = i + 1;
    else groups.push({ number: filled[i], start: i, end: i + 1 });
  }
  if (new Set(groups.map((g) => g.number)).size !== groups.length) return null;
  return groups;
}

export async function listZipImages(file) {
  const zip = new StreamZip.async({ file });
  try {
    const entries = await zip.entries();
    return Object.values(entries)
      .filter((e) => !e.isDirectory && usableEntry(e.name))
      .map((e) => e.name)
      .sort(naturalCompare);
  } finally {
    await zip.close().catch(() => {});
  }
}

export async function listDirImages(dir) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  return ents.filter((e) => e.isFile() && usableEntry(e.name)).map((e) => e.name).sort(naturalCompare);
}

export async function pagesFor(chapter) {
  let pages = cache.get(chapter.path);
  if (!pages) {
    pages = chapter.kind === 'zip' ? await listZipImages(chapter.path) : await listDirImages(chapter.path);
    cache.set(chapter.path, pages);
  }
  // a chapter can be a page range inside a volume archive
  if (chapter.page_start || chapter.page_end != null) return pages.slice(chapter.page_start || 0, chapter.page_end ?? undefined);
  return pages;
}

/** Resolve page `n` to either { file } on disk or { buffer } from an archive. */
export async function readPage(chapter, n) {
  const pages = await pagesFor(chapter);
  const name = pages[n];
  if (name === undefined) return null;
  if (chapter.kind === 'dir') return { file: path.join(chapter.path, name), mime: mimeFor(name) };
  const zip = new StreamZip.async({ file: chapter.path });
  try {
    return { buffer: await zip.entryData(name), mime: mimeFor(name) };
  } finally {
    await zip.close().catch(() => {});
  }
}
