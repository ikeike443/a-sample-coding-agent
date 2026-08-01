// Thin DOM writer: every formatting decision lives in the server-side view
// model (src/dashboard/view-model.ts), which is what the tests cover.
const POLL_INTERVAL_MS = 5000;

function renderCards(container, cards) {
  container.replaceChildren(
    ...cards.map((card) => {
      const el = document.createElement("div");
      el.className = `card tone-${card.tone}`;
      el.id = `card-${card.id}`;

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = card.label;

      const value = document.createElement("div");
      value.className = "value";
      value.textContent = card.value;

      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = card.detail;

      el.append(label, value, detail);
      return el;
    }),
  );
}

function renderRuns(tbody, runs) {
  tbody.replaceChildren(
    ...runs.map((run) => {
      const row = document.createElement("tr");

      const cells = [run.issueLabel, null, run.triggerType, run.detectedAtLabel, null, run.elapsedLabel];
      for (const text of cells) {
        const td = document.createElement("td");
        if (text !== null) {
          td.textContent = text;
        }
        row.append(td);
      }

      const statusCell = row.children[1];
      const status = document.createElement("span");
      status.className = `status tone-${run.tone}`;
      status.textContent = run.statusLabel;
      statusCell.append(status);

      const prCell = row.children[4];
      if (run.prUrl) {
        const link = document.createElement("a");
        link.href = run.prUrl;
        link.textContent = run.prUrl.replace("https://github.com/", "");
        link.target = "_blank";
        link.rel = "noreferrer";
        prCell.append(link);
      } else {
        prCell.textContent = "—";
      }

      return row;
    }),
  );
}

function renderTrend(container, points) {
  const width = 600;
  const height = 120;
  const padding = 8;

  if (points.length === 0) {
    container.replaceChildren();
    return;
  }

  const step = points.length === 1 ? 0 : (width - padding * 2) / (points.length - 1);
  const coords = points.map((point, index) => {
    const x = padding + step * index;
    const y = padding + (1 - point.successRate) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "trend");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#1a7f37");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("points", coords.join(" "));

  svg.append(line);
  container.replaceChildren(svg);
}

async function refresh() {
  const statusLine = document.getElementById("status-line");
  try {
    const response = await fetch("/dashboard/metrics", { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const { view } = await response.json();

    renderCards(document.getElementById("cards"), view.cards);
    renderRuns(document.querySelector("#runs tbody"), view.recentRuns);
    renderTrend(document.getElementById("trend"), view.successRateTrend);

    const empty = document.getElementById("empty");
    empty.textContent = view.emptyMessage;
    empty.hidden = view.hasRuns;
    document.getElementById("runs").hidden = !view.hasRuns;

    statusLine.textContent = `Updated ${view.generatedAtLabel} UTC · auto-refreshing every ${
      POLL_INTERVAL_MS / 1000
    }s`;
  } catch (error) {
    statusLine.textContent = `Failed to load metrics: ${error.message} · retrying…`;
  }
}

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
