/* ── STATE ──────────────────────────────────────────────── */
let player       = null;
let ytReady      = false;
let playerReady  = false;
let pendingId    = null;
let segments     = [];
let translations = [];
let current      = 0;
let pauseTimer   = null;
let syncTimer    = null;
let scores       = {};
let activeTab    = 'dict';
let viVisible    = false;
let wordIdx      = 0;   // word-by-word: index of next expected word

/* ── DOM ────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

/* ── YOUTUBE API ────────────────────────────────────────── */
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (pendingId) { _createPlayer(pendingId); pendingId = null; }
};

function _createPlayer(videoId) {
  player = new YT.Player('ytPlayer', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1, fs: 1, playsinline: 1 },
    events: {
      onReady: () => { playerReady = true; player.pauseVideo(); goTo(0); },
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING)
          setStatus('playing', '▶ Đang phát đoạn ' + (current + 1) + '…');
      },
    },
  });
}

function initPlayer(videoId) {
  if (player && playerReady) { player.loadVideoById(videoId); goTo(0); }
  else if (ytReady)           { _createPlayer(videoId); }
  else                        { pendingId = videoId; }
}

/* ── PLAYBACK ───────────────────────────────────────────── */
function playSeg(index) {
  if (!player || !segments[index]) return;
  const seg = segments[index];
  clearTimeout(pauseTimer);
  player.seekTo(seg.start, true);
  player.playVideo();
  pauseTimer = setTimeout(() => {
    player.pauseVideo();
    setStatus('waiting', '⌨ Gõ những gì bạn vừa nghe, rồi nhấn Enter.');
  }, seg.duration * 1000 + 600);
}

/* ── NAVIGATION ─────────────────────────────────────────── */
function goTo(index) {
  if (index < 0 || index >= segments.length) return;
  clearTimeout(pauseTimer);
  current = index;
  wordIdx = 0;
  hideResult();
  $('dictInput').value = '';
  $('dictInput').disabled = false;
  $('dictInput').focus();
  updateProgress();
  playSeg(current);
  renderMasked(index);
  if (activeTab === 'trans') highlightTransSeg(current, true);
}

/* ── TAB SWITCHING ──────────────────────────────────────── */
function switchTab(tab) {
  activeTab = tab;
  $('tabBtnDict').classList.toggle('active', tab === 'dict');
  $('tabBtnTrans').classList.toggle('active', tab === 'trans');
  $('paneDict').style.display  = tab === 'dict'  ? 'flex' : 'none';
  $('paneTrans').style.display = tab === 'trans' ? 'flex' : 'none';
  if (tab === 'trans') highlightTransSeg(current, true);
}

