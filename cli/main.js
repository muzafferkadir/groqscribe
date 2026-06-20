#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import process from 'node:process';
import readline from 'node:readline';
import { createWavBuffer, SilenceSegmenter } from '../src/audioUtils.js';
import { getWhisperLanguageName, looksLikeTurkishText, normalizeWhisperLanguage, transcribeAudioChunk, translateText, WHISPER_LANGUAGE_OPTIONS } from '../src/groqClient.js';
import { RequestRateLimiter, normalizeUsage } from '../src/rateLimiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const GLOBAL_CONFIG_DIR = join(homedir(), '.meet-groq-tr');
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');
const BUNDLED_SYSTEM_AUDIO_HELPER_BASE64 = typeof __SYSTEM_AUDIO_HELPER_BASE64__ === 'string' ? __SYSTEM_AUDIO_HELPER_BASE64__ : '';
const BUNDLED_SYSTEM_AUDIO_HELPER_PLATFORM = typeof __SYSTEM_AUDIO_HELPER_PLATFORM__ === 'string' ? __SYSTEM_AUDIO_HELPER_PLATFORM__ : '';
const BUNDLED_SYSTEM_AUDIO_HELPER_ARCH = typeof __SYSTEM_AUDIO_HELPER_ARCH__ === 'string' ? __SYSTEM_AUDIO_HELPER_ARCH__ : '';

const DEFAULTS = {
  sampleRate: 16000,
  channels: 1,
  frameMs: 100,
  silenceMs: 1000,
  threshold: 0.012,
  minSegmentMs: 5000,
  maxSegmentMs: 30000,
  longSegmentMs: 20000,
  longSegmentSilenceMs: 200,
  speechModel: 'whisper-large-v3-turbo',
  chatModel: 'llama-3.1-8b-instant',
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  maxTranscribePerMinute: 18,
  maxTranscribePerDay: 1900,
  listenMic: false,
  listenSystemAudio: true,
  autoSetupAudio: true,
};

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  printHelp();
  process.exit(0);
}
if (args.listDevices) {
  listDevices();
  process.exit(0);
}
if (args.uninstall) {
  await selfUninstall(args);
  process.exit(0);
}

const apiKey = await resolveApiKey(args);
const outputPath = resolve(process.cwd(), args.output || defaultTranscriptionFilename());
let config = buildConfig(args);
const state = {
  running: false,
  paused: false,
  stopping: false,
  showSettings: true,
  showOriginal: !args.noOriginal,
  status: 'Preparing...',
  error: '',
  lines: [],
  logs: [],
  segmentNo: 0,
  pendingQueue: 0,
  pendingQueues: { mic: 0, system: 0 },
  currentRequests: {},
  lastQuota: null,
  startedAt: Date.now(),
  outputPath,
  activeSources: [],
  transcriptScroll: 0,
  translateEnabled: Boolean(args.translate) && !args.noTranslate,
};

const captures = new Map();
const sourceQueues = new Map();
let quotaQueue = Promise.resolve();
let renderTimer = null;
let needsRender = true;

const usageFile = args.usageFile || join(GLOBAL_CONFIG_DIR, `usage-${hashApiKey(apiKey || 'no-key')}.json`);
const transcriptionLimiter = new RequestRateLimiter({
  maxPerMinute: Number(args.maxTranscribePerMinute || DEFAULTS.maxTranscribePerMinute),
  maxPerDay: Number(args.maxTranscribePerDay || DEFAULTS.maxTranscribePerDay),
  loadUsage: async () => loadUsageFile(usageFile),
  saveUsage: async (usage) => saveUsageFile(usageFile, usage),
});

setupTerminal();
startRenderLoop();

if (!apiKey) {
  state.error = 'GROQ_API_KEY missing. Get one at https://console.groq.com/keys — example: export GROQ_API_KEY="gsk_..."';
  state.status = 'Startup failed';
  requestRender();
} else {
  await startCaptures().catch((error) => {
    state.error = error.message;
    state.status = 'Startup failed';
    requestRender();
  });
}

async function startCaptures() {
  if (state.running) return;
  state.error = '';
  state.status = 'Preparing audio sources...';
  requestRender();

  const sources = resolveSources(config);
  const started = [];
  for (const source of sources) {
    try {
      const capture = await startOneCapture(source);
      captures.set(source, capture);
      started.push(source);
    } catch (error) {
      const sourceName = source === 'mic' ? 'Microphone' : 'System audio';
      const message = `${sourceName} could not start: ${error.message}`;
      log(message);
      state.error = message;
    }
  }

  state.activeSources = started;
  state.running = started.length > 0;
  state.paused = false;
  state.status = started.length
    ? `Listening: ${started.join(' + ')}`
    : 'No audio source could be started';
  log(`Output file: ${outputPath}`);
  requestRender();
}

