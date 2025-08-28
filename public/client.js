// client.js — simple local-mic flow + /chat endpoint for bot reply.
// Flow: Connect → Start Mic (continuous SR) → Translate → shows You + Bot (both src+tgt), saves, speaks.

let micStream = null;
let rec = null;
let recActive = false;

const connectBtn     = document.getElementById('connectBtn');
const micBtn         = document.getElementById('micBtn');
const translateBtn   = document.getElementById('translateBtn');
const disconnectBtn  = document.getElementById('disconnectBtn');
const connStatus     = document.getElementById('connStatus');
const micStatus      = document.getElementById('micStatus');

const enLine         = document.getElementById('enLine');
const esLine         = document.getElementById('esLine');
const botEnLine      = document.getElementById('botEnLine');
const botEsLine      = document.getElementById('botEsLine');

const youText        = document.getElementById('youText');
const historyContainer = document.getElementById('historyContainer');
const speakToggle    = document.getElementById('speakToggle');
const modeSelect     = document.getElementById('modeSelect');
const clearBtn       = document.getElementById('clearHistoryBtn');

let conversationHistory = [];
try {
  const saved = JSON.parse(localStorage.getItem('rt_history') || '[]');
  if (Array.isArray(saved)) conversationHistory = saved;
} catch {}
updateConversationHistory();

// ---------- State ----------
const State = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTED_IDLE: 'CONNECTED_IDLE',
  MIC_ON: 'MIC_ON',
  TRANSLATING: 'TRANSLATING'
});
let state = State.DISCONNECTED;
setState(State.DISCONNECTED);

function setState(next) {
  state = next;
  // default
  connectBtn.disabled   = true;
  micBtn.disabled       = true;
  translateBtn.disabled = true;
  disconnectBtn.disabled= true;
  modeSelect.disabled   = false;
  speakToggle.disabled  = false;
  clearBtn.disabled     = false;

  if (state === State.DISCONNECTED) {
    connectBtn.disabled = false;
    connStatus.textContent = 'Status: Disconnected';
    micStatus.textContent  = 'Mic: Off';
    micBtn.textContent     = 'Start Mic';
  }
  if (state === State.CONNECTED_IDLE) {
    connectBtn.disabled   = true;
    micBtn.disabled       = false;
    translateBtn.disabled = true;
    disconnectBtn.disabled= false;
    connStatus.textContent = 'Status: Connected';
    micStatus.textContent  = 'Mic: Off';
    micBtn.textContent     = 'Start Mic';
  }
  if (state === State.MIC_ON) {
    connectBtn.disabled   = true;
    micBtn.disabled       = true;   // only Translate active
    translateBtn.disabled = false;
    disconnectBtn.disabled= true;
    modeSelect.disabled   = true;
    speakToggle.disabled  = true;
    clearBtn.disabled     = true;
    connStatus.textContent = 'Status: Connected';
    micStatus.textContent  = 'Mic: On';
  }
  if (state === State.TRANSLATING) {
    connectBtn.disabled   = true;
    micBtn.disabled       = true;
    translateBtn.disabled = true;
    disconnectBtn.disabled= true;
    modeSelect.disabled   = true;
    speakToggle.disabled  = true;
    clearBtn.disabled     = true;
    connStatus.textContent = 'Status: Translating…';
  }
}

// ---------- Helpers ----------
function updateConversationHistory() {
  historyContainer.innerHTML = '';
  [...conversationHistory].reverse().forEach(item => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const youHdr = document.createElement('div');
    youHdr.style.color = '#9aa0aa';
    youHdr.textContent = 'You';
    const youSrc = document.createElement('div');
    const youTgt = document.createElement('div');
    youSrc.textContent = item.you_src || '';
    youTgt.textContent = item.you_tgt || '';

    const botHdr = document.createElement('div');
    botHdr.style.color = '#9aa0aa';
    botHdr.style.marginTop = '8px';
    botHdr.textContent = 'Chatbot';
    const botSrc = document.createElement('div');
    const botTgt = document.createElement('div');
    botSrc.textContent = item.bot_src || '';
    botTgt.textContent = item.bot_tgt || '';

    row.appendChild(youHdr);
    row.appendChild(youSrc);
    row.appendChild(youTgt);
    row.appendChild(botHdr);
    row.appendChild(botSrc);
    row.appendChild(botTgt);
    historyContainer.appendChild(row);
  });
}

let speakingUtterance = null;
function speak(text, langCode) {
  if (!speakToggle.checked || !text) return;
  try {
    if (speakingUtterance) window.speechSynthesis.cancel();
    speakingUtterance = new SpeechSynthesisUtterance(text);
    speakingUtterance.lang = langCode; // 'en-US' or 'es-ES'
    window.speechSynthesis.speak(speakingUtterance);
  } catch {}
}

