import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CODEQL_V3, codeqlFindings, isCodeqlV3, monthPhase } from '../src/deadlines.js';
import { parseFile } from '../src/workflow.js';

const SHA = 'a'.repeat(40);
const wf = (...uses: string[]) =>
  'on: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n' + uses.map((u) => `      - uses: ${u}\n`).join('');
const sites = (...uses: string[]) => parseFile('.github/workflows/codeql.yml', wf(...uses)).uses;
const find = (today: string, ...uses: string[]) => codeqlFindings(sites(...uses), { today });

describe('month-precision deadlines', () => {
  it('counts whole days to the first of the month, then "during", then "after"', () => {
    assert.deepEqual(monthPhase('2026-10-03', '2026-12'), { phase: 'before', daysToStart: 59, daysToEnd: 89 });
    assert.deepEqual(monthPhase('2026-11-30', '2026-12'), { phase: 'before', daysToStart: 1, daysToEnd: 31 });
    assert.deepEqual(monthPhase('2026-12-01', '2026-12'), { phase: 'during', daysToStart: 0, daysToEnd: 30 });
    assert.equal(monthPhase('2026-12-31', '2026-12').phase, 'during');
    assert.equal(monthPhase('2027-01-01', '2026-12').phase, 'after');
    assert.equal(monthPhase('2026-02-27', '2026-02').daysToEnd, 1); // February has 28 days in 2026
  });

  it('CodeQL v3 is recorded with the month only, cites its sources and says what the day hint is', () => {
    assert.equal(CODEQL_V3.month, '2026-12');
    assert.ok(CODEQL_V3.sources.some((s) => s.includes('2025-10-28-upcoming-deprecation-of-codeql-action-v3')));
    assert.match(CODEQL_V3.dayHint ?? '', /2026-12-09/);
  });
});

describe('codeql-action-v3', () => {
  it('finds v3, v3.x and v3.x.y on every sub-action, but not v4, other actions or branches', () => {
    const f = find('2026-10-03', 'github/codeql-action/init@v3', 'github/codeql-action/analyze@v3.28.0', 'github/codeql-action/upload-sarif@v3.1', 'github/codeql-action@v3');
    assert.equal(f.length, 4);
    assert.equal(find('2026-10-03', 'github/codeql-action/init@v4', 'github/codeql-action/init@main', 'actions/checkout@v3', 'github/codeql-action/init@v30', 'github/codeql-action/init@v3-beta').length, 0);
  });

  it('a commit SHA counts only when its comment names a v3 tag', () => {
    const s = parseFile('w.yml', wf(`github/codeql-action/init@${SHA} # v3.28.1`, `github/codeql-action/init@${SHA} # v4.31.0`, `github/codeql-action/init@${SHA}`)).uses;
    assert.deepEqual(s.map(isCodeqlV3), [true, false, false]);
  });

  it('is information more than a month ahead, a warning from 31 days before, in and after December, and never an error', () => {
    const sev = (d: string) => find(d, 'github/codeql-action/init@v3')[0]?.severity;
    assert.equal(sev('2026-10-03'), 'info');
    assert.equal(sev('2026-10-30'), 'info'); // 32 days to 2026-12-01
    assert.equal(sev('2026-10-31'), 'warning'); // 31 days
    assert.equal(sev('2026-12-15'), 'warning');
    assert.equal(sev('2027-03-01'), 'warning');
  });

  it('the message says the day is unknown and gives the whole-day range, not a made-up date', () => {
    const m = find('2026-10-03', 'github/codeql-action/analyze@v3')[0]?.message ?? '';
    assert.match(m, /December 2026 \(GitHub gave the month, not the day\)/);
    assert.match(m, /59 to 89 days from now/);
    assert.match(m, /no new updates/);
    assert.match(m, /github\/codeql-action\/analyze@v4/);
    const sha = codeqlFindings(parseFile('w.yml', wf(`github/codeql-action/init@${SHA} # v3.28.1`)).uses, { today: '2026-10-03' })[0]?.message ?? '';
    assert.match(sha, /^github\/codeql-action\/init@aaaaaaa \(v3\.28\.1\): /);
    assert.doesNotMatch(m, /2026-12-\d\d/);
    assert.match(find('2026-12-10', 'github/codeql-action/init@v3')[0]?.message ?? '', /any of the next 22 days of the month/);
    assert.match(find('2027-02-01', 'github/codeql-action/init@v3')[0]?.message ?? '', /already past/);
  });

  it('carries file and line of the uses: line', () => {
    const f = find('2026-10-03', 'actions/checkout@v7', 'github/codeql-action/init@v3')[0];
    assert.equal(f?.file, '.github/workflows/codeql.yml');
    assert.equal(f?.line, 7);
    assert.equal(f?.rule, 'codeql-action-v3');
  });
});
