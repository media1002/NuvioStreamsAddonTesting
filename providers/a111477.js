// providers/a111477.js
// Provider module for a.111477.xyz
// Drop into a NuvioStreamsAddon-like providers folder and enable it in config.

const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { URL } = require('url');

const cache = new NodeCache({ stdTTL: 60 * 5, checkperiod: 120 });

const BASE = 'https://a.111477.xyz';
const DEFAULT_TIMEOUT = 15000;

function log(...args) {
  // Toggle or replace with your addon logger
  if (process.env.PROVIDER_DEBUG) console.log('[a111477]', ...args);
}

async function fetchHtml(url, opts = {}) {
  const cacheKey = `html:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/1.0; +https://github.com/)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': BASE
  }, opts.headers || {});

  const res = await axios.get(url, {
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    headers,
    responseType: 'text',
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400
  });

  cache.set(cacheKey, res.data);
  return res.data;
}

async function fetchUrl(url, opts = {}) {
  const cacheKey = `raw:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (compatible; StremioAddon/1.0; +https://github.com/)',
    'Referer': BASE
  }, opts.headers || {});

  const res = await axios.get(url, {
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    headers,
    responseType: opts.responseType || 'text',
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400
  });

  cache.set(cacheKey, res.data);
  return res.data;
}

/**
 * Attempt to extract stream urls from HTML:
 * - <video> sources
 * - <a> hrefs ending with common extensions
 * - iframe src
 * - inline JS (player config containing m3u8/mp4 links)
 */
function extractStreamsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const found = new Set();

  // 1) <video> tags and <source>
  $('video, video source').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) found.add(resolveUrl(src, pageUrl));
  });

  // 2) direct anchors
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href').trim();
    if (!href) return;
    // typical video container extensions
    if (href.match(/\.(m3u8|mp4|mkv|mpd|webm)(\?.*)?$/i)) {
      found.add(resolveUrl(href, pageUrl));
    }
    // many sites have "download" or "stream" anchors - include them
    const low = $(el).text().toLowerCase();
    if (low.includes('play') || low.includes('stream') || low.includes('download')) {
      found.add(resolveUrl(href, pageUrl));
    }
  });

  // 3) iframes
  $('iframe[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src) found.add(resolveUrl(src, pageUrl));
  });

  // 4) inline scripts: look for m3u8 or mp4 urls in JS text
  $('script').each((i, el) => {
    const s = $(el).html();
    if (!s) return;
    // naive regex to find urls inside JS objects
    const re = /(https?:\/\/[^\s'"]+\.(m3u8|mp4|mkv|mpd)(\?[^\s'"]*)?)/ig;
    let m;
    while ((m = re.exec(s)) !== null) {
      found.add(m[1]);
    }
  });

  return Array.from(found);
}

function resolveUrl(u, base) {
  try {
    return new URL(u, base || BASE).toString();
  } catch (e) {
    return u;
  }
}

/**
 * Heuristic: decide quality & container type from URL or surrounding text
 */
function uriToStreamObject(uri) {
  const lower = uri.toLowerCase();
  let quality = 'SD';
  if (lower.match(/2160|4k/)) quality = '2160p';
  else if (lower.match(/1080|fullhd|fhd/)) quality = '1080p';
  else if (lower.match(/720|hd/)) quality = '720p';
  else if (lower.match(/480/)) quality = '480p';

  const container = lower.endsWith('.m3u8') ? 'hls' : (lower.endsWith('.mpd') ? 'dash' : 'mp4');
  const title = `A111477 — ${quality}`;

  return {
    title,
    url: uri,
    quality,
    container,
    // placeholders that Nuvio/Stremio might expect
    infoHash: null,
    subtitles: [],
    ver: '1.0'
  };
}

/**
 * If the page contains an iframe that itself is a player host,
 * fetch and try to extract streams from the iframe page too.
 */
async function resolveIframesAndExtract(url, html) {
  const $ = cheerio.load(html);
  const iframeUrls = [];
  $('iframe[src]').each((i, el) => {
    iframeUrls.push(resolveUrl($(el).attr('src'), url));
  });

  let results = [];
  for (const ifr of iframeUrls) {
    try {
      log('Following iframe ->', ifr);
      const inner = await fetchHtml(ifr, { headers: { Referer: url } });
      const ex = extractStreamsFromHtml(inner, ifr);
      if (ex.length) results = results.concat(ex);
      // Some iframe players are JS-based and provide JSON endpoints — attempt to read player vars
      // Placeholder: tryXhrJson(ifr, inner)
    } catch (e) {
      log('iframe fetch failed', ifr, e.message);
    }
  }
  return results;
}

/**
 * Placeholder helper: if the site uses an XHR/json player endpoint, implement here.
 * Example:
 *  - Inspect network tab in browser when page loads -> find XHR that returns playlist/json
 *  - Implement a call to that endpoint (maybe requires custom headers/cookies)
 */
async function tryXhrJsonCandidate(pageHtml, pageUrl) {
  // Example pseudo-implementation:
  //  const match = /playerOptions\s*=\s*(\{.*\})/.exec(pageHtml);
  //  if (match) { const obj = JSON.parse(match[1]); return obj.playlist.map(p=>p.file); }
  return [];
}

/**
 * Public: main function the addon will call
 * Accepts args: { id, imdb_id, tmdb_id, season, episode, query }
 * id expected to be something like 'a111477:slug' or 'a111477:/watch/slug' etc.
 */
async function getStreamsForId(args = {}) {
  try {
    let rawId = args.id || args.query || '';
    if (!rawId) throw new Error('no id/query provided');

    // allow id formats:
    // - a111477:slug
    // - a111477:/watch/slug
    // - slug
    // normalize:
    rawId = rawId.replace(/^a111477:/, '').replace(/^\/+/, '');

    // Build candidate page URLs to try. Adjust patterns to match the site's structure.
    const candidates = [
      `${BASE}/watch/${rawId}`,
      `${BASE}/movie/${rawId}`,
      `${BASE}/${rawId}`,
      `${BASE}/?s=${encodeURIComponent(rawId)}`,
      `${BASE}/player.php?id=${encodeURIComponent(rawId)}`
    ];

    let streams = [];
    for (const page of candidates) {
      try {
        log('Trying candidate page', page);
        const html = await fetchHtml(page);
        let urls = extractStreamsFromHtml(html, page);

        // follow iframes if initial extraction empty or to gather more sources
        if (!urls.length) {
          const iframeUrls = await resolveIframesAndExtract(page, html);
          urls = urls.concat(iframeUrls);
        }

        // attempt to read any XHR/JSON player info
        const jsonCandidates = await tryXhrJsonCandidate(html, page);
        urls = urls.concat(jsonCandidates);

        urls = Array.from(new Set(urls)).filter(Boolean);

        // If we found direct playable links, stop and return them
        if (urls.length) {
          streams = urls.map(uriToStreamObject);
          break;
        }
      } catch (e) {
        log(`candidate fetch failed ${page}:`, e.message);
        // try next candidate
      }
    }

    // final fallback: try site search page scraping
    if (!streams.length) {
      const searchUrl = `${BASE}/?s=${encodeURIComponent(rawId)}`;
      try {
        const shtml = await fetchHtml(searchUrl);
        const urls = extractStreamsFromHtml(shtml, searchUrl);
        if (urls.length) streams = urls.map(uriToStreamObject);
      } catch (e) {
        // ignore
      }
    }

    return streams;
  } catch (err) {
    log('getStreamsForId error', err.message);
    return []; // return empty array on error so addon keeps running
  }
}

/**
 * Optional: search function to populate catalog entries.
 * Implement a simple search that hits site search and extracts items with titles+paths.
 */
async function search(query) {
  const q = query || '';
  if (!q) return [];
  const searchUrl = `${BASE}/?s=${encodeURIComponent(q)}`;

  try {
    const html = await fetchHtml(searchUrl);
    const $ = cheerio.load(html);
    const results = [];

    // Generic pattern: search results often in article blocks with <a> to detail page
    $('article, .post, .movie, .item, .result').each((i, el) => {
      const a = $(el).find('a[href]').first();
      const href = a.attr('href');
      const title = $(el).find('h2, h3, .title').first().text().trim() || a.text().trim();
      if (href && title) {
        results.push({
          id: 'a111477:' + href.replace(BASE, '').replace(/^\//, ''),
          name: title,
          type: 'movie', // adjust if you can detect type
          url: resolveUrl(href, BASE)
        });
      }
    });

    // Fallback: any anchor on the page that looks like a content page
    if (!results.length) {
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const txt = $(el).text().trim();
        if (href && txt.length > 3 && href.includes('/watch')) {
          results.push({
            id: 'a111477:' + href.replace(BASE, '').replace(/^\//, ''),
            name: txt,
            type: 'movie',
            url: resolveUrl(href, BASE)
          });
        }
      });
    }

    return results;
  } catch (e) {
    log('search error', e.message);
    return [];
  }
}

module.exports = {
  id: 'a111477',
  name: 'A111477',
  // toggle-able: respect environment or config flags similar to Nuvio
  enabled: true,
  // main API used by the wrapper addon
  getStreamsForId,
  search,
  // expose helpers if needed
  _internal: {
    fetchHtml,
    extractStreamsFromHtml,
    resolveIframesAndExtract
  }
};
