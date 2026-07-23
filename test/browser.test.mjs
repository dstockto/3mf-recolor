// End-to-end test: drives the real page in a real browser, from file://,
// with a real multi-plate .3mf. Verifies the plan and the downloaded bytes.
//
//   node test/browser.test.mjs <sample.3mf>
//
// Without a sample path it runs the logic-only tests and skips the file tests.
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(here, '..', 'index.html')).href;
const sample = process.argv[2];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
await page.goto(PAGE);
await page.waitForFunction(() => !!window.__core);

console.log('\nCore logic (in-browser)');

// -- lookup ------------------------------------------------------------------
const lookup = await page.evaluate(() => {
  const { lookupColor } = window.__core;
  const m = { 'Cotton White': '#e6dddb', 'Ash Gray': '#485155', 'Ash Grey': '#485155' };
  return {
    exact:      lookupColor(m, 'cotton white')?.hex,
    greyVariant:lookupColor(m, 'Ash Grey')?.hex,
    empty:      lookupColor(m, ''),
    unknown:    lookupColor(m, 'Rocket Red'),
    ambiguous:  lookupColor({ 'Deep Blue': '#001', 'Deep Blue Metallic': '#002' }, 'Deep Blue')?.hex,
  };
});
ok('exact match is case-insensitive', lookup.exact === '#e6dddb');
ok('gray/grey both resolve', lookup.greyVariant === '#485155');
ok('empty plate name never matches', lookup.empty === null);
ok('unknown name does not match', lookup.unknown === null);
ok('exact wins over ambiguous substring', lookup.ambiguous === '#001');

// -- planning guards ---------------------------------------------------------
const plan = await page.evaluate(() => {
  const { planRecolor } = window.__core;
  const plates = [
    { id: 1, name: 'Cotton White', slots: [2] },
    { id: 2, name: 'Two Tone',     slots: [1, 3] },  // multi-color -> refuse
    { id: 3, name: '',             slots: [1] },      // unnamed -> skip
    { id: 4, name: 'Nothing',      slots: [] },       // no slot -> skip
  ];
  const m = { 'Cotton White': '#e6dddb', 'Two Tone': '#ff0000' };
  const { rows, edits } = planRecolor(plates, ['#000', '#111', '#222'], m);
  return { edits: [...edits.entries()], notes: rows.map(r => r.note) };
});
ok('only the single-slot named plate is edited',
   plan.edits.length === 1 && plan.edits[0][0] === 2 && plan.edits[0][1] === '#e6dddb',
   JSON.stringify(plan.edits));
ok('multi-color plate is refused', /not flattened/.test(plan.notes[1]), plan.notes[1]);
ok('unnamed plate is skipped', !!plan.notes[2], plan.notes[2]);
ok('plate with no slot is skipped', !!plan.notes[3], plan.notes[3]);

// -- plates sharing a filament slot move together -----------------------------
const shared = await page.evaluate(() => {
  const { autoMatch, resolveSelection } = window.__core;
  // Three structural plates, all on slot 1, none matching a color name.
  const plates = [
    { id: 1, name: 'Frame', slots: [1] },
    { id: 2, name: 'Base',  slots: [1] },
    { id: 3, name: 'Pins',  slots: [1] },
  ];
  const m = { 'Army Red': '#bf312e' };
  const sel = autoMatch(plates, m);
  const before = resolveSelection(plates, ['#888888'], m, sel);
  sel.set(1, 'Army Red');                    // pick once, on the slot
  const after = resolveSelection(plates, ['#888888'], m, sel);
  return {
    beforeHexes: before.rows.map(r => r.newHex),
    beforeOld:   before.rows.map(r => r.oldHex),
    beforeNotes: before.rows.map(r => r.note),
    afterHexes:  after.rows.map(r => r.newHex),
    editCount:   after.edits.size,
    sharedWith:  after.rows[0].shared,
  };
});
ok('unmatched plates carry their current color',
   shared.beforeOld.every(h => h === '#888888') && shared.beforeHexes.every(h => h === ''),
   JSON.stringify(shared.beforeOld));
