/* ── STATE ──────────────────────────────────────────────── */
let player      = null;
let ytReady     = false;
let pendingId   = null;
let segments    = [];
let current     = 0;
let pauseTimer  = null;
let scores      = {};   // { index: accuracy% }
let revealed    = {};   // { index: true }

/* ── DOM REFS ───────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const urlForm      = $('urlForm');
const videoUrlEl   = $('videoUrl');
const startBtn     = $('startBtn');
const btnLabel     = $('btnLabel');
const btnSpinner   = $('btnSpinner');
const errorMsg     = $('errorMsg');
const workspace    = $('workspace');
const videoMeta    = $('videoMeta');

const segCounter   = $('segCounter');
const overallScore = $('overallScore');
const progressFill = $('progressFill');

const replayBtn    = $('replayBtn');
const prevBtn      = $('prevBtn');
const nextBtn      = $('nextBtn');
const autoAdvance  = $('autoAdvance');

const statusBanner = $('statusBanner');
const statusText   = $('statusText');

const dictInput    = $('dictInput');
const checkBtn     = $('checkBtn');
const revealBtn    = $('revealBtn');
const clearBtn     = $('clearBtn');

const resultArea   = $('resultArea');
const wordRow      = $('wordRow');
const resultStat   = $('resultStat');

/* ── YOUTUBE IFRAME API ─────────────────────────────────── */
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (pendingId) { createPlayer(pendingId); pendingId = null; }
};

function createPlayer(videoId) {
  if (player) {
    player.loadVideoById(videoId);
    player.pauseVideo();
    return;
  }
  player = new YT.Player('ytPlayer', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1, fs: 1, playsinline: 1 },
    events: {
      onReady:       () => { player.pauseVideo(); goTo(0); },
      onStateChange: onYTStateChange,
    },
  });
}

function initPlayer(videoId) {
  if (ytReady) createPlayer(videoId);
  else pendingId = videoId;
}

function onYTStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    setStatus('playing', '▶ Đang phát đoạn ' + (current + 1) + '…');
  }
}

/* ── SEGMENT PLAYBACK ───────────────────────────────────── */
function playSeg(index) {
  if (!player || !segments[index]) return;
  const seg = segments[index];
  clearTimeout(pauseTimer);
  player.seekTo(seg.start, true);
  player.playVideo();
  const ms = seg.duration * 1000 + 600;
  pauseTimer = setTimeout(() => {
    player.pauseVideo();
    setStatus('waiting', '⌨ Gõ những gì bạn vừa nghe, rồi nhấn Enter.');
  }, ms);
}

/* ── NAVIGATION ─────────────────────────────────────────── */
function goTo(index) {
  if (index < 0 || index >= segments.length) return;
  clearTimeout(pauseTimer);
  current = index;
  hideResult();
  dictInput.value = '';
  dictInput.disabled = false;
  dictInput.focus();
  updateProgress();
  setStatus('', 'Đang tải đoạn…');
  playSeg(current);
}

/* ── CHECK ──────────────────────────────────────────────── */
function checkAnswer() {
  const input    = dictInput.value;
  const expected = segments[current].text;
  if (!input.trim()) { dictInput.focus(); return; }

  const result = compare(input, expected);
  scores[current] = result.accuracy;
  showResult(result, false);
  updateProgress();

  if (result.accuracy === 100 && autoAdvance.checked) {
    setTimeout(() => goTo(current + 1), 1400);
  }
}

function revealAnswer() {
  const expected = segments[current].text;
  revealed[current] = true;
  scores[current] = scores[current] ?? 0;

  wordRow.innerHTML = expected.split(/\s+/).map(w =>
    `<span class="word word-revealed">${esc(w)}</span>`
  ).join(' ');
  resultStat.innerHTML = '<span style="color:var(--muted);font-size:.82rem">Đáp án đã được hiển thị.</span>';
  resultArea.hidden = false;
  setStatus('checked', '✓ Đã xem đáp án');
  updateProgress();
}

