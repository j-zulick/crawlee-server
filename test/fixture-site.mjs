// "Ridgeline Motors" — fictional dealer site for offline tests. Ground truth returned with the server.
import http from 'node:http';

const MAP = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function makeVin(seed) {
  const base = ('1RM' + 'ABCDEFGHJ'[seed % 9] + String(seed).padStart(4, '0') + '0' + 'P' + 'R' + String(100000 + seed).slice(-6)).slice(0, 17).split('');
  let s = 0; base.forEach((c, i) => { s += (/\d/.test(c) ? +c : MAP[c]) * W[i]; });
  const r = s % 11; base[8] = r === 10 ? 'X' : String(r); return base.join('');
}

const MAKES = [['Toyota', 'Land Cruiser'], ['Ford', 'Bronco'], ['Subaru', 'Outback'], ['Honda', 'Pilot'], ['Jeep', 'Wrangler'], ['Mazda', 'CX-5']];
const COLORS = ['Blue', 'Silver', 'Red', 'Black', 'White', 'Green'];

export function inventory(n = 12) {
  return Array.from({ length: n }, (_, i) => {
    const [make, model] = MAKES[i % MAKES.length];
    return {
      id: i + 1, vin: i === 7 ? null : makeVin(i + 1), year: 2015 + (i % 9), make, model, trim: ['Base', 'Sport', 'Limited'][i % 3],
      price: i === 5 ? null : 21000 + i * 1375, mileage: 12000 + i * 4321, exterior_color: COLORS[i % COLORS.length],
      status: i === 3 ? 'sold' : 'available', style: ['jsonld', 'microdata', 'plain'][i % 3],
    };
  });
}

export function page(v) {
  const priceText = v.price === null ? 'Call for price' : '$' + v.price.toLocaleString('en-US');
  const head = `<title>${v.year} ${v.make} ${v.model} | Ridgeline Motors</title>`;
  if (v.style === 'jsonld') {
    const ld = { '@context': 'https://schema.org', '@type': 'Car', name: `${v.year} ${v.make} ${v.model}`, vehicleIdentificationNumber: v.vin, vehicleModelDate: String(v.year), brand: { '@type': 'Brand', name: v.make }, model: v.model, vehicleConfiguration: v.trim, color: v.exterior_color, mileageFromOdometer: { '@type': 'QuantitativeValue', value: v.mileage, unitCode: 'SMI' }, image: [`/img/${v.id}-1.jpg`], offers: { '@type': 'Offer', price: v.price, priceCurrency: 'USD', availability: v.status === 'sold' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock', seller: { '@type': 'AutoDealer', name: 'Ridgeline Motors', address: { addressLocality: 'Bend', addressRegion: 'OR' } } } };
    return `<!doctype html><html><head>${head}<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>${v.year} ${v.make} ${v.model}</h1><p>${priceText}</p></body></html>`;
  }
  if (v.style === 'microdata') {
    return `<!doctype html><html><head>${head}</head><body><div itemscope itemtype="https://schema.org/Car">
<h1 itemprop="name">${v.year} ${v.make} ${v.model}</h1>
<span itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">${v.make}</span></span>
<span itemprop="model">${v.model}</span><span itemprop="vehicleConfiguration">${v.trim}</span>
<meta itemprop="vehicleModelDate" content="${v.year}">${v.vin ? `<span itemprop="vehicleIdentificationNumber">${v.vin}</span>` : ''}
<span itemprop="color">${v.exterior_color}</span>
<div itemprop="mileageFromOdometer" itemscope itemtype="https://schema.org/QuantitativeValue"><span itemprop="value">${v.mileage.toLocaleString('en-US')}</span> mi</div>
<img itemprop="image" src="/img/${v.id}-1.jpg">
<div itemprop="offers" itemscope itemtype="https://schema.org/Offer">${v.price === null ? '<span>Call for price</span>' : `<span itemprop="price" content="${v.price}">${priceText}</span><meta itemprop="priceCurrency" content="USD">`}
<link itemprop="availability" href="https://schema.org/${v.status === 'sold' ? 'SoldOut' : 'InStock'}"></div></div></body></html>`;
  }
  return `<!doctype html><html><head>${head}</head><body><h1>${v.year} ${v.make} ${v.model} ${v.trim}</h1>
<div class="vehicle"><span class="make">${v.make}</span> <span class="model">${v.model}</span> <span class="trim">${v.trim}</span>
<div class="price">${priceText}</div><div class="mileage">${v.mileage.toLocaleString("en-US")} miles</div>
${v.vin ? `<div>VIN: ${v.vin}</div>` : ''}<div class="exterior-color">${v.exterior_color}</div>
<div class="status">${v.status === 'sold' ? 'Sold' : 'Available'}</div><img src="/img/${v.id}-1.jpg"></div></body></html>`;
}

export function startFixture({ n = 12, perPage = 5, duplicate = true } = {}) {
  const inv = inventory(n);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (code, body, type = 'text/html') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (u.pathname === '/robots.txt') return html(200, 'User-agent: *\nDisallow: /private/\n', 'text/plain');
    if (u.pathname === '/sitemap.xml') return html(200, `<?xml version="1.0"?><urlset>${inv.map(v => `<url><loc>http://${req.headers.host}/inventory/${v.id}</loc></url>`).join('')}</urlset>`, 'application/xml');
    if (u.pathname === '/private/secret') return html(200, '<h1>should never be fetched</h1>');
    const m = u.pathname.match(/^\/inventory\/(\d+)$/);
    if (m) { const v = inv[+m[1] - 1]; return v ? html(200, page(v)) : html(404, 'not found'); }
    if (u.pathname === '/inventory/dup-of-1') return html(200, page(inv[0]));
    if (u.pathname === '/' || u.pathname === '/inventory') {
      const p = Number(u.searchParams.get('page') || 1); const pages = Math.ceil(n / perPage);
      const items = inv.slice((p - 1) * perPage, p * perPage).map(v => `<li><a class="listing" href="/inventory/${v.id}">${v.year} ${v.make} ${v.model}</a></li>`).join('');
      const extra = duplicate && p === 1 ? '<li><a class="listing" href="/inventory/dup-of-1">Featured</a></li><li><a href="/private/secret">x</a></li><li><a href="http://evil.example/">off-site</a></li>' : '';
      return html(200, `<!doctype html><html><head><title>Inventory</title></head><body><ul>${items}${extra}</ul>${p < pages ? `<a class="next" href="/inventory?page=${p + 1}">Next</a>` : ''}</body></html>`);
    }
    html(404, 'not found');
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, inv, base: `http://127.0.0.1:${server.address().port}` })));
}
