import { EventEmitter } from 'node:events';

export function calculateRms16le(buffer) {
  if (!buffer?.length) return 0;
  const sampleCount = Math.floor(buffer.length / 2);
  if (!sampleCount) return 0;

  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32768;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

export function createWavBuffer(pcmBuffer, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export class SilenceSegmenter extends EventEmitter {
  constructor({
    sampleRate = 16000,
    channels = 1,
    frameMs = 100,
    silenceMs = 1000,
    preRollMs = 250,
    minSegmentMs = 5000,
    maxSegmentMs = 30000,
    longSegmentMs = 20000,
    longSegmentSilenceMs = 200,
    threshold = 0.012,
  } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.frameMs = frameMs;
    this.silenceMs = silenceMs;
    this.preRollMs = preRollMs;
    this.minSegmentMs = minSegmentMs;
    this.maxSegmentMs = maxSegmentMs;
    this.longSegmentMs = longSegmentMs;
    this.longSegmentSilenceMs = longSegmentSilenceMs;
    this.threshold = threshold;

    this.bytesPerFrame = Math.floor(sampleRate * channels * 2 * frameMs / 1000);
    this.maxPreRollFrames = Math.ceil(preRollMs / frameMs);
    this.silenceFramesToEnd = Math.ceil(silenceMs / frameMs);
    this.longSegmentSilenceFramesToEnd = Math.ceil(longSegmentSilenceMs / frameMs);
    this.minFrames = Math.ceil(minSegmentMs / frameMs);
    this.longSegmentFrames = Math.ceil(longSegmentMs / frameMs);
    this.maxFrames = Math.ceil(maxSegmentMs / frameMs);

    this.leftover = Buffer.alloc(0);
    this.preRoll = [];
    this.segment = [];
    this.inSpeech = false;
    this.silentFrames = 0;
    this.segmentFrames = 0;
    this.segmentStartedAt = 0;
  }

  push(chunk) {
    if (!chunk?.length) return [];
    const emitted = [];
    this.leftover = Buffer.concat([this.leftover, chunk]);

    while (this.leftover.length >= this.bytesPerFrame) {
      const frame = this.leftover.subarray(0, this.bytesPerFrame);
      this.leftover = this.leftover.subarray(this.bytesPerFrame);
      const segment = this.#processFrame(Buffer.from(frame));
      if (segment) emitted.push(segment);
    }

    return emitted;
  }

  flush() {
    if (!this.inSpeech || !this.segment.length) return null;
    return this.#emitSegment('flush');
  }

  #processFrame(frame) {
    const rms = calculateRms16le(frame);
    const isSpeech = rms >= this.threshold;

    if (!this.inSpeech) {
      if (!isSpeech) {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.maxPreRollFrames) this.preRoll.shift();
        return null;
      }

      this.inSpeech = true;
      this.silentFrames = 0;
      this.segmentFrames = 0;
      this.segmentStartedAt = Date.now();
      this.segment = [...this.preRoll, frame];
      this.preRoll = [];
      this.segmentFrames = this.segment.length;
      return null;
    }

    this.segment.push(frame);
    this.segmentFrames += 1;

    if (isSpeech) {
      this.silentFrames = 0;
    } else {
      this.silentFrames += 1;
    }

    const requiredSilentFrames = this.segmentFrames >= this.longSegmentFrames
      ? this.longSegmentSilenceFramesToEnd
      : this.silenceFramesToEnd;

    if (this.silentFrames >= requiredSilentFrames && this.segmentFrames >= this.minFrames) {
      return this.#emitSegment(this.segmentFrames >= this.longSegmentFrames ? 'short-silence-after-long-segment' : 'silence');
    }

    if (this.segmentFrames >= this.maxFrames) {
      return this.#emitSegment('max-duration');
    }

    return null;
  }

  #emitSegment(reason) {
    const pcm = Buffer.concat(this.segment);
    const durationMs = this.segmentFrames * this.frameMs;
    const segment = {
      pcm,
      durationMs,
      reason,
      startedAt: this.segmentStartedAt,
      endedAt: Date.now(),
    };

    this.inSpeech = false;
    this.silentFrames = 0;
    this.segmentFrames = 0;
    this.segmentStartedAt = 0;
    this.segment = [];

    if (durationMs < this.minSegmentMs && reason !== 'max-duration') return null;
    this.emit('segment', segment);
    return segment;
  }
}