function setYouLines(src, tgt) {
  const looksSpanish = /[áéíóúñ¿¡]|\bespañol\b|\bgracias\b|\bhola\b|\busted\b|\bseñor\b/i.test(src || '');
  if (looksSpanish) {
    enLine.textContent = `[EN] ${tgt || ''}`;
    esLine.textContent = `[ES] ${src || ''}`;
  } else {
    enLine.textContent = `[EN] ${src || ''}`;
    esLine.textContent = `[ES] ${tgt || ''}`;
  }
}

function setBotLines(src, tgt) {
  const looksSpanish = /[áéíóúñ¿¡]|\bespañol\b|\bgracias\b|\bhola\b|\busted\b|\bseñor\b/i.test(src || '');
  if (looksSpanish) {
    botEnLine.textContent = `[EN] ${tgt || ''}`;
    botEsLine.textContent = `[ES] ${src || ''}`;
  } else {
    botEnLine.textContent = `[EN] ${src || ''}`;
    botEsLine.textContent = `[ES] ${tgt || ''}`;
  }
}

// ---------- Mic + SR ----------
async function ensureMicPermission() {
  try {
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      });
    }
    return true;
  } catch (e) {
    console.error('Mic permission error:', e);
    alert('Microphone permission is required.');
    return false;
  }
}

function makeRecognizerIfNeeded() {
  if (!('webkitSpeechRecognition' in window)) {
    alert('Your browser does not support on-device speech recognition. Use Chrome.');
    return false;
  }
  if (!rec) {
    const SR = window.webkitSpeechRecognition;
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = true;

    rec.onresult = (ev) => {
      let finalText = '', interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      youText.textContent = (finalText || interim || '').trim();
    };
    rec.onend = () => {
      recActive = false;
      if (state === State.MIC_ON) {
        try { rec.start(); recActive = true; } catch {}
      }
    };
    rec.onerror = (e) => {
      console.warn('SpeechRecognition error:', e?.error || e);
    };
  }
  return true;
}

function startRecognition() {
  if (!rec) return;
  try {
    if (!recActive) { rec.start(); recActive = true; }
  } catch {
    setTimeout(() => { try { rec.start(); recActive = true; } catch {} }, 250);
  }
}
function stopRecognition() {
  if (!rec) return;
  try { rec.stop(); } catch {}
  recActive = false;
}
function stopMicTracks() {
  if (!micStream) return;
  micStream.getAudioTracks().forEach(t => t.stop && t.stop());
  micStream = null;
}

// ---------- Buttons ----------
connectBtn.addEventListener('click', async () => {
  const ok = await ensureMicPermission();
  if (!ok) return;
  setState(State.CONNECTED_IDLE);
});

disconnectBtn.addEventListener('click', () => {
  stopRecognition();
  stopMicTracks();
  setState(State.DISCONNECTED);
});

micBtn.addEventListener('click', async () => {
  if (state !== State.CONNECTED_IDLE) return;
  const ok = await ensureMicPermission();
  if (!ok) return;
  if (!makeRecognizerIfNeeded()) return;

  youText.textContent = '';
  startRecognition();
  setState(State.MIC_ON);
});

translateBtn.addEventListener('click', async () => {
  if (state !== State.MIC_ON) return;

  // Freeze mic while we send
  stopRecognition();

  const textToSend = (youText.textContent || '').trim();
  if (!textToSend) { setState(State.CONNECTED_IDLE); return; }

  setState(State.TRANSLATING);
  try {
    const r = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textToSend, mode: modeSelect.value })
    });
    const j = await r.json();

    // You (user)
    const u = j?.user || {};
    const you_src = `[SRC] ${u.src || textToSend}`;
    const you_tgt = `[TGT] ${u.tgt || ''}`;
    setYouLines(u.src || textToSend, u.tgt || '');

    // Bot
    const b = j?.bot || {};
    const bot_src = `[SRC] ${b.src || ''}`;
    const bot_tgt = `[TGT] ${b.tgt || ''}`;
    setBotLines(b.src || '', b.tgt || '');

    // Speak bot's ORIGINAL (opposite language) so it feels like a reply
    const botIsSpanish = /[áéíóúñ¿¡]/.test(b.src || '');
    speak(b.src || '', botIsSpanish ? 'es-ES' : 'en-US');

    // Save one combined turn
    conversationHistory.push({
      you_src, you_tgt, bot_src, bot_tgt
    });
    updateConversationHistory();
    try { localStorage.setItem('rt_history', JSON.stringify(conversationHistory)); } catch {}

    // Clear transcript for next turn
    youText.textContent = '';
  } catch (e) {
    console.error('Chat fetch error:', e);
  } finally {
    setState(State.CONNECTED_IDLE);
  }
});

clearBtn.addEventListener('click', () => {
  conversationHistory = [];
  try { localStorage.removeItem('rt_history'); } catch {}
  updateConversationHistory();
});
