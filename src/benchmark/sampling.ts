/** Small deterministic PRNG; benchmark sampling must be reproducible. */
class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  shuffle<T>(values: T[]): void {
    for (let index = values.length - 1; index > 0; index--) {
      const replacement = Math.floor(this.next() * (index + 1));
      [values[index], values[replacement]] = [values[replacement]!, values[index]!];
    }
  }
}

/** Round-robin sampling prevents a large stratum from crowding out smaller ones. */
export function stratifiedSample<T>(
  values: readonly T[],
  limit: number,
  seed: number,
  stratum: (value: T) => string,
): readonly T[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Sample limit must be a non-negative integer");
  if (limit === 0 || limit >= values.length) return Object.freeze([...values]);

  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = stratum(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }

  const random = new Random(seed);
  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [, group] of ordered) random.shuffle(group);
  random.shuffle(ordered);

  const selected: T[] = [];
  for (let cursor = 0; selected.length < limit; cursor++) {
    let found = false;
    for (const [, group] of ordered) {
      const value = group[cursor];
      if (value !== undefined && selected.length < limit) {
        selected.push(value);
        found = true;
      }
    }
    if (!found) break;
  }
  return Object.freeze(selected);
}

export function lengthBucket(length: number): string {
  if (length < 500) return "short";
  if (length < 1_500) return "medium";
  return "long";
}