async function startOneCapture(source) {
  const capturePlan = buildCapturePlan(args, DEFAULTS, source);
  const segmenter = new SilenceSegmenter({
    sampleRate: Number(args.sampleRate || DEFAULTS.sampleRate),
    channels: Number(args.channels || DEFAULTS.channels),
    frameMs: Number(args.frameMs || DEFAULTS.frameMs),
    silenceMs: Number(args.silenceMs || DEFAULTS.silenceMs),
    threshold: Number(args.threshold || DEFAULTS.threshold),
    minSegmentMs: Number(args.minSegmentMs || DEFAULTS.minSegmentMs),
    maxSegmentMs: Number(args.maxSegmentMs || DEFAULTS.maxSegmentMs),
    longSegmentMs: Number(args.longSegmentMs || DEFAULTS.longSegmentMs),
    longSegmentSilenceMs: Number(args.longSegmentSilenceMs || DEFAULTS.longSegmentSilenceMs),
  });

  const ffmpeg = spawn(capturePlan.command || args.ffmpeg || 'ffmpeg', capturePlan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = { source, ffmpeg, segmenter, label: capturePlan.label, stopping: false };

  ffmpeg.stdout.on('data', (chunk) => {
    if (state.paused || !captures.has(source)) return;
    const emitted = segmenter.push(chunk);
    for (const segment of emitted) enqueueSegment(segment, source);
    requestRender();
  });

  ffmpeg.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (/error|not found|permission|denied|invalid/i.test(text)) {
      state.error = `[${source}] ${text.split('\n').slice(-2).join(' ')}`;
      log(state.error);
      requestRender();
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    if (state.stopping || capture.stopping) return;
    const pending = segmenter.flush();
    if (pending) enqueueSegment(pending, source);
    captures.delete(source);
    state.activeSources = [...captures.keys()];
    state.running = captures.size > 0;
    state.status = `${source} exited: code=${code ?? '-'} signal=${signal ?? '-'}`;
    requestRender();
  });

  return capture;
}

async function stopCaptures() {
  if (!state.running && captures.size === 0) return;
  state.stopping = true;
  state.status = 'Stopping...';

  for (const [source, capture] of captures) {
    capture.stopping = true;
    const pending = capture.segmenter?.flush();
    if (pending) enqueueSegment(pending, source);
    capture.ffmpeg?.kill('SIGTERM');
  }

  captures.clear();
  state.activeSources = [];
  state.running = false;
  state.paused = false;
  await waitForSourceQueues();
  state.stopping = false;
  state.status = 'Stopped';
  requestRender();
}

function enqueueSegment(segment, source) {
  state.segmentNo += 1;
  state.pendingQueue += 1;
  state.pendingQueues[source] = (state.pendingQueues[source] || 0) + 1;
  const currentNo = state.segmentNo;
  const previousQueue = sourceQueues.get(source) || Promise.resolve();
  const nextQueue = previousQueue
    .then(() => processSegment(currentNo, segment, source))
    .catch((error) => {
      state.error = `[${currentNo}] ${source}: ${error.message}`;
      log(`[${source}] Groq error: ${error.message}`);
    })
    .finally(() => {
      clearCurrentRequest(source, currentNo);
      state.pendingQueue = Math.max(0, state.pendingQueue - 1);
      state.pendingQueues[source] = Math.max(0, (state.pendingQueues[source] || 0) - 1);
      if (sourceQueues.get(source) === nextQueue && state.pendingQueues[source] === 0) sourceQueues.delete(source);
      requestRender();
    });
  sourceQueues.set(source, nextQueue);
}

function setCurrentRequest(source, request) {
  state.currentRequests = { ...state.currentRequests, [source]: request };
}

function clearCurrentRequest(source, no) {
  if (state.currentRequests[source]?.no !== no) return;
  const next = { ...state.currentRequests };
  delete next[source];
  state.currentRequests = next;
}

async function waitForSourceQueues() {
  await Promise.allSettled([...sourceQueues.values()]);
}

function acquireTranscriptionQuota() {
  const acquisition = quotaQueue.then(() => transcriptionLimiter.acquire());
  quotaQueue = acquisition.catch(() => {});
  return acquisition;
}

async function processSegment(no, segment, source) {
  const duration = (segment.durationMs / 1000).toFixed(1);
  setCurrentRequest(source, { no, source });
  state.status = `[${no}] ${source}: ${duration}s segment is being sent to Groq...`;
  requestRender();

  const wavBuffer = createWavBuffer(segment.pcm, {
    sampleRate: Number(args.sampleRate || DEFAULTS.sampleRate),
    channels: Number(args.channels || DEFAULTS.channels),
  });

  const quota = await acquireTranscriptionQuota();
  state.lastQuota = quota;

  const original = await transcribeAudioChunk({
    apiKey,
    audioBlob: new Blob([wavBuffer], { type: 'audio/wav' }),
    audioFileName: `segment-${no}-${source}.wav`,
    model: args.speechModel || DEFAULTS.speechModel,
    language: whisperLanguageParam(),
    prompt: args.prompt,
  });

  if (!original) {
    state.status = `[${no}] Empty transcript`;
    return;
  }

  const translated = shouldSkipTranslation(original)
    ? original
    : await translateText({
        apiKey,
        text: original,
        targetLanguage: config.targetLanguage,
        model: args.chatModel || DEFAULTS.chatModel,
      });

  const timestamp = new Date().toLocaleTimeString();
  const item = { no, source, timestamp, text: translated || original, original };
  state.lines.push(item);
  if (state.lines.length > 300) state.lines.shift();
  if (state.transcriptScroll > 0) state.transcriptScroll += 1;

  appendTranscript(outputPath, item, state.showOriginal);
  state.status = `[${no}] Saved: ${basename(state.outputPath)}`;
  requestRender();
}

function isTranslationEnabled() {
  return state.translateEnabled;
}

function shouldSkipTranslation(text) {
  if (!isTranslationEnabled()) return true;
  const targetLanguage = String(config.targetLanguage || '').toLowerCase();
  const sourceLanguage = normalizeWhisperLanguage(config.sourceLanguage);
  if (sourceLanguage && sourceLanguage === targetLanguage) return true;
  return targetLanguage === 'tr' && looksLikeTurkishText(text);
}

