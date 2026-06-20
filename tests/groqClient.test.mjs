import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROQ_CHAT_URL,
  GROQ_TRANSCRIPTION_URL,
  looksLikeTurkishText,
  normalizeTranscriptText,
  normalizeWhisperLanguage,
  WHISPER_LANGUAGE_OPTIONS,
  transcribeAudioChunk,
  translateToTurkish,
} from '../src/groqClient.js';

test('normalizeTranscriptText cleans whitespace and known non-speech markers', () => {
  assert.equal(normalizeTranscriptText('  hello\n\tworld  '), 'hello world');
  assert.equal(normalizeTranscriptText('[Music]'), '');
});

test('normalizeWhisperLanguage accepts known Whisper languages and falls back to auto', () => {
  assert.equal(normalizeWhisperLanguage('TR'), 'tr');
  assert.equal(normalizeWhisperLanguage('auto'), 'auto');
  assert.equal(normalizeWhisperLanguage('unknown'), 'auto');
  assert.ok(WHISPER_LANGUAGE_OPTIONS.some(([code]) => code === 'en'));
});

test('looksLikeTurkishText detects Turkish snippets for same-language skip', () => {
  assert.equal(looksLikeTurkishText('konuşamıyorum'), true);
  assert.equal(looksLikeTurkishText('Ben fark ettim, ne oldu?'), true);
  assert.equal(looksLikeTurkishText('Good morning everyone'), false);
});

test('transcribeAudioChunk sends multipart audio request to Groq', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ text: ' Hello from Meet ' }), { status: 200 });
  };

  const result = await transcribeAudioChunk({
    apiKey: 'gsk_test',
    audioBlob: new Blob(['fake-audio'], { type: 'audio/webm' }),
    fetchImpl,
  });

  assert.equal(result, 'Hello from Meet');
  assert.equal(captured.url, GROQ_TRANSCRIPTION_URL);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer gsk_test');
  assert.ok(captured.init.body instanceof FormData);
  assert.equal(captured.init.body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(captured.init.body.get('response_format'), 'json');
  assert.ok(captured.init.body.get('file') instanceof Blob);
});

test('translateToTurkish sends Turkish-only translation prompt', async () => {
  let payload;
  const fetchImpl = async (url, init) => {
    payload = JSON.parse(init.body);
    assert.equal(url, GROQ_CHAT_URL);
    assert.equal(init.headers.Authorization, 'Bearer gsk_test');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Herkese günaydın.' } }] }), { status: 200 });
  };

  const result = await translateToTurkish({
    apiKey: 'gsk_test',
    text: 'Good morning everyone.',
    fetchImpl,
  });

  assert.equal(result, 'Herkese günaydın.');
  assert.equal(payload.model, 'llama-3.1-8b-instant');
  assert.match(payload.messages[0].content, /Turkish/);
  assert.match(payload.messages[0].content, /Return only/);
  assert.equal(payload.messages[1].content, 'Good morning everyone.');
});
