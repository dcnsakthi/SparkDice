"use strict";

(() => {
  const P = globalThis.Profile;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sampleFile = "query-profile_fc0ea46c-1c1f-4c19-9b35-b95317f026db.json";
  const maxBytes = 50 * 1024 * 1024;
  let profile, analysis, filename, graphIndex = 0, loadSequence = 0;
  const card = (label, value, note) => `<article class="card"><div class="card-label">${escape(label)}</div><div class="card-value">${escape(value)}</div><div class="card-note">${escape(note)}</div></article>`;
  const row = (label, value) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`;
  const operatorLink = (id, label = `#${id}`) => `<button type="button" class="node-link" data-node="${escape(id)}">${escape(label)}</button>`;
  const details = (label, value) => `<details><summary>${escape(label)}</summary><pre class="code">${escape(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre></details>`;
  function error(message) {
    $("error").textContent = message;
    $("error").hidden = false;
  }
  function switchTab(id) {
    document.querySelectorAll(".panel").forEach(panel => { panel.hidden = panel.id !== id; });
    document.querySelectorAll("[data-tab]").forEach(button => {
      if (button.dataset.tab === id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }
  function load(text, name) {
    const parsed = P.parse(text);
    profile = parsed;
    filename = name;
    graphIndex = 0;
    $("error").hidden = true;
    $("empty").hidden = true;
    $("workspace").hidden = false;
    $("operator-search").value = "";
    $("operator-sort").value = "duration";
    $("zoom").value = "1";
    $("detail").close();
    $("graph-select").innerHTML = profile.graphs.length ? profile.graphs.map((g, i) =>
      `<option value="${i}">Graph ${i + 1} / execution ${escape(g.executionId)}</option>`).join("") : '<option value="0">No graph exported</option>';
    $("graph-select").disabled = profile.graphs.length < 2;
    render();
    switchTab("overview");
    $("load-status").textContent = `Loaded ${name}. Parsed locally; no profile data is sent to a service.`;
  }
  async function loadFile(file) {
    if (!file) return;
    const sequence = ++loadSequence;
    $("error").hidden = true;
    $("load-status").textContent = `Reading ${file.name}...`;
    try {
      if (file.size > maxBytes) throw new Error("File is larger than the supported 50 MiB limit.");
      const text = await file.text();
      if (sequence !== loadSequence) return;
      load(text, file.name);
    } catch (cause) {
      if (sequence !== loadSequence) return;
      $("load-status").textContent = profile ? `Still showing ${filename}.` : "";
      error(`Could not open ${file.name}: ${cause.message}`);
    }
  }
  function render() {
    analysis = P.analyze(profile, graphIndex);
    const m = profile.metrics, q = profile.query;
    $("filename").textContent = filename;
    $("query-title").textContent = q.queryText ? String(q.queryText).slice(0, 160) : "Query profile";
    $("query-info").textContent = `${q.status || "Unknown status"} / Query ${q.id || "ID unavailable"} / Export ${profile.raw.version || "version unavailable"}`;
    $("warnings").innerHTML = profile.warnings.map(w => `<div class="notice">${escape(w)}</div>`).join("");
    $("summary").innerHTML = [
      card("Wall-clock duration", P.ms(m.totalTimeMs), "Query-level elapsed time"),
      card("Execution", P.ms(m.executionTimeMs), "Reported execution phase"),
      card("Compilation", P.ms(m.compilationTimeMs), `${P.percent(m.compilationTimeMs, m.totalTimeMs)} of wall clock`),
      card("Aggregated task time", P.ms(m.taskTotalTimeMs), "Across tasks, not wall clock"),
      card("Output rows", P.fmt(m.rowsProducedCount), q.metrics?.resultFromCache === true ? "Result served from cache" :
        q.metrics?.resultFromCache === false ? "Not a result-cache hit" : "Result-cache status unavailable"),
      card("Disk spill", P.bytes(m.spillToDiskBytes), "Query-level reported bytes")
    ].join("");
    $("stage-filter").innerHTML = '<option value="">All stages</option>' +
      [...new Set(analysis.graph.stages.map(s => s.id).concat(analysis.graph.nodes.flatMap(n => n.stageIds)))]
        .map(id => `<option value="${escape(id)}">Stage ${escape(id)}</option>`).join("");
    renderOverview();
    renderOperators();
    renderStages();
    renderPlan();
    renderFindings();
    renderQuery();
  }
  function bar(label, value, total, color = "") {
    const width = value !== null && total > 0 ? Math.min(100, value / total * 100) : 0;
    return `<div class="bar-row"><span>${escape(label)}</span><div class="bar-track"><div class="bar-fill ${color}" style="width:${width}%"></div></div><strong>${escape(P.ms(value))}</strong></div>`;
  }
  function finding(f, compact = false) {
    return `<article class="finding ${f.priority.toLowerCase()}">
      <div class="finding-heading"><span class="badge ${f.priority.toLowerCase()}">${escape(f.priority)}</span><h3>${escape(f.title)}</h3></div>
      <span class="finding-label">Evidence</span><p>${escape(f.evidence)}</p>
      <span class="finding-label">Suggested next step</span><p>${escape(f.recommendation)}</p>
      ${compact ? "" : `<span class="finding-label">How to validate</span><p>${escape(f.validation)}</p>`}
      ${f.nodeIds.map(id => operatorLink(id)).join("")}</article>`;
  }
  function renderOverview() {
    const m = profile.metrics, stages = analysis.graph.stages;
    const measured = analysis.ranked.slice(0, 5);
    $("overview").innerHTML = `<div class="two-col">
      <article class="box"><h2>Where did the time go?</h2><p class="muted">Each bar is relative to query wall clock, not a stacked total.</p>
      ${bar("Compilation", m.compilationTimeMs ?? null, m.totalTimeMs)}
      ${bar("Execution", m.executionTimeMs ?? null, m.totalTimeMs, "blue")}
      ${bar("Result fetch", m.resultFetchTimeMs ?? null, m.totalTimeMs, "orange")}
      ${bar("Provisioning queue", m.queuedProvisioningTimeMs ?? null, m.totalTimeMs)}
      ${bar("Overload queue", m.queuedOverloadTimeMs ?? null, m.totalTimeMs)}
      <p class="hint">Phase definitions may overlap. Fetch time is shown separately, not added to execution. Gaps between stage intervals do not prove scheduler overhead.</p></article>
      <article class="box"><h2>Top measured operators</h2><p class="muted">Ranked within the selected graph. Missing timings are excluded.</p>
      ${measured.length ? measured.map(n => `<div class="bar-row"><span>${operatorLink(n.id, n.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${measured[0].duration > 0 ? 100 * n.duration / measured[0].duration : 0}%"></div></div><strong>${P.ms(n.duration)}</strong></div>`).join("") : '<p class="muted">No operator timings were exported.</p>'}
      <p class="hint">Measured operator time: <strong>${P.ms(analysis.measuredTime)}</strong>. Exclusive nanosecond metrics retain sub-millisecond precision. Not the same scope as aggregated task time.</p></article>
      <article class="box"><h2>Data movement &amp; memory</h2><dl class="metric-list">
        ${row("Storage bytes read", P.bytes(m.readBytes))}${row("Reported storage rows read", P.fmt(m.rowsReadCount))}
        ${row("Remote bytes read", P.bytes(m.readRemoteBytes))}${row("Disk-cache bytes read", P.bytes(m.readCacheBytes))}
        ${row("Network bytes sent", P.bytes(m.networkSentBytes))}${row("Files read / pruned", `${P.fmt(m.readFilesCount)} / ${P.fmt(m.prunedFilesCount)}`)}
        ${row("Largest operator-reported peak", P.bytes(analysis.maxReportedPeak))}
        ${row("Photon task time", P.ms(m.photonTotalTimeMs))}
      </dl><p class="muted">Peak counters may include stage-level memory; peaks are not summed. Local inputs can process rows while storage read counters remain zero.</p></article>
      <article class="box"><h2>Execution coverage</h2><dl class="metric-list">
        ${row("Operators / dependency edges", `${analysis.graph.nodes.length} / ${analysis.graph.edges.length}`)}
        ${row("Exported stage attempts", P.fmt(stages.length))}
        ${row("Completed / skipped stages", `${stages.filter(s => /^(COMPLETE|COMPLETED)$/.test(s.status)).length} / ${stages.filter(s => s.status === "SKIPPED").length}`)}
        ${row("Query completed / planned tasks", `${P.fmt(P.number(profile.query.metrics?.taskProgress?.completedTaskCount))} / ${P.fmt(P.number(profile.query.metrics?.taskProgress?.plannedTaskCount))}`)}
        ${row("Union of observed stage intervals", P.ms(analysis.stageActiveTime))}
      </dl><p class="muted">Overlapping stage intervals are counted once. Skipped stages do not imply failed work. Per-task skew, CPU saturation, and GC require additional telemetry.</p></article>
      </div><div class="quick-findings"><div class="section-heading"><h2>Start here</h2><button type="button" data-go="recommendations">All recommendations (${analysis.findings.length})</button></div>
      ${analysis.findings.slice(0, 2).map(f => finding(f, true)).join("")}</div>`;
  }
  function renderOperators() {
    const query = $("operator-search").value.toLowerCase(), stage = $("stage-filter").value, sort = $("operator-sort").value;
    const nodes = analysis.graph.nodes.filter(n => (!query || `${n.name} ${n.id} ${n.tag}`.toLowerCase().includes(query)) &&
      (!stage || n.stageIds.includes(stage))).sort((a, b) => sort === "id" ? a.id.localeCompare(b.id, undefined, { numeric: true }) :
      (b[sort] ?? -1) - (a[sort] ?? -1));
    $("operator-count").textContent = `${nodes.length} of ${analysis.graph.nodes.length} operators. Export-hidden operators are included.`;
    $("operator-table").innerHTML = `<table><thead><tr><th>Operator</th><th>Measured time</th><th>Time share*</th><th>Output rows</th><th>Reported peak</th><th>Stages</th></tr></thead><tbody>
      ${nodes.map(n => `<tr><td>${operatorLink(n.id, `${n.name} #${n.id}`)}${n.hidden ? '<span class="badge observation">Export-hidden</span>' : ""}<div class="muted">${escape(n.tag)}</div></td>
      <td class="numeric" title="${escape(n.timeBasis)}">${P.ms(n.duration)}</td><td class="numeric">${P.percent(n.duration, analysis.measuredTime)}</td>
      <td class="numeric">${P.fmt(n.rows)}</td><td class="numeric">${P.bytes(n.peak)}</td><td>${escape(n.stageIds.join(", ") || "Not linked")}</td></tr>`).join("") ||
      '<tr><td colspan="6">No matching operators.</td></tr>'}</tbody></table><p class="muted">* Share of measured operator time, not elapsed query time. Hover the time value for its source; select an operator for all raw metrics.</p>`;
  }
  function renderStages() {
    const stages = analysis.graph.stages;
    const timestamps = stages.flatMap(s => [s.start, s.end]).filter(t => t !== null);
    const start = timestamps.reduce((a, b) => a === null ? b : Math.min(a, b), null);
    const end = timestamps.reduce((a, b) => a === null ? b : Math.max(a, b), null);
    const span = start !== null && end !== null ? Math.max(1, end - start) : 1;
    $("stages").innerHTML = `<h2>Stage attempts</h2><p class="muted">Actual exported timestamps, aligned to the first observed stage start. No synthetic task timeline.</p>
      ${!stages.length ? '<div class="notice">No stage data was exported for this graph.</div>' : `<div class="timeline">
      ${stages.map(s => `<div class="timeline-row"><span>Stage ${escape(s.id)} / attempt ${P.fmt(s.attempt)}</span><div class="timeline-track">
      ${s.status !== "SKIPPED" && s.start !== null && s.end !== null && s.end >= s.start ?
        `<div class="timeline-bar" style="left:${100 * (s.start - start) / span}%;width:${100 * (s.end - s.start) / span}%" title="+${P.ms(s.start - start)} to +${P.ms(s.end - start)}"></div>` :
        `<span class="timeline-skipped">${escape(s.status === "SKIPPED" ? "Skipped" : "Timestamps unavailable")}</span>`}</div><span>${P.ms(s.duration)}</span></div>`).join("")}
      </div><p class="muted">Timeline span: ${start !== null && end !== null ? P.ms(end - start) : "Not available"}. Stage interval union: ${P.ms(analysis.stageActiveTime)}. Inter-stage gaps are not attributed to a cause.</p>
      <div class="table-scroll"><table><thead><tr><th>Stage / attempt</th><th>Status</th><th>Complete / planned tasks</th><th>Failed / killed</th><th>Elapsed</th><th>Aggregate executor time</th><th>Submit to first task</th><th>Disk spill</th><th>Remote read</th><th>Operators</th></tr></thead><tbody>
      ${stages.map(s => `<tr><td>${escape(s.id)} / ${P.fmt(s.attempt)}</td><td>${escape(s.status)}</td><td>${P.fmt(s.completed)} / ${P.fmt(s.tasks)}</td>
      <td>${P.fmt(s.failed)} / ${P.fmt(s.killed)}</td><td class="numeric">${P.ms(s.duration)}</td><td class="numeric">${P.ms(s.executorTime)}</td><td class="numeric">${P.ms(s.launchDelay)}</td>
      <td>${P.bytes(s.spill)}</td><td>${P.bytes(s.remoteRead)}</td><td>${analysis.graph.nodes.filter(n => n.stageIds.includes(s.id)).map(n => operatorLink(n.id)).join("") || "Not linked"}</td></tr>`).join("")}
      </tbody></table></div>`}
      <p class="hint">Stage links do not identify an attempt. Operators linked to a stage are shown for every exported attempt of that stage. Skipped stages are preserved, but are excluded from elapsed-interval calculations.</p>
      ${details("Raw stage data (may contain identities and plan literals)", stages.map(s => s.raw))}`;
  }
  function renderPlan() {
    const svg = $("dag"), { nodes, edges } = analysis.graph;
    svg.replaceChildren();
    if (!nodes.length) {
      $("plan-status").textContent = "No operators were exported for this graph.";
      svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
      return;
    }
    const incoming = new Map(nodes.map(n => [n.id, 0]));
    const children = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) { incoming.set(e.to, incoming.get(e.to) + 1); children.get(e.from).push(e.to); }
    const queue = nodes.filter(n => incoming.get(n.id) === 0).map(n => n.id);
    const levels = new Map(queue.map(id => [id, 0]));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const child of children.get(id)) {
        levels.set(child, Math.max(levels.get(child) ?? 0, levels.get(id) + 1));
        incoming.set(child, incoming.get(child) - 1);
        if (incoming.get(child) === 0) queue.push(child);
      }
    }
    const cyclic = queue.length !== nodes.length;
    if (cyclic) nodes.forEach((n, i) => levels.set(n.id, i));
    $("plan-status").textContent = cyclic ?
      "This graph contains a dependency cycle. Displaying a linear fallback with the original edges; do not interpret it as execution order." :
      `${nodes.length} operators / ${edges.length} dependency edges. Orange marks the top three positive measured timings, not a proven critical path.`;
    const byLevel = new Map();
    for (const n of nodes) {
      const level = levels.get(n.id);
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(n);
    }
    const widest = Math.max(...[...byLevel.values()].map(group => group.length));
    const width = Math.max(760, widest * 260 + 60), height = byLevel.size * 122 + 50;
    const zoom = Number($("zoom").value);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width * zoom)); svg.setAttribute("height", String(height * zoom));
    const ns = "http://www.w3.org/2000/svg";
    const element = (tag, attrs, content) => {
      const el = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
      if (content !== undefined) el.textContent = content;
      return el;
    };
    const defs = element("defs", {});
    const marker = element("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
    marker.append(element("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#a7bdc9" }));
    defs.append(marker); svg.append(defs);
    const positions = new Map();
    byLevel.forEach((group, level) => group.forEach((n, i) =>
      positions.set(n.id, { x: (width - group.length * 260) / 2 + i * 260 + 10, y: level * 122 + 24 })));
    edges.forEach(e => {
      const a = positions.get(e.from), b = positions.get(e.to);
      const x1 = a.x + 120, y1 = a.y + 88, x2 = b.x + 120, y2 = b.y;
      svg.append(element("path", { d: `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`,
        class: "dag-edge", "marker-end": "url(#arrow)" }));
    });
    const hot = new Set(analysis.ranked.filter(n => n.duration > 0).slice(0, 3).map(n => n.id));
    nodes.forEach(n => {
      const { x, y } = positions.get(n.id);
      const group = element("g", { class: `dag-node${hot.has(n.id) ? " hot" : ""}`, tabindex: 0, role: "button",
        "aria-label": `${n.name} #${n.id}, time ${P.ms(n.duration)}, output ${P.fmt(n.rows)} rows`, "data-node": n.id, transform: `translate(${x} ${y})` });
      group.append(element("title", {}, `${n.name} #${n.id} | ${n.timeBasis}`));
      group.append(element("rect", { width: 240, height: 88, rx: 7 }));
      group.append(element("text", { x: 12, y: 23, class: "dag-title" }, n.name.length > 29 ? `${n.name.slice(0, 26)}...` : n.name));
      group.append(element("text", { x: 12, y: 43, class: "dag-sub" }, `#${n.id} / stages ${n.stageIds.join(", ") || "-"}`));
      group.append(element("text", { x: 12, y: 65, class: "dag-time" }, P.ms(n.duration)));
      group.append(element("text", { x: 114, y: 65, class: "dag-sub" }, `${P.fmt(n.rows)} rows`));
      group.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showNode(n.id); }
      });
      svg.append(group);
    });
  }
  function renderFindings() {
    $("recommendations").innerHTML = `<div class="section-heading"><div><h2>Hotspots &amp; recommendations</h2><p class="muted">Deterministic rules, grounded in this export. Relative expense is not proof of a performance problem.</p></div><span class="badge">${analysis.findings.length} findings</span></div>
      <div class="hint">Priority describes what to investigate, not a predicted speedup. Recommendations are conditional; validate correctness, runtime, and cost before adopting them.</div>
      ${analysis.findings.map(f => finding(f)).join("")}
      ${details("Rule thresholds and interpretation", "Compilation >= 25% of wall clock; summed known queue time >= 20%; result fetch >= 20%; disk spill > 0; failed task/stage count > 0; join output >= 10x the larger of exactly two immediate inputs; row/columnar conversion >= 10% of measured operator time. The top positive measured operator and longest reported stage are always surfaced. Local scans trigger a storage-scope caveat. Operator ranking sums EXCLUSIVE_TIME components with known units, falling back to keyMetrics.durationMs; it never sums cumulative timing. No skew claim is made without task distributions.")}`;
  }
  function renderQuery() {
    $("query").innerHTML = `<h2>Query &amp; provenance</h2><pre class="code">${escape(profile.query.queryText || "Query text not exported.")}</pre>
      <h3>What this file can tell you</h3><ul><li>Query-level timings, I/O counters, and task progress when supplied.</li><li>Operator dependencies, metrics, expressions, and stage links.</li><li>Stage attempts and elapsed intervals if timestamps were exported.</li></ul>
      <h3>What it cannot establish by itself</h3><ul><li>Per-task skew, executor CPU utilization, GC pauses, scheduling root causes, or a proven critical path.</li>
      <li>Full application history, jobs, or unexported upstream actions. A display or limit action may not represent the full production workload.</li>
      <li>Exact savings, appropriate cluster size, or safe broadcast size from row counts alone.</li>
      <li>Storage layout or pruning effectiveness when only local-input operators are present.</li></ul>
      <p class="hint">A reported zero is preserved. Missing and null metrics remain unavailable. The largest reported operator peak is not query-wide simultaneous memory usage. Different execution graphs are never added together.</p>
      <h3>Privacy &amp; compatibility</h3><p class="muted">Files are read in this browser. No telemetry, remote libraries, or external analysis service is used. Opening a new file replaces the current view; reload clears it. Version 1.3 is verified with the supplied export. Other versions are accepted only when they retain the query/graphs structure; unrecognized metrics remain visible in raw details. Analysis reports omit raw SQL and identities but can still contain sensitive names and metrics.</p>
      <a class="small-link" href="https://docs.databricks.com/aws/en/sql/user/queries/query-profile" target="_blank" rel="noreferrer">Databricks query profile documentation</a>
      ${details("Raw query metrics", profile.query.metrics ?? {})}
      ${details("Exported Databricks insights (not inferred by this viewer)", profile.raw.insights ?? [])}
      ${details("Raw query metadata (may contain personal information)", profile.query)}`;
  }
  function showNode(id) {
    const node = analysis.graph.nodes.find(n => n.id === id);
    if (!node) { error(`Operator ${id} is not present in this execution graph.`); return; }
    const inputs = analysis.graph.edges.filter(e => e.from === id).map(e => e.to);
    const consumers = analysis.graph.edges.filter(e => e.to === id).map(e => e.from);
    $("detail-body").innerHTML = `<h2>${escape(node.name)} <span class="muted">#${escape(node.id)}</span></h2>
      <p class="muted">${escape(node.tag)} / stages ${escape(node.stageIds.join(", ") || "not linked")}</p>
      <div class="cards">${card("Measured time", P.ms(node.duration), node.timeBasis)}${card("Output rows", P.fmt(node.rows), "Not input rows")}${card("Reported peak", P.bytes(node.peak), "May include stage-level counters")}</div>
      <p>Inputs: ${inputs.map(n => operatorLink(n)).join("") || "None exported"}<br>Consumers: ${consumers.map(n => operatorLink(n)).join("") || "None exported"}</p>
      <h3>Expressions &amp; metadata</h3><div class="table-scroll"><table><tbody>${node.metadata.map(m =>
        `<tr><th>${escape(m.label || m.key)}</th><td><div class="metadata-value">${escape(P.metadataValues(m).join("\n") || "Not available")}</div></td></tr>`).join("") || "<tr><td>No metadata exported.</td></tr>"}</tbody></table></div>
      ${details("Expression SQL", node.raw.expressionSqls ?? [])}
      <label class="detail-search">Filter all ${node.metrics.length} metrics (including hidden metrics)<input id="metric-search" type="search" placeholder="e.g. exclusive, shuffle, spill, memory"></label>
      <div id="metric-table" class="table-scroll"></div>
      ${details("Raw operator JSON", node.raw)}`;
    const renderMetrics = () => {
      const search = $("metric-search").value.toLowerCase();
      const metrics = node.metrics.filter(m => `${m.label} ${m.key}`.toLowerCase().includes(search));
      $("metric-table").innerHTML = `<table><thead><tr><th>Metric</th><th>Formatted value</th><th>Raw value / unit</th></tr></thead><tbody>
        ${metrics.map(m => `<tr><td>${escape(m.label || m.key)}<div class="muted">${escape(m.key)}</div></td><td class="numeric">${escape(P.formatMetric(m))}</td><td>${escape(P.text(m.value))}<div class="muted">${escape(m.metricType)}</div></td></tr>`).join("") ||
        '<tr><td colspan="3">No matching metrics.</td></tr>'}</tbody></table>`;
    };
    $("metric-search").addEventListener("input", renderMetrics);
    renderMetrics();
    if (!$("detail").open) $("detail").showModal();
    $("detail").scrollTop = 0;
  }
  document.addEventListener("click", event => {
    const node = event.target.closest("[data-node]");
    if (node) { showNode(node.dataset.node); return; }
    const tab = event.target.closest("[data-tab],[data-go]");
    if (tab) switchTab(tab.dataset.tab || tab.dataset.go);
  });
  $("file").addEventListener("change", event => { loadFile(event.target.files[0]); event.target.value = ""; });
  for (const type of ["dragenter", "dragover"]) $("dropzone").addEventListener(type, event => {
    event.preventDefault(); $("dropzone").classList.add("dragging");
  });
  for (const type of ["dragleave", "drop"]) $("dropzone").addEventListener(type, event => {
    event.preventDefault(); $("dropzone").classList.remove("dragging");
  });
  $("dropzone").addEventListener("drop", event => {
    if (event.dataTransfer.files.length !== 1) { error("Please drop exactly one query-profile JSON file."); return; }
    loadFile(event.dataTransfer.files[0]);
  });
  $("sample").addEventListener("click", async () => {
    const sequence = ++loadSequence;
    $("sample").disabled = true;
    $("error").hidden = true;
    $("load-status").textContent = "Reading the supplied example...";
    try {
      if (location.protocol === "file:") throw new Error("The example button requires the local server. Use Open query profile to select the supplied JSON when opening this page directly.");
      const response = await fetch(sampleFile);
      if (!response.ok) throw new Error(`Example request failed (HTTP ${response.status}). Use Open query profile to select a JSON export.`);
      const text = await response.text();
      if (sequence === loadSequence) load(text, sampleFile);
    } catch (cause) {
      if (sequence === loadSequence) {
        error(cause.message); $("load-status").textContent = profile ? `Still showing ${filename}.` : "";
      }
    } finally { $("sample").disabled = false; }
  });
  $("graph-select").addEventListener("change", () => { graphIndex = Number($("graph-select").value); render(); });
  $("zoom").addEventListener("change", renderPlan);
  $("operator-search").addEventListener("input", renderOperators);
  $("stage-filter").addEventListener("change", renderOperators);
  $("operator-sort").addEventListener("change", renderOperators);
  $("close-detail").addEventListener("click", () => $("detail").close());
  $("export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(P.report(profile, analysis, filename), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `analysis-${String(profile.query.id || "query").replace(/[^a-z0-9_-]/gi, "_")}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