function appendTranscript(path, item, includeOriginal) {
  const block = [`[${item.timestamp}] [${item.source}] ${item.text}`];
  if (includeOriginal && item.original && item.original !== item.text) block.push(`Original: ${item.original}`);
  appendFileSync(path, `${block.join('\n')}\n\n`);
}

function defaultTranscriptionFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // transcription_ss_hh_DD_MM_YY.txt — second, minute, day, month, 2-digit year
  const ss = pad(now.getSeconds());
  const hh = pad(now.getMinutes());
  const DD = pad(now.getDate());
  const MM = pad(now.getMonth() + 1);
  const YY = String(now.getFullYear()).slice(-2);
  return `transcription_${ss}_${hh}_${DD}_${MM}_${YY}.txt`;
}

function setupTerminal() {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', async (_str, key) => {
    if (key?.ctrl && key.name === 'c') return shutdown();
    if (key?.name === 'q') return shutdown();
    if (key?.name === 'space') return togglePause();
    if (key?.name === 's') return toggleSettings();
    if (key?.name === 'o') return toggleOriginal();
    if (key?.name === 'm') return toggleSource('mic');
    if (key?.name === 'b' || key?.name === 'c') return toggleSource('system');
    if (key?.name === 'r') return restartCaptures();
    if (key?.name === 'l') return cycleWhisperLanguage();
    if (key?.name === 'up') return scrollTranscript(1);
    if (key?.name === 'down') return scrollTranscript(-1);
    if (key?.name === 'pageup') return scrollTranscript(10);
    if (key?.name === 'pagedown') return scrollTranscript(-10);
    if (key?.name === 't') return toggleTranslation();
    if (key?.name === 'g') return cycleTargetLanguage();
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startRenderLoop() {
  renderTimer = setInterval(() => {
    // re-render every tick while capturing so the REC dots can blink
    if (needsRender || isCapturingLive()) render();
  }, 120);
  render();
}

function requestRender() {
  needsRender = true;
}

function isCapturingLive() {
  return state.running && !state.paused && captures.size > 0;
}

function scrollTranscript(delta) {
  if (!state.lines.length) return;
  const max = Math.max(0, state.lines.length - 1);
  state.transcriptScroll = Math.max(0, Math.min(max, state.transcriptScroll + delta));
  requestRender();
}

function render() {
  needsRender = false;
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const settingsWidth = state.showSettings ? Math.min(38, Math.floor(width * 0.38)) : 0;
  const mainWidth = width - settingsWidth - (settingsWidth ? 1 : 0);
  // header(1) + footer(1) + output(1) = 3 reserved rows, so the content
  // (transcript + sidebar) fills everything in between and footer/output
  // sit on the very last two rows without overlapping the sidebar.
  const contentHeight = Math.max(5, height - 3);

  const screen = [];
  const indicators = recordingIndicators();
  const indLen = stripAnsi(indicators).length;
  const statusText = trim(state.status, width - 14 - indLen - (indLen ? 1 : 0));
  screen.push(color(` groqscribe `, 'inverse') + ' ' + indicators + (indLen ? ' ' : '') + statusText);

  const transcriptRows = buildTranscriptRows(mainWidth, contentHeight);
  const settingsRows = state.showSettings ? buildSettingsRows(settingsWidth, contentHeight) : [];
  for (let i = 0; i < contentHeight; i += 1) {
    const left = pad(transcriptRows[i] || '', mainWidth);
    if (state.showSettings) screen.push(`${left}${color('│', 'dim')}${pad(settingsRows[i] || '', settingsWidth)}`);
    else screen.push(left);
  }

  const footer = ' Space:pause  M:mic  B:system  L:src lang  G:target  T:translate  R:restart  S:panel  O:original  ↑↓:scroll  Q:quit ';
  screen.push(color(trim(footer, width), 'inverse'));
  screen.push(color(trim(` Output: ${state.outputPath}`, width), 'dim'));
  process.stdout.write('\x1b[H\x1b[2J' + screen.join('\n'));
}

function buildTranscriptRows(width, height) {
  const rows = [];
  rows.push(color('─'.repeat(Math.max(1, width - 1)), 'dim'));

  if (state.transcriptScroll > 0 && state.lines.length) {
    rows.push(color(`↑ older transcript (${state.transcriptScroll} back) — press ↓ to return to live`, 'yellow'));
  }

  if (state.error) rows.push(color(`Error: ${state.error}`, 'red'));
  if (!state.lines.length) rows.push(color('No transcript yet. Detected speech/audio will appear here.', 'dim'));

  const items = state.lines.slice().reverse();
  const offset = Math.min(state.transcriptScroll, Math.max(0, items.length));
  for (const item of items.slice(offset)) {
    const badge = item.source === 'mic' ? color('● MIC', 'cyan') : color('● SYS', 'magenta');
    rows.push(`${color(`#${item.no}`, 'dim')} ${color(item.timestamp, 'dim')}  ${badge}`);
    rows.push(...wrap(item.text, width));
    if (state.showOriginal && item.original && item.original !== item.text) {
      rows.push(...wrap(`Original: ${item.original}`, width).map((line) => color(line, 'dim')));
    }
    rows.push('');
  }

  while (rows.length < height) rows.push('');
  return rows.slice(0, height);
}

function sourceStateLabel(source, desired) {
  if (!desired) return 'off';
  return captures.has(source) ? 'on/active' : 'on/inactive';
}

function recordingIndicators() {
  const blinkOn = Math.floor(Date.now() / 600) % 2 === 0;
  const parts = [];
  for (const source of ['mic', 'system']) {
    const desired = source === 'mic' ? config.listenMic : config.listenSystemAudio;
    if (!desired) continue;
    const capturing = captures.has(source);
    const label = source === 'mic' ? 'MIC' : 'SYS';
    if (capturing && state.running && !state.paused) {
      const dot = blinkOn ? color('●', 'red') : color('●', 'dim');
      parts.push(`${dot} ${label}`);
    } else if (capturing) {
      parts.push(`${color('●', 'dim')} ${label}`);
    } else {
      parts.push(`${color('○', 'dim')} ${label}`);
    }
  }
  return parts.join('  ');
}

function formatCurrentRequests() {
  const active = ['mic', 'system']
    .map((source) => state.currentRequests[source] ? `${source}#${state.currentRequests[source].no}` : '')
    .filter(Boolean);
  return active.join(' + ') || 'idle';
}

function formatPendingQueues() {
  const mic = state.pendingQueues.mic || 0;
  const system = state.pendingQueues.system || 0;
  return `mic ${mic} / system ${system} / total ${state.pendingQueue}`;
}

function buildSettingsRows(width, height) {
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  const sep = () => color('─'.repeat(Math.max(1, width - 1)), 'dim');
  const group = (title) => color(color(title, 'bold'), 'dim');
  const kv = (label, value) => `  ${color(label.padEnd(11), 'dim')}${value}`;
  const translateState = isTranslationEnabled() ? color('on', 'green') : color('off', 'dim');

  const rows = [
    color(' Settings', 'bold'),
    sep(),
    group('LANGUAGES'),
    kv('Source', formatWhisperLanguage(config.sourceLanguage)),
    kv('Target', formatWhisperLanguage(config.targetLanguage)),
    kv('Translate', `${translateState} ${color('(T to toggle)', 'dim')}`),
    sep(),
    group('SOURCES'),
    kv('Microphone', sourceStateLabel('mic', config.listenMic)),
    kv('System', sourceStateLabel('system', config.listenSystemAudio)),
    kv('Active', state.activeSources.join('+') || color('-', 'dim')),
    sep(),
    group('CAPTURE'),
    kv('Recording', state.running && !state.paused ? 'continuous' : state.paused ? 'paused' : 'off'),
    kv('Elapsed', formatDuration(elapsed)),
    kv('Status', state.paused ? 'paused' : state.running ? 'running' : 'off'),
    kv('Groq req', formatCurrentRequests()),
    kv('Queue', formatPendingQueues()),
    sep(),
    group('MODEL & LIMITS'),
    kv('Speech', args.speechModel || DEFAULTS.speechModel),
    kv('Chat model', isTranslationEnabled() ? args.chatModel || DEFAULTS.chatModel : color('-', 'dim')),
    kv('Limits', `${args.maxTranscribePerMinute || DEFAULTS.maxTranscribePerMinute}/min · ${args.maxTranscribePerDay || DEFAULTS.maxTranscribePerDay}/day`),
    kv('Quota', state.lastQuota ? `${state.lastQuota.usedThisMinute}/${args.maxTranscribePerMinute || DEFAULTS.maxTranscribePerMinute} · ${state.lastQuota.usedToday}/${args.maxTranscribePerDay || DEFAULTS.maxTranscribePerDay}` : color('-', 'dim')),
    sep(),
    group('TUNING'),
    kv('Segment', `min ${args.minSegmentMs || DEFAULTS.minSegmentMs}ms`),
    kv('Silence', `${args.silenceMs || DEFAULTS.silenceMs}ms`),
    kv('Long sil.', `${args.longSegmentSilenceMs || DEFAULTS.longSegmentSilenceMs}ms`),
    kv('Threshold', String(args.threshold || DEFAULTS.threshold)),
    sep(),
    group('SHORTCUTS'),
    '  Space pause   M mic    B system',
    '  L src lang    G target  T translate',
    '  R restart     S panel   O original',
    '  ↑↓ scroll     Q quit',
  ];
  while (rows.length < height) rows.push('');
  return rows.slice(0, height).map((row) => trim(row, width));
}

async function togglePause() {
  if (!state.running) return startCaptures().catch((error) => { state.error = error.message; requestRender(); });
  state.paused = !state.paused;
  state.status = state.paused ? 'Paused' : 'Listening';
  requestRender();
}

function toggleSettings() {
  state.showSettings = !state.showSettings;
  requestRender();
}

function toggleOriginal() {
  state.showOriginal = !state.showOriginal;
  requestRender();
}

function whisperLanguageParam() {
  const language = normalizeWhisperLanguage(config.sourceLanguage);
  return language === 'auto' ? undefined : language;
}

function cycleWhisperLanguage() {
  const current = normalizeWhisperLanguage(config.sourceLanguage);
  const index = WHISPER_LANGUAGE_OPTIONS.findIndex(([code]) => code === current);
  const next = WHISPER_LANGUAGE_OPTIONS[(index + 1) % WHISPER_LANGUAGE_OPTIONS.length][0];
  config = { ...config, sourceLanguage: next };
  saveGlobalConfig({ language: next });
  state.status = `Whisper language: ${formatWhisperLanguage(next)}`;
  requestRender();
}

function formatWhisperLanguage(language) {
  const normalized = normalizeWhisperLanguage(language);
  return `${normalized} (${getWhisperLanguageName(normalized)})`;
}

function toggleTranslation() {
  state.translateEnabled = !state.translateEnabled;
  state.status = state.translateEnabled
    ? `Translation on → ${formatWhisperLanguage(config.targetLanguage)}`
    : 'Translation off';
  requestRender();
}

function cycleTargetLanguage() {
  const options = WHISPER_LANGUAGE_OPTIONS.filter(([code]) => code !== 'auto');
  const current = String(config.targetLanguage || 'en').toLowerCase();
  const index = options.findIndex(([code]) => code === current);
  const next = options[(index + 1) % options.length][0];
  config = { ...config, targetLanguage: next };
  saveGlobalConfig({ targetLanguage: next });
  state.status = `Target language: ${formatWhisperLanguage(next)}`;
  requestRender();
}

async function toggleSource(source) {
  const key = source === 'mic' ? 'listenMic' : 'listenSystemAudio';
  config = { ...config, [key]: !config[key] };

  if (!config[key]) {
    await stopOneCapture(source);
    state.status = `${source === 'mic' ? 'Microphone' : 'System audio'} disabled`;
    requestRender();
    return;
  }

  if (!apiKey) {
    state.error = 'GROQ_API_KEY is missing; source could not start.';
    requestRender();
    return;
  }

  if (captures.has(source)) return;
  try {
    const capture = await startOneCapture(source);
    captures.set(source, capture);
    state.activeSources = [...captures.keys()];
    state.running = captures.size > 0;
    state.paused = false;
    state.status = `${source === 'mic' ? 'Microphone' : 'System audio'} enabled`;
  } catch (error) {
    config = { ...config, [key]: false };
    state.error = error.message;
    state.status = `${source} could not start`;
  }
  requestRender();
}

async function stopOneCapture(source) {
  const capture = captures.get(source);
  if (!capture) {
    state.activeSources = [...captures.keys()];
    state.running = captures.size > 0;
    return;
  }
  capture.stopping = true;
  const pending = capture.segmenter?.flush();
  if (pending) enqueueSegment(pending, source);
  capture.ffmpeg?.kill('SIGTERM');
  captures.delete(source);
  state.activeSources = [...captures.keys()];
  state.running = captures.size > 0;
  if (!state.running) state.paused = false;
}

async function restartCaptures() {
  await stopCaptures();
  await startCaptures().catch((error) => {
    state.error = error.message;
    state.status = 'Restart failed';
  });
  requestRender();
}

async function shutdown() {
  if (state.stopping) return;
  state.stopping = true;
  clearInterval(renderTimer);
  try {
    for (const [source, capture] of captures) {
      capture.stopping = true;
      const pending = capture.segmenter?.flush();
      if (pending) enqueueSegment(pending, source);
      capture.ffmpeg?.kill('SIGTERM');
    }
    captures.clear();
    await waitForSourceQueues();
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.log(`Transcription saved: ${outputPath}`);
    process.exit(0);
  }
}

function buildCapturePlan(options, defaults, source) {
  const sampleRate = String(options.sampleRate || defaults.sampleRate);
  const channels = String(options.channels || defaults.channels);
  const commonOutput = ['-vn', '-acodec', 'pcm_s16le', '-ar', sampleRate, '-ac', channels, '-f', 's16le', 'pipe:1'];

  if (options.inputArgs) return { label: `custom ffmpeg args`, args: [...splitShellLike(options.inputArgs), ...commonOutput] };

  if (process.platform === 'darwin') {
    if (source === 'system' && options.systemBackend !== 'virtual') {
      const helper = ensureSystemAudioHelper(options);
      if (helper) return { label: 'system / ScreenCaptureKit capture', command: helper, args: [] };
      log('ScreenCaptureKit helper could not be prepared; falling back to virtual audio device.');
    }

    if (!commandExists(options.ffmpeg || 'ffmpeg')) throw new Error('ffmpeg was not found. macOS: brew install ffmpeg');
    const device = resolveMacAudioDevice(source, options.device);
    const input = device.startsWith(':') ? device : `:${device}`;
    return { label: `${source} / ${device}`, args: ['-hide_banner', '-loglevel', 'warning', '-f', 'avfoundation', '-i', input, ...commonOutput] };
  }

  if (!commandExists(options.ffmpeg || 'ffmpeg')) throw new Error('ffmpeg was not found. macOS: brew install ffmpeg');

  if (process.platform === 'linux') {
    const input = options.device || (source === 'system' ? '@DEFAULT_MONITOR@' : 'default');
    return { label: `${source} / ${input}`, args: ['-hide_banner', '-loglevel', 'warning', '-f', 'pulse', '-i', input, ...commonOutput] };
  }

  if (process.platform === 'win32') {
    const device = options.device || (source === 'system' ? 'Stereo Mix' : 'Microphone');
    return { label: `${source} / ${device}`, args: ['-hide_banner', '-loglevel', 'warning', '-f', 'dshow', '-i', `audio=${device}`, ...commonOutput] };
  }

  throw new Error(`Unsupported platform: ${process.platform}`);
}

function buildConfig(options) {
  const explicitSource = String(options.source || '').toLowerCase();
  const sourceMic = ['mic', 'microphone', 'ambient'].includes(explicitSource) || options.mic || options.microphone || options.ambient;
  const sourceSystem = ['system', 'system-audio', 'speaker', 'output'].includes(explicitSource) || options.systemAudio || options.system;
  return {
    sourceLanguage: normalizeWhisperLanguage(options.language || options.sourceLanguage || loadGlobalConfig().language || DEFAULTS.sourceLanguage),
    targetLanguage: String(options.targetLanguage || options.targetLang || loadGlobalConfig().targetLanguage || DEFAULTS.targetLanguage).toLowerCase(),
    // Default: system audio only (mic off). Explicit source flags pick one source;
    // --no-mic/--no-system-audio toggle off the respective source. To start with
    // the mic instead, use --mic / --source mic (or press M at runtime).
    listenMic: sourceSystem ? false : sourceMic ? true : !options.noMic && (options.mic || options.microphone || options.ambient),
    listenSystemAudio: sourceMic ? false : sourceSystem ? true : !options.noSystemAudio,
    autoSetupAudio: options.noAutoSetupAudio ? false : DEFAULTS.autoSetupAudio,
  };
}

function resolveSources(currentConfig) {
  const sources = [];
  if (currentConfig.listenMic) sources.push('mic');
  if (currentConfig.listenSystemAudio) sources.push('system');
  return sources;
}

function ensureSystemAudioHelper(options) {
  const helperPath = resolve(PROJECT_ROOT, 'bin/system-audio-capture');
  if (existsSync(helperPath)) return helperPath;

  const bundledHelper = extractBundledSystemAudioHelper();
  if (bundledHelper) return bundledHelper;
  if (options.noBuildSystemHelper) return '';

  const buildScript = resolve(PROJECT_ROOT, 'scripts/build-system-audio-helper.sh');
  if (!existsSync(buildScript)) return '';
  if (!commandExists('swiftc')) {
    log('swiftc was not found; ScreenCaptureKit helper could not be built.');
    return '';
  }

  state.status = 'Building ScreenCaptureKit system audio helper...';
  requestRender();
  const result = spawnSync('bash', [buildScript], { encoding: 'utf8' });
  if (result.status !== 0) {
    log(`helper build error: ${result.stderr || result.stdout}`.trim());
    return '';
  }
  return existsSync(helperPath) ? helperPath : '';
}

function extractBundledSystemAudioHelper() {
  if (!BUNDLED_SYSTEM_AUDIO_HELPER_BASE64) return '';
  if (BUNDLED_SYSTEM_AUDIO_HELPER_PLATFORM && BUNDLED_SYSTEM_AUDIO_HELPER_PLATFORM !== process.platform) return '';
  if (BUNDLED_SYSTEM_AUDIO_HELPER_ARCH && BUNDLED_SYSTEM_AUDIO_HELPER_ARCH !== process.arch) {
    log(`Embedded system audio helper architecture differs: ${BUNDLED_SYSTEM_AUDIO_HELPER_ARCH}, this machine: ${process.arch}`);
    return '';
  }

  const helperDir = join(GLOBAL_CONFIG_DIR, 'bin');
  const helperPath = join(helperDir, `system-audio-capture-${process.platform}-${process.arch}`);
  try {
    mkdirSync(helperDir, { recursive: true, mode: 0o700 });
    writeFileSync(helperPath, Buffer.from(BUNDLED_SYSTEM_AUDIO_HELPER_BASE64, 'base64'));
    chmodSync(helperDir, 0o700);
    chmodSync(helperPath, 0o755);
    return helperPath;
  } catch (error) {
    log(`Embedded system audio helper could not be extracted: ${error.message}`);
    return '';
  }
}

function resolveMacAudioDevice(source, explicitDevice) {
  if (explicitDevice) return explicitDevice;
  const devices = getMacAudioDevices();
  if (source === 'system') {
    let systemDevice = pickMacSystemAudioDevice(devices);
    if (!systemDevice && config.autoSetupAudio) {
      state.status = 'No virtual audio device found; trying BlackHole setup...';
      requestRender();
      maybeAutoInstallBlackHole();
      systemDevice = pickMacSystemAudioDevice(getMacAudioDevices());
    }
    if (!systemDevice) {
      throw new Error('No virtual audio device was found for macOS system audio. Install BlackHole with npm run setup-macos-audio or use --no-system-audio.');
    }
    return systemDevice.name;
  }
  return pickMacMicrophoneDevice(devices)?.name || '0';
}

function maybeAutoInstallBlackHole() {
  if (process.platform !== 'darwin') return false;
  if (!commandExists('brew')) {
    log('Homebrew was not found; BlackHole could not be installed automatically.');
    return false;
  }
  const installed = spawnSync('brew', ['list', '--cask', 'blackhole-2ch'], { stdio: 'ignore' }).status === 0;
  if (installed) return true;
  log('Installing BlackHole 2ch. macOS may ask for password/permissions.');
  const result = spawnSync('brew', ['install', '--cask', 'blackhole-2ch'], { stdio: 'ignore' });
  if (result.status !== 0) {
    log('BlackHole could not be installed automatically. Manual: npm run setup-macos-audio');
    return false;
  }
  log('BlackHole was installed. Set macOS audio output to BlackHole/Multi-Output Device to capture system audio.');
  return true;
}

function listDevices() {
  if (process.platform === 'darwin') {
    const devices = getMacAudioDevices();
    console.log('macOS audio devices:');
    for (const device of devices) {
      const kind = /blackhole|loopback|vb-cable|soundflower|aggregate|multi-output/i.test(device.name) ? 'system-audio-candidate' : 'microphone/ambient';
      console.log(`  ${device.index}: ${device.name} (${kind})`);
    }
    if (!devices.some((device) => /blackhole|loopback|vb-cable|soundflower/i.test(device.name))) {
      console.log('\nSystem/speaker audio capture requires a virtual audio device such as BlackHole or Loopback/VB-Cable.');
      console.log('Easy setup: npm run setup-macos-audio');
      console.log('For microphone/ambient audio: npm start -- --no-system-audio');
    }
    return;
  }

  if (process.platform === 'linux') {
    console.log('On Linux, use a PulseAudio/PipeWire monitor source. Examples:');
    console.log('  pactl list short sources');
    console.log('  npm start -- --device "alsa_output...monitor"');
    return;
  }

  if (process.platform === 'win32') {
    console.log('To list Windows devices: ffmpeg -list_devices true -f dshow -i dummy');
    console.log('System audio may require Stereo Mix or VB-Cable.');
  }
}

function getMacAudioDevices() {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const devices = [];
  let inAudio = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('AVFoundation audio devices:')) { inAudio = true; continue; }
    if (line.includes('AVFoundation video devices:')) { inAudio = false; continue; }
    if (!inAudio) continue;
    const match = line.match(/\[(\d+)]\s+(.+)$/);
    if (match) devices.push({ index: match[1], name: match[2].trim() });
  }
  return devices;
}

