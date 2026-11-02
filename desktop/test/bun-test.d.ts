// Minimal types for `bun test` (keeps @types/bun's globals out of the app's type check).
declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toMatchObject(expected: object): void;
    not: Matchers;
  }
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(actual: unknown): Matchers;
  export const vi: { useFakeTimers(): void; useRealTimers(): void; advanceTimersByTime(ms: number): void };
  export const mock: { module(path: string, factory: () => Record<string, unknown>): void };
}