/* ── WORD-BY-WORD CHECK ─────────────────────────────────── */
function renderMasked(segIndex, hintIdx = -1) {
  if (!segments[segIndex]) return;
  const exp = normalize(segments[segIndex].text);
  const raw = segments[segIndex].text.trim().split(/\s+/);
  $('wordRow').innerHTML = raw.map((w, i) => {
    if (i < wordIdx)
      return `<span class="word word-correct">${esc(w)}</span>`;
    if (i === hintIdx)
      return `<span class="word word-hint">${esc(w)}</span>`;
    const len = exp[i] ? exp[i].length : w.replace(/[^\w']/g, '').length;
    return `<span class="word word-masked">${'*'.repeat(Math.max(len, 1))}</span>`;
  }).join(' ');
  $('resultStat').innerHTML = wordIdx > 0
    ? `<span style="color:var(--muted);font-size:.82rem">${wordIdx} / ${exp.length} từ</span>`
    : '';
  $('resultArea').style.display = 'flex';
}

function checkSentence() {
  const val  = $('dictInput').value.trim();
  const typed = val ? normalize(val) : [];
  const exp   = normalize(segments[current].text);
  if (wordIdx >= exp.length) return;

  // Count consecutive matches starting from wordIdx
  let matched = 0;
  for (let i = 0; i < typed.length && (wordIdx + i) < exp.length; i++) {
    if (typed[i] === exp[wordIdx + i]) matched++;
    else break;
  }

  wordIdx += matched;

  // Keep only unmatched words in input
  $('dictInput').value = typed.slice(matched).join(' ');

  if (wordIdx >= exp.length) {
    scores[current] = 100;
    updateProgress();
    const raw = segments[current].text.trim().split(/\s+/);
    $('wordRow').innerHTML = raw.map(w => `<span class="word word-correct">${esc(w)}</span>`).join(' ');
    $('resultStat').innerHTML = '';
    $('resultArea').style.display = 'flex';
    setStatus('checked', '🎉 Hoàn hảo!');
    showTranslation(current);
    $('dictInput').value = '';
    if ($('autoAdvance').checked) setTimeout(() => goTo(current + 1), 1400);
  } else {
    // Always reveal the next expected word as hint (wrong or not yet typed)
    renderMasked(current, wordIdx);
    const raw      = segments[current].text.trim().split(/\s+/);
    const hintWord = raw[wordIdx] || '';
    const hasMismatch = typed.length > matched;
    setStatus('waiting', matched > 0
      ? `✓ ${matched} từ đúng — tiếp theo cần gõ: "${hintWord}"`
      : (hasMismatch
          ? `⚠ Sai rồi — tiếp theo cần gõ: "${hintWord}"`
          : `Tiếp theo cần gõ: "${hintWord}"`));
    $('dictInput').focus();
  }
}

function revealAnswer() {
  const raw = segments[current].text.trim().split(/\s+/);
  wordIdx = normalize(segments[current].text).length;
  scores[current] = scores[current] ?? 0;
  $('wordRow').innerHTML = raw.map(w => `<span class="word word-revealed">${esc(w)}</span>`).join(' ');
  $('resultStat').innerHTML = '<span style="color:var(--muted);font-size:.82rem">Đáp án đã được hiển thị.</span>';
  $('resultArea').style.display = 'flex';
  showTranslation(current);
  setStatus('checked', '✓ Đã xem đáp án');
  updateProgress();
}

/* ── TRANSLATION DISPLAY ────────────────────────────────── */
function showTranslation(index) {
  const vi = translations[index];
  if (vi) {
    $('viText').textContent = vi;
    $('viText').className   = 'vi-text';
    $('viBlock').hidden     = false;
    viVisible = true;
  } else if (translations.length > 0 && translations.every(t => t === null)) {
    $('viText').textContent = 'Đang dịch…';
    $('viText').className   = 'vi-text loading';
    $('viBlock').hidden     = false;
    viVisible = true;
  } else {
    $('viBlock').hidden = true;
    viVisible = false;
  }
}

/* ── COMPARE ────────────────────────────────────────────── */
function normalize(s) {
  return s.toLowerCase()
    .replace(/[‘’‚‛′‵`´]/g, "'") // Unicode apostrophes → ASCII
    .replace(/[^\w\s']/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

function compare(input, expected) {
  const inp = normalize(input), exp = normalize(expected);
  let correct = 0;
  const tokens = [];
  for (let i = 0; i < exp.length; i++) {
    if (inp[i] === exp[i]) { tokens.push({ word: exp[i], cls: 'word-correct' }); correct++; }
    else if (!inp[i])       tokens.push({ word: exp[i], cls: 'word-missing' });
    else                    tokens.push({ word: inp[i], cls: 'word-incorrect' });
  }
  for (let i = exp.length; i < inp.length; i++)
    tokens.push({ word: inp[i], cls: 'word-extra' });
  const accuracy = exp.length ? Math.round((correct / exp.length) * 100) : 0;
  return { tokens, accuracy, correct, total: exp.length };
}

function showResult(result) {
  $('viBlock').hidden = true;
  viVisible = false;
  $('wordRow').innerHTML = result.tokens
    .map(t => `<span class="word ${t.cls}">${esc(t.word)}</span>`).join(' ');
  const chip = result.accuracy >= 80 ? 'acc-great' : result.accuracy >= 50 ? 'acc-ok' : 'acc-poor';
  $('resultStat').innerHTML =
    `<span class="acc-chip ${chip}">${result.accuracy}%</span>` +
    `<span style="color:var(--muted)">${result.correct}/${result.total} từ đúng</span>`;
  $('resultArea').hidden = false;
  const emoji = result.accuracy === 100 ? '🎉 Hoàn hảo!'
              : result.accuracy >= 80   ? '👍 Rất tốt!'
              : result.accuracy >= 50   ? '🙂 Khá ổn' : '💪 Cố lên!';
  setStatus('checked', `${emoji}  ${result.accuracy}% chính xác`);
}

function hideResult() {
  $('resultArea').style.display = 'none';
  $('wordRow').innerHTML = $('resultStat').innerHTML = '';
  $('viBlock').hidden = true;
  viVisible = false;
}

/* ── PROGRESS ───────────────────────────────────────────── */
function updateProgress() {
  const total = segments.length;
  $('segCounter').textContent   = `${current + 1} / ${total}`;
  $('progressFill').style.width = `${((current + 1) / total) * 100}%`;
  $('prevBtn').disabled = current === 0;
  $('nextBtn').disabled = current === total - 1;
  const vals = Object.values(scores);
  if (vals.length)
    $('overallScore').textContent =
      `Điểm TB: ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}%`;
}

/* ── STATUS ─────────────────────────────────────────────── */
function setStatus(type, msg) {
  $('statusBanner').className = 'status-banner' + (type ? ' ' + type : '');
  $('statusText').textContent = msg;
}

/* ── TRANSCRIPT RENDERING ───────────────────────────────── */
function renderTranscriptList() {
  const hasVI = translations.some(t => t);
  $('trList').innerHTML = segments.map((seg, i) => {
    const vi = translations[i];
    return `<div class="tr-seg${i === current ? ' active' : ''}" data-idx="${i}"
                 onclick="trClick(${i})">
      <button class="tr-play-btn" title="${fmtTime(seg.start)}"
              onclick="event.stopPropagation(); trPlay(${i})">&#9654;</button>
      <div class="tr-body">
        <div class="tr-en">${esc(seg.text)}</div>
        ${hasVI
          ? `<div class="tr-vi${vi ? '' : ' tr-pending'}">${vi ? esc(vi) : '…'}</div>`
          : ''}
      </div>
    </div>`;
  }).join('');
}

/* Called after background translation arrives — update only VI rows */
function patchTranslationRows() {
  const hasVI = translations.some(t => t);
  // Add vi row to segments that don't have one yet
  translations.forEach((vi, i) => {
    const row = $('trList').querySelector(`[data-idx="${i}"]`);
    if (!row) return;
    let viEl = row.querySelector('.tr-vi');
    if (!viEl && hasVI) {
      // Insert vi div if missing (first time translations arrive)
      const body = row.querySelector('.tr-body');
      viEl = document.createElement('div');
      viEl.className = 'tr-vi tr-pending';
      body.appendChild(viEl);
    }
    if (viEl && vi) {
      viEl.textContent = vi;
      viEl.classList.remove('tr-pending');
    }
  });
  // refresh vi-block only if it was already legitimately visible
  if (!$('resultArea').hidden && viVisible) showTranslation(current);
}

function highlightTransSeg(index, scroll = false) {
  const list = $('trList');
  const rows = list.querySelectorAll('.tr-seg');
  rows.forEach((r, i) => r.classList.toggle('active', i === index));
  if (scroll && $('autoScroll') && $('autoScroll').checked && rows[index]) {
    // Pin active row to 2nd position: show one row above it at the top
    const anchor = index > 0 ? rows[index - 1] : rows[index];
    const anchorTop = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTo({ top: list.scrollTop + anchorTop, behavior: 'smooth' });
  }
}

/* Click row → navigate; play button → play that segment */
function trClick(index) {
  current = index;
  hideResult();
  updateProgress();
  highlightTransSeg(index, true);
  if (player) player.seekTo(segments[index].start, true);
}

function trPlay(index) {
  goTo(index);
}

/* ── REAL-TIME SYNC ─────────────────────────────────────── */
function startSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!player || typeof player.getPlayerState !== 'function') return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING) return;
    const time = player.getCurrentTime();
    const idx  = segments.findIndex(s => time >= s.start && time < s.start + s.duration);
    if (idx !== -1 && idx !== current) {
      current = idx;
      updateProgress();
      if (activeTab === 'trans') highlightTransSeg(current, true);
    }
  }, 400);
}

/* ── BACKGROUND TRANSLATION FETCH ──────────────────────── */
async function fetchTranslationsBackground(langCode) {
  // Mark all VI rows as loading
  $('tabBtnTrans').dataset.loading = '1';
  updateTabLabel(true);

  try {
    const res  = await fetch('/api/translate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ texts: segments.map(s => s.text), target: 'vi' }),
    });
    const data = await res.json();
    if (data.translations) {
      translations = data.translations;
      patchTranslationRows();
    }
  } catch (e) {
    console.warn('Background translation failed:', e);
  } finally {
    delete $('tabBtnTrans').dataset.loading;
    updateTabLabel(false);
  }
}

function updateTabLabel(loading) {
  $('tabBtnTrans').textContent = loading ? '📋 Transcript ⏳' : '📋 Transcript';
}

/* ── FORM SUBMIT ────────────────────────────────────────── */
$('urlForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('videoUrl').value.trim();
  if (!url) return;
  setLoading(true);
  $('errorMsg').hidden = true;

  try {
    const res  = await fetch(`/api/transcript?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');

    segments     = data.segments;
    translations = data.translations || new Array(segments.length).fill(null);
    current      = 0;
    scores       = {};
    wordIdx      = 0;
    hideResult();

    $('workspace').hidden = false;
    $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });

    $('videoMeta').innerHTML =
      `<span class="badge">${esc(data.language)}</span>` +
      (data.is_generated ? `<span class="badge badge-auto">Auto-generated</span>` : '');

    renderTranscriptList();
    startSync();
    updateProgress();
    initPlayer(data.video_id);

    // If YouTube had no VI translation → fetch via Google Translate in background
    if (data.need_translate) {
      fetchTranslationsBackground(data.language_code);
    }

  } catch (err) {
    $('errorMsg').textContent = err.message;
    $('errorMsg').hidden = false;
    $('workspace').hidden = true;
    segments = [];
    translations = [];
    clearInterval(syncTimer);
  } finally {
    setLoading(false);
  }
});

