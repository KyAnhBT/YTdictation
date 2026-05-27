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
let inDictation  = false; // true while playSeg() timer is active — blocks startSync from overriding current
let targetLang   = 'vi'; // target translation language

function getLangFlag() {
  const sel = $('targetLang');
  if (!sel) return '🌐';
  const text = sel.options[sel.selectedIndex]?.text || '';
  // Flag emojis are regional indicator pairs — grab first non-space cluster
  const m = text.match(/^[^\s]+/);
  return m ? m[0] : '🌐';
}

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
          setStatus('playing', '▶ Playing segment ' + (current + 1) + '…');
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
  inDictation = true;
  player.seekTo(seg.start, true);
  player.playVideo();
  pauseTimer = setTimeout(() => {
    inDictation = false;
    player.pauseVideo();
    setStatus('waiting', '⌨ Type what you just heard, then press Enter.');
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
    ? `<span style="color:var(--muted);font-size:.82rem">${wordIdx} / ${exp.length} words</span>`
    : '';
  $('resultArea').style.display = 'flex';
}

function checkSentence() {
  const val  = $('dictInput').value.trim();
  const typed = val ? normalize(val) : [];
  const raw   = segments[current].text.trim().split(/\s+/);
  const exp   = normalize(segments[current].text);

  // Always check from exp[0]: user must type the full sentence from the start
  let matched = 0;
  for (let i = 0; i < typed.length && i < exp.length; i++) {
    if (typed[i] === exp[i]) matched++;
    else break;
  }

  wordIdx = matched;

  if (wordIdx >= exp.length) {
    scores[current] = 100;
    updateProgress();
    $('wordRow').innerHTML = raw.map(w => `<span class="word word-correct">${esc(w)}</span>`).join(' ');
    $('resultStat').innerHTML = '';
    $('resultArea').style.display = 'flex';
    setStatus('checked', '🎉 Perfect!');
    showTranslation(current);
    if ($('autoAdvance').checked) setTimeout(() => goTo(current + 1), 1400);
  } else {
    renderMasked(current, wordIdx);
    const hintWord = raw[wordIdx] || '';
    setStatus('waiting', wordIdx > 0
      ? `✓ ${wordIdx} correct — next word: "${hintWord}"`
      : (typed.length > 0
          ? `⚠ Wrong — next word: "${hintWord}"`
          : `Next word: "${hintWord}"`));
    $('dictInput').focus();
  }
}

function revealAnswer() {
  const raw = segments[current].text.trim().split(/\s+/);
  wordIdx = normalize(segments[current].text).length;
  scores[current] = scores[current] ?? 0;
  $('wordRow').innerHTML = raw.map(w => `<span class="word word-revealed">${esc(w)}</span>`).join(' ');
  $('resultStat').innerHTML = '<span style="color:var(--muted);font-size:.82rem">Answer revealed.</span>';
  $('resultArea').style.display = 'flex';
  showTranslation(current);
  setStatus('checked', '✓ Answer revealed');
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
    $('viText').textContent = 'Translating…';
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
    .replace(/[‘’‚‛′‵`´]/g, "’") // Unicode apostrophes → ASCII
    .replace(/[^\w\s'-]/g, ' ')  // keep hyphens so "ex-boyfriends" stays 1 token
    .trim().split(/\s+/).filter(Boolean);
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
      `Avg: ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}%`;
}

/* ── STATUS ─────────────────────────────────────────────── */
function setStatus(type, msg) {
  $('statusBanner').hidden    = !msg;
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
  // refresh vi-block only if result area is actually visible and vi was shown
  if ($('resultArea').style.display !== 'none' && viVisible) showTranslation(current);
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
    if (inDictation) return; // playSeg() is controlling playback — don't override current
    const time = player.getCurrentTime();
    const idx  = segments.findIndex(s => time >= s.start && time < s.start + s.duration);
    if (idx !== -1 && idx !== current) {
      current = idx;
      updateProgress();
      if (activeTab === 'trans') highlightTransSeg(current, true);
    }
  }, 400);
}

/* ── LANGUAGE CHANGE ────────────────────────────────────── */
function onLangChange() {
  targetLang = $('targetLang').value;
  if ($('viLabel')) $('viLabel').textContent = getLangFlag();
  // Clear current translations and re-fetch in new language
  if (segments.length === 0) return;
  translations = new Array(segments.length).fill(null);
  hideResult();
  renderTranscriptList();
  fetchTranslationsBackground(targetLang);
}

/* ── BACKGROUND TRANSLATION FETCH ──────────────────────── */
async function fetchTranslationsBackground(lang) {
  lang = lang || targetLang;
  $('tabBtnTrans').dataset.loading = '1';
  updateTabLabel(true);

  try {
    const res  = await fetch('/api/translate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ texts: segments.map(s => s.text), target: lang }),
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
    if (!res.ok) throw new Error(data.detail || 'Unknown error');

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

    // Update flag icon to match selected language
    if ($('viLabel')) $('viLabel').textContent = getLangFlag();

    // Fetch translation if: YouTube had no VI translation, OR user chose a non-VI language
    if (targetLang !== 'vi') {
      translations = new Array(segments.length).fill(null); // clear YouTube's VI translations
      fetchTranslationsBackground(targetLang);
    } else if (data.need_translate) {
      fetchTranslationsBackground('vi');
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
  hideResult();
  setStatus('', '');
  $('dictInput').focus();
});
$('replayBtn').addEventListener('click', () => playSeg(current));
$('prevBtn').addEventListener('click',   () => goTo(current - 1));
$('nextBtn').addEventListener('click',   () => goTo(current + 1));

/* ── KEYBOARD ───────────────────────────────────────────── */
$('dictInput').addEventListener('input', () => {
  $('resultArea').style.display = 'none';
  $('viBlock').hidden = true;   // hide translation while typing
  viVisible = false;
  $('statusBanner').hidden = true;  // hide hint banner while typing
});

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
