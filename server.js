'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_TTL = 30 * 60 * 1000;
const PARSE_DEADLINE = 30 * 1000;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PLATFORM_HOSTS = [
  'douyin.com',
  'iesdouyin.com',
  'kuaishou.com',
  'gifshow.com',
  'chenzhongtech.com',
  'kwai.com',
  'xiaohongshu.com',
  'xhslink.com',
];

const tokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokens) if (value.exp < now) tokens.delete(key);
}, 5 * 60 * 1000).unref();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}

function isAllowedShareHost(hostname) {
  const host = hostname.toLowerCase();
  return PLATFORM_HOSTS.some((suffix) => hostMatches(host, suffix));
}

function detectPlatform(value) {
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostMatches(host, 'douyin.com') || hostMatches(host, 'iesdouyin.com')) return 'douyin';
  if (
    hostMatches(host, 'kuaishou.com') ||
    hostMatches(host, 'gifshow.com') ||
    hostMatches(host, 'chenzhongtech.com') ||
    hostMatches(host, 'kwai.com')
  ) {
    return 'kuaishou';
  }
  if (hostMatches(host, 'xiaohongshu.com') || hostMatches(host, 'xhslink.com')) return 'xiaohongshu';
  return null;
}

function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"'，。！？、；：”）】》]+/g) || [];
  const urls = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)\]}>'"]+$/g, '');
    try {
      const url = new URL(cleaned);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href);
    } catch {
      /* ignore malformed */
    }
  }
  return urls;
}

function pickShareUrl(text) {
  const urls = extractUrls(text);
  for (const url of urls) {
    if (isAllowedShareHost(new URL(url).hostname)) return url;
  }
  return null;
}

async function followShareLink(startUrl) {
  let current = startUrl;
  const cookies = [];
  const headers = {
    'User-Agent': MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.4',
  };

  for (let hop = 0; hop < 8; hop += 1) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: cookies.length ? { ...headers, Cookie: cookies.join('; ') } : headers,
      signal: AbortSignal.timeout(15000),
    });

    for (const cookie of res.headers.getSetCookie?.() || []) {
      const pair = cookie.split(';')[0];
      if (pair) cookies.push(pair);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpError(422, '分享链接跳转异常，请重新复制链接');
      }
      if (!/^https?:$/.test(next.protocol) || !isAllowedShareHost(next.hostname)) {
        throw new HttpError(422, '链接跳转到了不受支持的地址');
      }
      current = next.href;
      continue;
    }

    const text = await readText(res);
    return { text, finalUrl: current, cookies, status: res.status };
  }

  throw new HttpError(422, '链接跳转次数过多，请换一条分享链接');
}

