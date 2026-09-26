// Mermaid flowchart -> Archify workflow v2 converter (best-effort, mechanical).
// Maps subgraphs to lanes, longest-path layering to columns (0..5), shape to
// component type, and infers edge roles (main/branch/return). Everything the
// converter cannot represent faithfully is reported in `warnings`, and the
// imported spec still goes through the normal archify validator.

const TYPE_BY_SHAPE = {
  rect: 'backend',
  round: 'frontend',
  stadium: 'frontend',
  diamond: 'security',
  cylinder: 'database',
  parallelogram: 'external',
  hexagon: 'cloud',
  default: 'backend',
};

function parseMermaidFlowchart(code) {
  const lines = String(code || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());
  const warnings = [];
  const nodes = new Map(); // id -> {label, shape, lane}
  const edges = [];
  const lanes = []; // {id, label} in declaration order
  const laneStack = [];
  let sawHeader = false;

  const laneId = (label, index) => `lane${index}`;

  function ensureNode(rawId) {
    const id = rawId.trim();
    if (!id) return null;
    if (!nodes.has(id)) {
      nodes.set(id, { label: id, shape: 'default', lane: laneStack.at(-1)?.id ?? laneId('Main', 0) });
    }
    return id;
  }

  function registerLane(id, label) {
    const existing = lanes.find((lane) => lane.id === id || lane.label === label);
    if (existing) return existing;
    const lane = { id: id || laneId(label, lanes.length), label: label || id };
    lanes.push(lane);
    return lane;
  }

  const mainLane = registerLane('main', 'Main');

  // Shape syntax per Mermaid flowchart docs: id[text], id(text), id{text},
  // id[(text)] cylinder, id([text]) stadium, id[[text]] subroutine,
  // id{{text}} hexagon, id[/text/] or id[\text\] parallelogram.
  function parseNodeToken(token) {
    const match = token.trim().match(/^([A-Za-z0-9_-]+)([\s\S]*)$/);
    if (!match) return null;
    const id = match[1];
    const rest = match[2].trim();
    let label = id;
    let shape = 'default';
    let inner = null;
    if (rest.length >= 2) {
      if (rest[0] === '[' && rest.at(-1) === ']' && rest.length >= 4
          && (rest[1] === '/' || rest[1] === '\\') && (rest.at(-2) === '/' || rest.at(-2) === '\\')) {
        shape = 'parallelogram';
        inner = rest.slice(2, -2);
      } else {
        for (const [open, close, name] of [['[(', ')]', 'cylinder'], (['([', '])', 'stadium']), ['[[', ']]', 'rect'], ['{{', '}}', 'hexagon']]) {
          if (rest.startsWith(open) && rest.endsWith(close) && rest.length >= 4) {
            shape = name;
            inner = rest.slice(2, -2);
            break;
          }
        }
        if (inner === null) {
          for (const [open, close, name] of [['[', ']', 'rect'], ['(', ')', 'round'], ['{', '}', 'diamond']]) {
            if (rest[0] === open && rest.at(-1) === close) {
              shape = name;
              inner = rest.slice(1, -1);
              break;
            }
          }
        }
      }
      if (inner !== null) {
        const text = inner.replace(/^["']+|["']+$/g, '').trim();
        if (text) label = text;
      }
    }
    return { id, label, shape };
  }

  const ARROW = /-{2,3}>|=\s*>|-\.->|==>|--o|--x/;

  for (const rawLine of lines) {
    let line = rawLine;
    if (!line || line.startsWith('%%')) continue;
    if (/^(flowchart|graph)\s+(TD|TB|LR|BT|RL|X)\b/i.test(line)) { sawHeader = true; continue; }
    if (/^(flowchart|graph)\b/i.test(line)) { sawHeader = true; warnings.push('忽略 flowchart 方向声明（archify 工作流固定为泳道左→右）'); continue; }
    if (/^(classDef|class|click|linkStyle|style|initialState|note|actor)\b/i.test(line)) {
      warnings.push(`忽略不支持的 Mermaid 行：${line.slice(0, 40)}`);
      continue;
    }
    const subgraphMatch = line.match(/^subgraph\s+(.+)$/i);
    if (subgraphMatch) {
      let spec = subgraphMatch[1].trim();
      let id;
      let label = spec;
      const bracket = spec.match(/^([A-Za-z0-9_-]+)\s*\[["']?([\s\S]*?)["']?\]$/);
      if (bracket) {
        id = bracket[1];
        label = bracket[2] || id;
      } else {
        id = spec.split(/\s+/)[0].replace(/[^A-Za-z0-9_-]/g, '');
        label = spec;
      }
      const lane = registerLane(id || laneId(label, lanes.length), label);
      laneStack.push(lane);
      continue;
    }
    if (/^end$/i.test(line)) {
      laneStack.pop();
      continue;
    }
    if (!sawHeader && !ARROW.test(line) && !/^[A-Za-z0-9_-]+\s*[\[\(\{]/.test(line)) continue;

    // Edge line
    if (ARROW.test(line)) {
      const arrowMatch = line.match(ARROW);
      const arrow = arrowMatch[0];
      let label = '';
      const pipeLabel = line.match(/(?:-->|---|==>)\s*\|([^|]+)\|\s*/);
      if (pipeLabel) label = pipeLabel[1].trim();
      const textArrow = line.match(/--\s+([^-][\s\S]*?)\s+-->/);
      if (!pipeLabel && textArrow) label = textArrow[1].trim();
      const parts = line.split(ARROW);
      const leftTokens = parts[0].split('&').map((t) => t.trim()).filter(Boolean);
      const rightTokens = parts.slice(1).join(' ').replace(/\|[^|]+\|/g, '').trim().split('&').map((t) => t.trim()).filter(Boolean);
      for (const left of leftTokens) {
        for (const right of rightTokens) {
          const fromNode = parseNodeToken(left);
          const toNode = parseNodeToken(right);
          if (!fromNode || !toNode) continue;
          const from = ensureNode(fromNode.id);
          const to = ensureNode(toNode.id);
          // A bare reference (no shape/label of its own) must not clobber the
          // declaration an earlier line already made for the same node.
          if (fromNode.shape !== 'default') nodes.get(from).shape = fromNode.shape;
          if (fromNode.label !== fromNode.id) nodes.get(from).label = fromNode.label;
          if (toNode.shape !== 'default') nodes.get(to).shape = toNode.shape;
          if (toNode.label !== toNode.id) nodes.get(to).label = toNode.label;
          if (laneStack.length) nodes.get(from).lane = laneStack.at(-1).id;
          edges.push({
            from,
            to,
            label,
            variant: arrow.includes('.') ? 'dashed' : arrow.startsWith('==') ? 'emphasis' : 'default',
          });
        }
      }
      continue;
    }

    // Standalone node declaration
    const node = parseNodeToken(line);
    if (node && /^[A-Za-z0-9_-]+/.test(line)) {
      const id = ensureNode(node.id);
      if (node.shape !== 'default') nodes.get(id).shape = node.shape;
      if (node.label !== node.id) nodes.get(id).label = node.label;
      if (laneStack.length) nodes.get(id).lane = laneStack.at(-1).id;
    }
  }

  // Attach lanes referenced before any subgraph assigned (nodes in main lane).
  for (const node of nodes.values()) {
    if (!lanes.some((lane) => lane.id === node.lane)) node.lane = mainLane.id;
  }
  return { nodes, edges, lanes, warnings };
}

function layerNodes(nodeIds, edges) {
  // Drop DFS back edges first: Mermaid flowcharts are full of retry/return
  // cycles, and without removing them the longest-path layering inflates the
  // whole cycle to the column cap. Excluded edges become `return` roles.
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge);
  const state = new Map(nodeIds.map((id) => [id, 0])); // 0 new, 1 on stack, 2 done
  const isBackEdge = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const edge of outgoing.get(id) || []) {
      const target = state.get(edge.to);
      if (target === 1) isBackEdge.add(edge);
      else if (target !== 2) visit(edge.to);
    }
    state.set(id, 2);
  };
  for (const id of nodeIds) {
    if (state.get(id) === 0) visit(id);
  }

  const level = new Map(nodeIds.map((id) => [id, 0]));
  const incoming = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (isBackEdge.has(edge)) continue;
    incoming.get(edge.to)?.push(edge.from);
  }
  // Longest-path layering over the now-acyclic edge set; iterate to a fixed
  // point, then clamp to the 6-column contract.
  for (let pass = 0; pass < nodeIds.length; pass += 1) {
    let changed = false;
    for (const id of nodeIds) {
      let next = level.get(id);
      for (const parent of incoming.get(id)) {
        const candidate = level.get(parent) + 1;
        if (candidate > next) {
          next = candidate;
          changed = true;
        }
      }
      level.set(id, next);
    }
    if (!changed) break;
  }
  return { level, isBackEdge };
}

function longestForwardChain(nodeIds, edges, level) {
  const forward = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (level.get(edge.to) > level.get(edge.from)) forward.get(edge.from)?.push(edge.to);
  }
  const best = new Map();
  const bestFrom = new Map();
  // Process from the deepest level backwards so every successor's own longest
  // chain is already resolved when its predecessors are computed.
  const order = [...nodeIds].sort((a, b) => level.get(b) - level.get(a));
  for (const id of order) {
    let length = 1;
    let tail = null;
    for (const next of forward.get(id) || []) {
      if ((best.get(next) ?? 0) + 1 > length) {
        length = (best.get(next) ?? 0) + 1;
        tail = next;
      }
    }
    best.set(id, length);
    bestFrom.set(id, tail);
  }
  let head = order[0];
  for (const id of order) {
    if ((best.get(id) ?? 0) > (best.get(head) ?? 0)) head = id;
  }
  const chain = [];
  for (let cursor = head; cursor != null; cursor = bestFrom.get(cursor)) {
    chain.push(cursor);
    if (chain.length > nodeIds.length) break;
  }
  return chain;
}

function cellKey(lane, column) {
  return `${lane}#${column}`;
}

export function mermaidToWorkflow(code, { title } = {}) {
  const parsed = parseMermaidFlowchart(code);
  const warnings = [...parsed.warnings];
  if (!parsed.nodes.size) {
    return { ok: false, error: '未能从 Mermaid 中解析出任何节点（目前支持 flowchart 的节点/连线/subgraph 语法）' };
  }
  if (parsed.edges.length === 0) warnings.push('未解析到连线：将生成无关系的工作流');

  const nodeIds = [...parsed.nodes.keys()];
  const { level, isBackEdge } = layerNodes(nodeIds, parsed.edges);
  if (isBackEdge.size) {
    warnings.push(`检测到 ${isBackEdge.size} 条回环连线（如重试/返回），已按 return 角色处理`);
  }

  // Two nodes sharing a (lane, col) cell collide in the workflow layout, so
  // assign columns greedily per lane in level order, bumping conflicts to the
  // next free column. Overflow past col 5 stacks in-cell with yOffset.
  const laneUsedCols = new Map();
  const laneStackAt = new Map();
  const col = new Map();
  const yOffset = new Map();
  let clamped = 0;
  let stacked = 0;
  for (const id of [...nodeIds].sort((a, b) => level.get(a) - level.get(b))) {
    const lane = parsed.nodes.get(id).lane;
    const used = laneUsedCols.get(lane) ?? new Set();
    let value = Math.min(5, level.get(id));
    if (level.get(id) > 5) clamped += 1;
    while (value < 5 && used.has(value)) value += 1;
    if (used.has(value)) {
      const stackIndex = laneStackAt.get(cellKey(lane, value)) ?? 0;
      laneStackAt.set(cellKey(lane, value), stackIndex + 1);
      if (stackIndex > 0) {
        yOffset.set(id, stackIndex * 64);
        stacked += 1;
      }
    }
    used.add(value);
    laneUsedCols.set(lane, used);
    col.set(id, value);
  }
  if (clamped) warnings.push(`${clamped} 个节点的层数超过 6 列上限，已压缩到第 5 列（可拆分流程后重新导入）`);
  if (stacked) warnings.push(`${stacked} 个节点在第 5 列溢出堆叠（yOffset），建议拆分流程`);

  const chain = longestForwardChain(nodeIds, parsed.edges, level);
  const mainPath = chain.length >= 2 ? chain : nodeIds.slice(0, 2);
  const onMain = new Set(mainPath);

  const hasCjk = [...parsed.nodes.values()].some((node) => /[\u4e00-\u9fff]/.test(node.label))
    || parsed.lanes.some((lane) => /[\u4e00-\u9fff]/.test(lane.label));

  const workflow = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: title || 'Mermaid 导入工作流',
      locale: hasCjk ? 'zh-CN' : 'en',
      quality_profile: 'standard',
    },
    lanes: parsed.lanes.filter((lane) => nodeIds.some((id) => parsed.nodes.get(id).lane === lane.id)),
    mainPath,
    nodes: nodeIds.map((id) => {
      const node = parsed.nodes.get(id);
      return {
        id,
        lane: node.lane,
        col: col.get(id),
        type: TYPE_BY_SHAPE[node.shape] || 'backend',
        label: node.label,
        ...(yOffset.has(id) ? { yOffset: yOffset.get(id) } : {}),
      };
    }),
    edges: parsed.edges.map((edge, index) => {
      const forward = col.get(edge.to) > col.get(edge.from);
      const role = !forward ? 'return' : onMain.has(edge.from) && onMain.has(edge.to)
        && mainPath.indexOf(edge.to) === mainPath.indexOf(edge.from) + 1 ? undefined : 'branch';
      return {
        id: `e${index + 1}`,
        from: edge.from,
        to: edge.to,
        ...(edge.label ? { label: edge.label } : {}),
        variant: edge.variant,
        ...(role ? { role } : {}),
      };
    }),
  };
  return { ok: true, spec: workflow, warnings };
}
