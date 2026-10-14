import { expect } from "vitest";

/** For the `it` that calls expectLinear. The measurement is CPU time and
 * doesn't care how loaded the machine is, but the test still runs on the wall
 * clock: well under a second alone, several seconds on a machine running many
 * suites at once. Vitest checks this only once the test returns. */
export const LINEAR_TEST_TIMEOUT_MS = 30_000;

/** Unmatched-bracket and backtick floods, the inputs the markdown strip once
 * went quadratic on: [repeated unit, repeats in the smaller input]. The larger
 * input, at 4x, is 100k characters, the validated body limit. */
export const BRACKET_FLOODS: Array<[string, number]> = [
  ["[", 25_000],
  ["[a](b", 5_000],
  ["![", 12_500],
  ["`", 25_000],
];

/** Fastest of this many measurements per side, interleaved, so a stall lands
 * on neither side alone. */
const RUNS = 3;

/** CPU time each side is sized to take. The thread CPU clock ticks about
 * once a millisecond on Linux, so a much shorter side is mostly rounding. */
const SIDE_MS = 30;

/** Bounds the sizing loop for a function too cheap to reach SIDE_MS. */
const MAX_REPS = 1_024;

/** CPU milliseconds this thread spent in `run`. Not wall-clock, which counts
 * the time the thread sat preempted: on a busy machine that lands on one side
 * more than the other often enough to move the ratio past its bound. */
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
 * Both sides take about the same CPU time when the code is linear, so a
 * garbage collection is as likely to land on either.
 */
export function expectLinear(
  run: (input: string) => unknown,
  make: (n: number) => string,
  n: number,
): void {
  const small = make(n);
  const large = make(4 * n);
  const smallSide = (reps: number) =>
    cpuMs(() => {
      for (let i = 0; i < 4 * reps; i++) run(small);
    });
  const largeSide = (reps: number) =>
    cpuMs(() => {
      for (let i = 0; i < reps; i++) run(large);
    });
  // Warm-up, so no measurement includes compiling the function, then double
  // the repetitions until a side is long enough to measure.
  run(small);
  let reps = 1;
  while (reps < MAX_REPS && smallSide(reps) < SIDE_MS) reps *= 2;
  let fastSmall = Number.POSITIVE_INFINITY;
  let fastLarge = Number.POSITIVE_INFINITY;
  for (let i = 0; i < RUNS; i++) {
    fastSmall = Math.min(fastSmall, smallSide(reps));
    fastLarge = Math.min(fastLarge, largeSide(reps));
  }
  const detail = `${large.length} chars ${reps}x: ${fastLarge.toFixed(1)} ms CPU; ${small.length} chars ${4 * reps}x: ${fastSmall.toFixed(1)} ms`;
  expect(fastSmall, `too cheap to measure (${detail})`).toBeGreaterThan(0);
  expect(fastLarge / fastSmall, detail).toBeLessThan(2);
}