ok('unmatched plate has no scolding note', shared.beforeNotes.every(n => n === ''),
   JSON.stringify(shared.beforeNotes));
ok('picking once updates every plate on that slot',
   shared.afterHexes.every(h => h === '#bf312e'), JSON.stringify(shared.afterHexes));
ok('one slot means one edit, not three', shared.editCount === 1, String(shared.editCount));
ok('shared plates are listed on the row',
   JSON.stringify(shared.sharedWith) === '[2,3]', JSON.stringify(shared.sharedWith));

// A slot whose plates disagree keeps the first match and flags the mismatch.
const disagree = await page.evaluate(() => {
  const { planRecolor } = window.__core;
  const plates = [{ id: 1, name: 'Red', slots: [1] }, { id: 2, name: 'Green', slots: [1] }];
  const { rows, edits } = planRecolor(plates, ['#000000'], { Red: '#ff0000', Green: '#00ff00' });
  return { n: edits.size, hexes: rows.map(r => r.newHex), hint: rows[1].hint };
});
ok('a shared slot resolves to one color', disagree.n === 1 &&
   disagree.hexes.every(h => h === '#ff0000'), JSON.stringify(disagree.hexes));
ok('the losing plate says what its name suggested',
   /name suggests Green/.test(disagree.hint), disagree.hint);

// -- surgical edit -----------------------------------------------------------
const edit = await page.evaluate(() => {
  const { setFilamentColours } = window.__core;
  const ps = `{\n  "filament_colour": [\n    "#111111",\n    "#222222",\n    "#333333"\n  ],\n  "filament_type": ["PLA"]\n}`;
  const out = setFilamentColours(ps, new Map([[1, '#aaaaaa'], [3, '#cccccc']]));
  let ranged = null;
  try { setFilamentColours(ps, new Map([[9, '#fff']])); } catch (e) { ranged = e.message; }
  return { out, ranged };
});
ok('edits only the targeted slots',
   edit.out.includes('"#aaaaaa"') && edit.out.includes('"#cccccc"') && edit.out.includes('"#222222"'));
ok('preserves the rest of the file', edit.out.includes('"filament_type"'));
ok('rejects an out-of-range slot', /out of range/.test(edit.ranged || ''), edit.ranged);

// -- built-in mapping --------------------------------------------------------
const builtin = await page.evaluate(() => {
  const c = window.__core.BUILTIN_COLORS;
  return { n: Object.keys(c).length, cotton: c['Cotton White'],
           gray: c['Ash Gray'], grey: c['Ash Grey'],
           malformed: Object.keys(c).filter(k => !/^[A-Za-z0-9]/.test(k)), all: c };
});
const builtinAll = builtin.all;
ok('built-in mapping is embedded', builtin.n > 50, `${builtin.n} colors`);
ok('built-in has gray and grey variants',
   builtin.gray === builtin.grey && !!builtin.gray);
ok('no malformed keys', builtin.malformed.length === 0, builtin.malformed.join(','));

// -- mapping export round-trips ---------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), '3mf-map-'));
  const out = join(dir, 'colors.json');
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#saveMap'),
  ]);
  await dl.saveAs(out);
  ok('exported file is named colors.json', dl.suggestedFilename() === 'colors.json',
     dl.suggestedFilename());

  const exported = JSON.parse(readFileSync(out, 'utf8'));
  ok('export matches the built-in mapping',
     JSON.stringify(exported) === JSON.stringify(builtinAll),
     `${Object.keys(exported).length} vs ${Object.keys(builtinAll).length}`);

  // Edit it, load it back, and confirm the app picked it up.
  const edited = join(dir, 'edited.json');
  writeFileSync(edited, JSON.stringify({ 'Cotton White': '#123456' }, null, 2));
  await page.setInputFiles('#mapFile', edited);
  await page.waitForFunction(() => /edited\.json/.test(document.getElementById('mapSrc').textContent));
  const active = await page.evaluate(() => document.getElementById('mapSrc').textContent);
  ok('edited mapping loads back in', /edited\.json/.test(active) && /1 names/.test(active), active);

  await page.click('#resetMap');
  await page.waitForFunction(() => /built-in/.test(document.getElementById('mapSrc').textContent));
  ok('built-in mapping can be restored',
     /built-in/.test(await page.evaluate(() => document.getElementById('mapSrc').textContent)));
}