async function readText(res, limit = MAX_PAGE_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPage(url, cookies = [], ua = MOBILE_UA, referer = '') {
  const headers = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.4',
  };
  if (referer) headers.Referer = referer;
  if (cookies.length) headers.Cookie = cookies.join('; ');
  const res = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(18000),
  });
  const text = await readText(res);
  return { text, finalUrl: res.url || url, status: res.status };
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const text = await readText(res, 3 * 1024 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let ttwidCache = { value: '', exp: 0 };

async function getTtwid() {
  if (ttwidCache.value && ttwidCache.exp > Date.now()) return ttwidCache.value;
  try {
    const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const cookie = (res.headers.getSetCookie?.() || [])
      .map((item) => item.split(';')[0])
      .find((item) => item.startsWith('ttwid='));
    if (cookie) {
      ttwidCache = { value: cookie, exp: Date.now() + 12 * 60 * 60 * 1000 };
      return cookie;
    }
  } catch {
    /* ttwid is optional; the page still parses without it in some regions */
  }
  return '';
}

/* ---------------- JSON extraction helpers ---------------- */

function extractJsonAfter(text, marker) {
  if (!text) return null;
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = text.indexOf('{', markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          try {
            return JSON.parse(slice.replace(/\bundefined\b/g, 'null'));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

function findDeep(root, predicate, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 18) return null;
  if (predicate(root)) return root;
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    const hit = findDeep(value, predicate, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function collectDeep(root, predicate, out = [], depth = 0) {
  if (!root || typeof root !== 'object' || depth > 18) return out;
  if (predicate(root)) out.push(root);
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) collectDeep(value, predicate, out, depth + 1);
  return out;
}

function firstUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === 'object') {
    return firstUrl(value.url_list || value.urlList || value.url || value.src);
  }
  return null;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

/* ---------------- Douyin ---------------- */

function extractDouyinId(value) {
  if (!value) return null;
  const patterns = [
    /\/share\/video\/(\d{6,})/,
    /\/share\/note\/(\d{6,})/,
    /\/video\/(\d{6,})/,
    /\/note\/(\d{6,})/,
    /[?&](?:modal_id|item_ids|aweme_id|vid)=(\d{6,})/,
  ];
  for (const pattern of patterns) {
    const match = String(value).match(pattern);
    if (match) return match[1];
  }
  return null;
}

function looksLikeDouyinItem(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const hasVideo = obj.video && (obj.video.play_addr || obj.video.bit_rate || obj.video.uri);
  const hasImages = Array.isArray(obj.images) && obj.images.length > 0;
  return Boolean(hasVideo || hasImages);
}

function pickDouyinItem(data, id) {
  if (!data) return null;
  const exact = findDeep(
    data,
    (obj) => (obj.aweme_id === id || obj.awemeId === id || obj.item_id === id) && looksLikeDouyinItem(obj)
  );
  if (exact) return exact;
  return findDeep(data, looksLikeDouyinItem);
}

function douyinFilterNote(data) {
  const hit = findDeep(data, (obj) => Array.isArray(obj.filter_list) && obj.filter_list.length > 0);
  const filter = hit?.filter_list?.[0];
  return filter?.notice || filter?.detail_msg || '';
}

async function parseDouyin(link) {
  const share = await followShareLink(link);
  const id =
    extractDouyinId(share.finalUrl) || extractDouyinId(share.text) || extractDouyinId(link);
  if (!id) throw new HttpError(422, '没能从链接里识别出抖音作品 ID，请复制完整的分享链接');

  const ttwid = await getTtwid();
  const cookies = ttwid ? [...share.cookies, ttwid] : share.cookies;
  let item = pickDouyinItem(extractJsonAfter(share.text, 'window._ROUTER_DATA'), id);
  let filterNote = '';

  const pageUrls = [
    `https://www.iesdouyin.com/share/video/${id}/?from_ssr=1`,
    `https://www.iesdouyin.com/share/note/${id}/?from_ssr=1`,
  ];
  if (share.finalUrl.includes('/note/')) pageUrls.reverse();

  for (const pageUrl of pageUrls) {
    if (item) break;
    try {
      const page = await fetchPage(pageUrl, cookies, MOBILE_UA, 'https://www.douyin.com/');
      const data = extractJsonAfter(page.text, 'window._ROUTER_DATA');
      item = pickDouyinItem(data, id);
      if (!filterNote) filterNote = douyinFilterNote(data);
    } catch {
      /* try the next share page */
    }
  }

  if (!item) {
    const api = await fetchJson(
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${encodeURIComponent(id)}`,
      {
        Referer: 'https://www.douyin.com/',
        ...(ttwid ? { Cookie: ttwid } : {}),
      }
    );
    item = api?.item_list?.[0] || null;
  }

  if (!item) {
    throw new HttpError(
      422,
      filterNote
        ? `抖音解析失败：${filterNote}`
        : '抖音解析失败：作品可能已删除、设为私密，或平台暂时限制了访问'
    );
  }

  return buildDouyinRaw(item, id, link);
}

function upgradeDouyinPlayUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes('/play/')) return null;
    parsed.searchParams.set('ratio', '1080p');
    return parsed.href;
  } catch {
    return null;
  }
}

function buildDouyinRaw(item, id, sourceUrl) {
  const video = item.video || {};
  const candidates = [];

  const pushAddr = (addr) => {
    if (!addr) return;
    const list = Array.isArray(addr.url_list) ? addr.url_list : [addr.url || addr];
    for (const url of list) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      const clean = url.replace('playwm', 'play');
      if (clean !== url) {
        const high = upgradeDouyinPlayUrl(clean);
        if (high) candidates.push(high);
        candidates.push(clean);
      }
      candidates.push(url);
    }
  };

  if (Array.isArray(video.bit_rate)) {
    const sorted = [...video.bit_rate].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
    for (const rate of sorted) pushAddr(rate.play_addr);
  }
  pushAddr(video.play_addr_h264);
  pushAddr(video.play_addr);
  pushAddr(video.download_addr);

  if (video.uri) {
    candidates.push(
      `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(video.uri)}&ratio=1080p&line=0`
    );
  }

  let images = [];
  const imageHost = findDeep(item, (obj) => Array.isArray(obj.images) && obj.images.length);
  if (imageHost) {
    images = imageHost.images
      .map((img) => firstUrl(img.url_list || img.urlList || img))
      .filter(Boolean);
  }

  const coverUrl =
    firstUrl(video.cover) ||
    firstUrl(video.origin_cover) ||
    firstUrl(video.dynamic_cover) ||
    images[0] ||
    null;

  const rawDuration = Number(video.duration) || 0;
  return {
    platform: 'douyin',
    platformName: '抖音',
    id,
    title: item.desc || item.caption || item.share_info?.share_title || '抖音作品',
    author: item.author?.nickname || item.author?.unique_id || '',
    coverUrl,
    duration: rawDuration > 0 ? Math.round(rawDuration / 1000) : 0,
    videoUrl: dedupe(candidates)[0] || null,
    images,
    sourceUrl,
  };
}

/* ---------------- Kuaishou ---------------- */

function kuaishouIdFrom(value) {
  if (!value) return null;
  const patterns = [
    /\/(?:short-video|photo)\/([A-Za-z0-9_-]{6,})/,
    /fw\/photo\/([A-Za-z0-9_-]{6,})/,
    /[?&]photoId=([A-Za-z0-9_-]{6,})/,
  ];
  for (const pattern of patterns) {
    const match = String(value).match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractKuaishouFromHtml(html, id) {
  if (!html) return null;

  const state =
    extractJsonAfter(html, 'window.INIT_STATE') ||
    extractJsonAfter(html, 'window.__APOLLO_STATE__') ||
    extractJsonAfter(html, '__APOLLO_STATE__');

  let photo = null;
  let authorName = '';
  let videoUrls = [];
  let cover = '';
  let title = '';
  let duration = 0;
  let photoId = id || '';

  if (state) {
    photo =
      findDeep(state, (obj) => Array.isArray(obj.mainMvUrls) && obj.mainMvUrls.length > 0) ||
      findDeep(state, (obj) => typeof obj.photoUrl === 'string' && /^https?:/.test(obj.photoUrl)) ||
      findDeep(state, (obj) => obj.photoId === id && (obj.photoUrl || obj.mainMvUrls));

    const author = findDeep(
      state,
      (obj) =>
        typeof obj.userName === 'string' &&
        obj.userName &&
        (obj.userId || obj.avatar || obj.headUrl)
    );
    if (author?.userName) authorName = author.userName;
  }

  if (photo) {
    if (typeof photo.photoUrl === 'string') videoUrls.push(photo.photoUrl);
    if (Array.isArray(photo.mainMvUrls)) {
      for (const item of photo.mainMvUrls) {
        const url = typeof item === 'string' ? item : item?.url || item?.src;
        if (typeof url === 'string') videoUrls.push(url);
      }
    }
    if (Array.isArray(photo.coverUrls)) cover = firstUrl(photo.coverUrls) || cover;
    cover = photo.coverUrl || photo.poster || cover;
    title = photo.caption || photo.title || '';
    duration = Number(photo.duration) || 0;
    photoId = photo.photoId || photoId;
    if (!authorName) authorName = photo.userName || photo.authorName || '';
  }

  if (!videoUrls.length) {
    const pattern = /"(?:photoUrl|srcNoMark|playUrl)"\s*:\s*"(https?:[^"]+?\.mp4[^"]*)"/g;
    let match;
    while ((match = pattern.exec(html))) {
      videoUrls.push(match[1].replace(/\\\//g, '/').replace(/\\u002F/g, '/'));
    }
  }

  if (!videoUrls.length) {
    const pattern = /https?:\\?\/\\?\/[^"'\\\s]+?\.mp4[^"'\\\s]*/g;
    let match;
    while ((match = pattern.exec(html))) {
      videoUrls.push(match[0].replace(/\\\//g, '/'));
    }
  }

  videoUrls = dedupe(videoUrls.filter((url) => /^https?:\/\//.test(url)));

  if (!videoUrls.length && !cover) return null;

  return {
    platform: 'kuaishou',
    platformName: '快手',
    id: photoId || '',
    title: title || '快手作品',
    author: authorName,
    coverUrl: cover || null,
    duration: duration > 0 ? Math.round(duration > 1000 ? duration / 1000 : duration) : 0,
    videoUrl: videoUrls[0] || null,
    images: [],
    sourceUrl: '',
  };
}

async function parseKuaishou(link) {
  const share = await followShareLink(link);
  const id =
    kuaishouIdFrom(share.finalUrl) || kuaishouIdFrom(share.text) || kuaishouIdFrom(link);

  const htmlCandidates = [share.text];
  if (id) {
    for (const pageUrl of [
      `https://m.gifshow.com/fw/photo/${id}`,
      `https://www.kuaishou.com/short-video/${id}`,
    ]) {
      try {
        const page = await fetchPage(pageUrl, share.cookies, MOBILE_UA, 'https://www.kuaishou.com/');
        htmlCandidates.push(page.text);
      } catch {
        /* try next */
      }
    }
  }

  for (const html of htmlCandidates) {
    const raw = extractKuaishouFromHtml(html, id);
    if (raw && raw.videoUrl) {
      raw.sourceUrl = link;
      return raw;
    }
  }

  throw new HttpError(422, '快手解析失败：作品可能已删除，或平台要求登录后查看');
}

/* ---------------- Xiaohongshu ---------------- */

function xhsNoteId(value) {
  if (!value) return null;
  const match = String(value).match(
    /\/(?:explore|discovery\/item|note)\/([0-9a-fA-F]{16,})|[?&](?:noteId|note_id)=([0-9a-fA-F]{16,})/
  );
  return match ? match[1] || match[2] : null;
}

function extractXhsFromHtml(html) {
  if (!html) return null;
  const state = extractJsonAfter(html, 'window.__INITIAL_STATE__');

  let note = state
    ? findDeep(state, (obj) => obj.note && (obj.note.video || obj.note.imageList))?.note ||
      findDeep(state, (obj) => obj.video?.media && (obj.title || obj.desc))
    : null;

  if (!note) {
    const map = extractJsonAfter(html, '"noteDetailMap"');
    if (map) {
      const entry = Object.values(map)[0];
      if (entry?.note) note = entry.note;
    }
  }

  if (!note) return null;

  const video = note.video || {};
  const stream = video.media?.stream || {};
  const videoUrls = [];

  for (const codec of ['h264', 'h265', 'av1', 'hevc']) {
    const list = stream[codec];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.masterUrl) videoUrls.push(item.masterUrl);
      for (const url of item?.backupUrls || []) if (url) videoUrls.push(url);
    }
  }

  if (video.consumer?.originVideoKey) {
    videoUrls.push(`https://sns-video-bd.xhscdn.com/${video.consumer.originVideoKey}`);
  }

  const images = (note.imageList || [])
    .map((img) => firstUrl(img.urlDefault || img.urlPre || img.infoList || img))
    .filter(Boolean);

  if (!videoUrls.length && video) {
    for (const hit of collectDeep(video, (obj) => typeof obj === 'object')) {
      if (typeof hit.masterUrl === 'string' && /\.mp4/.test(hit.masterUrl)) videoUrls.push(hit.masterUrl);
      if (typeof hit.master_url === 'string' && /\.mp4/.test(hit.master_url)) videoUrls.push(hit.master_url);
    }
  }

  const rawDuration = Number(video.media?.video?.duration || video.capa?.duration || video.duration) || 0;

  return {
    platform: 'xiaohongshu',
    platformName: '小红书',
    id: note.noteId || note.id || '',
    title: note.title || (note.desc ? String(note.desc).split('\n')[0] : '') || '小红书笔记',
    author: note.user?.nickname || note.user?.name || '',
    coverUrl:
      firstUrl(note.imageList?.[0]?.urlDefault) ||
      firstUrl(video.media?.video?.thumbnail) ||
      images[0] ||
      null,
    duration: rawDuration > 0 ? Math.round(rawDuration > 1000 ? rawDuration / 1000 : rawDuration) : 0,
    videoUrl: dedupe(videoUrls)[0] || null,
    images,
    sourceUrl: '',
  };
}