function pickMacSystemAudioDevice(devices) {
  return devices.find((device) => /blackhole|loopback|vb-cable|soundflower|aggregate|multi-output/i.test(device.name)) || null;
}

function pickMacMicrophoneDevice(devices) {
  return devices.find((device) => !/blackhole|loopback|vb-cable|soundflower|aggregate|multi-output/i.test(device.name)) || null;
}

async function selfUninstall(options) {
  const binDir = process.env.GROQSCRIBE_BIN_DIR || join(homedir(), '.local/bin');
  const installDir = process.env.GROQSCRIBE_DIR || join(homedir(), '.groqscribe');
  const configDir = GLOBAL_CONFIG_DIR; // ~/.meet-groq-tr
  const binPath = join(binDir, 'groqscribe');
  const keepConfig = Boolean(options.keepConfig);

  const targets = [];
  if (existsSync(binPath)) targets.push(`  • binary:        ${binPath}`);
  if (existsSync(installDir)) targets.push(`  • source clone:  ${installDir}`);
  if (existsSync(configDir)) targets.push(`  • config:        ${configDir}${keepConfig ? '  (kept — --keep-config)' : '  (API key + usage stats)'}`);

  console.log('\nUninstall plan:');
  if (targets.length) console.log(targets.join('\n'));
  else { console.log('\ngroqscribe is not installed — nothing to remove.'); return; }
  console.log('  • PATH entry the installer added in your shell rc (if any)\n');

  if (!options.yes && !options.y) {
    const ans = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let done = false;
      const finish = (a) => { if (done) return; done = true; try { rl.close(); } catch {} resolve((a || '').trim()); };
      rl.question('Proceed with uninstall? [y/N] ', finish);
      rl.on('close', () => finish(''));
      process.stdin.on('end', () => finish(''));
    });
    if (!/^(y|yes)$/i.test(ans)) { console.log('Aborted.'); return; }
  }

  const rm = (p) => { try { spawnSync('rm', ['-rf', p]); } catch {} };

  // stop any other running groqscribe (not this process)
  try {
    const out = spawnSync('pgrep', ['-f', binPath], { encoding: 'utf8' });
    if (out.status === 0) {
      const pids = out.stdout.split('\n').map((n) => Number(n)).filter((n) => n && n !== process.pid);
      if (pids.length) { console.log('Stopping running groqscribe...'); pids.forEach((p) => { try { process.kill(p, 'SIGTERM'); } catch {} }); }
    }
  } catch {}

  if (existsSync(binPath)) { rm(binPath); console.log(`✓ Removed binary: ${binPath}`); }
  if (existsSync(installDir)) { rm(installDir); console.log(`✓ Removed source clone: ${installDir}`); }
  if (keepConfig) { if (existsSync(configDir)) console.log(`▸ Kept config: ${configDir} (--keep-config)`); }
  else if (existsSync(configDir)) { rm(configDir); console.log(`✓ Removed config: ${configDir} (API key + usage stats)`); }

  // clean the '# Added by groqscribe installer' PATH block from shell rc files
  const rcFiles = ['.zshrc', '.bashrc', '.profile'].map((f) => join(homedir(), f)).concat([join(homedir(), '.config/fish/config.fish')]);
  for (const rc of rcFiles) {
    if (!existsSync(rc)) continue;
    let text = readFileSync(rc, 'utf8');
    if (!text.includes('# Added by groqscribe installer') || !text.includes(binDir)) continue;
    text = text.replace(/\n?# Added by groqscribe installer\n(?:export PATH[^\n]*|set -gx PATH[^\n]*)\n?/g, '');
    try { writeFileSync(rc, text); console.log(`✓ Cleaned PATH entry from ${rc}`); } catch {}
  }

  console.log('\ngroqscribe has been uninstalled.\n  Reinstall any time with:\n    curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash\n');
}

