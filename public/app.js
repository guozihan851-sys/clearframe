'use strict';

const form = document.getElementById('parse-form');
const input = document.getElementById('share-input');
const parseBtn = document.getElementById('parse-btn');
const pasteBtn = document.getElementById('paste-btn');
const errorBox = document.getElementById('error');
const resultBox = document.getElementById('result');
const toast = document.getElementById('toast');

let toastTimer = null;
let busy = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.hidden = true; }, 260);
  }, 2200);
}

function setBusy(state) {
  busy = state;
  parseBtn.disabled = state;
  input.readOnly = state;
  parseBtn.innerHTML = state
    ? '<span class="spinner" aria-hidden="true"></span><span class="btn-label">正在解析</span>'
    : '<span class="btn-label">提取原片</span><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10h11M10.5 4.5 16 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderResult(data) {
  const platforms = {
    douyin: '抖音',
    kuaishou: '快手',
    xiaohongshu: '小红书',
  };
  const platformName = data.platformName || platforms[data.platform] || '作品';
  const poster = data.coverUrl ? escapeHtml(data.coverUrl) : '';
  const hasVideo = Boolean(data.video);
  const images = Array.isArray(data.images) ? data.images : [];

  let playerHtml = '';
  if (hasVideo) {
    playerHtml = `
      <div class="result-body">
        <div class="player">
          ${poster ? `<div class="poster-fallback" style="background-image:url('${poster}')"></div>` : ''}
          <video controls playsinline preload="metadata" ${poster ? `poster="${poster}"` : ''} src="${escapeHtml(data.video.playUrl)}"></video>
        </div>
        <aside class="info">
          <p class="info-label">作品标题</p>
          <h2>${escapeHtml(data.title)}</h2>
          <p class="author">${data.author ? '@' + escapeHtml(data.author) : '作者信息未获取'}</p>
          <div class="facts">
            <div><span>时长</span><strong>${data.duration ? formatDuration(data.duration) : '—'}</strong></div>
            <div><span>格式</span><strong>MP4</strong></div>
            <div><span>水印</span><strong class="ok">已去除</strong></div>
          </div>
          <div class="result-actions">
            <a class="btn primary" href="${escapeHtml(data.video.downloadUrl)}" download>下载原片</a>
            <button type="button" class="btn ghost" data-copy="${escapeHtml(data.video.sourceUrl)}">复制直链</button>
          </div>
          <p class="result-hint">链接 30 分钟内有效 · 视频不经过本站存储</p>
        </aside>
      </div>`;
  }

  let galleryHtml = '';
  if (images.length) {
    galleryHtml = `
      <div class="gallery">
        <div class="gallery-head">
          <h3>${hasVideo ? '关联图集' : '图文作品'}</h3>
          <span>${images.length} 张图片 · 点击下载原图</span>
        </div>
        <div class="gallery-grid">
          ${images.map((image, index) => `
            <div class="gallery-item">
              <img src="${escapeHtml(image.preview)}" alt="第 ${index + 1} 张图片" loading="lazy" />
              <div class="overlay">
                <span class="index">${String(index + 1).padStart(2, '0')}</span>
                <a class="gallery-dl" href="${escapeHtml(image.download)}" download>下载</a>
              </div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  resultBox.innerHTML = `
    <article class="result-card">
      <div class="result-top">
        <span class="pill pill-${escapeHtml(data.platform)}">${escapeHtml(platformName)}</span>
        <span class="result-type">${hasVideo ? '无水印视频' : '无水印图文'}</span>
        ${data.id ? `<span class="result-id">ID ${escapeHtml(data.id)}</span>` : ''}
      </div>
      ${playerHtml}
      ${galleryHtml}
    </article>`;

  resultBox.hidden = false;

  const copyBtn = resultBox.querySelector('[data-copy]');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyText(copyBtn.dataset.copy));
  }

  resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('视频直链已复制');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      showToast('视频直链已复制');
    } catch {
      showToast('复制失败，请手动选择链接');
    }
    area.remove();
  }
}

const PARSE_TIMEOUT_MS = 60000;
const RETRY_TIMEOUT_MS = 45000;
const SLOW_HINT_MS = 7000;
const VERY_SLOW_HINT_MS = 18000;

const BTN_IDLE_HTML =
  '<span class="btn-label">提取原片</span><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 10h11M10.5 4.5 16 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function setBtnLabel(text) {
  parseBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="btn-label">${text}</span>`;
}

/* 服务端可能返回网关的 HTML 页面（会话失效），必须先读文本再解析，
   否则 response.json() 会抛出一个用户完全看不懂的语法错误。 */
async function postParse(value, signal) {
  const response = await fetch('/api/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: value }),
    signal,
  });

  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!data) {
    // 典型情况：网关拦下请求，回了一张 HTML 说明页
    throw new Error('页面会话已失效，请刷新本页后重试');
  }
  if (!response.ok || !data.ok) {
    const err = new Error(data.error || `解析失败（HTTP ${response.status}）`);
    err.business = true; // 业务错误不重试
    throw err;
  }
  return data;
}

function withTimeout(value, ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return postParse(value, controller.signal).finally(() => clearTimeout(timer));
}

async function parseLink() {
  if (busy) return;
  const value = input.value.trim();
  if (!value) {
    showError('先把分享链接粘贴进来吧');
    input.focus();
    return;
  }

  clearError();
  resultBox.hidden = true;
  resultBox.innerHTML = '';
  setBusy(true);

  let hint1 = null;
  let hint2 = null;

  try {
    hint1 = setTimeout(() => { if (busy) setBtnLabel('还在解析…'); }, SLOW_HINT_MS);
    hint2 = setTimeout(() => { if (busy) setBtnLabel('服务响应较慢，请再等等'); }, VERY_SLOW_HINT_MS);

    let data;
    try {
      data = await withTimeout(value, PARSE_TIMEOUT_MS);
    } catch (error) {
      if (error.business) throw error;
      // 网络层失败 / 超时：自动再试一次（首次访问时后端可能刚被唤醒）
      clearTimeout(hint1);
      clearTimeout(hint2);
      setBtnLabel('重新解析中…');
      try {
        data = await withTimeout(value, RETRY_TIMEOUT_MS);
      } catch (second) {
        if (second.business) throw second;
        if (second.name === 'AbortError') {
          throw new Error('解析超时了，链接可能被平台限制了访问，稍后再试一次');
        }
        throw new Error('连不上解析服务，请检查网络后刷新本页重试');
      }
    }

    renderResult(data);
  } catch (error) {
    showError(error.message || '解析失败，请稍后再试');
  } finally {
    clearTimeout(hint1);
    clearTimeout(hint2);
    busy = false;
    parseBtn.disabled = false;
    input.readOnly = false;
    parseBtn.innerHTML = BTN_IDLE_HTML;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  parseLink();
});

input.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    parseLink();
  }
});

input.addEventListener('paste', () => {
  clearError();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showToast('剪贴板是空的');
      return;
    }
    input.value = text.trim();
    input.focus();
    clearError();
  } catch {
    input.focus();
    showError('浏览器没有授予剪贴板权限，请直接按 Ctrl + V 粘贴');
  }
});