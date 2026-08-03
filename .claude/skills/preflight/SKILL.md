---
name: preflight
description: Pre-PR verification ladder — local gate + Blacksmith CI-parity; adversarial review and CodeRabbit only at milestones/ship-readiness. Use before opening any PR or declaring a milestone done.
---

# /preflight — before any PR

1. **Local gate:** run `/verify` (green, evidence captured).
2. **CI parity on Blacksmith Testbox** (free plan — frugality is part of the job):
   - Reuse a warm box (`blacksmith testbox status`); otherwise `blacksmith testbox warmup --idle-timeout 10`.
   - Run the gate on it — or use `~/Development/github.com/agentic-coding/agent-optimization/scripts/verify-parity.sh`.
   - **`blacksmith testbox stop` when done** unless another run is imminent. Never leave a box idling.
3. **Fresh-context adversarial review — milestones/ship-readiness only, skip on routine PRs:** spawn a subagent that sees only `git diff main...HEAD`, the task description, and the acceptance criteria — not this session's context. Prompt: *"Report correctness gaps only — bugs, broken invariants, unhandled failure modes, security issues. Not style preferences."* Every finding gets fixed or rejected with a written reason.
4. **CodeRabbit** at significant milestones only (free plan). Rate-limited → skip, log it in the PR body, rely on step 3.
5. **PR body:** what changed and why, evidence summary, review outcomes. Flag proposed AGENTS.md additions for the owner's approval. No AI attribution — ever.
