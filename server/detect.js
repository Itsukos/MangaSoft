import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker, createScheduler } from 'tesseract.js';
import { DATA_DIR } from './db.js';

/**
 * Finds chapter title pages in a volume by OCR-ing every page and looking for text such as
 * "CHAPTER 12", "Ch. 12" or "#12". Results are suggestions; the UI makes the user confirm them.
 */

export const detectJobs = new Map(); // archive path -> job state

const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
};

/**
 * Look for a chapter heading in OCR text. Tolerates garbled "Chapter" (stylised fonts) and a
 * missing number: returns { number: null } when the word is present but no number was read.
 */
export function parseHeading(text) {
  for (const line of text.split('\n')) {
    const tokens = line.split(/[\s:|]+/).filter(Boolean);
    // "CHAPTER 7: Title" / "Ch. 7" / garbled "(@hapter 7". Stylised title pages often carry noise
    // earlier on the same line, so the word may appear anywhere as long as a number follows it;
    // a number-less heading must be at the start of the line (and so not mid-sentence prose).
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i].toLowerCase().replace(/[^a-z]/g, '');
      const long = word.length >= 6 && word.length <= 9 && lev(word, 'chapter') <= 2;
      const short = word === 'ch' || word === 'chap';
      if (!long && !short) continue;
      for (const t of tokens.slice(i + 1, i + (long ? 3 : 2))) {
        const m = t.match(/^[#:]?(\d{1,3})[:.]?$/);
        if (m && +m[1] > 0 && +m[1] < 1000) return { number: +m[1], text: tokens.slice(i, i + 4).join(' ').slice(0, 80), exact: true };
      }
      if (long && i < 2) return { number: null, text: line.trim().slice(0, 80) };
    }
    const alone = line.trim().match(/^(?:#|no\.?)\s*(\d{1,3})$/i);
    if (alone) return { number: +alone[1], text: line.trim(), exact: true };
  }
  return null;
}

async function prepare(input, width) {
  return sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .greyscale()
    .normalise()
    .png()
    .toBuffer();
}

/**
 * @param key        job key (archive path)
 * @param pageCount  number of pages in the whole file
 * @param getPage    async (i) => { file } | { buffer }
 * @param expectedFirst  chapter number we expect the volume to begin with (hint only)
 */
export function startDetect(key, pageCount, getPage, expectedFirst) {
  const existing = detectJobs.get(key);
  if (existing?.state === 'running') return existing;

  const job = { state: 'running', phase: 'scan', done: 0, total: pageCount, candidates: [], error: null, expectedFirst };
  detectJobs.set(key, job);

  (async () => {
    const scheduler = createScheduler();
    try {
      const n = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)));
      for (let i = 0; i < n; i++) {
        scheduler.addWorker(await createWorker('eng', 1, { cachePath: path.join(DATA_DIR, 'tessdata') }));
      }
      const ocr = async (indices, width, onlyLong) => {
        const hits = [];
        await Promise.all(indices.map((i) => (async () => {
          try {
            const page = await getPage(i);
            if (!page) return;
            const png = await prepare(page.file || page.buffer, width);
            const { data } = await scheduler.addJob('recognize', png);
            const hit = parseHeading(data.text || '');
            if (hit && (!onlyLong || hit.number === null || hit.exact)) hits.push({ page: i, ...hit });
          } catch { /* unreadable page: skip */ } finally { job.done++; }
        })()));
        return hits;
      };

      const all = Array.from({ length: pageCount }, (_, i) => i);
      let found = await ocr(all, 1600, false);
      let result = refine(found, expectedFirst);

      // second pass: look harder where a chapter is probably hiding - before the first hit,
      // between hits whose numbers skip, and after the last hit
      const gaps = [];
      const good = result.filter((r) => r.confidence !== 'low' && r.number !== null).sort((a, b) => a.page - b.page);
      if (!good.length) gaps.push([0, pageCount - 1]);
      else {
        if (expectedFirst != null && good[0].number > expectedFirst && good[0].page > 3) gaps.push([0, good[0].page - 1]);
        for (let k = 0; k + 1 < good.length; k++) {
          if (good[k + 1].number - good[k].number > 1) gaps.push([good[k].page + 6, good[k + 1].page - 1]);
        }
        const last = good[good.length - 1];
        if (pageCount - last.page > 40) gaps.push([last.page + 6, pageCount - 1]);
      }
      const known = new Set(found.map((f) => f.page));
      const extra = [...new Set(gaps.flatMap(([lo, hi]) => all.filter((p) => p >= lo && p <= hi)))].filter((p) => !known.has(p)).slice(0, 160);
      if (extra.length) {
        job.phase = 'gaps';
        job.total = job.done + extra.length;
        found = found.concat(await ocr(extra, 2200, true));
        result = refine(found, expectedFirst);
      }
      job.candidates = result;
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
    } finally {
      await scheduler.terminate().catch(() => {});
    }
  })();
  return job;
}

