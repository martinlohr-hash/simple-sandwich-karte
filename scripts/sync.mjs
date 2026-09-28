// Täglicher Abgleich der Sandwich-Karte: Lightspeed-Bestellseite → data/sandwiches.json
//
// Regeln:
// - Neue Artikel und Preisänderungen werden sofort übernommen.
// - Ein Artikel wird erst gestrichen, wenn er an zwei Tagen hintereinander fehlt
//   (schützt davor, dass ein um 12 Uhr ausverkauftes Sandwich einen Tag lang verschwindet).
// - Schlägt der Abruf fehl oder ist die Liste leer, bleibt die bisherige Karte unverändert.
//
// Aufruf: node scripts/sync.mjs [--force]   (--force ignoriert die 12-Uhr-Prüfung)

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const BASE = 'https://mylightspeed.app';
const MERCHANT = 'YXRMQJBM';
const LOCATION = 'C-ordering';
const CATEGORY = 'Sandwiches';
const OUT = new URL('../data/sandwiches.json', import.meta.url);
const LOG = new URL('../CHANGELOG.md', import.meta.url);

// Artikel, die nicht auf der Website erscheinen sollen (SKU aus Lightspeed).
const HIDDEN_SKUS = new Set(JSON.parse(
  await readFile(new URL('../hidden-skus.json', import.meta.url), 'utf8')
).map(String));

const ALLERGENS = {
  cereals: 'Gluten', wheat: 'Weizen', milk: 'Milch', eggs: 'Ei', soybeans: 'Soja',
  mustard: 'Senf', celery: 'Sellerie', sesame: 'Sesam', nuts: 'Schalenfrüchte',
  peanuts: 'Erdnüsse', fish: 'Fisch', crustaceans: 'Krebstiere', molluscs: 'Weichtiere',
  lupin: 'Lupine', sulphites: 'Sulfite',
};

const berlin = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

const stripHtml = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function fetchSandwiches() {
  let cookie = '';
  const get = async path => {
    const res = await fetch(BASE + path, { headers: { cookie, accept: 'application/json' } });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
  };

  await get(`/api/oa/initialize-session?merchantCode=${MERCHANT}&location=${LOCATION}`);
  const categories = await get('/api/oa/pos/v1/menu/categories');
  const cat = categories.find(c => c.name.trim().toLowerCase() === CATEGORY.toLowerCase());
  if (!cat) throw new Error(`Kategorie "${CATEGORY}" nicht gefunden`);

  const raw = [];
  for (let page = 0; page < 20; page++) {
    const res = await get(`/api/oa/pos/v1/menu/categories/${cat.id}/items?page=${page}`);
    raw.push(...res.data);
    if (!res.metadata?.next) break;
  }

  return raw
    .filter(i => i.type === 'menuItem' && !HIDDEN_SKUS.has(String(i.sku)))
    .map(i => {
      const t = i.texts?.find(x => x.locale === 'de') ?? i.texts?.[0] ?? {};
      const friendly = stripHtml(t.friendlyDisplayName);
      // Manche Artikel haben die Beschreibung im Anzeigenamen-Feld stehen (z. B. Big J Pastrami).
      const description = stripHtml(t.description) || (friendly && friendly !== i.name ? friendly : '');
      return {
        sku: String(i.sku),
        name: i.name.trim(),
        description,
        priceCents: i.unitPriceCents,
        allergens: (i.allergenCodes || []).map(a => ALLERGENS[a] ?? a),
      };
    });
}

const euro = c => (c / 100).toFixed(2).replace('.', ',') + ' €';

async function main() {
  const force = process.argv.includes('--force');
  const now = berlin();
  let prev = { items: [], missingSince: {} };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

  if (!force) {
    if (now.hour !== 12) return console.log(`Nicht 12 Uhr in Berlin (${now.hour} Uhr) – übersprungen.`);
    if (prev.checkedOn === now.date) return console.log('Heute schon abgeglichen – übersprungen.');
  }

  const fresh = await fetchSandwiches();
  if (!fresh.length) throw new Error('Lightspeed lieferte 0 Sandwiches – Karte bleibt unverändert.');

  const freshBySku = new Map(fresh.map(i => [i.sku, i]));
  const prevBySku = new Map(prev.items.map(i => [i.sku, i]));
  const missingSince = {};
  const changes = [];

  // Aktuelle Reihenfolge aus Lightspeed, dazu noch nicht gestrichene fehlende Artikel am Ende.
  const items = [...fresh];
  for (const old of prev.items) {
    if (freshBySku.has(old.sku)) continue;
    if (HIDDEN_SKUS.has(old.sku)) { changes.push(`− ausgeblendet: ${old.name}`); continue; }
    const since = prev.missingSince?.[old.sku];
    if (since && since !== now.date) {
      changes.push(`− gestrichen: ${old.name}`);
    } else {
      missingSince[old.sku] = since ?? now.date;
      items.push(old);
      if (!since) changes.push(`? fehlt heute (bleibt bis morgen stehen): ${old.name}`);
    }
  }

  for (const item of fresh) {
    const old = prevBySku.get(item.sku);
    if (!old) changes.push(`+ neu: ${item.name} (${euro(item.priceCents)})`);
    else {
      if (old.priceCents !== item.priceCents) changes.push(`€ ${item.name}: ${euro(old.priceCents)} → ${euro(item.priceCents)}`);
      if (old.name !== item.name) changes.push(`✎ umbenannt: ${old.name} → ${item.name}`);
      if (old.description !== item.description) changes.push(`✎ Beschreibung geändert: ${item.name}`);
    }
  }

  const out = {
    checkedOn: now.date,
    checkedAt: new Date().toISOString(),
    updatedOn: changes.some(c => !c.startsWith('?')) || !prev.updatedOn ? now.date : prev.updatedOn,
    items,
    missingSince,
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');

  if (changes.length) {
    await appendFile(LOG, `\n## ${now.date}\n${changes.map(c => `- ${c}`).join('\n')}\n`);
  }
  console.log(changes.length ? changes.join('\n') : 'Keine Änderungen.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