/* ── BUTTONS ────────────────────────────────────────────── */
$('checkBtn').addEventListener('click',  checkSentence);
$('revealBtn').addEventListener('click', revealAnswer);
$('clearBtn').addEventListener('click', () => {
  wordIdx = 0;
  $('dictInput').value = '';
  $('viBlock').hidden = true;
  viVisible = false;
  renderMasked(current);
  $('resultStat').innerHTML = '';
  setStatus('', '');
  $('dictInput').focus();
});
$('replayBtn').addEventListener('click', () => playSeg(current));
$('prevBtn').addEventListener('click',   () => goTo(current - 1));
$('nextBtn').addEventListener('click',   () => goTo(current + 1));

/* ── KEYBOARD ───────────────────────────────────────────── */
$('dictInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); checkSentence(); return; }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); playSeg(current); }
    if (e.key === 'ArrowRight')          { e.preventDefault(); goTo(current + 1); }
    if (e.key === 'ArrowLeft')           { e.preventDefault(); goTo(current - 1); }
  }
});

/* ── HELPERS ────────────────────────────────────────────── */
function setLoading(on) {
  $('btnLabel').hidden   = on;
  $('btnSpinner').hidden = !on;
  $('startBtn').disabled = on;
  $('videoUrl').disabled = on;
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