async function resolveApiKey(options) {
  if (options.resetApiKey) saveGlobalConfig({ apiKey: '' });

  if (options.apiKey) {
    const apiKey = String(options.apiKey).trim();
    if (apiKey && !options.noSaveApiKey) saveGlobalConfig({ apiKey });
    return apiKey;
  }

  if (!options.resetApiKey && process.env.GROQ_API_KEY) return String(process.env.GROQ_API_KEY).trim();

  if (!options.resetApiKey) {
    const saved = loadGlobalConfig().apiKey;
    if (saved) return String(saved).trim();
  }

  process.stdout.write('\nGet a free Groq API key at: https://console.groq.com/keys\n\n');
  const entered = await promptSecret('Enter Groq API key (will be saved globally): ');
  const apiKey = entered.trim();
  if (!apiKey) return '';

  if (!options.noSaveApiKey) {
    saveGlobalConfig({ apiKey });
    process.stdout.write(`Groq API key saved: ${GLOBAL_CONFIG_FILE}\n`);
  }
  return apiKey;
}

function loadGlobalConfig() {
  try {
    return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveGlobalConfig(patch) {
  const current = loadGlobalConfig();
  const next = { ...current, ...patch };
  if (!next.apiKey) delete next.apiKey;

  mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(next, null, 2));
  try { chmodSync(GLOBAL_CONFIG_DIR, 0o700); } catch {}
  try { chmodSync(GLOBAL_CONFIG_FILE, 0o600); } catch {}
}

function promptSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise((resolveValue) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolveValue(answer || '');
      });
    });
  }

  return new Promise((resolveValue) => {
    const wasRaw = process.stdin.isRaw;
    let value = '';
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setRawMode(true);

    const restore = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(wasRaw));
    };

    const onData = (buffer) => {
      for (const byte of buffer) {
        if (byte === 3) {
          restore();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (byte === 13 || byte === 10) {
          restore();
          process.stdout.write('\n');
          resolveValue(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += Buffer.from([byte]).toString('utf8');
      }
    };

    process.stdin.on('data', onData);
  });
}

