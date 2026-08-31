# Performance lab

The performance lab generates its corpora at runtime and writes reports under Playwright's ignored `test-results/performance` directory.

Run the short local profiles with:

```bash
pnpm perf:micro
pnpm perf:smoke
```

Run the full progressive and idle profiles with:

```bash
pnpm perf:stress
pnpm perf:idle
```

Override the generated matrix with byte counts and shapes:

```bash
STRATAMD_PERF_SIZES=50000,250000 STRATAMD_PERF_SHAPES=rich,table-heavy pnpm perf:smoke
```

Keep named experiment outputs or repeat a profile with:

```bash
STRATAMD_PERF_RUN_ID=desktop-baseline pnpm perf:smoke
STRATAMD_PERF_PROFILE=smoke STRATAMD_PERF_RUN_ID=repeat-3 node scripts/run-performance.mjs --repeat-each=3
STRATAMD_PERF_TRACE=1 STRATAMD_PERF_SIZES=100000 STRATAMD_PERF_RUN_ID=send-trace pnpm perf:smoke
STRATAMD_PERF_TRACE=all STRATAMD_PERF_SIZES=100000 STRATAMD_PERF_RUN_ID=full-trace pnpm perf:smoke
```

Budgets classify reports but do not fail the run by default. Set `STRATAMD_PERF_ENFORCE=1` after the reference-machine targets have been calibrated.

Each application test gets a clean application data directory. The stress report includes corpus dimensions, action timings, renderer frame and long-task measurements, Electron process samples, budget violations, and the final classification.

When no desktop display is available, the runner falls back to Xvfb. Xvfb runs are useful for correctness and relative diagnosis, but their GPU-process CPU, memory, and frame cadence must not be used to calibrate desktop budgets.

See `docs/plans/open/performance-plan.md` for the design and optimization sequence.
