"use strict";

/* Pure analysis shared by the viewer and the browser test suite. */
globalThis.Profile = (() => {
  const number = value => {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "string" && !value.trim()) return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : null;
  };
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const sum = values => {
    const known = values.filter(value => value !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  const maximum = values => values.reduce((max, value) =>
    value === null ? max : max === null ? value : Math.max(max, value), null);
  const fmt = value => value === null || value === undefined ? "Not available" :
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  const ms = value => value === null || value === undefined ? "Not available" :
    value < 1000 ? `${fmt(value)} ms` : value < 60000 ? `${fmt(value / 1000)} s` : `${fmt(value / 60000)} min`;
  const bytes = value => {
    if (value === null || value === undefined) return "Not available";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const index = value === 0 ? 0 : Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
    return `${fmt(value / 1024 ** Math.max(0, index))} ${units[Math.max(0, index)]}`;
  };
  const percent = (part, total) => part !== null && total > 0 ? `${fmt(100 * part / total)}%` : "Not available";
  const timeMetric = metric => {
    const value = number(metric.value);
    if (value === null) return null;
    if (metric.metricType === "TIMING_METRIC_NS") return value / 1e6;
    if (metric.metricType === "TIMING_METRIC_MS") return value;
    return null;
  };
  const formatMetric = metric => {
    const value = number(metric.value);
    if (timeMetric(metric) !== null) return ms(timeMetric(metric));
    if (metric.metricType === "SIZE_METRIC_BYTES") return bytes(value);
    return value === null ? text(metric.value) || "Not available" : fmt(value);
  };
  const metadataValues = metadata => {
    if (metadata.value !== undefined && metadata.value !== null && metadata.value !== "") return [text(metadata.value)];
    if (Array.isArray(metadata.values) && metadata.values.length) return metadata.values.map(text);
    if (Array.isArray(metadata.metaValues)) return metadata.metaValues.map(value => text(value?.value ?? value));
    return [];
  };
  const metadataText = (node, key) => node.metadata.filter(m => m.key === key).flatMap(metadataValues).join(", ");
  function array(value, path) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    return value;
  }
  function record(value, path) {
    if (!object(value)) throw new Error(`${path} must be an object.`);
    return value;
  }
  function identifier(value, path) {
    if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "")
      throw new Error(`${path} must be a non-empty identifier.`);
    return String(value);
  }
  function normalizeNode(raw, path) {
    record(raw, path);
    const metrics = array(raw.metrics, `${path}.metrics`).map((m, i) => record(m, `${path}.metrics[${i}]`));
    const keyed = key => metrics.filter(m => m.key === key);
    const key = object(raw.keyMetrics) ? raw.keyMetrics : {};
    const exclusive = sum(keyed("EXCLUSIVE_TIME").map(timeMetric));
    const output = maximum(keyed("NUMBER_OUTPUT_ROWS").map(m => number(m.value)));
    const peak = maximum(keyed("PEAK_MEMORY_USAGE").map(m => number(m.value)));
    const metadata = array(raw.metadata, `${path}.metadata`).map((m, i) => record(m, `${path}.metadata[${i}]`));
    return {
      id: identifier(raw.id, `${path}.id`), name: text(raw.name || raw.tag || "Unnamed operator"),
      tag: text(raw.tag || ""), metrics, metadata, raw,
      rows: number(key.rowsNum) ?? output,
      duration: exclusive ?? number(key.durationMs),
      timeBasis: exclusive !== null ? "Exclusive time (sum of reported components)" :
        number(key.durationMs) !== null ? "Reported keyMetrics.durationMs" : "Not available",
      peak: number(key.peakMemoryBytes) ?? peak,
      spill: maximum(metrics.filter(m => m.metricType === "SIZE_METRIC_BYTES" &&
        /(?:disk.*spill|spill.*disk|bytes spilled|spill size)/i.test(`${m.key} ${m.label}`))
        .map(m => number(m.value))),
      stageIds: array(raw.stageLinks, `${path}.stageLinks`).map((id, i) => identifier(id, `${path}.stageLinks[${i}]`)),
      hidden: raw.hidden === true
    };
  }
  function normalizeStage(raw, path) {
    record(raw, path);
    const start = number(raw.startTimeMs) || number(raw.firstTaskLaunchedTime) || null;
    const end = number(raw.endTimeMs) || number(raw.completionTime) || null;
    const submitted = number(raw.submissionTime) || null;
    const duration = number(raw.keyMetrics?.durationMs) ??
      (start !== null && end !== null && end >= start ? end - start : null);
    return {
      id: identifier(raw.stageId, `${path}.stageId`), attempt: number(raw.attemptId),
      status: text(raw.status || "UNKNOWN"), start, end, submitted, duration,
      launchDelay: submitted !== null && start !== null && start >= submitted ? start - submitted : null,
      tasks: number(raw.numTasks), completed: number(raw.numCompleteTasks),
      failed: number(raw.numFailedTasks), killed: number(raw.numKilledTasks),
      executorTime: number(raw.executorRunTimeMs), spill: number(raw.diskBytesSpilled),
      remoteRead: number(raw.remoteBytesRead), raw
    };
  }
  function parse(input) {
    let raw;
    try { raw = typeof input === "string" ? JSON.parse(input.replace(/^\uFEFF/, "")) : input; }
    catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
    record(raw, "Profile");
    if (!object(raw.query) || !Array.isArray(raw.graphs))
      throw new Error("Unsupported profile format. Expected a Databricks export containing a query object and a graphs array. Spark event logs are not query profiles.");
    const warnings = [];
    if (raw.version !== "1.3") warnings.push(`Export version ${text(raw.version ?? "unspecified")} is unverified. Recognized fields are shown; check raw details for unsupported metrics.`);
    const graphs = raw.graphs.map((g, index) => {
      const path = `graphs[${index}]`;
      record(g, path);
      if (!Array.isArray(g.nodes)) throw new Error(`${path}.nodes must be an array.`);
      const nodes = g.nodes.map((n, i) => normalizeNode(n, `${path}.nodes[${i}]`));
      const ids = new Set(nodes.map(n => n.id));
      if (ids.size !== nodes.length) throw new Error(`${path} contains duplicate operator IDs.`);
      const edges = array(g.edges, `${path}.edges`).map((e, i) => {
        record(e, `${path}.edges[${i}]`);
        return { from: identifier(e.fromId, `${path}.edges[${i}].fromId`), to: identifier(e.toId, `${path}.edges[${i}].toId`) };
      });
      const validEdges = edges.filter(e => ids.has(e.from) && ids.has(e.to));
      if (edges.length !== validEdges.length) warnings.push(`Graph ${index + 1}: ${edges.length - validEdges.length} dangling edge(s) omitted.`);
      return { index, nodes, edges: validEdges,
        stages: array(g.stageData, `${path}.stageData`).map((s, i) => normalizeStage(s, `${path}.stageData[${i}]`)),
        executionId: text(g.executionId ?? index + 1), raw: g };
    });
    if (!graphs.length) warnings.push("No execution graphs were exported. Only query-level metrics can be analyzed.");
    if (graphs.length > 1) warnings.push("Multiple execution graphs are available. Operator and stage analysis uses only the selected graph; query totals cover the whole query. Graphs are not summed or assumed to be separate work.");
    const metrics = object(raw.query.metrics) ? raw.query.metrics : {};
    const queryMetrics = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, number(value)]));
    const start = number(raw.query.queryStartTimeMs);
    const end = number(raw.query.queryEndTimeMs);
    queryMetrics.totalTimeMs = queryMetrics.totalTimeMs ??
      (start !== null && end !== null && end >= start ? end - start : null);
    return { raw, query: raw.query, metrics: queryMetrics, graphs, warnings };
  }
  function intervalUnion(stages) {
    const intervals = stages.filter(s => s.status !== "SKIPPED" && s.start !== null && s.end !== null && s.end >= s.start)
      .map(s => [s.start, s.end]).sort((a, b) => a[0] - b[0]);
    if (!intervals.length) return null;
    let total = 0, [start, end] = intervals[0];
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (nextStart <= end) end = Math.max(end, nextEnd);
      else { total += end - start; [start, end] = [nextStart, nextEnd]; }
    }
    return total + end - start;
  }
  function analyze(profile, graphIndex = 0) {
    const graph = profile.graphs[graphIndex] ?? { nodes: [], edges: [], stages: [] };
    const m = profile.metrics;
    const ranked = graph.nodes.filter(n => n.duration !== null).sort((a, b) => b.duration - a.duration);
    const measuredTime = sum(ranked.map(n => n.duration));
    const findings = [];
    const add = (id, priority, title, evidence, recommendation, validation, nodeIds = []) =>
      findings.push({ id, priority, title, evidence, recommendation, validation, nodeIds });
    if (m.compilationTimeMs > 0 && m.totalTimeMs > 0 && m.compilationTimeMs / m.totalTimeMs >= 0.25)
      add("compilation", "Opportunity", "Compilation is a material part of latency",
        `${ms(m.compilationTimeMs)} compilation / ${ms(m.totalTimeMs)} wall clock (${percent(m.compilationTimeMs, m.totalTimeMs)}).`,
        "For repeated runs, keep query structure stable and avoid unnecessary actions that trigger replanning. Inspect plan complexity before rewriting. More workers do not directly remove compilation time.",
        "Compare compilation and total latency across several equivalent runs on the same compute; distinguish warm-cache from cold-cache runs.");
    const queue = sum([m.queuedProvisioningTimeMs ?? null, m.queuedOverloadTimeMs ?? null]);
    if (queue > 0 && m.totalTimeMs > 0 && queue / m.totalTimeMs >= 0.2)
      add("queue", "Investigate", "Queueing contributes materially to elapsed time",
        `${ms(queue)} reported queue time (${percent(queue, m.totalTimeMs)} of wall clock).`,
        "Separate provisioning from overload: review startup policy for provisioning delays, or concurrency and warehouse capacity for overload. Size compute only after checking utilization and cost.",
        "Compare queue time at similar concurrency before and after the change.");
    if (m.resultFetchTimeMs > 0 && m.totalTimeMs > 0 && m.resultFetchTimeMs / m.totalTimeMs >= 0.2)
      add("fetch", "Opportunity", "Result delivery is worth investigating",
        `${ms(m.resultFetchTimeMs)} result fetch time; ${fmt(m.rowsProducedCount)} output rows. Fetch time may overlap or sit outside other reported phases.`,
        "Return only needed columns and rows, or write large results to a table rather than collecting them into a client.",
        "Measure client end-to-end latency and result size as well as query execution time.");
    const spillNodes = graph.nodes.filter(n => n.spill > 0);
    const spillStages = graph.stages.filter(s => s.spill > 0);
    if (m.spillToDiskBytes > 0 || spillNodes.length || spillStages.length)
      add("spill", "Investigate", "Disk spill is reported",
        `Query spill: ${bytes(m.spillToDiskBytes)}. ${spillNodes.length} operator(s) and ${spillStages.length} stage attempt(s) report positive disk spill; these scopes are not added together.`,
        "Reduce rows and columns before joins, sorts, and aggregations. Check partition sizes and task skew; consider more memory per task only if working-set pressure remains.",
        "Compare spill bytes, longest task duration, peak memory, and total latency with unchanged result semantics.", spillNodes.map(n => n.id));
    const failed = graph.stages.filter(s => s.failed > 0 || /FAIL/i.test(s.status));
    if (failed.length || m.failedTaskCount > 0 || number(profile.query.metrics?.taskProgress?.failedTaskCount) > 0)
      add("failures", "Investigate", "Failed tasks or stages are reported",
        `${failed.length} stage attempt(s) report failures; query task progress reports ${fmt(number(profile.query.metrics?.taskProgress?.failedTaskCount))} failed tasks.`,
        "Inspect Spark task errors and executor logs before changing query logic or retry settings.",
        "Confirm the underlying failure is resolved on repeat runs.");
    if (ranked[0]?.duration > 0) {
      const top = ranked[0];
      const shuffle = /shuffle|exchange/i.test(`${top.name} ${top.tag}`);
      const consumers = graph.edges.filter(e => e.to === top.id).map(e => graph.nodes.find(n => n.id === e.from));
      const broadcastJoin = consumers.find(n => /broadcast/i.test(metadataText(n, "JOIN_ALGORITHM")));
      const partitioning = metadataText(top, "PARTITIONING_TYPE");
      const strategyEvidence = [
        partitioning ? `Reported partitioning: ${partitioning}.` : "",
        broadcastJoin ? `Consumer ${broadcastJoin.id} already uses ${metadataText(broadcastJoin, "JOIN_ALGORITHM")}.` : ""
      ].filter(Boolean).join(" ");
      add("top-operator", "Opportunity", `Top measured operator: ${top.name}`,
        `Operator ${top.id}: ${ms(top.duration)}, ${percent(top.duration, measuredTime)} of the selected graph's measured operator time; ${fmt(top.rows)} output rows. This is not a wall-clock share.${strategyEvidence ? ` ${strategyEvidence}` : ""}`,
        shuffle ? broadcastJoin ?
          "The consuming join already uses broadcast; adding a broadcast hint is not a new optimization. Inspect exchange preparation, build-side projection, and repeated materialization. A single partition on a small broadcast side is not itself evidence of a bottleneck. Change partitioning only after validating plan requirements." :
          "Inspect partitioning and the surrounding join or aggregation. If a join side is genuinely small in bytes, check whether a broadcast strategy is eligible; do not force it from row count alone. Avoid redundant repartitioning." :
          /aggregate/i.test(top.name) ? "Reduce data before aggregation and review grouping-key cardinality. Pre-aggregate before joins only when doing so preserves the intended semantics." :
          /join/i.test(top.name) ? "Check join keys, input sizes, statistics, and the physical join algorithm. Filter early and choose broadcast only when the build side safely fits memory." :
          /scan/i.test(top.name) ? "Inspect pushed filters, projected columns, file pruning, and file sizes before considering layout or compaction changes." :
          "Inspect this operator's inputs and expressions. Reduce unnecessary work upstream without changing result semantics.",
        "Compare this operator's exclusive time and whole-query latency over representative runs; a relative hotspot in a short query may not justify a rewrite.", [top.id]);
    }
    const longest = graph.stages.filter(s => s.status !== "SKIPPED" && s.duration !== null).sort((a, b) => b.duration - a.duration)[0];
    if (longest)
      add("longest-stage", "Observation", "Longest reported stage",
        `Stage ${longest.id}, attempt ${fmt(longest.attempt)}: ${ms(longest.duration)} elapsed; ${ms(longest.executorTime)} aggregate executor runtime over ${fmt(longest.tasks)} planned tasks.`,
        "Use the linked operators to locate work inside this stage. Aggregate executor runtime is not elapsed time, and an average cannot establish skew.",
        "Open the original Spark UI or event log for per-task distributions, executor utilization, and scheduler diagnostics.",
        graph.nodes.filter(n => n.stageIds.includes(longest.id)).map(n => n.id));
    for (const node of graph.nodes.filter(n => /join/i.test(`${n.name} ${n.tag}`))) {
      const inputs = [...new Set(graph.edges.filter(e => e.from === node.id).map(e => e.to))]
        .map(id => graph.nodes.find(n => n.id === id));
      if (inputs.length !== 2 || inputs.some(n => n.rows === null)) continue;
      const largestInput = Math.max(...inputs.map(n => n.rows));
      if (largestInput > 0 && node.rows !== null && node.rows / largestInput >= 10)
        add(`join-${node.id}`, "Investigate", "Large join-output amplification",
          `Operator ${node.id} emits ${fmt(node.rows)} rows from immediate inputs of ${inputs.map(n => fmt(n.rows)).join(" and ")} rows (${fmt(node.rows / largestInput)}x the larger input).`,
          "Verify key uniqueness, missing predicates, and intended many-to-many semantics. Deduplicate or pre-aggregate only if business logic permits; expansion can be intentional.",
          "Check distinct key counts on both inputs and validate output correctness after any rewrite.", [node.id]);
    }
    const local = graph.nodes.filter(n => /local table scan/i.test(n.name));
    if (local.length)
      add("local-input", "Observation", "Local inputs limit storage conclusions",
        `${local.length} Local Table Scan operator(s), with output rows ${local.map(n => fmt(n.rows)).join(", ")}. Query-level storage read bytes: ${bytes(m.readBytes)}.`,
        "This export does not measure a normal table-file scan for these inputs. If they originate in driver or client materialization, test reading distributed tables directly at production scale. Zero storage reads does not mean zero input rows.",
        "Profile the upstream data-loading action and a representative full workload, not only display() or a limited preview.", local.map(n => n.id));
    const conversion = graph.nodes.filter(n => /row to columnar|columnar to row/i.test(n.name));
    const conversionTime = sum(conversion.map(n => n.duration));
    if (conversionTime > 0 && measuredTime > 0 && conversionTime / measuredTime >= 0.1)
      add("conversion", "Opportunity", "Row / columnar conversion is visible",
        `${ms(conversionTime)} across ${conversion.length} conversion operator(s), ${percent(conversionTime, measuredTime)} of measured operator time.`,
        "Inspect boundaries between row-based inputs and Photon operators. Prefer supported built-in expressions and distributed inputs where practical; this is not proof that a UDF or Photon fallback occurred.",
        "Check the new physical plan and conversion time while verifying equivalent output.", conversion.map(n => n.id));
    if (!findings.length)
      add("insufficient", "Observation", "No rule-triggered hotspot in available metrics",
        "The exported metrics do not meet the documented heuristic thresholds, or relevant metrics are missing.",
        "Inspect operator details and collect a representative complete run before tuning.",
        "Use Spark task-level telemetry for skew, GC, executor, and scheduler investigation.");
    const priority = { Investigate: 0, Opportunity: 1, Observation: 2 };
    findings.sort((a, b) => priority[a.priority] - priority[b.priority]);
    return { graph, ranked, measuredTime, findings, stageActiveTime: intervalUnion(graph.stages),
      maxReportedPeak: maximum(graph.nodes.map(n => n.peak)) };
  }
  function report(profile, analysis, filename) {
    return {
      reportVersion: 1, sourceFile: filename, queryId: text(profile.query.id ?? ""),
      executionId: analysis.graph.executionId ?? null,
      summary: profile.metrics,
      caveats: [...profile.warnings,
        "Query wall clock, aggregate task time, operator time, and stage elapsed time are different scopes; do not add them.",
        "Missing metrics are unknown, not zero. Operator peak memory is not summed and may include stage-level counters.",
        "No per-task distributions or executor telemetry are reconstructed from aggregate metrics.",
        "Recommendations are deterministic heuristics, not proven root causes or predicted speedups."],
      findings: analysis.findings,
      operators: analysis.graph.nodes.map(n => ({ id: n.id, name: n.name, durationMs: n.duration,
        timeBasis: n.timeBasis, outputRows: n.rows, peakMemoryBytes: n.peak, stageIds: n.stageIds })),
      stages: analysis.graph.stages.map(({ raw, ...stage }) => stage)
    };
  }
  return { parse, analyze, report, number, sum, fmt, ms, bytes, percent, timeMetric, formatMetric, metadataValues, text, intervalUnion };
})();
