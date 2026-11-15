// Field extraction from a parsed HTML page. Pure functions: (cheerio $, url) -> record.
// Order per profile: JSON-LD -> microdata -> CSS selectors. Each field records which
// layer produced it, so the gateway can flag "extractor drift" when a site changes.
// Written from scratch against schema.org and Crawlee/cheerio docs.

import { z } from 'zod';

// ---------- normalizers ----------

export function parsePrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (!s || /call|contact|request|tbd|n\/a/i.test(s)) return null;
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function parseCurrency(v, fallback = null) {
  const s = String(v ?? '');
  if (/\b(USD|US\$)|\$/.test(s)) return 'USD';
  if (/\bEUR\b|€/.test(s)) return 'EUR';
  if (/\bGBP\b|£/.test(s)) return 'GBP';
  if (/\bCAD\b/.test(s)) return 'CAD';
  const m = s.match(/\b([A-Z]{3})\b/);
  return m ? m[1] : fallback;
}

export function parseMileage(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return parseMileage(v.value ?? v['@value'] ?? null);
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const s = String(v).replace(/,/g, '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

const VIN_MAP = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function normaliseVin(v) {
  const s = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : null;
}

// North American check digit (position 9). Non-NA VINs may legitimately fail.
export function vinChecksumValid(vin) {
  const v = normaliseVin(vin); if (!v) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = v[i]; const n = /\d/.test(c) ? Number(c) : VIN_MAP[c]; sum += n * VIN_W[i]; }
  const r = sum % 11; return v[8] === (r === 10 ? 'X' : String(r));
}

export function parseYear(v) {
  const m = String(v ?? '').match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return m ? Number(m[1]) : null;
}

export function parseStatus(v) {
  const s = String(v ?? '').toLowerCase();
  if (!s) return null;
  if (/sold|outofstock|out of stock|discontinued|soldout|pending sale/.test(s)) return 'sold';
  if (/instock|in stock|available|for sale|onlineonly|limitedavailability|preorder/.test(s)) return 'available';
  return null;
}

const clean = s => (s === null || s === undefined ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const first = (...vals) => { for (const v of vals) if (v !== null && v !== undefined && v !== '') return v; return null; };
const asArray = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const nameOf = v => (v && typeof v === 'object' ? first(v.name, v['@id']) : v);

// ---------- JSON-LD ----------

export function readJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try { flatten(JSON.parse(raw), out); } catch { /* malformed block: skip */ }
  });
  return out;
}

