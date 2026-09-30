/** Small deterministic PRNG used only for repeatable sampling and parent selection. */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 0x9e3779b9;
  }

  get state(): number { return this.#state; }

  restore(state: number): void {
    if (!Number.isSafeInteger(state) || state < 1 || state > 0xffff_ffff) throw new Error("Invalid random state");
    this.#state = state;
  }

  next(): number {
    let value = this.#state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.#state = value >>> 0;
    return this.#state / 0x1_0000_0000;
  }

  integer(maximumExclusive: number): number {
    if (!Number.isSafeInteger(maximumExclusive) || maximumExclusive < 1) throw new Error("maximumExclusive must be positive");
    return Math.floor(this.next() * maximumExclusive);
  }

  shuffle<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index--) {
      const other = this.integer(index + 1);
      [values[index], values[other]] = [values[other]!, values[index]!];
    }
    return values;
  }
}