async function parseXiaohongshu(link) {
  const share = await followShareLink(link);
  const id = xhsNoteId(share.finalUrl) || xhsNoteId(share.text) || xhsNoteId(link);

  let html = share.text;
  let raw = extractXhsFromHtml(html);

  if (!raw && id) {
    for (const pageUrl of [
      `https://www.xiaohongshu.com/explore/${id}`,
      `https://www.xiaohongshu.com/discovery/item/${id}`,
    ]) {
      try {
        const page = await fetchPage(pageUrl, share.cookies, DESKTOP_UA, 'https://www.xiaohongshu.com/');
        html = page.text;
        raw = extractXhsFromHtml(html);
        if (raw) break;
      } catch {
        /* try next */
      }
    }
  }

  if (!raw || (!raw.videoUrl && !raw.images.length)) {
    throw new HttpError(
      422,
      '小红书解析失败：笔记可能需要登录才能查看，或链接已失效'
    );
  }

  raw.sourceUrl = link;
  return raw;
}

/* ---------------- Response assembly ---------------- */

function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function extensionFromUrl(url, fallback) {
  try {
    const match = new URL(url).pathname.toLowerCase().match(/\.(jpe?g|png|webp|gif|heic)$/);
    if (match) return match[1] === 'jpeg' ? 'jpg' : match[1];
  } catch {
    /* ignore */
  }
  return fallback;
}

