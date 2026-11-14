import type { Db, SqlValue } from './db';
import { inHoldout } from './holdout';
import { AUTO_LINK, matchStores } from './match';

/**
 * Demo data for a sales demo client (id starting with "demo"): merchants matched to the
 * catalogue, offers in English and Arabic, and four weeks of synthetic customers, visits, floors,
 * offers, control groups and purchases, so the console's reports look like a running pilot.
 *
 * Built in steps so each request stays small (Workers' CPU limits): 'setup' wipes the client's
 * data and creates merchants and offers; 'activity' adds customers [from, from + count).
 * Everything is clearly synthetic: install ids start with "demo-".
 */
export const DEMO_INSTALLS = 1200;
export const DEMO_BATCH = 100;
export const DEMO_DAYS = 28;

const MERCHANTS = [
  { key: 'costa', name: 'Costa Coffee', nameAr: 'كوستا كوفي', category: 'Cafe', mcc: '5814', mids: ['900101', '900102'] },
  { key: 'starbucks', name: 'Starbucks', nameAr: 'ستاربكس', category: 'Cafe', mcc: '5814', mids: ['900201'] },
  { key: 'carrefour', name: 'Carrefour', nameAr: 'كارفور', category: 'Hypermarket', mcc: '5411', mids: ['900301'] },
  { key: 'hm', name: 'H&M', nameAr: 'إتش آند إم', category: 'Fashion', mcc: '5651', mids: ['900401'] },
  { key: 'sephora', name: 'Sephora', nameAr: 'سيفورا', category: 'Beauty', mcc: '5977', mids: ['900501'] },
] as const;

type Key = (typeof MERCHANTS)[number]['key'];

