import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestRateLimiter } from '../src/rateLimiter.js';

test('RequestRateLimiter counts daily usage and enforces daily limit', async () => {
  let saved;
  const limiter = new RequestRateLimiter({
    maxPerMinute: 10,
    maxPerDay: 2,
    now: () => Date.parse('2026-06-20T12:00:00Z'),
    loadUsage: async () => ({ date: '2026-06-20', count: 0 }),
    saveUsage: async (usage) => { saved = usage; },
  });

  await limiter.acquire();
  const quota = await limiter.acquire();
  assert.equal(quota.usedToday, 2);
  assert.deepEqual(saved, { date: '2026-06-20', count: 2 });
  await assert.rejects(() => limiter.acquire(), /Daily Groq transcription limit/);
});

test('RequestRateLimiter waits when minute limit is full', async () => {
  let now = Date.parse('2026-06-20T12:00:00Z');
  let slept = 0;
  const limiter = new RequestRateLimiter({
    maxPerMinute: 1,
    maxPerDay: 10,
    now: () => now,
    sleep: async (ms) => {
      slept += ms;
      now += ms;
    },
    loadUsage: async () => ({ date: '2026-06-20', count: 0 }),
  });

  await limiter.acquire();
  await limiter.acquire();
  assert.ok(slept >= 60_000);
});
