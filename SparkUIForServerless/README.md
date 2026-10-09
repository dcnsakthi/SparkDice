# SparkDice

A dependency-free, local browser viewer for Databricks query-profile JSON exports.
It provides Spark UI-style inspection, not a replacement Spark History Server.
No credentials, Databricks connection, package installation, or AI service is needed.

## Run

Open `index.html` in a modern Edge, Chrome, or Firefox browser, then select **Open
query profile** and choose a downloaded JSON export. Drag-and-drop is also supported.
Files are limited to 50 MiB.

For the supplied example button and automated tests, start the local server:

```powershell
.\serve.ps1
```

Then open <http://localhost:8765/> and select **Load supplied example**. To use another
port, run `.\serve.ps1 -Port 8766`. Stop with Ctrl+C. The server binds to localhost
and serves an explicit file allowlist, not a directory listing. It does not receive
uploaded profiles: the file picker reads them directly inside the browser.

The VS Code **Serve SparkDice** task runs the same server.

## Explore

The SparkDice header pairs a spark-and-dice mark with **Slice. Dice. Insight.**
Use the top-right sun, moon, and monitor icons to select **Light**, **Dark**, or
**System default**. System mode is the initial default and follows operating-system
appearance changes automatically. Only the theme preference is saved in local
storage, shared by the viewer and test page; profiles are never saved there.
If browser storage is unavailable, a visible warning explains that the selection
applies only to the current page.

- **Overview:** query wall clock, compilation, execution, aggregate task time, I/O,
  memory, execution coverage, and leading findings.
- **Execution plan:** dependency graph with all exported nodes, including hidden
  wrappers and disconnected nodes. Arrows follow the exported `fromId -> toId`
  direction (consumer to input in the supplied export), not time order. Click or
  keyboard-activate nodes for full metrics, metadata, SQL expressions, and inputs.
- **Operators:** search, stage filtering, and sorting by time, rows, or peak memory.
- **Stages:** separate attempts, timestamp-aligned timeline, task counts, failures,
  aggregate executor runtime, submission-to-first-task delay, and raw stage data.
- **Hotspots & recommendations:** evidence, conditional tuning advice, validation
  steps, and links to the relevant operators.
- **Query & limitations:** query text, original query metrics, exported insights,
  provenance, and limitations.
- **Export analysis:** downloads a structured JSON report of findings, normalized
  operator/stage metrics, and caveats. Raw query text and user identities are omitted,
  but names, filenames, and metrics can still be sensitive.

## Supported format and metric semantics

Verified against the included Databricks **version 1.3** export with a `query`
object and `graphs` array. Compatible exports using that structure are accepted;
other versions receive a warning. Arbitrary future schemas, Spark event logs, and
query-history API responses are not claimed to be supported. Unsupported or
malformed structures produce an explicit error and leave the last valid profile visible.

- Query-level fields come from `query.metrics`.
- Operators come from `graphs[].nodes`, edges from `graphs[].edges`, and stage
  attempts from `graphs[].stageData`.
- Operator time sums reported `EXCLUSIVE_TIME` components, converting
  `TIMING_METRIC_NS` to milliseconds and preserving sub-millisecond precision.
  This matters for combined shuffle source/sink operators. The fallback is
  `keyMetrics.durationMs`. Cumulative time is displayed in details but never
  added into rankings.
- Operator-time shares use the sum of known operator timings in the selected
  graph, **not** query wall clock or aggregate task time.
- Output rows and peak memory prefer key metrics; otherwise the maximum of the
  corresponding reported counters is used, avoiding source/sink duplication.
  Stage-level memory counters may be embedded in operators. Peaks are never summed
  into a supposed query memory requirement.
- Missing/null metrics remain unknown; a reported zero stays zero.
- Stage elapsed time prefers `keyMetrics.durationMs`, otherwise valid start/end
  timestamps. Zero timestamps are treated as absent. Skipped stages are retained
  but excluded from elapsed interval calculations. Overlapping intervals are
  unioned, not added.
- Multiple execution graphs are selectable and are never merged or summed. Their
  relation to `activePlanId` is not guessed. Query summaries still cover the entire query.
- Unknown raw metric keys remain available in operator details. Dangling edges
  warn; dependency cycles use a clearly labeled linear visualization fallback.

## Recommendation rules

These are transparent heuristics, not machine learning or proven root causes:

| Signal | Threshold |
|---|---|
| Compilation | At least 25% of query wall clock |
| Known provisioning + overload queue time | At least 20% of query wall clock |
| Result fetch | At least 20% of wall clock; not assumed additive |
| Disk spill | Positive bytes at query, operator, or stage scope |
| Failures | Failed tasks or failed stage status |
| Operator hotspot | Largest positive measured operator time |
| Stage hotspot | Longest non-skipped stage with reported duration |
| Join amplification | Output at least 10x the larger of exactly two known immediate input row counts |
| Row/columnar conversion | At least 10% of measured operator time |
| Local Table Scan | Always adds a storage-scope caveat |

Advice does not assert skew without task distributions, recommend cluster resizing
from aggregate time alone, or force broadcast joins from row counts.
Per-task duration percentiles, executor CPU/GC, full job history, scheduling root
causes, and a proven critical path require Spark UI/event logs or additional telemetry.

## Supplied profile: initial interpretation

The included `store_sales.display()` profile reports **1,268 ms** wall clock,
**461 ms** compilation (36.36%), **807 ms** execution, **365 ms** aggregate task time,
**1,200** output rows, and **zero disk spill**.

- Shuffle **#1162** has the largest measured exclusive time: **23.735982 ms**
  across source and sink. Its consumer already uses **Photon Broadcast Hash**
  with the right build side. Adding a broadcast hint is therefore not a new
  optimization. Inspect exchange preparation, build-side projection, and repeated
  materialization; its reported single partition is not proof of a problem for
  this 1,200-row input.
- Grouping Aggregate **#1161** costs **16.583447 ms**; Left Outer Join **#1160**
  costs **11.987959 ms**. The aggregation already reduces 181,141 local-input rows
  to 1,207 rows, so do not assume aggregation pushdown is missing.
- Stage **234** is longest at **77 ms** elapsed and **143 ms** aggregate executor
  runtime. Stages 232 and 237 take 43 ms and 29 ms; three other stages are skipped.
  Completed tasks total 17. The union of stage intervals is 149 ms; the remaining
  query time cannot be labeled scheduler overhead from this export alone.
- Two Local Table Scan inputs explain why meaningful row processing can coexist
  with zero storage-read bytes. Profile upstream loading and a representative full
  action before proposing storage layout changes or production-scale tuning.
- Compilation is a larger query-latency opportunity than any individual operator
  here. Compare repeated equivalent runs before rewriting a 1.268-second preview.
  High reported shuffle peak-memory counters alone do not prove memory pressure.

## Validate

Start the server and open <http://localhost:8765/tests.html>. The dependency-free
browser suite checks branding, theme selection/persistence, numeric conversion, units, precision, missing data, malformed
profiles, graph separation, stage intervals, attempts, exact recommendation
thresholds, report shape/privacy, and metrics from the supplied export.
`globalThis.testResults` exposes machine-readable results in the test page.

No source data is embedded in application scripts. Uploaded data is not persisted
in local storage. Reload clears the in-memory profile. Profiles and any reports
should be treated as sensitive.

Reference: [Databricks query profile documentation](https://docs.databricks.com/aws/en/sql/user/queries/query-profile).
