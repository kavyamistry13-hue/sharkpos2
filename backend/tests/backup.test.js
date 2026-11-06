const test = require('node:test');
const assert = require('node:assert/strict');
const { toDelete } = require('../../scripts/backup-prune');

const name = (d, t = '020000') => `sharkpos2-${d}T${t}Z.dump.enc`;
const days = (n, from = new Date('2026-10-01T00:00:00Z')) => Array.from({ length: n }, (_, i) => { const d = new Date(from.getTime() - i * 86400000); return name(d.toISOString().slice(0, 10).replace(/-/g, '')); });

test('retention: keeps 14 dailies + weeklies + monthlies, deletes the rest, never the newest, ignores foreign files', () => {
  const names = days(400);
  const del = toDelete([...names, 'notes.txt', 'sharkpos-old.dump']);
  const kept = names.filter((n) => !del.includes(n));
  assert.ok(kept.includes(names[0]) && kept.includes(names[13]), 'last 14 days kept');
  assert.ok(!del.includes('notes.txt') && !del.includes('sharkpos-old.dump'), 'unknown files are never touched');
  assert.ok(kept.length >= 14 && kept.length <= 14 + 8 + 12, `kept ${kept.length}`);
  assert.ok(del.includes(names[399]), 'a year-old daily is pruned');
  assert.ok(kept.includes(name('20260630')), 'the last backup of an older month survives as its monthly');
  assert.ok(del.includes(name('20260615')), 'other backups from that month are pruned');
});

test('retention: several backups on one day keep only the newest; few backups are all kept', () => {
  assert.deepEqual(toDelete([name('20261001', '010000'), name('20261001', '030000')]), [name('20261001', '010000')]);
  assert.deepEqual(toDelete([name('20261001')]), []);
  assert.deepEqual(toDelete([]), []);
});