/**
 * Turn raw hits into an ordered list of suggestions:
 *  - duplicates of a number keep the earliest page
 *  - hits whose number breaks the increasing sequence are flagged low confidence
 *  - hits with no readable number get the number implied by their neighbours when it is unambiguous
 */
export function refine(found, expectedFirst) {
  // a number far outside what the series' other volumes imply is probably a misread digit
  const implausible = (n) => expectedFirst != null && expectedFirst > 1 && (n < expectedFirst - 3 || n > expectedFirst + 60);
  const score = (f) => (f.number === null ? 0 : implausible(f.number) ? 1 : 3) + (f.exact ? 1 : 0);

  // hits within a few pages of each other are one heading (title page + spread): keep the best reading
  const sortedHits = [...found].sort((a, b) => a.page - b.page);
  const clusters = [];
  for (const f of sortedHits) {
    const c = clusters[clusters.length - 1];
    if (c && f.page - c[c.length - 1].page <= 6) c.push(f); else clusters.push([f]);
  }
  const picked = clusters.map((c) => c.reduce((best, f) => (score(f) > score(best) ? f : best)));

  const seen = new Set();
  const list = picked.filter((f) => {
    if (f.number === null) return true;
    if (seen.has(f.number)) return false;
    seen.add(f.number);
    return true;
  });

  // longest strictly-increasing run of numbered hits = the believable sequence
  const numbered = list.filter((f) => f.number !== null);
  const prev = new Array(numbered.length).fill(-1), len = new Array(numbered.length).fill(1);
  for (let i = 0; i < numbered.length; i++) {
    for (let j = 0; j < i; j++) {
      if (numbered[j].number < numbered[i].number && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
  }
  const trusted = new Set();
  let bestEnd = 0;
  for (let i = 1; i < numbered.length; i++) {
    if (len[i] > len[bestEnd] || (len[i] === len[bestEnd] && numbered[i].number < numbered[bestEnd].number)) bestEnd = i;
  }
  for (let k = bestEnd; k >= 0 && numbered.length; k = prev[k]) trusted.add(numbered[k]);

  const out = list.map((f) => {
    if (f.number !== null && implausible(f.number)) return { ...f, number: null, ocrNumber: f.number, confidence: 'low' };
    return { ...f, confidence: f.number === null ? 'low' : trusted.has(f) ? 'high' : 'low' };
  });
  // fill unnumbered hits that sit between two trusted numbers with exactly one missing value
  for (let i = 0; i < out.length; i++) {
    if (out[i].number !== null || out[i].ocrNumber != null) continue;
    const before = [...out.slice(0, i)].reverse().find((f) => f.number !== null && f.confidence === 'high');
    const after = out.slice(i + 1).find((f) => f.number !== null && f.confidence === 'high');
    const lo = before ? before.number : (expectedFirst != null ? expectedFirst - 1 : null);
    if (lo !== null && after && after.number - lo === 2) { out[i].number = lo + 1; out[i].confidence = 'medium'; out[i].inferred = true; }
    else if (lo !== null && !after) { out[i].number = lo + 1; out[i].confidence = 'medium'; out[i].inferred = true; }
  }
  return out;
}