function cleanTitle(title, platformName) {
  const text = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 100) : `${platformName}作品`;
}

function issueToken(url, meta) {
  const token = crypto.randomBytes(18).toString('hex');
  tokens.set(token, { url, ...meta, exp: Date.now() + TOKEN_TTL });
  return token;
}

function buildResponse(raw) {
  const referer =
    raw.platform === 'douyin'
      ? 'https://www.douyin.com/'
      : raw.platform === 'kuaishou'
        ? 'https://www.kuaishou.com/'
        : 'https://www.xiaohongshu.com/';

  const title = cleanTitle(raw.title, raw.platformName);
  const baseName =
    sanitizeFilename(`${raw.author ? raw.author + ' - ' : ''}${title}`) || `${raw.platformName}作品`;

  let video = null;
  if (raw.videoUrl) {
    const token = issueToken(raw.videoUrl, {
      kind: 'video',
      referer,
      filename: `${baseName}.mp4`,
    });
    video = {
      playUrl: `/api/media?token=${token}`,
      downloadUrl: `/api/media?token=${token}&download=1`,
      sourceUrl: raw.videoUrl,
    };
  }

  let coverUrl = null;
  if (raw.coverUrl) {
    const token = issueToken(raw.coverUrl, {
      kind: 'image',
      referer,
      filename: `${baseName}.${extensionFromUrl(raw.coverUrl, 'jpg')}`,
    });
    coverUrl = `/api/media?token=${token}`;
  }

  const images = (raw.images || []).map((url, index) => {
    const filename = `${baseName}-${String(index + 1).padStart(2, '0')}.${extensionFromUrl(url, 'jpg')}`;
    const token = issueToken(url, { kind: 'image', referer, filename });
    return {
      preview: `/api/media?token=${token}`,
      download: `/api/media?token=${token}&download=1`,
      sourceUrl: url,
    };
  });

  return {
    ok: true,
    platform: raw.platform,
    platformName: raw.platformName,
    id: raw.id || '',
    title,
    author: raw.author || '',
    duration: raw.duration || 0,
    coverUrl,
    video,
    images,
  };
}

