'use strict';

const { chromium } = require('playwright');
const cron   = require('node-cron');
const fs     = require('fs');

const OUTPUT_FILE    = process.env.OUTPUT_FILE    || '/data/inventory.json';
const CRON_SCHEDULE  = process.env.CRON_SCHEDULE  || '*/30 * * * *';

// ─── Dealer roster ────────────────────────────────────────────────────────────
// strategy: 'dealercom'  → direct JSON API (no browser)
// strategy: 'browser'    → Playwright + XHR interception
const DEALERS = [
  { name: 'George Kell Ford',        key: 'gkf',            city: 'Newport, AR',       base: 'https://www.georgekellford.com',        strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Cavenaugh Ford',           key: 'cavenaugh',      city: 'Jonesboro, AR',     base: 'https://www.cavenaughford.com',          strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Central Ford',             key: 'central',        city: 'Trumann, AR',       base: 'https://www.centralfordtrumann.com',    strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Red River Ford Cabot',     key: 'redriver_cabot', city: 'Cabot, AR',         base: 'https://www.redriverfordcabot.com',     strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Mark Martin Ford',         key: 'markmartin',     city: 'Batesville, AR',    base: 'https://www.markmartinfordar.com',      strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Riser Harness Ford',       key: 'riser',          city: 'Searcy, AR',        base: 'https://www.riserford.com',             strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Freedom Ford',             key: 'freedom',        city: 'Melbourne, AR',     base: 'https://www.freedomford.net',           strategy: 'dealercom', invPath: '/new-inventory/index.htm' },
  { name: 'Red River Ford Wynne',     key: 'redriver_wynne', city: 'Wynne, AR',         base: 'https://www.redriverfordtoyota.com',   strategy: 'browser',  invPath: '/new-inventory/index.htm' },
  { name: 'Crain Ford Jacksonville',  key: 'crain_jax',      city: 'Jacksonville, AR',  base: 'https://www.crainfordjacksonville.com', strategy: 'browser',  invPath: '/new-inventory/index.htm' },
  { name: 'Crain Ford Little Rock',   key: 'crain_lr',       city: 'Little Rock, AR',   base: 'https://www.crainfordoflittlerock.net', strategy: 'browser',  invPath: '/new-inventory/index.htm' },
  { name: 'Everett Ford',             key: 'everett',        city: 'Benton, AR',        base: 'https://www.everettford.com',           strategy: 'browser',  invPath: '/new-inventory/index.htm' },
  { name: 'Meadows Ford',             key: 'meadows',        city: 'Mountain View, AR', base: 'https://www.meadowsford.com',           strategy: 'browser',  invPath: '/new-inventory/index.htm' },
];

// ─── Model name normalizer ────────────────────────────────────────────────────
const MODEL_MAP = [
  ['bronco sport',     'Bronco Sport'],
  ['bronco',           'Bronco'],
  ['e-transit',        'E-Transit'],
  ['escape',           'Escape'],
  ['expedition max',   'Expedition MAX'],
  ['expedition',       'Expedition'],
  ['explorer',         'Explorer'],
  ['edge',             'Edge'],
  ['f-150',            'F-150'],
  ['f-250',            'Super Duty F-250'],
  ['f-350',            'Super Duty F-350'],
  ['f-450',            'Super Duty F-450'],
  ['f-550',            'Super Duty F-550'],
  ['maverick',         'Maverick'],
  ['mustang mach-e',   'Mustang Mach-E'],
  ['mustang',          'Mustang'],
  ['ranger',           'Ranger'],
  ['transit connect',  'Transit Connect'],
  ['transit-150',      'Transit-150'],
  ['transit-250',      'Transit-250'],
  ['transit-350',      'Transit-350'],
  ['transit',          'Transit'],
];

function normalizeModel(raw) {
  if (!raw) return '';
  const s = raw.toLowerCase().replace(/[®™+]/g, '').replace(/\s+/g, ' ').trim();
  for (const [key, val] of MODEL_MAP) {
    if (s.includes(key)) return val;
  }
  return raw.replace(/[®™]/g, '').trim();
}

function vdpUrl(base, link) {
  if (!link) return '';
  return link.startsWith('http') ? link : `${base}${link}`;
}

// ─── Dealer.com — in-browser API call (bypasses 403) ─────────────────────────
// Navigate to the dealer site first to get valid cookies/session, then call
// the Dealer.com inventory API from inside the browser context so it sees
// real browser headers and credentials instead of a server-side request.
async function scrapeDealercom(dealer, browser) {
  const page = await browser.newPage();
  try {
    // Load homepage to establish session/cookies
    await page.goto(dealer.base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Call the API from inside the browser — has valid Origin, Referer, cookies
    const raw = await page.evaluate(async (base) => {
      const url = `${base}/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_NEW/inventory/` +
                  `?make=Ford&new_used=N&start=0&count=999&_=${Date.now()}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      return resp.json();
    }, dealer.base);

    const items = raw?.inventory || raw?.vehicles || raw?.items || [];
    if (!Array.isArray(items)) throw new Error('Unexpected API shape');

    return items
      .filter(v => (v.make || '').toUpperCase() === 'FORD')
      .map(v => {
        const p    = v.pricing || v.price || {};
        const msrp = Number(p.msrp || p.MSRP || v.msrp || 0);
        const sale = Number(p.sellingPrice || p.internetPrice || p.sale || v.sellingPrice || msrp);
        const disc = Math.max(0, msrp - sale);
        return {
          dealer:          dealer.name,
          dealer_key:      dealer.key,
          city:            dealer.city,
          year:            Number(v.year) || new Date().getFullYear(),
          make:            'Ford',
          model:           normalizeModel(v.model || ''),
          trim:            (v.trim || '').replace(/[®™]/g, '').trim(),
          body_style:      v.bodyStyle || v.body_style || '',
          stock_number:    v.stockNumber || v.stock || '',
          vin:             v.vin || '',
          exterior_color:  v.extColor || v.exteriorColor || v.color || '',
          msrp,
          sale_price:      sale,
          dealer_discount: disc,
          discount_pct:    msrp > 0 ? Math.round((disc / msrp) * 1000) / 10 : 0,
          vdp_url:         vdpUrl(dealer.base, v.links?.vdp || v.link?.href || v.vdp_url || v.href || ''),
        };
      });
  } finally {
    await page.close();
  }
}

// ─── Browser sites — Playwright + XHR interception ───────────────────────────
// DealerSocket / VinSolutions sites load inventory via async XHR.
// Intercept every JSON response, collect all candidates, pick the largest set.
async function scrapeBrowser(dealer, browser) {
  const page = await browser.newPage();
  const captured = [];
  const pending  = [];

  page.on('response', (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    // Skip analytics / telemetry / font endpoints
    const u = res.url();
    if (/analytics|segment|beacon|pixel|telemetry|gtm|hotjar|font/i.test(u)) return;

    const p = res.json()
      .then(body => {
        if (!body || typeof body !== 'object') return;
        const arr = body.inventory || body.vehicles || body.results ||
                    body.data?.vehicles || body.data?.inventory ||
                    body.listings || body.items ||
                    (Array.isArray(body) ? body : null);
        if (Array.isArray(arr) && arr.length > 0) captured.push(arr);
      })
      .catch(() => {});
    pending.push(p);
  });

  const targetUrl = `${dealer.base}${dealer.invPath}?make=Ford&new_used=N`;
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000); // let async inventory calls complete
    await Promise.allSettled(pending); // drain response handlers
  } finally {
    await page.close();
  }

  if (captured.length === 0) return [];

  // Pick the largest captured dataset (most likely the full inventory)
  const best = captured.sort((a, b) => b.length - a.length)[0];
  return best
    .filter(v => {
      const make = (v.make || v.Make || '').toLowerCase();
      return make === 'ford' || make === '' || make === 'f';
    })
    .map(v => normalizeBrowser(v, dealer));
}

function normalizeBrowser(v, dealer) {
  const msrp = Number(v.msrp || v.MSRP || v.listPrice || v.ListPrice || v.sticker || 0);
  const sale  = Number(v.salePrice || v.sellingPrice || v.internetPrice || v.SalePrice || msrp);
  const disc  = Math.max(0, msrp - sale);
  return {
    dealer:          dealer.name,
    dealer_key:      dealer.key,
    city:            dealer.city,
    year:            Number(v.year || v.Year || v.modelYear) || new Date().getFullYear(),
    make:            'Ford',
    model:           normalizeModel(v.model || v.Model || v.modelName || ''),
    trim:            (v.trim || v.Trim || v.trimName || '').replace(/[®™]/g, '').trim(),
    body_style:      v.bodyStyle || v.body || v.BodyStyle || '',
    stock_number:    v.stockNumber || v.stock || v.StockNumber || '',
    vin:             v.vin || v.VIN || v.Vin || '',
    exterior_color:  v.extColor || v.exteriorColor || v.color || v.ExteriorColor || '',
    msrp,
    sale_price:      sale,
    dealer_discount: disc,
    discount_pct:    msrp > 0 ? Math.round((disc / msrp) * 1000) / 10 : 0,
    vdp_url:         vdpUrl(dealer.base, v.vdpUrl || v.url || v.link || v.href || v.VdpUrl || ''),
  };
}

// ─── Load previous inventory for carry-over on failure ────────────────────────
function loadPrevious() {
  try {
    const raw = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const byKey = {};
    for (const v of (raw.vehicles || [])) {
      (byKey[v.dealer_key] = byKey[v.dealer_key] || []).push(v);
    }
    return byKey;
  } catch {
    return {};
  }
}

// ─── Main crawl ───────────────────────────────────────────────────────────────
async function crawl() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ── Crawl start ─────────────────────────────────`);

  const prev = loadPrevious();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
  });

  const dealerMeta  = [];
  const allVehicles = [];

  for (const dealer of DEALERS) {
    const t0 = Date.now();
    process.stdout.write(`  ${dealer.name.padEnd(28)} `);
    let vehicles = [];
    let status   = 'ok';
    let notes    = '';

    try {
      vehicles = dealer.strategy === 'dealercom'
        ? await scrapeDealercom(dealer, browser)
        : await scrapeBrowser(dealer, browser);

      // Enforce Ford-only filter as final safety net
      vehicles = vehicles.filter(v => v.make === 'Ford' && v.msrp > 0);
    } catch (err) {
      status   = 'error';
      notes    = String(err.message || err).substring(0, 120);
      vehicles = prev[dealer.key] || [];
      if (vehicles.length > 0) status = 'carried_over';
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const avgDisc = vehicles.length
      ? Math.round(vehicles.reduce((s, v) => s + v.dealer_discount, 0) / vehicles.length * 100) / 100
      : 0;
    const avgPct = vehicles.length
      ? Math.round(vehicles.reduce((s, v) => s + v.discount_pct, 0) / vehicles.length * 10) / 10
      : 0;

    console.log(`${String(vehicles.length).padStart(3)} vehicles  ${elapsed}s  [${status}]${notes ? '  ' + notes : ''}`);
    allVehicles.push(...vehicles);
    dealerMeta.push({
      dealer:          dealer.name,
      dealer_key:      dealer.key,
      city:            dealer.city,
      inventory_url:   dealer.base,
      platform:        dealer.strategy,
      reported_count:  vehicles.length,
      extracted_count: vehicles.length,
      avg_discount:    avgDisc,
      avg_discount_pct: avgPct,
      status,
      duration_sec:    parseFloat(elapsed),
      notes,
    });
  }

  await browser.close();

  const output = {
    generated_at:      new Date().toISOString(),
    dealers:           dealerMeta,
    vehicles:          allVehicles,
    browser_needed_keys: DEALERS.filter(d => d.strategy === 'browser').map(d => d.key),
  };

  // Only write if we got actual data — don't overwrite a good snapshot with zeros
  if (allVehicles.length === 0) {
    console.log('  ── No vehicles captured, keeping previous snapshot ──');
    return;
  }

  // Atomic write — avoids serving a partial file
  const tmp = OUTPUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(output));
  fs.renameSync(tmp, OUTPUT_FILE);

  const ok    = dealerMeta.filter(d => d.status === 'ok').length;
  const total = allVehicles.length;
  console.log(`  ── ${total} New Ford vehicles  ${ok}/${DEALERS.length} dealers OK ──`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────
(async () => {
  // Run immediately on container start so data is available right away
  await crawl().catch(err => console.error('Initial crawl error:', err));

  console.log(`\nScheduled: ${CRON_SCHEDULE} (every 30 min)`);
  cron.schedule(CRON_SCHEDULE, () =>
    crawl().catch(err => console.error('Scheduled crawl error:', err))
  );
})();