function flatten(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) { for (const n of node) flatten(n, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  if (node['@graph']) flatten(node['@graph'], out, depth + 1);
  if (node['@type']) out.push(node);
  for (const k of ['mainEntity', 'itemOffered', 'item']) if (node[k] && typeof node[k] === 'object') flatten(node[k], out, depth + 1);
  if (node['@type'] && /ItemList/i.test(asArray(node['@type']).join(' '))) for (const li of asArray(node.itemListElement)) flatten(li, out, depth + 1);
}

const hasType = (n, re) => asArray(n['@type']).some(t => re.test(String(t)));

// ---------- microdata ----------

// Returns top-level itemscope objects: { type, props: { name: [values] } }.
export function readMicrodata($) {
  const items = [];
  $('[itemscope]').each((_, el) => {
    const $el = $(el);
    if ($el.attr('itemprop') && $el.parents('[itemscope]').length) return; // nested; read via parent
    items.push(readItem($, $el));
  });
  return items;
}

function readItem($, $scope, depth = 0) {
  const type = clean($scope.attr('itemtype')) || '';
  const props = {};
  $scope.find('[itemprop]').each((_, el) => {
    const $p = $(el);
    // only direct properties of this scope
    const owner = $p.parent().closest('[itemscope]');
    if (!owner.length || owner[0] !== $scope[0]) return;
    const name = $p.attr('itemprop');
    let value;
    if ($p.is('[itemscope]')) value = depth < 4 ? readItem($, $p, depth + 1) : null;
    else value = first($p.attr('content'), $p.attr('value'), $p.attr('datetime'), $p.is('a,link') ? $p.attr('href') : null, $p.is('img') ? $p.attr('src') : null, clean($p.text()));
    for (const n of String(name).split(/\s+/)) (props[n] ||= []).push(value);
  });
  return { type, props };
}

const mdGet = (item, key) => (item?.props?.[key] || [])[0] ?? null;

// ---------- vehicle profile ----------

export const VehicleSchema = z.object({
  vin: z.string().length(17).nullable(),
  year: z.number().int().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  trim: z.string().nullable(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  mileage: z.number().int().nullable(),
  exterior_color: z.string().nullable(),
  location: z.string().nullable(),
  seller: z.string().nullable(),
  listing_url: z.string().url(),
  photos: z.array(z.string()),
  status: z.enum(['available', 'sold']).nullable(),
  source: z.string(),
  extractor: z.record(z.string(), z.enum(['jsonld', 'microdata', 'selector'])),
  extracted_at: z.string(),
  vin_checksum_valid: z.boolean().nullable(),
  missing_required: z.array(z.string()),
});

export const VEHICLE_REQUIRED = ['vin', 'year', 'make', 'model', 'price', 'mileage', 'listing_url', 'status'];

// Default selectors: common class/attribute conventions on dealer pages. Site profiles
// can override any of these with { selectors: { price: '.my-price', ... } }.
export const DEFAULT_VEHICLE_SELECTORS = {
  vin: '[data-vin], .vin, [class*="vin" i]',
  year: '[data-year], .year',
  make: '[data-make], .make',
  model: '[data-model], .model',
  trim: '[data-trim], .trim',
  price: '[data-price], .price, [class*="price" i]',
  mileage: '[data-mileage], .mileage, .odometer, [class*="mileage" i]',
  exterior_color: '[data-color], .exterior-color, .color',
  location: '.location, [data-location]',
  seller: '.dealer-name, .seller, [data-seller]',
  status: '.status, [data-status], .availability',
  title: 'h1',
};

function selectorValue($, sel) {
  if (!sel) return null;
  const $e = $(sel).first();
  if (!$e.length) return null;
  for (const a of ['data-vin', 'data-year', 'data-make', 'data-model', 'data-trim', 'data-price', 'data-mileage', 'data-color', 'data-status', 'content', 'value']) {
    const v = $e.attr(a); if (v) return clean(v);
  }
  return clean($e.text());
}

// Body text with a space between elements, so adjacent blocks don't fuse ("VIN: X…Blue").
export function blockText($, root = 'body') {
  const $c = $(root).first().clone();
  $c.find('script,style,noscript,template').remove();
  $c.find('*').each((_, e) => { $c.find(e).append(' '); });
  return clean($c.text()) || '';
}

function labelled(text, re) {
  const m = text.match(re); return m ? clean(m[1]) : null;
}

export function extractVehicle($, url, { selectors = {}, now = () => new Date() } = {}) {
  const src = {};
  const set = (field, value, layer) => { if (value !== null && value !== undefined && value !== '' && rec[field] == null) { rec[field] = value; src[field] = layer; } };
  const rec = { vin: null, year: null, make: null, model: null, trim: null, price: null, currency: null, mileage: null, exterior_color: null, location: null, seller: null, status: null };
  let photos = [];

  // 1. JSON-LD
  const nodes = readJsonLd($);
  const car = nodes.find(n => hasType(n, /^(Car|Vehicle|MotorizedBicycle|Motorcycle)$/i)) || nodes.find(n => hasType(n, /^Product$/i) && (n.vehicleIdentificationNumber || n.mileageFromOdometer));
  if (car) {
    const offer = asArray(car.offers).find(Boolean) || nodes.find(n => hasType(n, /Offer/i)) || {};
    set('vin', normaliseVin(car.vehicleIdentificationNumber || car.vin), 'jsonld');
    set('year', parseYear(first(car.vehicleModelDate, car.modelDate, car.productionDate, car.releaseDate)), 'jsonld');
    set('make', clean(nameOf(first(car.brand, car.manufacturer))), 'jsonld');
    set('model', clean(nameOf(car.model)), 'jsonld');
    set('trim', clean(car.vehicleConfiguration), 'jsonld');
    set('price', parsePrice(first(offer.price, offer.priceSpecification?.price, offer.lowPrice)), 'jsonld');
    set('currency', clean(first(offer.priceCurrency, offer.priceSpecification?.priceCurrency)), 'jsonld');
    set('mileage', parseMileage(car.mileageFromOdometer), 'jsonld');
    set('exterior_color', clean(car.color), 'jsonld');
    const seller = offer.seller || offer.offeredBy;
    set('seller', clean(nameOf(seller)), 'jsonld');
    const addr = seller?.address || offer.availableAtOrFrom?.address;
    set('location', clean(typeof addr === 'string' ? addr : addr ? [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ') : null), 'jsonld');
    set('status', parseStatus(offer.availability), 'jsonld');
    photos = asArray(car.image).map(i => (typeof i === 'string' ? i : i?.url || i?.contentUrl)).filter(Boolean);
  }

  // 2. microdata
  const items = readMicrodata($);
  const mcar = items.find(i => /schema\.org\/(Car|Vehicle|Motorcycle)/i.test(i.type)) || items.find(i => /schema\.org\/Product/i.test(i.type) && (mdGet(i, 'vehicleIdentificationNumber') || mdGet(i, 'mileageFromOdometer')));
  if (mcar) {
    const offer = mdGet(mcar, 'offers') || {};
    const brand = mdGet(mcar, 'brand') || mdGet(mcar, 'manufacturer');
    set('vin', normaliseVin(mdGet(mcar, 'vehicleIdentificationNumber')), 'microdata');
    set('year', parseYear(first(mdGet(mcar, 'vehicleModelDate'), mdGet(mcar, 'modelDate'), mdGet(mcar, 'productionDate'))), 'microdata');
    set('make', clean(typeof brand === 'object' ? mdGet(brand, 'name') : brand), 'microdata');
    const model = mdGet(mcar, 'model');
    set('model', clean(typeof model === 'object' ? mdGet(model, 'name') : model), 'microdata');
    set('trim', clean(mdGet(mcar, 'vehicleConfiguration')), 'microdata');
    const mileage = mdGet(mcar, 'mileageFromOdometer');
    set('mileage', parseMileage(typeof mileage === 'object' ? mdGet(mileage, 'value') : mileage), 'microdata');
    set('exterior_color', clean(mdGet(mcar, 'color')), 'microdata');
    if (typeof offer === 'object') {
      set('price', parsePrice(mdGet(offer, 'price')), 'microdata');
      set('currency', clean(mdGet(offer, 'priceCurrency')), 'microdata');
      set('status', parseStatus(mdGet(offer, 'availability')), 'microdata');
      const seller = mdGet(offer, 'seller');
      set('seller', clean(typeof seller === 'object' ? mdGet(seller, 'name') : seller), 'microdata');
    }
    if (!photos.length) photos = (mcar.props.image || []).filter(v => typeof v === 'string');
  }

  // 3. selectors + labelled text
  const S = { ...DEFAULT_VEHICLE_SELECTORS, ...selectors };
  const body = blockText($);
  const title = selectorValue($, S.title) || clean($('title').text()) || '';
  set('vin', normaliseVin(selectorValue($, S.vin)) || normaliseVin(labelled(body, /\bVIN[:#\s]+([A-HJ-NPR-Z0-9]{17})\b/i)), 'selector');
  set('year', parseYear(selectorValue($, S.year)) || parseYear(title), 'selector');
  set('make', selectorValue($, S.make), 'selector');
  set('model', selectorValue($, S.model), 'selector');
  set('trim', selectorValue($, S.trim), 'selector');
  const priceText = selectorValue($, S.price) || labelled(body, /\b(?:price|asking)[:\s]*([$€£]?\s?[\d,.]+k?(?:\s*(?:USD|EUR|GBP|CAD))?)/i);
  set('price', parsePrice(priceText), 'selector');
  set('currency', parseCurrency(priceText), 'selector');
  set('mileage', parseMileage(selectorValue($, S.mileage) || labelled(body, /\b(?:mileage|odometer|miles)[:\s]*([\d,.]+\s*k?)/i)), 'selector');
  set('exterior_color', selectorValue($, S.exterior_color) || labelled(body, /\bexterior(?: color)?[:\s]+([A-Za-z][A-Za-z ]{1,30}?)(?=\s{2}|\s[A-Z][a-z]+:|$)/), 'selector');
  set('location', selectorValue($, S.location), 'selector');
  set('seller', selectorValue($, S.seller), 'selector');
  set('status', parseStatus(selectorValue($, S.status)) || (/\bsold\b/i.test(title) ? 'sold' : null), 'selector');
  if (!photos.length) photos = $('img[src]').map((_, e) => $(e).attr('src')).get().filter(s => /\.(jpe?g|png|webp)(\?|$)/i.test(s)).slice(0, 20);
  if (rec.price !== null && !rec.currency) rec.currency = 'USD';
  if (!rec.status && rec.price !== null) { rec.status = 'available'; src.status = 'selector'; }

  const abs = p => { try { return new URL(p, url).href; } catch { return null; } };
  const out = {
    ...rec,
    listing_url: url,
    photos: [...new Set(photos.map(abs).filter(Boolean))].slice(0, 30),
    source: new URL(url).hostname,
    extractor: src,
    extracted_at: now().toISOString(),
    vin_checksum_valid: rec.vin ? vinChecksumValid(rec.vin) : null,
  };
  out.missing_required = VEHICLE_REQUIRED.filter(k => out[k] === null || out[k] === undefined);
  return VehicleSchema.parse(out);
}

// A page "looks like" a single listing if it has a vehicle entity or VIN + price.
export function looksLikeListing(rec) {
  return Boolean((rec.vin || rec.make || rec.model) && (rec.price !== null || rec.mileage !== null || rec.status === 'sold'));
}

// ---------- generic profile (any page: products, articles, docs) ----------

export function extractGeneric($, url, { now = () => new Date(), maxText = 4000, fields = {} } = {}) {
  const nodes = readJsonLd($);
  const product = nodes.find(n => hasType(n, /^(Product|Book|Car|Vehicle|SoftwareApplication)$/i));
  const article = nodes.find(n => hasType(n, /(Article|BlogPosting|NewsArticle|TechArticle|Report)$/i));
  const offer = product ? asArray(product.offers).find(Boolean) || {} : {};
  const md = readMicrodata($);
  const mprod = md.find(i => /schema\.org\/(Product|Book)/i.test(i.type));
  const moffer = mprod ? mdGet(mprod, 'offers') : null;
  const $c = $.root().clone();
  $c.find('script,style,noscript,nav,footer,header,svg,form').remove();
  const text = clean(($c.find('main, article, [role=main]').first().text() || $c.find('body').text() || '')) || '';
  const meta = n => clean($(`meta[name="${n}"], meta[property="${n}"]`).attr('content'));
  const priceRaw = first(offer.price, offer.priceSpecification?.price, typeof moffer === 'object' && moffer ? mdGet(moffer, 'price') : null, meta('product:price:amount'));
  return {
    url,
    title: clean(first(product?.name, article?.headline, meta('og:title'), $('h1').first().text(), $('title').text())),
    description: clean(first(product?.description, article?.description, meta('description'), meta('og:description'))),
    published: clean(first(article?.datePublished, meta('article:published_time'))),
    author: clean(nameOf(asArray(article?.author)[0])),
    entity_types: [...new Set(nodes.flatMap(n => asArray(n['@type']).map(String)).concat(md.map(i => i.type.split('/').pop()).filter(Boolean)))].slice(0, 12),
    product: product || mprod ? {
      name: clean(first(product?.name, mprod ? mdGet(mprod, 'name') : null)),
      sku: clean(first(product?.sku, product?.gtin13, product?.isbn, mprod ? mdGet(mprod, 'sku') : null)),
      price: parsePrice(priceRaw),
      currency: clean(first(offer.priceCurrency, typeof moffer === 'object' && moffer ? mdGet(moffer, 'priceCurrency') : null, meta('product:price:currency'))) || (priceRaw ? parseCurrency(priceRaw) : null),
      availability: parseStatus(first(offer.availability, typeof moffer === 'object' && moffer ? mdGet(moffer, 'availability') : null)),
      brand: clean(nameOf(product?.brand)),
    } : null,
    fields: Object.keys(fields).length ? Object.fromEntries(Object.entries(fields).map(([k, sel]) => { try { return [k, clean($(sel).first().text())]; } catch { return [k, null]; } })) : undefined,
    text: text.slice(0, maxText),
    text_truncated: text.length > maxText,
    extracted_at: now().toISOString(),
  };
}