/* ---------------- HTTP handling ---------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '提交的内容太长了'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleParse(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    throw new HttpError(400, '请求格式不正确');
  }

  const input = String(body.input || '').slice(0, 5000);
  if (!input.trim()) throw new HttpError(400, '请先粘贴分享链接');

  const link = pickShareUrl(input);
  if (!link) {
    const anyUrl = extractUrls(input)[0];
    if (anyUrl) {
      let host = '';
      try {
        host = new URL(anyUrl).hostname;
      } catch {
        /* ignore */
      }
      throw new HttpError(400, `暂不支持 ${host || '该'} 平台，目前支持抖音、快手、小红书`);
    }
    throw new HttpError(400, '没有找到有效的分享链接，请粘贴完整的分享口令或链接');
  }

  const platform = detectPlatform(link);
  const runner =
    platform === 'douyin'
      ? parseDouyin
      : platform === 'kuaishou'
        ? parseKuaishou
        : platform === 'xiaohongshu'
          ? parseXiaohongshu
          : null;
  if (!runner) throw new HttpError(400, '暂不支持该平台');

  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new HttpError(504, '解析超时：平台响应太慢，请稍后重试')),
      PARSE_DEADLINE
    );
    timer.unref?.();
  });

  let raw;
  try {
    raw = await Promise.race([runner(link), deadline]);
  } finally {
    clearTimeout(timer);
  }

  sendJson(res, 200, buildResponse(raw));
}