/* ── COMPARISON ─────────────────────────────────────────── */
function normalize(s) {
  return s.toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function compare(input, expected) {
  const inp = normalize(input);
  const exp = normalize(expected);
  const len  = Math.max(inp.length, exp.length);
  let correct = 0;
  const tokens = [];

  for (let i = 0; i < exp.length; i++) {
    if (inp[i] === exp[i]) {
      tokens.push({ word: exp[i], cls: 'word-correct' });
      correct++;
    } else if (inp[i] === undefined) {
      tokens.push({ word: exp[i], cls: 'word-missing' });
    } else {
      // show what user typed as incorrect, then the expected
      tokens.push({ word: inp[i], cls: 'word-incorrect' });
    }
  }
  // extra words user typed beyond expected length
  for (let i = exp.length; i < inp.length; i++) {
    tokens.push({ word: inp[i], cls: 'word-extra' });
  }

  const accuracy = exp.length ? Math.round((correct / exp.length) * 100) : 0;
  return { tokens, accuracy, correct, total: exp.length };
}

function showResult(result, isReveal) {
  wordRow.innerHTML = result.tokens
    .map(t => `<span class="word ${t.cls}">${esc(t.word)}</span>`)
    .join(' ');

  const chipCls = result.accuracy >= 80 ? 'acc-great'
                : result.accuracy >= 50 ? 'acc-ok'
                : 'acc-poor';
  resultStat.innerHTML =
    `<span class="acc-chip ${chipCls}">${result.accuracy}%</span>` +
    `<span style="color:var(--muted)">${result.correct}/${result.total} từ đúng</span>`;
  resultArea.hidden = false;

  const emoji = result.accuracy === 100 ? '🎉 Hoàn hảo!' : result.accuracy >= 80 ? '👍 Rất tốt!' : result.accuracy >= 50 ? '🙂 Khá tốt' : '💪 Cố lên!';
  setStatus('checked', emoji + '  ' + result.accuracy + '% chính xác');
}

function hideResult() {
  resultArea.hidden = true;
  wordRow.innerHTML  = '';
  resultStat.innerHTML = '';
}

/* ── PROGRESS UI ────────────────────────────────────────── */
function updateProgress() {
  const total = segments.length;
  segCounter.textContent = `${current + 1} / ${total}`;
  progressFill.style.width = `${((current + 1) / total) * 100}%`;

  prevBtn.disabled = current === 0;
  nextBtn.disabled = current === total - 1;

  const vals = Object.values(scores);
  if (vals.length) {
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    overallScore.textContent = `Điểm TB: ${avg}%`;
  }
}

/* ── STATUS BANNER ──────────────────────────────────────── */
function setStatus(type, msg) {
  statusBanner.className = 'status-banner';
  if (type) statusBanner.classList.add(type);
  statusText.textContent = msg;
}

/* ── FORM SUBMIT ────────────────────────────────────────── */
urlForm.addEventListener('submit', async e => {
  e.preventDefault();
  const url = videoUrlEl.value.trim();
  if (!url) return;

  setLoading(true);
  hideError();

  try {
    const res  = await fetch(`/api/transcript?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Lỗi không xác định');

    segments = data.segments;
    current  = 0;
    scores   = {};
    revealed = {};

    // show workspace
    workspace.hidden = false;
    workspace.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // meta badges
    videoMeta.innerHTML =
      `<span class="badge">${esc(data.language)}</span>` +
      (data.is_generated ? `<span class="badge badge-auto">Auto-generated</span>` : '');

    initPlayer(data.video_id);
    updateProgress();
    setStatus('', 'Đang khởi động trình phát…');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

/* ── BUTTON EVENTS ──────────────────────────────────────── */
checkBtn.addEventListener('click',  checkAnswer);
revealBtn.addEventListener('click', revealAnswer);
clearBtn.addEventListener('click',  () => { dictInput.value = ''; hideResult(); dictInput.focus(); });
replayBtn.addEventListener('click', () => playSeg(current));
prevBtn.addEventListener('click',   () => goTo(current - 1));
nextBtn.addEventListener('click',   () => goTo(current + 1));

/* ── KEYBOARD SHORTCUTS ─────────────────────────────────── */
dictInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); checkAnswer(); return; }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'r' || e.key === 'R')       { e.preventDefault(); playSeg(current); }
    if (e.key === 'ArrowRight')                { e.preventDefault(); goTo(current + 1); }
    if (e.key === 'ArrowLeft')                 { e.preventDefault(); goTo(current - 1); }
  }
});

/* ── HELPERS ────────────────────────────────────────────── */
function setLoading(on) {
  btnLabel.hidden   = on;
  btnSpinner.hidden = !on;
  startBtn.disabled = on;
  videoUrlEl.disabled = on;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
