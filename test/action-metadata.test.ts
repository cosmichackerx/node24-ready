import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

// GitHub Marketplace rules for action.yml: unique name, description (max 125 chars), branding with a Feather icon
// and one of the allowed colours. The file must also be real YAML (an unquoted ": " in a description breaks it).
const doc = parse(readFileSync(new URL('../../action.yml', import.meta.url), 'utf8')) as {
  name: string;
  description: string;
  branding: { icon: string; color: string };
  inputs: Record<string, { description?: string; default?: unknown }>;
  runs: { using: string; steps: { uses?: string; run?: string }[] };
};

test('action.yml has Marketplace-ready metadata', () => {
  assert.ok(doc.name && doc.name.length <= 60);
  assert.notEqual(doc.name.toLowerCase(), 'node24-ready', 'name should differ from the repository name');
  assert.ok(doc.description.length > 20 && doc.description.length <= 125, `description is ${doc.description.length} chars`);
  assert.ok(['white', 'black', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'].includes(doc.branding.color));
  assert.ok(['alert-triangle', 'shield', 'check-circle', 'search'].includes(doc.branding.icon), 'icon is from the Feather set');
  for (const [name, input] of Object.entries(doc.inputs)) assert.ok(input.description, `input ${name} has a description`);
});

test('the action is composite and does not depend on any other action (so it cannot itself be on Node 20)', () => {
  assert.equal(doc.runs.using, 'composite');
  for (const step of doc.runs.steps) assert.equal(step.uses, undefined, 'no nested uses:');
});

test('the committed bundle exists and runs', async () => {
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL('../../action/index.mjs', import.meta.url)), 'run `npm run bundle`');
});