// -- hand-picking a color ----------------------------------------------------
const picked = await page.evaluate(() => {
  const { autoMatch, resolveSelection } = window.__core;
  const plates = [
    { id: 1, name: 'Cotton White', slots: [2] },
    { id: 2, name: 'Nonsense Name', slots: [3] },  // no auto-match
    { id: 3, name: 'Two Tone', slots: [1, 4] },    // multi-color
  ];
  const m = { 'Cotton White': '#e6dddb', 'Army Red': '#bf312e' };
  const sel = autoMatch(plates, m);
  const before = resolveSelection(plates, ['#000000', '#111111', '#222222', '#333333'], m, sel);
  // Selection is keyed by SLOT: plate 2 sits on slot 3, plate 1 on slot 2.
  sel.set(3, 'Army Red');   // assign a color to the plate that didn't match
  sel.set(2, 'Army Red');   // override the one that did
  const after = resolveSelection(plates, ['#000000', '#111111', '#222222', '#333333'], m, sel);
  return {
    unmatchedSelectable: before.rows[1].selectable,
    multiSelectable: before.rows[2].selectable,
    beforeEdits: [...before.edits.entries()],
    afterEdits: [...after.edits.entries()],
    overrideHex: after.rows[0].newHex,
  };
});
ok('unmatched plate still gets a picker', picked.unmatchedSelectable === true);
ok('multi-color plate gets no picker', picked.multiSelectable === false);
ok('picking a color for an unmatched plate adds an edit',
   picked.beforeEdits.length === 1 && picked.afterEdits.length === 2,
   JSON.stringify(picked.afterEdits));
ok('picking overrides an auto-match', picked.overrideHex === '#bf312e', picked.overrideHex);

// picking "leave unchanged" removes the edit and reveals the current color
const cleared = await page.evaluate(() => {
  const { autoMatch, resolveSelection } = window.__core;
  const plates = [{ id: 1, name: 'Cotton White', slots: [2] }];
  const m = { 'Cotton White': '#e6dddb' };
  const sel = autoMatch(plates, m);
  sel.set(2, '');                       // slot 2, not plate 1
  const r = resolveSelection(plates, ['#000000', '#E4E6E2'], m, sel);
  return { n: r.edits.size, newHex: r.rows[0].newHex, oldHex: r.rows[0].oldHex };
});
ok('choosing "leave unchanged" drops the edit',
   cleared.n === 0 && cleared.newHex === '', JSON.stringify(cleared));
ok('the plate still shows its current color',
   cleared.oldHex === '#E4E6E2', cleared.oldHex);