/** Deterministic random numbers (mulberry32), so a demo looks the same every time it is loaded. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Multi-row INSERTs within D1's 100-parameter limit. */
function insertRows(table: string, cols: string[], rows: SqlValue[][]) {
  const per = Math.max(1, Math.floor(100 / cols.length));
  const out: { sql: string; params: SqlValue[] }[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push({ sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`, params: chunk.flat() });
  }
  return out;
}

async function runAll(db: Db, statements: { sql: string; params: SqlValue[] }[]) {
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
}

export async function demoSetup(db: Db, tenantId: string, now: Date) {
  // Wipe this demo client's data.
  await db.batch(
    ['events', 'conversions', 'installs', 'consents', 'webhook_deliveries', 'merchant_mids'].map((t) => ({ sql: `DELETE FROM ${t} WHERE tenant_id = ?`, params: [tenantId] as SqlValue[] })),
  );
  await db.run('DELETE FROM merchants WHERE tenant_id = ?', [tenantId]); // cascades to offers and branches

  const stores = await db.all<{ id: string; name: string; mall_id: string; floor_index: number | null }>(
    "SELECT s.id, s.name, s.mall_id, s.floor_index FROM stores s JOIN malls m ON m.id = s.mall_id WHERE m.status = 'pilot'",
  );
  const t = now.toISOString();
  const ids = new Map<Key, string>();
  const statements: { sql: string; params: SqlValue[] }[] = [];
  let branches = 0;
  for (const m of MERCHANTS) {
    const id = crypto.randomUUID();
    ids.set(m.key, id);
    statements.push({
      sql: 'INSERT INTO merchants (id, tenant_id, name, name_ar, category, mcc, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, tenantId, m.name, m.nameAr, m.category, m.mcc, `DEMO-${m.key.toUpperCase()}`, t],
    });
    for (const mid of m.mids) statements.push({ sql: 'INSERT INTO merchant_mids (tenant_id, mid, merchant_id) VALUES (?, ?, ?)', params: [tenantId, mid, id] });
    for (const c of matchStores(m.name, stores, 10).filter((x) => x.score >= AUTO_LINK)) {
      statements.push({ sql: "INSERT OR IGNORE INTO merchant_branches (merchant_id, store_id, source) VALUES (?, ?, 'auto')", params: [id, c.storeId] });
      branches++;
    }
  }
  await db.batch(statements);

  const hasBranches = async (key: Key) => !!(await db.first('SELECT 1 FROM merchant_branches WHERE merchant_id = ?', [ids.get(key)!]));
  const starts = iso(now.getTime() - (DEMO_DAYS + 2) * 86_400_000);
  const ends = iso(now.getTime() + 30 * 86_400_000);
  const offers: { key: Key; all: boolean; mall: string | null; title: string; titleAr: string; body: string; bodyAr: string; priority: number; segments: string[] | null; holdout: number; status: string }[] = [
    { key: 'costa', all: await hasBranches('costa'), mall: 'mall-of-oman', title: 'Free cookie with any coffee', titleAr: 'كوكيز مجانية مع أي قهوة', body: 'Pay with your Demo Bank card.', bodyAr: 'ادفع ببطاقة بنك العرض.', priority: 5, segments: null, holdout: 15, status: 'active' },
    { key: 'starbucks', all: await hasBranches('starbucks'), mall: 'oman-avenues-mall', title: 'Double stars this weekend', titleAr: 'نجوم مضاعفة نهاية هذا الأسبوع', body: 'On any drink paid with your card.', bodyAr: 'على أي مشروب تدفعه ببطاقتك.', priority: 4, segments: null, holdout: 15, status: 'active' },
    { key: 'carrefour', all: false, mall: 'mall-of-oman', title: '5% cashback on groceries', titleAr: 'استرداد ٥٪ على مشتريات البقالة', body: 'Up to 5 OMR per visit.', bodyAr: 'حتى ٥ ريالات لكل زيارة.', priority: 3, segments: null, holdout: 15, status: 'active' },
    { key: 'hm', all: false, mall: 'oman-avenues-mall', title: '15% off for Visa Infinite', titleAr: 'خصم ١٥٪ لحاملي فيزا إنفينيت', body: 'Today only, in store.', bodyAr: 'اليوم فقط، في المتجر.', priority: 6, segments: ['visa-infinite'], holdout: 15, status: 'active' },
    { key: 'sephora', all: false, mall: 'city-centre-muscat', title: 'Gift with purchases over 20 OMR', titleAr: 'هدية مع مشتريات تزيد عن ٢٠ ريالاً', body: 'While stocks last.', bodyAr: 'حتى نفاد الكمية.', priority: 2, segments: null, holdout: 15, status: 'draft' },
  ];
  const rows: SqlValue[][] = offers.map((o) => [
    crypto.randomUUID(),
    tenantId,
    ids.get(o.key)!,
    o.all ? null : o.mall,
    null,
    null,
    o.all ? 1 : 0,
    o.title,
    o.body,
    o.titleAr,
    o.bodyAr,
    null,
    starts,
    ends,
    o.priority,
    1,
    o.segments ? JSON.stringify(o.segments) : null,
    null,
    null,
    o.holdout,
    o.status,
    t,
    t,
  ]);
  await runAll(
    db,
    insertRows(
      'offers',
      ['id', 'tenant_id', 'merchant_id', 'mall_id', 'floor_index', 'store_id', 'all_branches', 'title', 'body', 'title_ar', 'body_ar', 'cta_url', 'starts_at', 'ends_at', 'priority', 'daily_cap_per_user', 'segments', 'max_deliveries', 'max_conversions', 'holdout_pct', 'status', 'created_at', 'updated_at'],
      rows,
    ),
  );
  return { merchants: MERCHANTS.length, branches, offers: offers.length, installs: DEMO_INSTALLS, batch: DEMO_BATCH };
}

/** Synthetic activity for customers [from, from + count): visits over the last four weeks. */
export async function demoActivity(db: Db, tenantId: string, now: Date, from: number, count: number) {
  const offers = await db.all<{ id: string; merchant_id: string; mall_id: string | null; all_branches: number; segments: string | null; holdout_pct: number }>(
    "SELECT id, merchant_id, mall_id, all_branches, segments, holdout_pct FROM offers WHERE tenant_id = ? AND status = 'active'",
    [tenantId],
  );
  const branchMalls = new Map<string, { mall: string; floor: number | null }[]>();
  for (const b of await db.all<{ merchant_id: string; mall_id: string; floor_index: number | null }>(
    'SELECT mb.merchant_id, s.mall_id, s.floor_index FROM merchant_branches mb JOIN stores s ON s.id = mb.store_id JOIN merchants m ON m.id = mb.merchant_id WHERE m.tenant_id = ?',
    [tenantId],
  )) {
    branchMalls.set(b.merchant_id, [...(branchMalls.get(b.merchant_id) ?? []), { mall: b.mall_id, floor: b.floor_index }]);
  }
  const mids = new Map((await db.all<{ merchant_id: string; mid: string }>('SELECT merchant_id, mid FROM merchant_mids WHERE tenant_id = ?', [tenantId])).map((r) => [r.merchant_id, r.mid]));
  const floors = await db.all<{ mall_id: string; floor_index: number }>("SELECT f.mall_id, f.floor_index FROM floors f JOIN malls m ON m.id = f.mall_id WHERE m.status = 'pilot'");
  const malls = [...new Set(floors.map((f) => f.mall_id))];
  const received = now.toISOString();
  // Midnight in Muscat (UTC+4, no daylight saving) today; visits fall on the 28 days before it.
  const todayMuscat = Math.floor((now.getTime() + 4 * 3_600_000) / 86_400_000) * 86_400_000 - 4 * 3_600_000;

  const events: SqlValue[][] = [];
  const consents: SqlValue[][] = [];
  const installs: SqlValue[][] = [];
  const conversions: SqlValue[][] = [];
  for (let n = from; n < Math.min(from + count, DEMO_INSTALLS); n++) {
    const r = rng(n * 7919 + 17);
    const install = `demo-install-${String(n).padStart(4, '0')}`;
    const ios = r() < 0.55;
    const platform = ios ? 'ios' : 'android';
    const hasBaro = ios || r() < 0.4; // many budget Android phones have no barometer
    const segments = r() < 0.2 ? ['visa-infinite'] : [];
    const firstDay = Math.floor(r() * DEMO_DAYS);
    const tConsent = now.getTime() - (DEMO_DAYS - firstDay) * 86_400_000 - 3_600_000;
    if (n >= 20 && r() < 0.12) continue; // never opted in: nothing is stored for them (the first 20 always opt in, for demos)
    consents.push([tenantId, install, `demo-cust-${n}`, 'mall_offers', 'granted', 'demo-mall-offers-2026-11', null, r() < 0.3 ? 'ar' : 'en', platform, 'app', iso(tConsent), received]);
    installs.push([tenantId, install, `demo-cust-${n}`, segments.length ? JSON.stringify(segments) : null, r() < 0.3 ? 'ar' : 'en', platform, received]);
    const visits = 1 + Math.floor(r() * 4);
    let lastShown = 0;
    for (let v = 0; v < visits; v++) {
      const day = firstDay + Math.floor(r() * (DEMO_DAYS - firstDay));
      const hour = 10 + Math.floor(r() * 12); // 10:00–22:00 Muscat
      const tArrive = todayMuscat - (DEMO_DAYS - day) * 86_400_000 + hour * 3_600_000 + Math.floor(r() * 3_600_000);
      const mall = malls[Math.floor(r() * malls.length)]!;
      const mallFloors = floors.filter((f) => f.mall_id === mall).map((f) => f.floor_index);
      events.push([tenantId, install, 'arrived', mall, null, null, platform, iso(tArrive), received]);
      let t = tArrive;
      const path = hasBaro ? Array.from({ length: 1 + Math.floor(r() * 3) }, () => mallFloors[Math.floor(r() * mallFloors.length)]!) : [];
      for (const floor of path) {
        t += 60_000 + Math.floor(r() * 1_800_000);
        events.push([tenantId, install, 'floor', mall, floor, null, platform, iso(t), received]);
      }
      // One offer per visit at most: the first that applies here.
      const here = offers.filter((o) => {
        if (o.segments && !(JSON.parse(o.segments) as string[]).some((s) => segments.includes(s))) return false;
        if (o.all_branches) return (branchMalls.get(o.merchant_id) ?? []).some((b) => b.mall === mall && (b.floor === null || path.includes(b.floor)));
        return o.mall_id === mall;
      });
      const offer = here[Math.floor(r() * here.length)];
      if (!offer || t - lastShown < 2 * 3_600_000) continue;
      lastShown = t;
      const tOffer = t + 30_000;
      const held = inHoldout(install, offer.id, offer.holdout_pct);
      events.push([tenantId, install, held ? 'offer_held_out' : 'offer_delivered', mall, path.at(-1) ?? null, offer.id, platform, iso(tOffer), received]);
      if (!held && r() < 0.32) events.push([tenantId, install, 'offer_opened', mall, path.at(-1) ?? null, offer.id, platform, iso(tOffer + 20_000 + Math.floor(r() * 300_000)), received]);
      // Purchases: 17% with the offer, 10% without (the lift the pilot is meant to measure).
      if (r() < (held ? 0.1 : 0.17) && mids.has(offer.merchant_id)) {
        const tBuy = tOffer + 600_000 + Math.floor(r() * 36 * 3_600_000);
        if (tBuy < now.getTime()) {
          const amount = Math.round((2 + r() * 23) * 1000) / 1000;
          conversions.push([tenantId, offer.id, install, held ? 'control' : 'treatment', amount, 'OMR', `demo-${install}-${offer.id}-${v}`, iso(tBuy), received]);
        }
      }
    }
  }
  await runAll(db, [
    ...insertRows('consents', ['tenant_id', 'install_id', 'customer_ref', 'purpose', 'status', 'policy_version', 'text_hash', 'language', 'platform', 'source', 't', 'received_at'], consents),
    ...insertRows('installs', ['tenant_id', 'install_id', 'customer_ref', 'segments', 'locale', 'platform', 'updated_at'], installs),
    ...insertRows('events', ['tenant_id', 'install_id', 'type', 'mall_id', 'floor_index', 'offer_id', 'platform', 't', 'received_at'], events),
    ...insertRows('conversions', ['tenant_id', 'offer_id', 'install_id', 'grp', 'amount', 'currency', 'txn_hash', 't', 'received_at'], conversions),
  ]);
  return { customers: installs.length, events: events.length, purchases: conversions.length };
}
