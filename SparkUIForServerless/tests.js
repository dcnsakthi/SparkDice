"use strict";

(async () => {
  if (document.readyState !== "complete") {
    await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  const P = globalThis.Profile, results = [];
  const assert = (condition, message = "Assertion failed") => { if (!condition) throw new Error(message); };
  const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `Expected ${b}, got ${a}`);
  const throws = (fn, pattern) => {
    try { fn(); } catch (error) { assert(pattern.test(error.message), error.message); return; }
    throw new Error("Expected an error");
  };
  const metric = (key, value, metricType = "TIMING_METRIC_NS", label = key) => ({ key, value, metricType, label });
  const node = (id, name, metrics = [], extra = {}) => ({ id, name, metrics, ...extra });
  const fixture = (nodes = [], metrics = {}, edges = [], stageData = []) =>
    ({ version: "1.3", query: { id: "test", metrics }, graphs: [{ nodes, edges, stageData }] });
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  await test("SparkDice branding and accessible theme controls are present", () => {
    assert(document.querySelector(".brand").getAttribute("aria-label") === "SparkDice home");
    assert(document.querySelector(".brand-name").textContent === "SparkDice");
    assert(document.querySelector(".brand-mark"));
    assert(document.querySelectorAll(".theme-switch button").length === 3);
    assert(document.querySelectorAll('.theme-switch button[aria-pressed="true"]').length === 1);
  });
  await test("Light, dark and system themes apply, select and persist correctly", () => {
    const root = document.documentElement;
    const originalMode = root.dataset.themeMode;
    const saved = localStorage.getItem("sparkdice-theme");
    const backgrounds = {};
    try {
      for (const mode of ["light", "dark", "system"]) {
        const button = document.querySelector(`button[data-theme-mode="${mode}"]`);
        button.click();
        const expected = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
        assert(root.dataset.theme === expected, `Incorrect resolved theme for ${mode}`);
        assert(root.dataset.themeMode === mode);
        assert(button.getAttribute("aria-pressed") === "true");
        assert(document.querySelectorAll('.theme-switch button[aria-pressed="true"]').length === 1);
        assert(localStorage.getItem("sparkdice-theme") === mode);
        backgrounds[mode] = getComputedStyle(document.body).backgroundColor;
      }
      assert(backgrounds.light !== backgrounds.dark, "Light and dark backgrounds must differ");
    } finally {
      document.querySelector(`button[data-theme-mode="${originalMode}"]`).click();
      if (saved === null) localStorage.removeItem("sparkdice-theme");
      else localStorage.setItem("sparkdice-theme", saved);
    }
  });
  await test("Numeric conversion preserves zero and rejects null, booleans, blanks and nonfinite values", () => {
    for (const v of [null, undefined, false, true, "", " ", -1, Infinity, {}, "abc"]) assert(P.number(v) === null);
    assert(P.number("0") === 0); assert(P.number("2.5") === 2.5);
  });
  await test("Malformed JSON and unsupported structures fail explicitly", () => {
    throws(() => P.parse("{"), /Invalid JSON/);
    throws(() => P.parse([]), /must be an object/);
    throws(() => P.parse({ events: [] }), /Unsupported profile/);
    throws(() => P.parse({ query: {}, graphs: [{}] }), /nodes must be an array/);
    throws(() => P.parse(fixture([node("1", "Scan", {})])), /metrics must be an array/);
    throws(() => P.parse(fixture([node("1", "Scan"), node("1", "Scan")])), /duplicate/);
    throws(() => P.parse(fixture([node(null, "Scan")])), /identifier/);
  });
  await test("BOM and numeric strings are accepted", () => {
    const p = P.parse("\uFEFF" + JSON.stringify(fixture([], { totalTimeMs: "123" })));
    assert(p.metrics.totalTimeMs === 123);
  });
  await test("Exclusive nanosecond components sum; cumulative timing is not ranked", () => {
    const n = P.parse(fixture([node("a", "Shuffle", [
      metric("EXCLUSIVE_TIME", 5241731), metric("EXCLUSIVE_TIME", 18494251),
      metric("CUMULATIVE_TIME", 99999999999)
    ], { keyMetrics: { durationMs: 23 } })])).graphs[0].nodes[0];
    close(n.duration, 23.735982);
  });
  await test("Sub-millisecond precision is retained despite rounded key metrics", () => {
    const n = P.parse(fixture([node("a", "Sort", [metric("EXCLUSIVE_TIME", 500850)], { keyMetrics: { durationMs: 0 } })])).graphs[0].nodes[0];
    close(n.duration, 0.50085);
  });
  await test("MS units and key-duration fallback work; unknown units are not assumed", () => {
    const p = P.parse(fixture([
      node("a", "Sort", [metric("EXCLUSIVE_TIME", 5, "TIMING_METRIC_MS")]),
      node("b", "Sort", [metric("EXCLUSIVE_TIME", 700, "UNKNOWN_TYPE")], { keyMetrics: { durationMs: 3 } }),
      node("c", "Sort", [metric("CUMULATIVE_TIME", 900)]),
      node("d", "Sort", [metric("EXCLUSIVE_TIME", 0)])
    ]));
    assert(p.graphs[0].nodes[0].duration === 5); assert(p.graphs[0].nodes[1].duration === 3);
    assert(p.graphs[0].nodes[2].duration === null); assert(p.graphs[0].nodes[3].duration === 0);
  });
  await test("Duplicate row counters use maximum, not sum; explicit zero wins", () => {
    const metrics = [metric("NUMBER_OUTPUT_ROWS", 0, "SUM_METRIC"), metric("NUMBER_OUTPUT_ROWS", 1200, "SUM_METRIC"), metric("NUMBER_OUTPUT_ROWS", 1200, "SUM_METRIC")];
    const p = P.parse(fixture([node("a", "Shuffle", metrics), node("b", "Scan", metrics, { keyMetrics: { rowsNum: 0 } })]));
    assert(p.graphs[0].nodes[0].rows === 1200); assert(p.graphs[0].nodes[1].rows === 0);
  });
  await test("Missing metrics stay unknown and unknown versions warn", () => {
    const raw = fixture([node("a", "Scan")]); raw.version = "9";
    const p = P.parse(raw), a = P.analyze(p);
    assert(p.warnings.length === 1); assert(a.measuredTime === null); assert(a.maxReportedPeak === null);
    assert(P.bytes(null) === "Not available"); assert(P.ms(0) === "0 ms");
    assert(P.percent(null, 5) === "Not available"); assert(P.bytes(1024) === "1 KiB");
  });
  await test("Wall-clock fallback uses query timestamps", () => {
    const raw = fixture(); raw.query.queryStartTimeMs = 100; raw.query.queryEndTimeMs = 450;
    assert(P.parse(raw).metrics.totalTimeMs === 350);
  });
  await test("Graph totals stay separate and dangling edges warn", () => {
    const raw = fixture([node("a", "Scan", [], { keyMetrics: { durationMs: 5 } })], {}, [{ fromId: "a", toId: "missing" }]);
    raw.graphs.push(fixture([node("a", "Scan", [], { keyMetrics: { durationMs: 7 } })]).graphs[0]);
    const p = P.parse(raw);
    assert(P.analyze(p, 0).measuredTime === 5); assert(P.analyze(p, 1).measuredTime === 7);
    assert(p.warnings.length === 2); assert(p.graphs[0].edges.length === 0);
  });
  await test("Empty graphs yield a usable query-only analysis", () => {
    const p = P.parse({ version: "1.3", query: { metrics: { totalTimeMs: 50 } }, graphs: [] });
    assert(p.warnings.length === 1); assert(P.analyze(p).graph.nodes.length === 0);
  });
  await test("Overlapping intervals are unioned; skipped stages have no fabricated duration", () => {
    const stages = [
      { stageId: 1, startTimeMs: 100, endTimeMs: 200, status: "COMPLETE" },
      { stageId: 2, startTimeMs: 150, endTimeMs: 250, status: "COMPLETE" },
      { stageId: 3, startTimeMs: 0, endTimeMs: 0, status: "SKIPPED" }
    ];
    const a = P.analyze(P.parse(fixture([], {}, [], stages)));
    assert(a.stageActiveTime === 150); assert(a.graph.stages[2].duration === null);
  });
  await test("Stage attempts are preserved; submit delay is separate from runtime", () => {
    const stages = [0, 1].map(attemptId => ({ stageId: 2, attemptId, submissionTime: 100, startTimeMs: 120, endTimeMs: 170 }));
    const p = P.parse(fixture([], {}, [], stages));
    assert(p.graphs[0].stages.length === 2); assert(p.graphs[0].stages[0].launchDelay === 20);
    assert(p.graphs[0].stages[0].duration === 50);
  });
  await test("Compilation threshold is exactly 25%, not a vague proxy", () => {
    for (const [compilationTimeMs, expected] of [[249, false], [250, true]]) {
      const a = P.analyze(P.parse(fixture([], { totalTimeMs: 1000, compilationTimeMs })));
      assert(a.findings.some(f => f.id === "compilation") === expected);
    }
  });
  await test("Queue and fetch threshold is exactly 20%", () => {
    for (const [value, expected] of [[199, false], [200, true]]) {
      const a = P.analyze(P.parse(fixture([], { totalTimeMs: 1000, queuedOverloadTimeMs: value, resultFetchTimeMs: value })));
      assert(a.findings.some(f => f.id === "queue") === expected);
      assert(a.findings.some(f => f.id === "fetch") === expected);
    }
  });
  await test("Positive spill triggers advice; zero spill and high peak alone do not", () => {
    const nodes = [node("a", "Sort", [], { keyMetrics: { peakMemoryBytes: 8 * 1024 ** 3 } })];
    assert(!P.analyze(P.parse(fixture(nodes, { spillToDiskBytes: 0 }))).findings.some(f => f.id === "spill"));
    assert(P.analyze(P.parse(fixture(nodes, { spillToDiskBytes: 1 }))).findings.some(f => f.id === "spill"));
  });
  await test("Stage-only disk spill and query task failures trigger findings", () => {
    const raw = fixture([], {}, [], [{ stageId: 1, diskBytesSpilled: 1 }]);
    raw.query.metrics.taskProgress = { failedTaskCount: 1 };
    const a = P.analyze(P.parse(raw));
    assert(a.findings.some(f => f.id === "spill")); assert(a.findings.some(f => f.id === "failures"));
  });
  await test("Join amplification needs exactly two known inputs and a >=10x ratio", () => {
    const edges = [{ fromId: "join", toId: "left" }, { fromId: "join", toId: "right" }];
    for (const [rows, expected] of [[999, false], [1000, true]]) {
      const nodes = [node("join", "Join", [], { keyMetrics: { rowsNum: rows } }), node("left", "Scan", [], { keyMetrics: { rowsNum: 100 } }), node("right", "Scan", [], { keyMetrics: { rowsNum: 50 } })];
      assert(P.analyze(P.parse(fixture(nodes, {}, edges))).findings.some(f => f.id === "join-join") === expected);
      nodes[2].keyMetrics.rowsNum = null;
      assert(!P.analyze(P.parse(fixture(nodes, {}, edges))).findings.some(f => f.id === "join-join"));
    }
  });
  await test("Conversion threshold is exactly 10% of measured operator time", () => {
    for (const [durationMs, expected] of [[9, false], [10, true]]) {
      const nodes = [node("c", "Row To Columnar", [], { keyMetrics: { durationMs } }), node("s", "Scan", [], { keyMetrics: { durationMs: 100 - durationMs } })];
      assert(P.analyze(P.parse(fixture(nodes))).findings.some(f => f.id === "conversion") === expected);
    }
  });
  await test("Report excludes raw query text and identity fields", () => {
    const raw = fixture(); raw.query.queryText = "private SQL"; raw.query.user = { name: "private identity" };
    const p = P.parse(raw), report = P.report(p, P.analyze(p), "fixture.json");
    const serialized = JSON.stringify(report);
    assert(!serialized.includes("private SQL")); assert(!serialized.includes("private identity"));
    assert(Array.isArray(report.findings) && Array.isArray(report.operators) && Array.isArray(report.stages));
  });
  await test("Scalar metadata wins over empty arrays; array and metaValue formats remain readable", () => {
    assert(P.metadataValues({ value: "Photon Broadcast Hash", values: [], metaValues: [] })[0] === "Photon Broadcast Hash");
    assert(P.metadataValues({ values: ["store_id"] })[0] === "store_id");
    assert(P.metadataValues({ values: [], metaValues: [{ value: "Right" }] })[0] === "Right");
    assert(P.metadataValues({}).length === 0);
  });
  await test("Already-broadcast join does not receive a redundant broadcast recommendation", () => {
    const nodes = [node("j", "Join", [], { metadata: [{ key: "JOIN_ALGORITHM", value: "Photon Broadcast Hash", values: [] }] }),
      node("s", "Shuffle", [], { keyMetrics: { durationMs: 10 }, metadata: [{ key: "PARTITIONING_TYPE", value: "Single" }] })];
    const a = P.analyze(P.parse(fixture(nodes, {}, [{ fromId: "j", toId: "s" }])));
    const f = a.findings.find(f => f.id === "top-operator");
    assert(f.evidence.includes("already uses Photon Broadcast Hash"));
    assert(f.recommendation.includes("adding a broadcast hint is not a new optimization"));
  });
  await test("Provided export has correct timings, task counts, stages, and leading hotspot", async () => {
    const response = await fetch("query-profile_fc0ea46c-1c1f-4c19-9b35-b95317f026db.json");
    assert(response.ok, `Fixture HTTP ${response.status}`);
    const p = P.parse(await response.text()), a = P.analyze(p);
    assert(p.metrics.totalTimeMs === 1268); assert(p.metrics.compilationTimeMs === 461);
    assert(p.metrics.executionTimeMs === 807); assert(p.metrics.taskTotalTimeMs === 365);
    assert(a.graph.nodes.length === 19); assert(a.graph.stages.length === 6);
    assert(a.graph.stages.filter(s => s.status === "SKIPPED").length === 3);
    assert(a.ranked[0].id === "1162"); close(a.ranked[0].duration, 23.735982);
    assert(a.stageActiveTime === 149);
    assert(a.graph.stages.reduce((sum, s) => sum + s.executorTime, 0) === 365);
    assert(a.graph.stages.reduce((sum, s) => sum + s.completed, 0) === 17);
    assert(!a.findings.some(f => f.id === "spill" || f.id.startsWith("join-")));
    assert(a.findings.some(f => f.id === "compilation")); assert(a.findings.some(f => f.id === "local-input"));
    assert(a.findings.find(f => f.id === "top-operator").evidence.includes("already uses Photon Broadcast Hash"));
  });
  const failed = results.filter(r => !r.passed);
  document.getElementById("test-summary").textContent = `${results.length - failed.length}/${results.length} passed; ${failed.length} failed.`;
  document.getElementById("test-results").textContent = results.map(r => `${r.passed ? "PASS" : "FAIL"} ${r.name}${r.error ? `\n  ${r.error}` : ""}`).join("\n");
  globalThis.testResults = { passed: results.length - failed.length, failed: failed.length, results };
})();