// -- custom mapping is remembered across a reload ----------------------------
{
  const dir = mkdtempSync(join(tmpdir(), '3mf-ls-'));
  const custom = join(dir, 'my-colors.json');
  writeFileSync(custom, JSON.stringify({ 'Cotton White': '#abcdef', 'Army Red': '#123456' }));
  await page.setInputFiles('#mapFile', custom);
  await page.waitForFunction(() => /my-colors\.json/.test(document.getElementById('mapSrc').textContent));

  const saved = await page.evaluate(() => document.getElementById('mapSrc').textContent);
  ok('custom mapping reports it is saved', /saved on this device/.test(saved), saved);

  await page.reload();
  await page.waitForFunction(() => !!window.__core);
  const afterReload = await page.evaluate(() => ({
    label: document.getElementById('mapSrc').textContent,
    colors: window.__core ? null : null,
    active: document.getElementById('resetMap').classList.contains('hidden'),
  }));
  ok('custom mapping survives a reload', /my-colors\.json/.test(afterReload.label), afterReload.label);
  ok('"Use built-in" is offered after restore', afterReload.active === false);

  // clearing it sticks too
  await page.click('#resetMap');
  await page.waitForFunction(() => /built-in/.test(document.getElementById('mapSrc').textContent));
  await page.reload();
  await page.waitForFunction(() => !!window.__core);
  ok('"Use built-in" is remembered too',
     /built-in/.test(await page.evaluate(() => document.getElementById('mapSrc').textContent)));

  // a corrupt stored value must not wedge the page
  await page.evaluate(() => localStorage.setItem('3mf-recolor.mapping', '{not json'));
  await page.reload();
  await page.waitForFunction(() => !!window.__core);
  ok('corrupt saved mapping falls back to built-in',
     /built-in/.test(await page.evaluate(() => document.getElementById('mapSrc').textContent)));
  ok('corrupt saved mapping is discarded',
     await page.evaluate(() => localStorage.getItem('3mf-recolor.mapping')) === null);
}

// -- full round trip on a real file -----------------------------------------
if (sample && existsSync(sample)) {
  console.log(`\nEnd-to-end (${sample.split('/').pop()})`);
  await page.setInputFiles('#file', sample);
  await page.waitForSelector('#result:not(.hidden)', { timeout: 60000 });

  const rows = await page.$$eval('#rows tr', (trs) => trs.map((tr) => ({
    plate: tr.children[0].textContent.trim(),
    name: tr.children[1].textContent.trim(),
    slot: tr.children[3 - 1].textContent.trim(),
    change: tr.children[3].textContent.trim(),
    skipped: tr.classList.contains('skip'),
  })));
  ok('a plan row per plate', rows.length > 0, `${rows.length} rows`);
  ok('no row was skipped', rows.every(r => !r.skipped),
     rows.filter(r => r.skipped).map(r => r.name).join(', '));

  const summary = await page.textContent('#summary');
  ok('summary reports the recolor count', /to recolor/.test(summary), summary);
  ok('download button enabled', !(await page.isDisabled('#save')));

  const dir = mkdtempSync(join(tmpdir(), '3mf-'));
  const out = join(dir, 'out.3mf');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#save'),
  ]);
  await download.saveAs(out);

  // Verify the produced archive against the input.
  const before = readZip(readFileSync(sample));
  const after = readZip(readFileSync(out));
  const names = [...before.keys()];
  ok('entry set is identical',
     names.length === after.size && names.every(n => after.has(n)));
  const changed = names.filter(n => !Buffer.from(before.get(n)).equals(Buffer.from(after.get(n) ?? [])));
  ok('only project_settings.config changed',
     changed.length === 1 && changed[0].endsWith('project_settings.config'),
     changed.join(', '));

  const psName = changed[0];
  const b4 = JSON.parse(Buffer.from(before.get(psName)).toString('utf8'));
  const af = JSON.parse(Buffer.from(after.get(psName)).toString('utf8'));
  const otherKeys = Object.keys(b4).filter(k => JSON.stringify(b4[k]) !== JSON.stringify(af[k]));
  ok('only filament_colour differs',
     otherKeys.length === 1 && otherKeys[0] === 'filament_colour', otherKeys.join(', '));
  ok('new colors came from the mapping', af.filament_colour.some((c, i) => c !== b4.filament_colour[i]));
  console.log(`     before: ${JSON.stringify(b4.filament_colour)}`);
  console.log(`     after:  ${JSON.stringify(af.filament_colour)}`);
} else {
  console.log('\nEnd-to-end: skipped (pass a .3mf path to run it)');
}

ok('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

// Minimal zip reader for verification (independent of the page's own code).
function readZip(buf) {
  const map = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    map.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return map;
}
