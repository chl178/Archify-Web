// Nested-component (container) coverage for the architecture renderer:
// schema acceptance, auto-size, containment, overlap exemptions for
// ancestor/descendant pairs, connection rules across container borders,
// and the breadcrumb tooltip scope chain.
//
//   node --test test/nested-components.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-nested-'));
const renderer = path.join(skillRoot, 'renderers/architecture/render-architecture.mjs');

let seq = 0;
function render(doc, extraArgs = []) {
  seq += 1;
  const input = path.join(tmp, `nested-${seq}.json`);
  const outPath = path.join(tmp, `nested-${seq}.html`);
  fs.writeFileSync(input, JSON.stringify(doc));
  try {
    const stdout = execFileSync('node', [renderer, input, outPath, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return {
      code: 0,
      stderr: '',
      stdout,
      html: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '',
    };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stderr: String(err.stderr || ''),
      stdout: String(err.stdout || ''),
      html: fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '',
    };
  }
}

function baseDoc() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Nested fixture' },
    components: [
      { id: 'client', type: 'frontend', label: 'Client', pos: [40, 200], size: [120, 60] },
      {
        id: 'box',
        type: 'backend',
        label: 'Box',
        pos: [300, 100],
        children: [
          { id: 'a', type: 'security', label: 'A', pos: [20, 10], size: [140, 50] },
          { id: 'b', type: 'database', label: 'B', pos: [20, 90], size: [140, 50] },
        ],
      },
      { id: 'store', type: 'database', label: 'Store', pos: [640, 140], size: [120, 60] },
    ],
    connections: [
      { id: 'e1', from: 'client', to: 'a' },
      { id: 'e2', from: 'b', to: 'store' },
    ],
  };
}

test('nested components render with container frames and reachable children', () => {
  const { code, stderr, html } = render(baseDoc());
  assert.equal(code, 0, stderr);
  assert.match(html, /data-composition-frame-kind="container" data-composition-frame-id="box"/);
  assert.match(html, /data-node-label=""[^>]*>A</);
  assert.match(html, /data-node-label=""[^>]*>B</);
  // Connections reach children across the container border.
  assert.match(html, /data-composition-points="[^"]+"/);
});

test('container auto-sizes from the children bounding box', () => {
  const { code, stdout, stderr } = render(baseDoc(), ['--layout-json']);
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  const box = report.components.find((c) => c.id === 'box');
  const a = report.components.find((c) => c.id === 'a');
  const b = report.components.find((c) => c.id === 'b');
  // 30px side pad / 30px header / 50px bottom (boundary 30/50 rule).
  assert.equal(box.width, 220);
  assert.equal(box.height, 220);
  assert.deepEqual([a.x, a.y], [350, 140]);
  assert.deepEqual([b.x, b.y], [350, 220]);
  assert.equal(a.parent, 'box');
  assert.equal(b.parent, 'box');
  assert.equal(report.components.find((c) => c.id === 'client').parent, undefined);
});

test('three levels of nesting render and the tooltip breadcrumb spans them', () => {
  const doc = baseDoc();
  doc.components[1].children[0] = {
    id: 'a',
    type: 'security',
    label: 'A',
    pos: [20, 10],
    children: [
      { id: 'leaf', type: 'security', label: 'Leaf', pos: [16, 8], size: [110, 40] },
    ],
  };
  doc.connections[0] = { id: 'e1', from: 'client', to: 'leaf' };
  // a grew taller as a container; slide b below it.
  doc.components[1].children[1].pos = [20, 160];
  const { code, stderr, html } = render(doc);
  assert.equal(code, 0, stderr);
  assert.match(html, /data-composition-frame-kind="container" data-composition-frame-id="a"/);
  // Outermost ancestor first in the focus scope chain.
  assert.match(html, /aria-label="Focus Leaf, Box › A"[^>]*data-node-context="Box › A"/);
});

test('a child that escapes an explicit container size fails closed', () => {
  const doc = baseDoc();
  doc.components[1].size = [220, 120]; // b sits at rel y 90..140 — outside.
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /Component "b" is not fully inside its parent container "box"/);
});

test('siblings inside a container keep the 8px separation contract', () => {
  const doc = baseDoc();
  doc.components[1].children[1].pos = [20, 40]; // overlaps a (rel y 10..60).
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /Components "a" and "b" are less than 8px apart/);
});

test('an unrelated component placed inside a container is an overlap, not nesting', () => {
  const doc = baseDoc();
  doc.components[2].pos = [340, 130]; // store lands inside box.
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /less than 8px apart/);
});

test('connecting a container to its own child is rejected', () => {
  const doc = baseDoc();
  doc.connections.push({ id: 'e3', from: 'box', to: 'a' });
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /links a container to its own child/);
});

test('a route running along the container border is a border-run violation', () => {
  const doc = baseDoc();
  doc.meta.quality_profile = 'standard'; // border-run gate is profile-gated.
  // Middle via segment is collinear with box's left border (x=300): a run,
  // not a perpendicular crossing. The route still honors both endpoint sides.
  doc.connections.push({
    id: 'e3',
    from: 'client',
    to: 'b',
    fromSide: 'right',
    toSide: 'left',
    via: [[300, 230], [300, 245], [350, 245]],
  });
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /container-border-run/);
  assert.match(stderr, /container "Box" left border for 15px/);
});

test('schema rejects a child without pos and a child using grid placement', () => {
  const noPos = baseDoc();
  delete noPos.components[1].children[0].pos;
  const { code: code1, stderr: stderr1 } = render(noPos);
  assert.notEqual(code1, 0);
  assert.match(stderr1, /pos/);

  const gridChild = baseDoc();
  gridChild.components[1].children[0].row = 2;
  const { code: code2, stderr: stderr2 } = render(gridChild);
  assert.notEqual(code2, 0);
  assert.match(stderr2, /additionalProperty|row/);
});

test('duplicate ids across the nesting tree are rejected', () => {
  const doc = baseDoc();
  doc.components[1].children[0].id = 'client';
  const { code, stderr } = render(doc);
  assert.notEqual(code, 0);
  assert.match(stderr, /unique across the whole nesting tree/);
});
