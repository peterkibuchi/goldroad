import { expect } from "vitest";

/** Fastest of this many measurements per side, interleaved, so a stall lands
 * on neither side alone. */
const RUNS = 3;

/** For the `it` that calls expectLinear. The measurement is CPU time and
 * doesn't care how loaded the machine is, but the wall clock it runs on does:
 * these tests take well under a second alone and several on a machine running
 * many suites at once. */
export const LINEAR_TEST_TIMEOUT_MS = 30_000;

/** CPU time each side is sized to take. The thread CPU clock ticks in about
 * a millisecond, so a side much shorter than this is mostly rounding. */
const SIDE_MS = 30;

/** CPU milliseconds this thread spent in `run`. CPU time, not wall-clock: on
 * a busy machine the scheduler preempts a long run more often than a short
 * one, and that alone moves a wall-clock ratio. */
function cpuMs(run: () => void): number {
  const start = process.threadCpuUsage();
  run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/**
 * Asserts that `run` grows linearly with its input, not quadratically.
 *
 * A wall-clock ceiling flaked here: 250 ms passed on a quiet machine and failed
 * at 270 to 326 ms on a loaded one. This asserts the property instead, with no
 * absolute speed in it: `run` on `make(4 * n)` against `run` four times on
 * `make(n)`. Linear work costs the same on both sides and quadratic work 4x as
 * much on the large input; the bound is 2x, halfway between on a log scale.
 * When the code is linear both sides do the same work, so garbage collection
 * and cache pressure weigh on them alike.
 */
export function expectLinear(
  run: (input: string) => unknown,
  make: (n: number) => string,
  n: number,
): void {
  const small = make(n);
  const large = make(4 * n);
  // Also the warm-up, so no measurement includes compiling the function. Wall
  // time is fine here: it only decides how many repetitions fill a side.
  const start = performance.now();
  run(large);
  const once = performance.now() - start;
  const reps = Math.min(200, Math.ceil(SIDE_MS / Math.max(once, 0.01)));
  let smallSide = Number.POSITIVE_INFINITY;
  let largeSide = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    smallSide = Math.min(
      smallSide,
      cpuMs(() => {
        for (let j = 0; j < 4 * reps; j++) run(small);
      }),
    );
    largeSide = Math.min(
      largeSide,
      cpuMs(() => {
        for (let j = 0; j < reps; j++) run(large);
      }),
    );
  }
  expect(
    largeSide / smallSide,
    `${large.length} chars ${reps}x: ${largeSide.toFixed(1)} ms; ${small.length} chars ${4 * reps}x: ${smallSide.toFixed(1)} ms`,
  ).toBeLessThan(2);
}