function loadUsageFile(path) {
  try { return normalizeUsage(JSON.parse(readFileSync(path, 'utf8'))); } catch { return normalizeUsage(null); }
}

function saveUsageFile(path, usage) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(usage, null, 2));
  try { chmodSync(path, 0o600); } catch {}
}

function hashApiKey(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    let key = null;
    if (arg.startsWith('--')) key = toCamel(arg.slice(2));
    else if (arg.startsWith('-') && arg.length === 2) key = toCamel(arg.slice(1)); // short flags like -y
    if (!key) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith('-')) parsed[key] = true;
    else { parsed[key] = next; index += 1; }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function splitShellLike(value) {
  return String(value).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^['"]|['"]$/g, '')) || [];
}

function commandExists(command) {
  if (existsSync(command)) return true;
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function log(message) {
  state.logs.push(message);
  if (state.logs.length > 20) state.logs.shift();
}

function wrap(text, width) {
  const clean = String(text || '');
  const rows = [];
  let rest = clean;
  while (rest.length > width) {
    rows.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  rows.push(rest);
  return rows;
}

function trim(text, width) {
  const raw = stripAnsi(String(text || ''));
  if (raw.length <= width) return text;
  return raw.slice(0, Math.max(0, width - 1)) + '…';
}

function pad(text, width) {
  const rawLength = stripAnsi(String(text || '')).length;
  if (rawLength >= width) return trim(text, width);
  return String(text || '') + ' '.repeat(width - rawLength);
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function color(text, kind) {
  const codes = {
    bold: ['\x1b[1m', '\x1b[22m'],
    dim: ['\x1b[2m', '\x1b[22m'],
    red: ['\x1b[31m', '\x1b[39m'],
    cyan: ['\x1b[36m', '\x1b[39m'],
    inverse: ['\x1b[7m', '\x1b[27m'],
    yellow: ['\x1b[33m', '\x1b[39m'],
    magenta: ['\x1b[35m', '\x1b[39m'],
    green: ['\x1b[32m', '\x1b[39m'],
  };
  const pair = codes[kind] || ['', ''];
  return `${pair[0]}${text}${pair[1]}`;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function printHelp() {
  console.log(`groqscribe

Live microphone & system-audio transcription with Groq Whisper, shown in a terminal TUI. Writes transcription_<ss>_<hh>_<DD>_<MM>_<YY>.txt in the current working directory (one file per run, so they never overwrite each other).
Default output is the raw whisper-large-v3-turbo transcript; chat translation is off unless --translate (or press T).

By default only system audio is captured (microphone is off) to avoid double-capturing the same sound through both sources; enable the mic with --mic or press M at runtime.

Usage:
  groqscribe                          # default: system audio only
  groqscribe --mic                    # capture microphone instead of system audio
  groqscribe --no-system-audio        # disable system audio (press M to add mic)
  groqscribe --language auto          # Whisper source language; auto or ISO code (en/tr/de...)
  groqscribe --translate              # enable chat translation
  groqscribe --target-language en     # target language used with --translate; default en
  groqscribe --reset-api-key          # ignore env/config and prompt for a new global API key
  groqscribe --no-save-api-key        # do not save a prompted API key
  groqscribe --long-segment-ms 20000 --long-segment-silence-ms 200
  groqscribe --list-devices           # list available audio devices
  groqscribe --uninstall              # remove groqscribe and its config
  groqscribe --help                   # show this help

Install:
  curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/install.sh | bash

Uninstall:
  groqscribe --uninstall                    # interactive prompt
  groqscribe --uninstall -y                 # skip the confirmation
  groqscribe --uninstall --keep-config      # keep your saved API key
  # or via curl:
  curl -fsSL https://raw.githubusercontent.com/muzafferkadir/groqscribe/main/scripts/uninstall.sh | bash

API key precedence: --api-key, GROQ_API_KEY, ~/.meet-groq-tr/config.json, interactive prompt. Get a free key at https://console.groq.com/keys. With --reset-api-key, env/config are ignored and a new key is requested.

Shortcuts (while running):
  Space  pause/resume        L  cycle source language
  M      toggle microphone   G  cycle target language
  B      toggle system audio T  toggle translation
  R      restart             S  toggle settings panel
  O      toggle original     ↑↓ scroll transcript
  Q      quit

macOS note:
  System audio uses the ScreenCaptureKit helper first. Grant Screen & System Audio Recording permission to the terminal app when macOS asks. If that fails, use the virtual audio fallback with npm run setup-macos-audio or force it with --system-backend virtual.
`);
}
