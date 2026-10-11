import { getSetting } from './db.js';
import * as al from './anilist.js';
import * as md from './mangadex.js';

/**
 * Automatic matching for manga, honouring the user's choice of source order
 * (Settings → "Metadata source") and which providers are switched on.
 * Returns true when a provider matched. AniList errors (rate limit / offline) are re-thrown so the
 * scan banner can show them; MangaDex errors are treated as "no match".
 */
export async function matchManga(series) {
  const order = getSetting('meta_order', 'anilist-first') === 'mangadex-first' ? ['mangadex', 'anilist'] : ['anilist', 'mangadex'];
  const enabled = { anilist: getSetting('auto_match', true), mangadex: getSetting('mangadex_fallback', true) };
  let anilistError = null;
  for (const p of order) {
    if (!enabled[p]) continue;
    try {
      if (p === 'anilist' ? await al.autoMatch(series) : await md.autoMatch(series)) return true;
    } catch (e) {
      if (p === 'anilist') anilistError = e;
    }
  }
  if (anilistError) throw anilistError;
  return false;
}

export const anyProviderEnabled = () => !!(getSetting('auto_match', true) || getSetting('mangadex_fallback', true));
