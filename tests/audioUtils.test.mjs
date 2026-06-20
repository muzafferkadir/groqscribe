import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRms16le, createWavBuffer, SilenceSegmenter } from '../src/audioUtils.js';

function frame(value, samples = 1600) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
  return buffer;
}

test('calculateRms16le returns normalized RMS', () => {
  assert.equal(calculateRms16le(Buffer.alloc(3200)), 0);
  assert.ok(calculateRms16le(frame(32767)) > 0.99);
});

test('createWavBuffer writes a valid PCM WAV header', () => {
  const pcm = Buffer.alloc(3200);
  const wav = createWavBuffer(pcm, { sampleRate: 16000, channels: 1 });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

test('SilenceSegmenter emits after configured silence', () => {
  const segmenter = new SilenceSegmenter({
    sampleRate: 16000,
    frameMs: 100,
    silenceMs: 300,
    threshold: 0.01,
    minSegmentMs: 100,
    preRollMs: 0,
  });

  const emitted = [];
  for (let i = 0; i < 5; i += 1) emitted.push(...segmenter.push(frame(4000)));
  assert.equal(emitted.length, 0);

  for (let i = 0; i < 2; i += 1) emitted.push(...segmenter.push(frame(0)));
  assert.equal(emitted.length, 0);

  emitted.push(...segmenter.push(frame(0)));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, 'silence');
  assert.equal(emitted[0].durationMs, 800);
});

test('SilenceSegmenter waits for minimum segment duration before silence emit', () => {
  const segmenter = new SilenceSegmenter({
    sampleRate: 16000,
    frameMs: 100,
    silenceMs: 300,
    threshold: 0.01,
    minSegmentMs: 500,
    preRollMs: 0,
  });

  const emitted = [];
  emitted.push(...segmenter.push(frame(4000))); // speech starts, 100ms
  for (let i = 0; i < 3; i += 1) emitted.push(...segmenter.push(frame(0))); // silence condition met at 400ms total
  assert.equal(emitted.length, 0);

  emitted.push(...segmenter.push(frame(0))); // 500ms total, silence already >300ms
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, 'silence');
  assert.equal(emitted[0].durationMs, 500);
});

test('SilenceSegmenter uses shorter silence threshold after long segment duration', () => {
  const segmenter = new SilenceSegmenter({
    sampleRate: 16000,
    frameMs: 100,
    silenceMs: 1000,
    longSegmentMs: 2000,
    longSegmentSilenceMs: 200,
    threshold: 0.01,
    minSegmentMs: 500,
    preRollMs: 0,
  });

  const emitted = [];
  for (let i = 0; i < 20; i += 1) emitted.push(...segmenter.push(frame(4000)));
  assert.equal(emitted.length, 0);

  emitted.push(...segmenter.push(frame(0)));
  assert.equal(emitted.length, 0);

  emitted.push(...segmenter.push(frame(0)));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].reason, 'short-silence-after-long-segment');
});