function asciiFallback(name) {
  const cleaned = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return cleaned || 'download';
}

async function handleMedia(req, res, url) {
  const token = url.searchParams.get('token') || '';
  const entry = tokens.get(token);
  if (!entry || entry.exp < Date.now()) {
    tokens.delete(token);
    throw new HttpError(404, '下载链接已过期，请重新解析');
  }

  const headers = {
    'User-Agent': DESKTOP_UA,
    Accept: '*/*',
    Referer: entry.referer || '',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(entry.url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(600000),
    });
  } catch {
    throw new HttpError(502, '媒体文件拉取失败，请稍后重试');
  }

  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(502, `媒体文件获取失败（HTTP ${upstream.status}）`);
  }

  res.statusCode = upstream.status;
  for (const header of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.headers.get('content-type')) {
    res.setHeader('Content-Type', entry.kind === 'video' ? 'video/mp4' : 'image/jpeg');
  }
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (url.searchParams.get('download') === '1') {
    const filename = entry.filename || 'download';
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }

  if (req.method === 'HEAD' || !upstream.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    res.destroy();
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(404, 'Not found');
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (!stat.isFile()) throw new HttpError(404, 'Not found');

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = url.pathname;

    if (pathname === '/api/parse' && req.method === 'POST') {
      await handleParse(req, res);
    } else if (pathname === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
      await handleMedia(req, res, url);
    } else if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, uptime: process.uptime() });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
    } else {
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' });
    }
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500 && !(error instanceof HttpError)) {
      console.error('[error]', error);
    }
    if (!res.headersSent) {
      const message =
        error instanceof HttpError ? error.message : '服务器开小差了，请稍后再试';
      sendJson(res, status, { ok: false, error: message });
    } else {
      res.destroy();
    }
  } finally {
    if (pathname.startsWith('/api/')) {
      console.log(`${req.method} ${pathname} ${Date.now() - started}ms`);
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`净影 ClearFrame 已启动：http://localhost:${PORT}`);
});