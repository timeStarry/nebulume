// Decoding and remote fetches are expensive: each window admits only a small preview batch.
export function createConcurrencyLimit(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limited<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await operation();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
