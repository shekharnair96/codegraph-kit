# CodeGraph experiment figures

Static charts from the CodeGraph A/B experiments. Each one is rendered from the
recorded run data with Chart.js (animation disabled), and the same figures are
embedded in [`../deck.html`](../deck.html).

| Figure | File | What it shows |
|---|---|---|
| 1 | [`01-cost-per-task.png`](01-cost-per-task.png) | Cost per task by model x tooling (the model x tooling A/B). Sonnet KG-only (green) is the cost-optimal cell. |
| 2 | [`04-toolcalls-per-task.png`](04-toolcalls-per-task.png) | Tool-calls per task by model x tooling (the model x tooling A/B). |
| 3 | [`02-naive-baseline-cost.png`](02-naive-baseline-cost.png) | The no-KG baseline run: cost with grep/read only (blue = Sonnet, orange = Opus). |
| 4 | [`03-tuning-series-turns.png`](03-tuning-series-turns.png) | The prompt/tooling tuning series for Sonnet KG-only (green = best, red = regression). |
| 5 | [`05-cache-composition.png`](05-cache-composition.png) | Input-token composition by billing bucket (cache-read vs cache-write vs fresh). |
| 6 | [`06-tier-median-time.png`](06-tier-median-time.png) | The task-tier study: median completion time by tier (the hardest tier is censored at the 900s kill for the no-KG arm). |
| 7 | [`07-tier-mean-turns.png`](07-tier-mean-turns.png) | The task-tier study: mean turns by tier — the cost driver (no-KG runs on the hardest tier were all killed). |

Rendered from the recorded run data with Chart.js.
