# @slopcontrol/mastra

Mastra-based chat service for SlopControl.

## Plan loop live-turn eventing

`plan_loop_start` / `plan_loop_continue` are gated tools: they start long-running plan-loop turns asynchronously and return immediately. Progress streams in as `live_progress` events, and the turn signals readiness with `live_settled` when `PLAN.md` is ready — callers should not poll `plan_loop_get`.
