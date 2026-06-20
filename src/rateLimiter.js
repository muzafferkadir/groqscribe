const DEFAULT_USAGE = {
  date: '',
  count: 0,
};

export class RequestRateLimiter {
  constructor({
    maxPerMinute = 18,
    maxPerDay = 1900,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadUsage = async () => DEFAULT_USAGE,
    saveUsage = async () => {},
  } = {}) {
    this.maxPerMinute = Number(maxPerMinute) || 18;
    this.maxPerDay = Number(maxPerDay) || 1900;
    this.now = now;
    this.sleep = sleep;
    this.loadUsage = loadUsage;
    this.saveUsage = saveUsage;
    this.minuteTimestamps = [];
    this.usage = { ...DEFAULT_USAGE };
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.usage = normalizeUsage(await this.loadUsage(), this.today());
    this.initialized = true;
  }

  async acquire() {
    await this.init();
    this.rollDayIfNeeded();

    if (this.usage.count >= this.maxPerDay) {
      throw new Error(`Daily Groq transcription limit reached (${this.maxPerDay}/day).`);
    }

    while (true) {
      const now = this.now();
      this.minuteTimestamps = this.minuteTimestamps.filter((timestamp) => now - timestamp < 60_000);
      if (this.minuteTimestamps.length < this.maxPerMinute) break;
      const waitMs = Math.max(250, 60_000 - (now - this.minuteTimestamps[0]) + 50);
      await this.sleep(waitMs);
      this.rollDayIfNeeded();
      if (this.usage.count >= this.maxPerDay) {
        throw new Error(`Daily Groq transcription limit reached (${this.maxPerDay}/day).`);
      }
    }

    this.minuteTimestamps.push(this.now());
    this.usage.count += 1;
    await this.saveUsage(this.usage);

    return {
      usedToday: this.usage.count,
      remainingToday: Math.max(0, this.maxPerDay - this.usage.count),
      usedThisMinute: this.minuteTimestamps.length,
      remainingThisMinute: Math.max(0, this.maxPerMinute - this.minuteTimestamps.length),
    };
  }

  rollDayIfNeeded() {
    const today = this.today();
    if (this.usage.date !== today) {
      this.usage = { date: today, count: 0 };
      this.minuteTimestamps = [];
    }
  }

  today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}

export function normalizeUsage(value, fallbackDate = new Date().toISOString().slice(0, 10)) {
  if (!value || typeof value !== 'object') return { date: fallbackDate, count: 0 };
  return {
    date: typeof value.date === 'string' && value.date ? value.date : fallbackDate,
    count: Math.max(0, Number(value.count) || 0),
  };
}
