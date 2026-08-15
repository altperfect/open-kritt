import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';

import { RESERVED_POST_SCRIPT_KEYS, isExtraRef, parseRefs } from '../src/lib/constants.js';
import { serializePostScript } from '../src/lib/serialize.js';
import { validatePostScript } from '../src/lib/validation.js';

const originalSeedSql = fs.readFileSync(
  new URL('../../database/init/009_seed_post_scripts.sql', import.meta.url),
  'utf8'
);
const securitySeedSql = fs.readFileSync(
  new URL('../../database/init/024_seed_security_post_scripts.sql', import.meta.url),
  'utf8'
);
const reportCreatorRefreshSql = fs.readFileSync(
  new URL('../../database/init/027_describe_report_creator_inputs.sql', import.meta.url),
  'utf8'
);
const pocCreatorRefreshPath = new URL('../../database/init/029_refresh_poc_creator_output.sql', import.meta.url);
const pocCreatorRefreshSql = fs.existsSync(pocCreatorRefreshPath) ? fs.readFileSync(pocCreatorRefreshPath, 'utf8') : '';
const seedSql = `${originalSeedSql}\n${securitySeedSql}`;

function parseSeedScripts(sql) {
  return [
    ...sql.matchAll(
      /SELECT\s*\n\s*'([^']+)',\s*\n\s*'([^']+)',\s*\n\s*\$script\$\n([\s\S]*?)\n\$script\$,\s*\n\s*'([^']+)'/g
    ),
  ].map(([, name, description, content, outputFormat]) => ({
    name,
    description,
    content,
    outputFormat: JSON.parse(outputFormat),
  }));
}

const bundledScripts = parseSeedScripts(seedSql);
const securityScripts = parseSeedScripts(securitySeedSql);

test('bundled post-scripts reference only supported scan and finding inputs', () => {
  const allowed = new Set(RESERVED_POST_SCRIPT_KEYS);

  assert.equal(bundledScripts.length, 6);
  for (const script of bundledScripts) {
    const { content } = script;
    const unsupported = [...new Set(parseRefs(content))].filter((key) => !allowed.has(key) && !isExtraRef(key));
    assert.deepEqual(unsupported, []);
  }
});

test('security artifact post-scripts use the reserved renderer outputs', () => {
  assert.equal(securityScripts.length, 3);
  for (const script of securityScripts) assert.doesNotThrow(() => validatePostScript(script));

  const scriptsByName = new Map(securityScripts.map((script) => [script.name, script]));

  assert.deepEqual(scriptsByName.get('PoC Creator')?.outputFormat, { _reserved_poc: 'string' });
  assert.deepEqual(scriptsByName.get('Report Creator')?.outputFormat, { _reserved_report: 'string' });
  assert.deepEqual(scriptsByName.get('Is Malicious Actor in scope')?.outputFormat, {
    _chip_is_in_scope: 'boolean',
    is_valid: 'boolean',
  });
});

test('PoC Creator returns a reviewer-ready Markdown PoC instead of raw Git output', () => {
  const description = pocCreatorRefreshSql.match(/description = '([^']+)'/)?.[1];
  const content = pocCreatorRefreshSql.match(/content = \$script\$\n([\s\S]*?)\n\$script\$/)?.[1];

  assert.match(description || '', /reviewer-ready Markdown PoC/);
  assert.match(content || '', /## Reproduction steps/);
  assert.match(content || '', /## Validation evidence/);
  assert.match(content || '', /complete contents of every PoC file/);
  assert.doesNotMatch(content || '', /Deliver ONLY the PoC diff/);
  assert.doesNotMatch(content || '', /Generate actual diff by using `git diff`/);
});

test('PoC Creator refresh upgrades only the untouched bundled prompt', () => {
  const legacyPocCreator = securityScripts.find((script) => script.name === 'PoC Creator');

  assert.ok(legacyPocCreator);
  const persistedLegacyContent = `\n${legacyPocCreator.content}\n`;
  assert.equal(createHash('md5').update(persistedLegacyContent).digest('hex'), 'eb8192d8a3e42826f3cf75866fe3b9bb');
  assert.match(pocCreatorRefreshSql, /UPDATE public\.post_scripts/);
  assert.match(pocCreatorRefreshSql, /name = 'PoC Creator'/);
  assert.match(pocCreatorRefreshSql, /md5\(content\) = 'eb8192d8a3e42826f3cf75866fe3b9bb'/);
  assert.match(pocCreatorRefreshSql, /stores its Git diff in the PoC tab/);
  assert.match(pocCreatorRefreshSql, /reviewer-ready Markdown PoC/);
  assert.match(pocCreatorRefreshSql, /Do not return a raw `git diff`/);
});

test('Report Creator refresh labels every expanded finding and context input', () => {
  const content = reportCreatorRefreshSql.match(/content = \$script\$\n([\s\S]*?)\n\$script\$/)?.[1];

  assert.ok(content);
  for (const labeledInput of [
    'Repository full name: {{repo_full}}',
    'Repository scope scanned: {{repo_scope}}',
    'Commit SHA scanned: {{commit_sha}}',
    'Checked-out workspace root: {{workspace_root}}',
    'Workspace layout (available directories and files):\n{{workspace_layout}}',
    'Workspace manifest JSON (repository metadata):\n```json\n{{workspace_manifest_json}}',
    'Runtime configuration:\n```json\n{{configuration}}',
    'Dependencies (packages and versions):\n{{dependencies}}',
    'Summary: {{summary}}',
    'Vulnerability type: {{vulnerability_type}}',
    'Vulnerable file path: {{file_path}}',
    'Vulnerable line number: {{line}}',
    'Technical explanation: {{explanation}}',
    'Trigger flow (ordered path from attacker input to the vulnerable operation): {{trigger_flow}}',
    'Confirmed exploitable: {{exploitable}}',
    'Malicious actor (the attacker role): {{malicious_actor}}',
    'Malicious input example (payload or sequence): {{malicious_input_example}}',
  ]) {
    assert.match(content, new RegExp(labeledInput.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('every bundled post-script insert is guarded by name', () => {
  const names = bundledScripts.map((script) => script.name);
  const guards = [
    ...seedSql.matchAll(/WHERE NOT EXISTS \(SELECT 1 FROM public\.post_scripts WHERE name = '([^']+)'\);/g),
  ].map((match) => match[1]);

  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(guards, names);
});

test('post-script serialization exposes creation timestamps for frontend ordering', () => {
  const insertedAt = new Date('2026-07-20T10:00:00Z');
  const updatedAt = new Date('2026-07-20T11:00:00Z');

  assert.deepEqual(
    serializePostScript({
      id: 7n,
      name: 'Triage',
      description: '',
      content: 'Review {{summary}}.',
      outputFormat: '{}',
      insertedAt,
      updatedAt,
    }),
    {
      id: '7',
      name: 'Triage',
      description: '',
      content: 'Review {{summary}}.',
      outputFormat: {},
      keys: [],
      insertedAt,
      updatedAt,
    }
  );
});
