// A speed limit per visitor address, so one address can't fill the database with hits. Counts are
// kept in memory, so each Cloud Run instance counts on its own and a restart starts over.
//
// Limits are written "count/minutes", comma-separated, e.g. "300/10,3000/1440". "off" turns it off.
export function parseLimits(text) {
  if (!text || text === 'off') return [];
  return text.split(',').map((part) => {
    const [max, minutes] = part.split('/').map(Number);
    if (!(max > 0 && minutes > 0)) throw new Error(`Bad rate limit "${part}": use count/minutes, like 300/10`);
    return { max, ms: minutes * 60_000 };
  });
}

// Middleware that limits requests from each address, answering 429 with `message` when over.
export function rateLimit(limitsText, message) {
  const windows = parseLimits(limitsText).map((w) => ({ ...w, hits: new Map() })); // ip -> { count, resetAt }
  if (!windows.length) return (req, res, next) => next();

  // Forget addresses whose window has ended, so the maps don't grow forever.
  setInterval(() => {
    const now = Date.now();
    for (const w of windows) for (const [ip, h] of w.hits) if (h.resetAt <= now) w.hits.delete(ip);
  }, 60_000).unref();

  return (req, res, next) => {
    const now = Date.now();
    let retryAfter = 0;
    for (const w of windows) {
      let h = w.hits.get(req.ip);
      if (!h || h.resetAt <= now) w.hits.set(req.ip, (h = { count: 0, resetAt: now + w.ms }));
      h.count++;
      if (h.count > w.max) retryAfter = Math.max(retryAfter, h.resetAt - now);
    }
    if (!retryAfter) return next();
    res.set('Retry-After', String(Math.ceil(retryAfter / 1000)));
    res.status(429).json({ error: message });
  };
}
