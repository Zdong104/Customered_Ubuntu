/**
 * Quick Answers parser: pure JavaScript, no gi:// imports, so it can be unit
 * tested with `gjs -m test/test-parser.js` outside the shell.
 *
 *   parse(query, ctx) -> Array<Result>            (possibly empty)
 *                     |  {pending: '<fetch key>'}  (needs network data first)
 *
 * Result = {title, desc, copy?, url?, icon?, color?}
 *   title  the answer ("2.2 °C"), desc the interpretation ("36 °F → Celsius")
 *   copy   text put on the clipboard on activation (rows without url)
 *   url    lookups: activation opens this URL instead of copying
 *   icon   symbolic icon name; color: "#rrggbb" draws a swatch instead
 *
 * ctx = {
 *   now:    epoch ms
 *   tz:     {local: 'America/New_York', offset(zoneId, utcMs) -> {offset: s, abbr} | null}
 *   data:   key -> cached fetch result | undefined (not fetched / expired)
 *   config: {weatherCity, currencyTargets, flightStatus: {apiKey}}
 * }
 *
 * The parser runs on every keystroke: it bails out before any regex work
 * unless the query has a digit, a currency sign, or starts with a keyword.
 */

import {flightCards} from './flightCard.js';

const MAX_ROWS = 3;

const ICON = {
    calc: 'accessories-calculator-symbolic',
    time: 'preferences-system-time-symbolic',
    date: 'x-office-calendar-symbolic',
    money: 'accessories-calculator-symbolic',
    code: 'utilities-terminal-symbolic',
    flight: 'airplane-mode-symbolic',
    package: 'mail-send-symbolic',
    web: 'web-browser-symbolic',
    dict: 'accessories-dictionary-symbolic',
};

// ---------------------------------------------------------------- numbers

const NUM = '[-+−]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|[-+−]?\\.\\d+';
const SEP = '(?:to|in|into|as|->|→|=)';

export function parseNumber(s) {
    const v = Number(String(s).replace(/,/g, '').replace('−', '-'));
    return Number.isFinite(v) ? v : NaN;
}

function groupInt(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Sensible rounding: >=1000 -> 0 dp, >=10 -> 1 dp, >=1 -> 2 dp, <1 -> ~2 sig. */
export function fmt(x, dec) {
    if (!Number.isFinite(x))
        return '–';
    const a = Math.abs(x);
    if (dec === undefined) {
        if (a >= 1000)
            dec = 0;
        else if (a >= 10)
            dec = 1;
        else if (a >= 1 || a === 0)
            dec = 2;
        else
            dec = Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(a))));
    }
    let s = a.toFixed(dec);
    if (s.includes('.'))
        s = s.replace(/0+$/, '').replace(/\.$/, '');
    const [i, f] = s.split('.');
    const out = groupInt(i) + (f ? `.${f}` : '');
    return x < 0 && /[1-9]/.test(out) ? `-${out}` : out;
}

/** Fixed decimals with separators (currency). */
function fmtFixed(x, dec) {
    const s = Math.abs(x).toFixed(dec);
    const [i, f] = s.split('.');
    const out = groupInt(i) + (f ? `.${f}` : '');
    return x < 0 && /[1-9]/.test(out) ? `-${out}` : out;
}

function row(title, desc, extra = {}) {
    const r = {title, desc, ...extra};
    if (!r.url && r.copy === undefined)
        r.copy = title;
    return r;
}

// ------------------------------------------------------------------ units

const UNITS = {};
const EXACT = {};   // case-sensitive aliases
const LOWER = {};   // case-insensitive aliases (stored lowercased)

/**
 * aliases starting with '=' are case-sensitive (e.g. '=m' meters but not
 * 'M'; '=Mb' megabits while 'mb'/'MB' are megabytes).
 */
function defUnit(key, dim, f, short, long, aliases, opts = {}) {
    UNITS[key] = {key, dim, f, short, long, ...opts};
    for (const a of aliases) {
        if (a.startsWith('='))
            EXACT[a.slice(1)] = key;
        else
            LOWER[a.toLowerCase()] = key;
    }
}

const pl = (...w) => w.flatMap(x => [x, `${x}s`]);

// length (m)
defUnit('mm', 'len', 0.001, 'mm', 'inches', ['mm', ...pl('millimeter', 'millimetre'), '毫米']);
defUnit('cm', 'len', 0.01, 'cm', 'centimeters', ['cm', ...pl('centimeter', 'centimetre'), '厘米', '公分']);
defUnit('m', 'len', 1, 'm', 'meters', ['=m', ...pl('meter', 'metre'), '米']);
defUnit('km', 'len', 1000, 'km', 'kilometers', ['km', 'kms', ...pl('kilometer', 'kilometre'), '公里', '千米', 'k run']);
defUnit('in', 'len', 0.0254, 'in', 'inches', ['in', 'inch', 'inches', '"', '″', '”', "''", '英寸']);
defUnit('ft', 'len', 0.3048, 'ft', 'feet', ['ft', 'foot', 'feet', "'", '′', '’', '英尺']);
defUnit('yd', 'len', 0.9144, 'yd', 'yards', ['yd', 'yds', ...pl('yard'), '码']);
defUnit('mi', 'len', 1609.344, 'mi', 'miles', ['mi', ...pl('mile'), '英里']);
defUnit('nmi', 'len', 1852, 'nmi', 'nautical miles', ['nmi', ...pl('nautical mile')]);
defUnit('ftin', 'len', 0.0254, '', 'feet & inches', ['ft in', 'ft/in', 'feet and inches', 'feet inches', 'ft and in'], {ftin: true});
// mass (kg)
defUnit('mg', 'mass', 1e-6, 'mg', 'milligrams', ['mg', ...pl('milligram')]);
defUnit('g', 'mass', 0.001, 'g', 'grams', ['g', ...pl('gram', 'gramme'), '克']);
defUnit('kg', 'mass', 1, 'kg', 'kilograms', ['kg', 'kgs', 'kilo', 'kilos', ...pl('kilogram'), '公斤', '千克']);
defUnit('lb', 'mass', 0.45359237, 'lb', 'pounds', ['lb', 'lbs', ...pl('pound'), '磅']);
defUnit('oz', 'mass', 0.028349523125, 'oz', 'ounces', ['oz', ...pl('ounce'), '盎司']);
defUnit('st', 'mass', 6.35029318, 'st', 'stone', ['st', 'stone', 'stones'], {needSpace: true});
defUnit('t', 'mass', 1000, 't', 'tonnes', [...pl('tonne', 'metric ton'), '吨']);
defUnit('jin', 'mass', 0.5, '斤', 'jin', ['斤'], {cjk: true});
defUnit('liang', 'mass', 0.05, '两', 'liang', ['两'], {cjk: true});
// volume (L)
defUnit('ml', 'vol', 0.001, 'mL', 'milliliters', ['ml', 'cc', ...pl('milliliter', 'millilitre'), '毫升']);
defUnit('l', 'vol', 1, 'L', 'liters', ['l', 'ltr', ...pl('liter', 'litre'), '升']);
defUnit('cup', 'vol', 0.2365882365, 'cups', 'cups', ['cup', 'cups']);
defUnit('tbsp', 'vol', 0.01478676478125, 'tbsp', 'tablespoons', ['tbsp', 'tbs', 'tbsps', ...pl('tablespoon')]);
defUnit('tsp', 'vol', 0.00492892159375, 'tsp', 'teaspoons', ['tsp', 'tsps', ...pl('teaspoon')]);
defUnit('floz', 'vol', 0.0295735295625, 'fl oz', 'fluid ounces', ['fl oz', 'floz', 'fl. oz', 'fl.oz', ...pl('fluid ounce')]);
defUnit('gal', 'vol', 3.785411784, 'gal', 'gallons', ['gal', 'gals', ...pl('gallon')]);
defUnit('qt', 'vol', 0.946352946, 'qt', 'quarts', ['qt', 'qts', ...pl('quart')]);
defUnit('pt', 'vol', 0.473176473, 'pt', 'pints', ['pt', 'pts', ...pl('pint')]);
// area (m²)
defUnit('sqft', 'area', 0.09290304, 'sq ft', 'square feet', ['sqft', 'sq ft', 'sq. ft', 'sq.ft', 'ft2', 'ft²', 'square feet', 'square foot', 'sf']);
defUnit('sqm', 'area', 1, 'm²', 'square meters', ['sqm', 'sq m', 'm2', 'm²', '㎡', ...pl('square meter', 'square metre'), '平米', '平方米', '平方']);
defUnit('acre', 'area', 4046.8564224, 'acres', 'acres', ['acre', 'acres']);
defUnit('ha', 'area', 10000, 'ha', 'hectares', ['ha', ...pl('hectare'), '公顷']);
defUnit('km2', 'area', 1e6, 'km²', 'square kilometers', ['km2', 'km²', 'sq km', 'sqkm', ...pl('square kilometer', 'square kilometre'), '平方公里']);
defUnit('sqmi', 'area', 2589988.110336, 'sq mi', 'square miles', ['sq mi', 'sqmi', 'mi2', 'mi²', ...pl('square mile')]);
defUnit('mu', 'area', 2000 / 3, '亩', 'mu', ['亩'], {cjk: true});
// temperature (°C, affine)
defUnit('f', 'temp', 1, '°F', 'Fahrenheit', ['f', '°f', '° f', '℉', 'deg f', 'degf', 'degrees f', 'degree f', 'fahrenheit', '华氏度'],
    {to: v => (v - 32) * 5 / 9, from: c => c * 9 / 5 + 32, dec: 1});
defUnit('c', 'temp', 1, '°C', 'Celsius', ['c', '°c', '° c', '℃', 'deg c', 'degc', 'degrees c', 'degree c', 'celsius', 'centigrade', '摄氏度', '度'],
    {dec: 1});
// speed (m/s)
defUnit('mph', 'speed', 0.44704, 'mph', 'mph', ['mph', 'mi/h', 'miles per hour']);
defUnit('kmh', 'speed', 1 / 3.6, 'km/h', 'km/h', ['km/h', 'kph', 'kmh', 'kmph', 'km/hr', 'kilometers per hour', '公里/小时']);
defUnit('mps', 'speed', 1, 'm/s', 'm/s', ['m/s', 'meters per second']);
defUnit('knot', 'speed', 1852 / 3600, 'kn', 'knots', ['knot', 'knots', 'kn', 'kt', 'kts']);
// fuel economy (L/100 km, inverse)
defUnit('mpg', 'fuel', 1, 'mpg', 'mpg (US)', ['mpg'], {to: v => 235.214583 / v, from: b => 235.214583 / b});
defUnit('l100km', 'fuel', 1, 'L/100 km', 'L/100 km', ['l/100km', 'l/100 km', 'l per 100km', 'l per 100 km']);
// pressure (kPa)
defUnit('psi', 'press', 6.894757293168, 'psi', 'psi', ['psi']);
defUnit('kpa', 'press', 1, 'kPa', 'kPa', ['kpa']);
defUnit('bar', 'press', 100, 'bar', 'bar', ['bar', 'bars']);
defUnit('atm', 'press', 101.325, 'atm', 'atmospheres', ['atm']);
defUnit('hpa', 'press', 0.1, 'hPa', 'hPa', ['hpa', 'mbar', 'millibar']);
// data size (bytes); '=' aliases are the case-sensitive bit units
defUnit('kB', 'data', 1e3, 'kB', 'kilobytes', ['kb', 'kilobyte', 'kilobytes']);
defUnit('MB', 'data', 1e6, 'MB', 'megabytes', ['mb', 'megabyte', 'megabytes']);
defUnit('GB', 'data', 1e9, 'GB', 'gigabytes', ['gb', 'gigabyte', 'gigabytes']);
defUnit('TB', 'data', 1e12, 'TB', 'terabytes', ['tb', 'terabyte', 'terabytes']);
defUnit('PB', 'data', 1e15, 'PB', 'petabytes', ['pb', 'petabyte', 'petabytes']);
defUnit('KiB', 'data', 1024, 'KiB', 'KiB', ['kib']);
defUnit('MiB', 'data', 1024 ** 2, 'MiB', 'MiB', ['mib']);
defUnit('GiB', 'data', 1024 ** 3, 'GiB', 'GiB', ['gib']);
defUnit('TiB', 'data', 1024 ** 4, 'TiB', 'TiB', ['tib']);
defUnit('PiB', 'data', 1024 ** 5, 'PiB', 'PiB', ['pib']);
defUnit('Kb', 'data', 125, 'Kb', 'kilobits', ['=Kb', 'kbit', 'kilobit', 'kilobits']);
defUnit('Mb', 'data', 125e3, 'Mb', 'megabits', ['=Mb', 'mbit', 'megabit', 'megabits']);
defUnit('Gb', 'data', 125e6, 'Gb', 'gigabits', ['=Gb', 'gbit', 'gigabit', 'gigabits']);
defUnit('Tb', 'data', 125e9, 'Tb', 'terabits', ['=Tb', 'tbit', 'terabit', 'terabits']);
// data rate (bytes/s); "bps" is always bits, "B/s" bytes
defUnit('kbps', 'rate', 125, 'kbps', 'kbps', ['kbps', 'kbit/s', '=Kb/s', '=kb/s']);
defUnit('Mbps', 'rate', 125e3, 'Mbps', 'Mbps', ['mbps', 'mbit/s', '=Mb/s']);
defUnit('Gbps', 'rate', 125e6, 'Gbps', 'Gbps', ['gbps', 'gbit/s', '=Gb/s']);
defUnit('kBps', 'rate', 1e3, 'kB/s', 'kB/s', ['kb/s', '=kBps', '=KBps']);
defUnit('MBps', 'rate', 1e6, 'MB/s', 'MB/s', ['mb/s', '=MBps']);
defUnit('GBps', 'rate', 1e9, 'GB/s', 'GB/s', ['gb/s', '=GBps']);
// durations (s)
defUnit('sec', 'dur', 1, 's', 'seconds', ['sec', 'secs', ...pl('second'), '秒']);
defUnit('min', 'dur', 60, 'min', 'minutes', ['min', 'mins', ...pl('minute'), '分钟']);
defUnit('hr', 'dur', 3600, 'h', 'hours', ['h', 'hr', 'hrs', ...pl('hour'), '小时']);

export function lookupUnit(text) {
    const t = text.trim().replace(/\s+/g, ' ');
    const key = EXACT[t] ?? LOWER[t.toLowerCase()] ??
        LOWER[t.toLowerCase().replace(/\.$/, '')];
    return key ? UNITS[key] : null;
}

const toBase = (u, v) => (u.to ? u.to(v) : v * u.f);
const fromBase = (u, b) => (u.from ? u.from(b) : b / u.f);

function fmtFtIn(meters) {
    const totalIn = meters / 0.0254;
    const neg = totalIn < 0;
    let ft = Math.floor(Math.abs(totalIn) / 12);
    let inch = Math.round((Math.abs(totalIn) - ft * 12) * 10) / 10;
    if (inch >= 12) {
        ft += 1;
        inch -= 12;
    }
    return `${neg ? '-' : ''}${ft}′${fmt(inch, 1)}″`;
}

function showQty(v, u) {
    if (u.ftin)
        return fmtFtIn(v * u.f);
    const n = fmt(v, u.dec);
    return u.cjk ? `${n}${u.short}` : `${n} ${u.short}`;
}

// auto direction: unit key -> target keys (function of base value)
const AUTO = {
    mm: ['in'], cm: b => (b >= 0.5 && b <= 2.5 ? ['ftin', 'in'] : ['in']),
    m: b => (b < 3 ? ['ft', 'ftin'] : ['ft']), km: ['mi'], in: ['cm'],
    ft: b => (b < 3.05 ? ['m', 'cm'] : ['m']), ftin: ['cm', 'm'], yd: ['m'],
    mi: ['km'], nmi: ['km', 'mi'],
    mg: ['g'], g: ['oz'], kg: ['lb'], lb: ['kg'], oz: ['g'], st: ['kg', 'lb'],
    t: ['lb'], jin: ['kg', 'lb'], liang: ['g', 'oz'],
    ml: ['floz', 'cup'], l: ['gal', 'floz'], cup: ['ml'], tbsp: ['ml'],
    tsp: ['ml'], floz: ['ml'], gal: ['l'], qt: ['l'], pt: ['ml'],
    sqft: ['sqm'], sqm: ['sqft'], acre: ['sqm', 'ha', 'sqft'], ha: ['acre'],
    km2: ['sqmi'], sqmi: ['km2'], mu: ['sqm', 'sqft'],
    f: ['c'], c: ['f'],
    mph: ['kmh'], kmh: ['mph'], knot: ['kmh', 'mph'], mps: ['kmh', 'mph'],
    mpg: ['l100km'], l100km: ['mpg'],
    psi: ['kpa', 'bar'], kpa: ['psi'], bar: ['psi', 'kpa'], atm: ['kpa', 'psi'], hpa: ['psi'],
    kB: ['KiB'], MB: ['MiB'], GB: ['GiB'], TB: ['TiB'], PB: ['PiB'],
    KiB: ['kB'], MiB: ['MB'], GiB: ['GB'], TiB: ['TB'], PiB: ['PB'],
    Kb: ['kB'], Mb: ['MB'], Gb: ['MB'], Tb: ['GB'],
    kbps: ['kBps'], Mbps: ['MBps'], Gbps: ['MBps', 'GBps'],
    kBps: ['kbps'], MBps: ['Mbps'], GBps: ['Gbps'],
};

/** Parse "6'7", "1米8", "36F", "100 km/h" -> {value, unit, base, raw} */
function parseQuantity(s) {
    s = s.trim();
    let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|′|’|ft|feet|foot)\s*(\d+(?:\.\d+)?)\s*(?:"|″|”|''|in|inch|inches)?$/i);
    if (m) {
        const inches = Number(m[1]) * 12 + Number(m[2]);
        if (Number(m[2]) >= 12)
            return null;
        return {value: inches, unit: UNITS.ftin, base: inches * 0.0254, display: fmtFtIn(inches * 0.0254)};
    }
    m = s.match(/^(\d)\s*米\s*(\d{1,2})$/);
    if (m) {
        const meters = Number(m[1]) + Number(m[2]) / (m[2].length === 1 ? 10 : 100);
        return {value: meters, unit: UNITS.m, base: meters, display: s.replace(/\s+/g, ''), targets: ['cm', 'ftin']};
    }
    m = s.match(new RegExp(`^(${NUM})(\\s*)(\\S.*)$`));
    if (!m)
        return null;
    const unit = lookupUnit(m[3]);
    if (!unit)
        return null;
    if (unit.needSpace && !m[2] && !/^stones?$/i.test(m[3]))
        return null; // "1st", "21st" are ordinals
    const value = parseNumber(m[1]);
    if (Number.isNaN(value))
        return null;
    const display = unit.key === 'in' && /^["″”]$/.test(m[3]) ? `${fmt(value)}″` : showQty(value, unit);
    return {value, unit, base: toBase(unit, value), display, token: m[3]};
}

function fmtDuration(sec) {
    sec = Math.round(sec);
    if (sec < 60)
        return `${sec} s`;
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const mi = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d && sec >= 2 * 86400)
        parts.push(`${d} d`);
    const hh = d && sec >= 2 * 86400 ? h : h + d * 24;
    if (hh)
        parts.push(`${hh} h`);
    if (mi)
        parts.push(`${mi} min`);
    if (s && sec < 3600)
        parts.push(`${s} s`);
    return parts.join(' ') || '0 s';
}

function convertRows(q, targets) {
    const rows = [];
    for (const key of targets) {
        const tu = UNITS[key];
        if (!tu || tu.key === q.unit.key)
            continue;
        let title;
        if (tu.ftin)
            title = fmtFtIn(q.base);
        else
            title = showQty(fromBase(tu, q.base), tu);
        rows.push(row(title, `${q.display} → ${tu.long}`, {icon: ICON.calc}));
    }
    return rows;
}

function durationRows(q) {
    const sec = q.base;
    if (sec <= 0 || sec > 1e8)
        return [];
    const rows = [];
    const hms = fmtDuration(sec);
    if (q.unit.key === 'sec') {
        if (sec < 60)
            return [];
        rows.push(row(hms, `${q.display} → minutes & seconds`, {icon: ICON.time}));
        rows.push(row(`${fmt(sec / 60)} min`, `${q.display} → minutes`, {icon: ICON.time}));
    } else if (q.unit.key === 'min') {
        if (sec >= 3600 && hms !== q.display)
            rows.push(row(hms, `${q.display} → hours & minutes`, {icon: ICON.time}));
        rows.push(row(`${fmt(sec / 3600)} h`, `${q.display} → hours`, {icon: ICON.time}));
        if (sec < 3600)
            rows.push(row(`${fmt(sec)} s`, `${q.display} → seconds`, {icon: ICON.time}));
    } else {
        if (hms !== q.display && hms !== `${fmt(q.value)} h`)
            rows.push(row(hms, `${q.display} → hours & minutes`, {icon: ICON.time}));
        rows.push(row(`${fmt(sec / 60)} min`, `${q.display} → minutes`, {icon: ICON.time}));
    }
    return rows;
}

function unitAnswers(q) {
    // explicit "X unit to unit" (last separator wins: "10 in in cm")
    let m = q.match(new RegExp(`^(.*\\S)\\s+${SEP}\\s+(\\S.*)$`, 'i'));
    if (m) {
        const src = parseQuantity(m[1]);
        const tu = lookupUnit(m[2]);
        if (src && tu && tu.dim === src.unit.dim) {
            if (src.unit.dim === 'dur')
                return [row(`${fmt(src.base / tu.f)} ${tu.short}`, `${src.display} → ${tu.long}`, {icon: ICON.time})];
            return convertRows(src, [tu.key]);
        }
        if (src && tu)
            return [];
    }

    // download time "20 GB at 100 Mbps"
    m = q.match(/^(.+?)\s+(?:at|@|over|on)\s+(.+)$/i);
    if (m) {
        const size = parseQuantity(m[1]);
        const rate = parseQuantity(m[2]);
        if (size && rate && size.unit.dim === 'data' && rate.unit.dim === 'rate' && rate.base > 0) {
            const sec = size.base / rate.base;
            return [row(fmtDuration(sec), `${size.display} at ${rate.display} → download time`, {icon: ICON.time})];
        }
        return [];
    }

    const qty = parseQuantity(q);
    if (!qty)
        return [];
    const u = qty.unit;
    if (u.dim === 'dur')
        return durationRows(qty);
    if (u.dim === 'fuel' && qty.value <= 0)
        return [];
    if (u.dim === 'data' && qty.value === 0)
        return [];

    let targets = qty.targets ?? AUTO[u.key];
    if (typeof targets === 'function')
        targets = targets(qty.base);
    if (!targets)
        return [];
    const rows = convertRows(qty, targets);

    // screen diagonal: 27" -> cm + 16:9 panel size
    if (u.key === 'in' && /^["″”]$/.test(qty.token ?? '') && qty.value >= 5 && qty.value <= 120) {
        const d = qty.base * 100;
        const w = d * 16 / Math.sqrt(337), h = d * 9 / Math.sqrt(337);
        rows.push(row(`${fmt(w, 1)} × ${fmt(h, 1)} cm`, `${qty.display} 16:9 screen → width × height`, {icon: ICON.calc}));
    }
    return rows;
}

// --------------------------------------------------------------- currency

const CUR_CODES = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
    'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD',
    'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'];
const CUR_UPPER_ONLY = new Set(['TRY', 'PHP', 'ISK', 'RON']); // real words in lowercase
const CUR_WORDS = {
    dollar: 'USD', dollars: 'USD', bucks: 'USD', 'us dollars': 'USD', '美元': 'USD', '美金': 'USD',
    euro: 'EUR', euros: 'EUR', '欧元': 'EUR',
    yuan: 'CNY', rmb: 'CNY', renminbi: 'CNY', '元': 'CNY', '块': 'CNY', '人民币': 'CNY', '块钱': 'CNY',
    yen: 'JPY', '円': 'JPY', '日元': 'JPY',
    won: 'KRW', '韩元': 'KRW', rupee: 'INR', rupees: 'INR',
    '英镑': 'GBP', '港币': 'HKD', '港元': 'HKD',
};
const CUR_SYMS = {
    'US$': 'USD', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD', 'HK$': 'HKD',
    'NZ$': 'NZD', 'S$': 'SGD', 'R$': 'BRL', '$': 'USD', '¥': 'CNY', '￥': 'CNY',
    '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR', 'JP¥': 'JPY',
};
const CUR_PREFIX = {USD: '$', CNY: '¥', EUR: '€', GBP: '£'};
const CUR_RE_SYM = '(?:US\\$|CA?\\$|AU?\\$|HK\\$|NZ\\$|S\\$|R\\$|JP¥|[$¥￥€£₩₹])';

function curCode(s) {
    if (!s)
        return null;
    const t = s.trim();
    if (CUR_SYMS[t.toUpperCase()] || CUR_SYMS[t])
        return CUR_SYMS[t] ?? CUR_SYMS[t.toUpperCase()];
    const up = t.toUpperCase();
    if (CUR_CODES.includes(up) && (t === up || !CUR_UPPER_ONLY.has(up)))
        return up;
    return CUR_WORDS[t.toLowerCase()] ?? null;
}

function fmtMoney(v, code) {
    const dec = code === 'JPY' || code === 'KRW' || code === 'IDR' || code === 'HUF' || code === 'ISK' ? 0 : 2;
    const n = fmtFixed(v, dec);
    return CUR_PREFIX[code] ? `${v < 0 ? '-' : ''}${CUR_PREFIX[code]}${n.replace(/^-/, '')}` : `${n} ${code}`;
}

function parseMoney(q) {
    const mult = s => (!s ? 1 : /^k$/i.test(s) ? 1e3 : /^m$/i.test(s) ? 1e6 : 1);
    let m = q.match(new RegExp(`^(${CUR_RE_SYM})\\s*(${NUM})\\s*([kKmM])?(?:\\s+${SEP}\\s+(.+))?$`, 'i'));
    if (m) {
        const code = curCode(m[1]);
        if (code)
            return {code, amount: parseNumber(m[2]) * mult(m[3]), target: m[4]};
    }
    m = q.match(new RegExp(`^(${NUM})\\s*([kK])?\\s*([^\\d\\s].*?)(?:\\s+${SEP}\\s+(.+))?$`, 'i'));
    if (m) {
        const code = curCode(m[3]);
        if (code)
            return {code, amount: parseNumber(m[1]) * mult(m[2]), target: m[4]};
    }
    return null;
}

function currencyAnswers(q, ctx) {
    const p = parseMoney(q);
    if (!p || Number.isNaN(p.amount))
        return null;
    let targets;
    if (p.target) {
        const t = curCode(p.target);
        if (!t)
            return [];
        targets = [t];
    } else {
        targets = (ctx.config?.currencyTargets ?? ['USD', 'EUR', 'GBP']).filter(c => c !== p.code);
    }
    const data = ctx.data?.('rates');
    if (data === undefined)
        return {pending: 'rates'};
    if (!data || data.error || !data.rates)
        return [];
    const rates = {...data.rates, USD: 1};
    if (!rates[p.code])
        return [];
    const rows = [];
    for (const t of targets) {
        if (!rates[t] || t === p.code)
            continue;
        const v = p.amount / rates[p.code] * rates[t];
        rows.push(row(fmtMoney(v, t), `${fmtMoney(p.amount, p.code)} ${p.code} → ${t} (rates from ${data.date})`,
            {icon: ICON.money, copy: fmtFixed(v, t === 'JPY' || t === 'KRW' ? 0 : 2).replace(/,/g, '')}));
    }
    return rows;
}

// ----------------------------------------------------------------- devtools

function hslOf(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r)
            h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h *= 60;
    }
    return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function colorAnswers(q) {
    let m = q.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (m) {
        let hex = m[1].toLowerCase();
        if (hex.length === 3)
            hex = [...hex].map(c => c + c).join('');
        const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
        const color = `#${hex.slice(0, 6)}`;
        const rows = [row(`rgb(${r}, ${g}, ${b})`, `#${m[1]} → RGB`, {color})];
        if (hex.length === 8)
            rows[0] = row(`rgba(${r}, ${g}, ${b}, ${fmt(parseInt(hex.slice(6), 16) / 255, 2)})`, `#${m[1]} → RGBA`, {color});
        rows.push(row(hslOf(r, g, b), `#${m[1]} → HSL`, {color}));
        return rows;
    }
    m = q.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i);
    if (m) {
        const c = [m[1], m[2], m[3]].map(Number);
        if (c.some(x => x > 255))
            return [];
        const hex = `#${c.map(x => x.toString(16).padStart(2, '0')).join('')}`;
        return [row(hex.toUpperCase(), `${q} → hex`, {color: hex}), row(hslOf(...c), `${q} → HSL`, {color: hex})];
    }
    return null;
}

const BASES = {
    hex: 16, hexadecimal: 16, bin: 2, binary: 2, oct: 8, octal: 8, dec: 10, decimal: 10,
};
const BASE_PREFIX = {16: '0x', 2: '0b', 8: '0o', 10: ''};
const BASE_NAME = {16: 'hex', 2: 'binary', 8: 'octal', 10: 'decimal'};

function toBaseStr(n, base) {
    const s = n.toString(base);
    return base === 16 ? `0x${s.toUpperCase()}` : `${BASE_PREFIX[base]}${s}`;
}

function parseIntLiteral(s) {
    const m = s.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i);
    if (!m || s.length > 70)
        return null;
    try {
        const base = /^0x/i.test(s) ? 16 : /^0b/i.test(s) ? 2 : /^0o/i.test(s) ? 8 : 10;
        return {n: BigInt(s.toLowerCase()), base};
    } catch {
        return null;
    }
}

function baseAnswers(q) {
    let m = q.match(/^(\S+)\s+(?:in|to|as)\s+(hex|hexadecimal|bin|binary|oct|octal|dec|decimal)$/i);
    if (m) {
        const lit = parseIntLiteral(m[1]);
        if (!lit)
            return null;
        const base = BASES[m[2].toLowerCase()];
        return [row(toBaseStr(lit.n, base), `${m[1]} → ${BASE_NAME[base]}`, {icon: ICON.code})];
    }
    m = q.match(/^0[xbo][0-9a-f]+$/i);
    if (m) {
        const lit = parseIntLiteral(q);
        if (!lit)
            return [];
        const rows = [row(lit.n.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ','), `${q} → decimal`,
            {icon: ICON.code, copy: lit.n.toString(10)})];
        for (const b of [16, 2])
            if (b !== lit.base && (b !== 2 || lit.n < 2n ** 32n))
                rows.push(row(toBaseStr(lit.n, b), `${q} → ${BASE_NAME[b]}`, {icon: ICON.code}));
        return rows;
    }
    return null;
}

// ------------------------------------------------------------- time zones

const Z = (id, label, abbr = false) => ({id, label, abbr});
const ZONE_LIST = [
    [['pst', 'pdt', 'pt', 'pacific'], Z('America/Los_Angeles', 'Pacific', true)],
    [['est', 'edt', 'et', 'eastern'], Z('America/New_York', 'Eastern', true)],
    [['cst', 'cdt', 'ct', 'central'], Z('America/Chicago', 'Central', true)],
    [['mst', 'mdt', 'mt', 'mountain'], Z('America/Denver', 'Mountain', true)],
    [['akst', 'akdt', 'alaska'], Z('America/Anchorage', 'Alaska', true)],
    [['hst', 'hawaii', 'honolulu'], Z('Pacific/Honolulu', 'Honolulu')],
    [['utc', 'gmt', 'zulu', 'z'], Z('UTC', 'UTC', true)],
    [['bst', 'london', 'uk', 'britain', 'england'], Z('Europe/London', 'London')],
    [['cet', 'cest', 'paris', 'france'], Z('Europe/Paris', 'Paris')],
    [['berlin', 'germany', 'munich', 'frankfurt'], Z('Europe/Berlin', 'Berlin')],
    [['eet', 'eest', 'athens'], Z('Europe/Athens', 'Athens')],
    [['jst', 'tokyo', 'japan', 'osaka'], Z('Asia/Tokyo', 'Tokyo')],
    [['kst', 'seoul', 'korea'], Z('Asia/Seoul', 'Seoul')],
    [['ist', 'india', 'delhi', 'new delhi', 'mumbai', 'bangalore', 'bengaluru'], Z('Asia/Kolkata', 'India')],
    [['aest', 'aedt', 'sydney'], Z('Australia/Sydney', 'Sydney')],
    [['melbourne'], Z('Australia/Melbourne', 'Melbourne')],
    [['brisbane'], Z('Australia/Brisbane', 'Brisbane')],
    [['perth', 'awst'], Z('Australia/Perth', 'Perth')],
    [['nzst', 'nzdt', 'auckland', 'new zealand'], Z('Pacific/Auckland', 'Auckland')],
    [['beijing', 'china', 'shanghai', 'shenzhen', 'guangzhou', 'hangzhou', 'chengdu', 'wuhan', 'nanjing', 'xian', "xi'an",
        '北京', '上海', '深圳', '广州', '中国'], Z('Asia/Shanghai', 'Beijing')],
    [['hkt', 'hong kong', 'hongkong', 'hk', '香港'], Z('Asia/Hong_Kong', 'Hong Kong')],
    [['taipei', 'taiwan', '台北'], Z('Asia/Taipei', 'Taipei')],
    [['sgt', 'singapore'], Z('Asia/Singapore', 'Singapore')],
    [['bangkok', 'thailand'], Z('Asia/Bangkok', 'Bangkok')],
    [['hanoi', 'vietnam', 'ho chi minh', 'saigon'], Z('Asia/Ho_Chi_Minh', 'Vietnam')],
    [['jakarta'], Z('Asia/Jakarta', 'Jakarta')],
    [['manila', 'philippines'], Z('Asia/Manila', 'Manila')],
    [['kuala lumpur', 'malaysia'], Z('Asia/Kuala_Lumpur', 'Kuala Lumpur')],
    [['dubai', 'uae', 'abu dhabi'], Z('Asia/Dubai', 'Dubai')],
    [['tel aviv', 'israel', 'jerusalem'], Z('Asia/Jerusalem', 'Tel Aviv')],
    [['istanbul', 'turkey'], Z('Europe/Istanbul', 'Istanbul')],
    [['msk', 'moscow'], Z('Europe/Moscow', 'Moscow')],
    [['cairo', 'egypt'], Z('Africa/Cairo', 'Cairo')],
    [['nairobi', 'kenya'], Z('Africa/Nairobi', 'Nairobi')],
    [['johannesburg', 'south africa'], Z('Africa/Johannesburg', 'Johannesburg')],
    [['dublin', 'ireland'], Z('Europe/Dublin', 'Dublin')],
    [['lisbon', 'portugal'], Z('Europe/Lisbon', 'Lisbon')],
    [['madrid', 'spain', 'barcelona'], Z('Europe/Madrid', 'Madrid')],
    [['amsterdam', 'netherlands'], Z('Europe/Amsterdam', 'Amsterdam')],
    [['brussels'], Z('Europe/Brussels', 'Brussels')],
    [['zurich', 'switzerland', 'geneva'], Z('Europe/Zurich', 'Zurich')],
    [['rome', 'milan', 'italy'], Z('Europe/Rome', 'Rome')],
    [['vienna'], Z('Europe/Vienna', 'Vienna')],
    [['stockholm', 'sweden'], Z('Europe/Stockholm', 'Stockholm')],
    [['oslo'], Z('Europe/Oslo', 'Oslo')],
    [['copenhagen'], Z('Europe/Copenhagen', 'Copenhagen')],
    [['helsinki'], Z('Europe/Helsinki', 'Helsinki')],
    [['warsaw', 'poland'], Z('Europe/Warsaw', 'Warsaw')],
    [['prague'], Z('Europe/Prague', 'Prague')],
    [['nyc', 'new york', 'boston', 'washington', 'dc', 'washington dc', 'philadelphia', 'miami', 'atlanta',
        'detroit', 'pittsburgh', 'raleigh', 'charlotte', 'orlando'], Z('America/New_York', 'New York')],
    [['toronto', 'montreal', 'ottawa'], Z('America/Toronto', 'Toronto')],
    [['chicago', 'dallas', 'houston', 'austin', 'nashville', 'minneapolis', 'new orleans', 'san antonio'],
        Z('America/Chicago', 'Chicago')],
    [['denver', 'salt lake city'], Z('America/Denver', 'Denver')],
    [['phoenix', 'arizona'], Z('America/Phoenix', 'Phoenix')],
    [['la', 'los angeles', 'sf', 'san francisco', 'san jose', 'san diego', 'las vegas', 'seattle', 'portland',
        'silicon valley', 'bay area'], Z('America/Los_Angeles', 'Los Angeles')],
    [['vancouver'], Z('America/Vancouver', 'Vancouver')],
    [['anchorage'], Z('America/Anchorage', 'Anchorage')],
    [['mexico city', 'mexico'], Z('America/Mexico_City', 'Mexico City')],
    [['sao paulo', 'são paulo', 'brazil', 'rio'], Z('America/Sao_Paulo', 'São Paulo')],
    [['buenos aires', 'argentina'], Z('America/Argentina/Buenos_Aires', 'Buenos Aires')],
    [['bogota', 'colombia'], Z('America/Bogota', 'Bogotá')],
    [['lima', 'peru'], Z('America/Lima', 'Lima')],
];
const ZONES = {};
for (const [names, z] of ZONE_LIST) {
    for (const n of names)
        ZONES[n] = {...z, label: z.abbr ? n.toUpperCase() : (titleCase(n).length > 3 ? titleCase(n) : z.label)};
}
// labels: cities use their own name ("Seattle"), abbreviations their letters
function titleCase(s) {
    return s.replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}
ZONES.la.label = 'Los Angeles';
ZONES.sf.label = 'San Francisco';
ZONES.nyc.label = 'New York';
ZONES.dc.label = 'Washington';
ZONES.hk.label = 'Hong Kong';
ZONES.uk.label = 'London';
const BEIJING = {id: 'Asia/Shanghai', label: 'Beijing'};

export function lookupZone(s) {
    const k = s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!,]+$/, '');
    return ZONES[k] ?? null;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
    jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function zinfo(ctx, id, utc) {
    try {
        return ctx.tz?.offset(id, utc) ?? null;
    } catch {
        return null;
    }
}

function wallOf(ctx, id, utc) {
    const o = zinfo(ctx, id, utc);
    if (!o)
        return null;
    const d = new Date(utc + o.offset * 1000);
    return {
        y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(),
        mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(), off: o.offset, abbr: o.abbr,
    };
}

function wallToUtc(ctx, id, y, mo, d, h, mi) {
    const wall = Date.UTC(y, mo, d, h, mi);
    const o1 = zinfo(ctx, id, wall);
    if (!o1)
        return null;
    let utc = wall - o1.offset * 1000;
    const o2 = zinfo(ctx, id, utc);
    if (o2 && o2.offset !== o1.offset)
        utc = wall - o2.offset * 1000;
    return utc;
}

function utcOffStr(off) {
    const sign = off < 0 ? '−' : '+';
    const a = Math.abs(off);
    const h = Math.floor(a / 3600), m = Math.round((a % 3600) / 60);
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

function abbrOf(w) {
    return /^[A-Z]{2,5}$/.test(w.abbr ?? '') ? w.abbr : utcOffStr(w.off);
}

function fmtClock(w, seconds = false) {
    const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
    const ss = seconds ? `:${String(w.s).padStart(2, '0')}` : '';
    return `${h12}:${String(w.mi).padStart(2, '0')}${ss} ${w.h < 12 ? 'AM' : 'PM'}`;
}

function fmtDay(w) {
    return `${WD[w.wd]}, ${MON[w.mo]} ${w.d}`;
}

function zoneLabel(z, w, ctx) {
    if (z.local)
        return `local (${abbrOf(w)})`;
    if (z.abbr)
        return abbrOf(w);
    if (z.id === 'UTC')
        return 'UTC';
    return `${z.label} (${utcOffStr(w.off)})`;
}

function sameDay(a, b) {
    return a.y === b.y && a.mo === b.mo && a.d === b.d;
}

function timeAnswers(q, ctx) {
    if (!ctx.tz)
        return null;
    const local = {id: ctx.tz.local, label: 'local', local: true};
    const now = ctx.now ?? Date.now();

    // current time somewhere
    let m = q.match(/^(?:time|now|current time)\s+(?:in|at)\s+(.+)$/i) ??
        q.match(/^time\s+(.+)$/i) ?? q.match(/^(.+?)\s+time(?:\s+now)?$/i);
    if (m) {
        const z = lookupZone(m[1]);
        if (!z)
            return null;
        const w = wallOf(ctx, z.id, now);
        const lw = wallOf(ctx, local.id, now);
        if (!w || !lw)
            return [];
        const diffH = (w.off - lw.off) / 3600;
        const diff = diffH === 0 ? 'same as local'
            : `${fmt(Math.abs(diffH), 2)} h ${diffH > 0 ? 'ahead of' : 'behind'} local`;
        return [row(fmtClock(w), `Time in ${zoneLabel(z, w, ctx)} · ${fmtDay(w)} · ${diff}`, {icon: ICON.time})];
    }

    // "3pm PST", "10:30 EST in CST", "9am Beijing"
    m = q.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s+(.+)$/i);
    if (!m || (!m[2] && !m[3]))
        return null;
    let h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    const ap = m[3]?.toLowerCase()[0];
    if (mi > 59)
        return null;
    if (ap) {
        if (h < 1 || h > 12)
            return null;
        h = (h % 12) + (ap === 'p' ? 12 : 0);
    } else if (h > 23) {
        return null;
    }
    const parts = m[4].split(/\s+(?:in|to|->|→|as)\s+/i);
    if (parts.length > 2)
        return null;
    const src = lookupZone(parts[0]);
    const dst = parts[1] ? lookupZone(parts[1]) : null;
    if (!src || (parts[1] && !dst))
        return null;
    const today = wallOf(ctx, src.id, now);
    if (!today)
        return [];
    const utc = wallToUtc(ctx, src.id, today.y, today.mo, today.d, h, mi);
    if (utc === null)
        return [];
    const sw = wallOf(ctx, src.id, utc);
    const srcText = `${fmtClock(sw)} ${zoneLabel(src, sw, ctx)}`;

    let targets = dst ? [dst, local, BEIJING] : [local, BEIJING, {id: 'UTC', label: 'UTC'}];
    const seen = new Set([src.id]);
    targets = targets.filter(t => {
        if (!t.id || seen.has(t.id))
            return false;
        seen.add(t.id);
        return true;
    }).slice(0, dst ? 3 : 2);

    const rows = [];
    for (const t of targets) {
        const tw = wallOf(ctx, t.id, utc);
        if (!tw)
            continue;
        const dayNote = sameDay(tw, sw) ? '' : ` (${WD[tw.wd]})`;
        rows.push(row(`${fmtClock(tw)}${dayNote}`,
            `${srcText} → ${zoneLabel(t, tw, ctx)}${dayNote ? `, ${fmtDay(tw)}` : ''}`,
            {icon: ICON.time, copy: fmtClock(tw)}));
    }
    return rows;
}

// ---------------------------------------------------------------- dates

const dayNum = (y, mo, d) => Math.round(Date.UTC(y, mo, d) / 86400000);
function fromDayNum(n) {
    const dt = new Date(n * 86400000);
    return {y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate(), wd: dt.getUTCDay()};
}
function validDate(y, mo, d) {
    if (mo < 0 || mo > 11 || d < 1 || y < 1 || y > 9999)
        return false;
    const t = fromDayNum(dayNum(y, mo, d));
    return t.mo === mo && t.d === d;
}
function fmtDate(x) {
    const t = fromDayNum(dayNum(x.y, x.mo, x.d));
    return `${WD[t.wd]}, ${MON[t.mo]} ${t.d}, ${t.y}`;
}

function todayOf(ctx) {
    const now = ctx.now ?? Date.now();
    const w = ctx.tz ? wallOf(ctx, ctx.tz.local, now) : null;
    if (w)
        return {y: w.y, mo: w.mo, d: w.d};
    const d = new Date(now);
    return {y: d.getFullYear(), mo: d.getMonth(), d: d.getDate()};
}

/** -> {y, mo, d, hasYear} | null */
export function parseDate(s, today) {
    s = s.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
    const rel = {today: 0, now: 0, tomorrow: 1, yesterday: -1, tmr: 1};
    if (s in rel) {
        const t = fromDayNum(dayNum(today.y, today.mo, today.d) + rel[s]);
        return {...t, hasYear: true};
    }
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    let y, mo, d, hasYear = true;
    if (m) {
        [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
    } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
        [mo, d] = [Number(m[1]) - 1, Number(m[2])];
        hasYear = !!m[3];
        y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.y;
    } else if ((m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/)) && m[1] in MONTHS) {
        [mo, d] = [MONTHS[m[1]], Number(m[2])];
        hasYear = !!m[3];
        y = m[3] ? Number(m[3]) : today.y;
    } else if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/)) && m[2] in MONTHS) {
        [mo, d] = [MONTHS[m[2]], Number(m[1])];
        hasYear = !!m[3];
        y = m[3] ? Number(m[3]) : today.y;
    } else {
        return null;
    }
    if (!validDate(y, mo, d))
        return null;
    return {y, mo, d, hasYear};
}

function plural(n, w) {
    return `${fmt(n, 0)} ${w}${Math.abs(n) === 1 ? '' : 's'}`;
}

function weeksNote(n) {
    const a = Math.abs(n);
    if (a < 14)
        return '';
    const w = Math.floor(a / 7), d = a % 7;
    return ` · ${plural(w, 'week')}${d ? ` ${plural(d, 'day')}` : ''}`;
}

function dateAnswers(q, ctx) {
    const today = todayOf(ctx);
    const tn = dayNum(today.y, today.mo, today.d);

    let m = q.match(/^(?:how many\s+)?days?\s+(until|till|til|to|before|left until|since|from|after|ago since)\s+(.+?)\??$/i);
    if (m) {
        const dt = parseDate(m[2], today);
        if (!dt)
            return [];
        const since = /since|from|after/i.test(m[1]);
        let n = dayNum(dt.y, dt.mo, dt.d);
        if (!dt.hasYear && !since && n < tn)
            n = dayNum(dt.y + 1, dt.mo, dt.d);
        if (!dt.hasYear && since && n > tn)
            n = dayNum(dt.y - 1, dt.mo, dt.d);
        const diff = since ? tn - n : n - tn;
        const t = fromDayNum(n);
        return [row(plural(diff, 'day'), `${since ? 'Since' : 'Until'} ${fmtDate(t)}${weeksNote(diff)}`,
            {icon: ICON.date, copy: String(diff)})];
    }

    m = q.match(/^(.+?)\s*([+-])\s*(\d+)\s*(days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)$/i);
    if (m) {
        const dt = parseDate(m[1], today);
        if (!dt)
            return null;
        const n = Number(m[3]) * (m[2] === '-' ? -1 : 1);
        const unit = m[4].toLowerCase()[0];
        let res;
        if (unit === 'd' || unit === 'w') {
            res = fromDayNum(dayNum(dt.y, dt.mo, dt.d) + n * (unit === 'w' ? 7 : 1));
        } else {
            const months = unit === 'y' ? n * 12 : n;
            const total = dt.y * 12 + dt.mo + months;
            const y = Math.floor(total / 12), mo = total % 12;
            const lastDay = fromDayNum(dayNum(y, mo + 1, 1) - 1).d;
            res = fromDayNum(dayNum(y, mo, Math.min(dt.d, lastDay)));
        }
        const unitWord = {d: 'day', w: 'week', m: 'month', y: 'year'}[unit];
        return [row(fmtDate(res), `${fmtDate(dt)} ${m[2] === '-' ? '−' : '+'} ${plural(Math.abs(n), unitWord)}`,
            {icon: ICON.date, copy: `${res.y}-${String(res.mo + 1).padStart(2, '0')}-${String(res.d).padStart(2, '0')}`})];
    }

    m = q.match(/^(?:from\s+)?(.+?)\s+(?:to|until|till|-|–|→)\s+(.+)$/i);
    if (m) {
        const a = parseDate(m[1], today), b = parseDate(m[2], today);
        if (!a || !b)
            return null;
        const diff = dayNum(b.y, b.mo, b.d) - dayNum(a.y, a.mo, a.d);
        return [row(plural(diff, 'day'), `${fmtDate(a)} → ${fmtDate(b)}${weeksNote(diff)}`,
            {icon: ICON.date, copy: String(diff)})];
    }
    return null;
}

function timestampAnswers(q, ctx) {
    if (!/^\d{10}$|^\d{13}$/.test(q))
        return null;
    const ms = q.length === 13 ? Number(q) : Number(q) * 1000;
    if (ms < Date.UTC(2001, 0, 1) || ms >= Date.UTC(2040, 0, 1))
        return null;
    const id = ctx.tz?.local;
    const w = id ? wallOf(ctx, id, ms) : null;
    if (!w)
        return [];
    const iso = new Date(ms).toISOString().replace('.000Z', 'Z');
    return [row(`${fmtDay(w)}, ${w.y}, ${fmtClock(w, true)}`, `Unix time → local (${abbrOf(w)}) · ${iso}`,
        {icon: ICON.date})];
}

// ---------------------------------------------------------------- lookups

// IATA -> [ICAO, name]; deliberately excludes codes that collide with common
// tokens (MP/mp3, A3/a320, AK/ak47, MM, FM, MS, PS, TV ...).
const AIRLINES = {
    AA: ['AAL', 'American'], DL: ['DAL', 'Delta'], UA: ['UAL', 'United'], WN: ['SWA', 'Southwest'],
    AS: ['ASA', 'Alaska'], B6: ['JBU', 'JetBlue'], NK: ['NKS', 'Spirit'], F9: ['FFT', 'Frontier'],
    HA: ['HAL', 'Hawaiian'], G4: ['AAY', 'Allegiant'], SY: ['SCX', 'Sun Country'], AC: ['ACA', 'Air Canada'],
    WS: ['WJA', 'WestJet'], AM: ['AMX', 'Aeroméxico'], Y4: ['VOI', 'Volaris'], CM: ['CMP', 'Copa'],
    AV: ['AVA', 'Avianca'], LA: ['LAN', 'LATAM'], G3: ['GLO', 'Gol'], AD: ['AZU', 'Azul'],
    BA: ['BAW', 'British Airways'], VS: ['VIR', 'Virgin Atlantic'], AF: ['AFR', 'Air France'], KL: ['KLM', 'KLM'],
    LH: ['DLH', 'Lufthansa'], LX: ['SWR', 'SWISS'], OS: ['AUA', 'Austrian'], SN: ['BEL', 'Brussels Airlines'],
    IB: ['IBE', 'Iberia'], AY: ['FIN', 'Finnair'], SK: ['SAS', 'SAS'], EI: ['EIN', 'Aer Lingus'],
    TP: ['TAP', 'TAP Air Portugal'], AZ: ['ITY', 'ITA Airways'], FR: ['RYR', 'Ryanair'], U2: ['EZY', 'easyJet'],
    W6: ['WZZ', 'Wizz Air'], VY: ['VLG', 'Vueling'], DY: ['NOZ', 'Norwegian'], TK: ['THY', 'Turkish Airlines'],
    EK: ['UAE', 'Emirates'], QR: ['QTR', 'Qatar Airways'], EY: ['ETD', 'Etihad'], SV: ['SVA', 'Saudia'],
    LY: ['ELY', 'El Al'], ET: ['ETH', 'Ethiopian'], KQ: ['KQA', 'Kenya Airways'], SA: ['SAA', 'South African'],
    AI: ['AIC', 'Air India'], '6E': ['IGO', 'IndiGo'], SQ: ['SIA', 'Singapore Airlines'], TR: ['TGW', 'Scoot'],
    CX: ['CPA', 'Cathay Pacific'], UO: ['HKE', 'HK Express'], CA: ['CCA', 'Air China'], MU: ['CES', 'China Eastern'],
    CZ: ['CSN', 'China Southern'], HU: ['CHH', 'Hainan Airlines'], '3U': ['CSC', 'Sichuan Airlines'],
    ZH: ['CSZ', 'Shenzhen Airlines'], MF: ['CXA', 'Xiamen Airlines'], HO: ['DKH', 'Juneyao'], '9C': ['CQH', 'Spring Airlines'],
    CI: ['CAL', 'China Airlines'], BR: ['EVA', 'EVA Air'], JX: ['SJX', 'STARLUX'], NH: ['ANA', 'ANA'],
    JL: ['JAL', 'Japan Airlines'], KE: ['KAL', 'Korean Air'], OZ: ['AAR', 'Asiana'], '7C': ['JJA', 'Jeju Air'],
    TG: ['THA', 'Thai Airways'], VN: ['HVN', 'Vietnam Airlines'], VJ: ['VJC', 'VietJet'], PR: ['PAL', 'Philippine Airlines'],
    '5J': ['CEB', 'Cebu Pacific'], MH: ['MAS', 'Malaysia Airlines'], GA: ['GIA', 'Garuda'], QF: ['QFA', 'Qantas'],
    JQ: ['JST', 'Jetstar'], VA: ['VOZ', 'Virgin Australia'], NZ: ['ANZ', 'Air New Zealand'], FJ: ['FJI', 'Fiji Airways'],
};

function flightAnswers(q, ctx) {
    const m = q.match(/^([a-z0-9]{2})(\s?)(\d{1,4})$/i);
    if (!m || !/[a-z]/i.test(m[1]))
        return null;
    const code = m[1].toUpperCase();
    const al = AIRLINES[code];
    if (!al)
        return null;
    const lower = m[1] !== code;
    if (lower && !m[2] && (m[3].length < 2 || /^(19|20)\d\d$/.test(m[3])))
        return null; // "ac3", "vs2022"
    const num = String(Number(m[3]));
    const flight = `${code}${num}`;
    const label = `${code} ${num}`;
    const google = `https://www.google.com/search?q=${encodeURIComponent(label)}`;
    const aware = row(`Track ${label} on FlightAware`, `${al[1]} · map and history`,
        {icon: ICON.web, url: `https://www.flightaware.com/live/flight/${al[0]}${num}`});
    let note = '';
    if (ctx.flightLookup) {
        // inline status card (AeroDataBox); services decides whether a call is allowed
        const st = ctx.data?.(`flight:${flight}`);
        if (st === undefined)
            return {pending: `flight:${flight}`};
        if (st && !st.error && !st.notFound) {
            const t = todayOf(ctx);
            const todayStr = `${t.y}-${String(t.mo + 1).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
            const cards = flightCards(st, {query: label, now: ctx.now ?? Date.now(), todayStr});
            if (cards.length) {
                let stale = '';
                if (st.stale) {
                    const w = ctx.tz && st.fetchedAt ? wallOf(ctx, ctx.tz.local, st.fetchedAt) : null;
                    stale = ` · as of ${w ? fmtClock(w) : 'earlier'}${st.reason ? ` (${st.reason})` : ''}`;
                }
                const rows = cards.map(c => row(c.title, c.desc + stale, {icon: ICON.flight, url: google}));
                if (rows.length === 1)
                    rows.push(aware);
                rows.push(row('Flight data by AeroDataBox', 'aerodatabox.com', {icon: ICON.web, url: 'https://aerodatabox.com'}));
                return rows.slice(0, 3);
            }
            note = 'No flight found today';
        } else {
            note = st?.notFound ? 'No flight found today' : (st?.error || 'flight status unavailable');
        }
    }
    const rows = [];
    if (!ctx.flightLookup) {
        // no key yet: offer the guided first-run setup (extension.js routes the action)
        rows.push(row('Sign in free to show flight status', 'One-time setup · free AeroDataBox plan',
            {icon: 'dialog-password-symbolic', action: 'flight-setup', flight, label, query: q, copy: null}));
    }
    rows.push(row(`Flight ${label}: live status`, `${note ? `${note} · ` : ''}${al[1]} · Google flight card`,
        {icon: ICON.flight, url: google}));
    rows.push(aware);
    return rows;
}

const CARRIERS = {
    ups: ['UPS', n => `https://www.ups.com/track?tracknum=${n}`],
    usps: ['USPS', n => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`],
    fedex: ['FedEx', n => `https://www.fedex.com/fedextrack/?trknbr=${n}`],
};

function trackRow(carrier, n) {
    const [name, url] = CARRIERS[carrier];
    return [row(`Track ${name} package ${n}`, `${name} tracking`, {icon: ICON.package, url: url(n)})];
}

function packageAnswers(q) {
    let m = q.match(/^(ups|usps|fedex)\s+([0-9a-z]{8,34})$/i);
    if (m)
        return trackRow(m[1].toLowerCase(), m[2].toUpperCase());
    if (/^1z[0-9a-z]{16}$/i.test(q))
        return trackRow('ups', q.toUpperCase());
    if (/^9[2-5]\d{18,20}$/.test(q))
        return trackRow('usps', q);
    if (/^\d{12}$|^\d{15}$/.test(q))
        return trackRow('fedex', q);
    return null;
}

const WMO = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
    82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm',
    96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};
function wmoIcon(c) {
    if (c === 0 || c === 1)
        return 'weather-clear-symbolic';
    if (c === 2)
        return 'weather-few-clouds-symbolic';
    if (c === 3)
        return 'weather-overcast-symbolic';
    if (c === 45 || c === 48)
        return 'weather-fog-symbolic';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86)
        return 'weather-snow-symbolic';
    if (c >= 95)
        return 'weather-storm-symbolic';
    return 'weather-showers-symbolic';
}

/** Default weather city when none is configured: the system time zone's city
 *  (America/New_York -> "New York"), so shipped copies carry no personal city. */
export function tzCity(id) {
    const c = String(id ?? '').split('/').pop().replace(/_/g, ' ');
    return /^[A-Za-z][A-Za-z .'-]+$/.test(c) && !/^(UTC|GMT|UCT|Zulu|Universal|Local)/i.test(c) ? c : '';
}

function weatherAnswers(q, ctx) {
    const m = q.match(/^weather(?:\s+(?:in|for|at)?\s*(.*?))?\s*\??$/i);
    if (!m)
        return null;
    const city = (m[1] || ctx.config?.weatherCity || tzCity(ctx.tz?.local)).trim();
    if (city.length < 2)
        return [];
    const key = `weather:${city.toLowerCase()}`;
    const w = ctx.data?.(key);
    if (w === undefined)
        return {pending: key};
    const url = `https://www.google.com/search?q=${encodeURIComponent(`weather ${w?.name ?? city}`)}`;
    if (!w || w.error || w.notFound) {
        return [row(`Weather for ${city}`, w?.notFound ? 'Place not found · search the web' : 'Weather service unavailable · search the web',
            {icon: 'weather-few-clouds-symbolic', url})];
    }
    const f = c => Math.round(c * 9 / 5 + 32);
    const desc = WMO[w.code] ?? 'weather';
    const title = `${Math.round(w.tempC)} °C / ${f(w.tempC)} °F, ${desc} · H ${Math.round(w.hiC)} L ${Math.round(w.loC)}`;
    return [row(title, `Weather in ${w.name}${w.country ? `, ${w.country}` : ''} · Open-Meteo`,
        {icon: wmoIcon(w.code), url})];
}

function defineAnswers(q, ctx) {
    const m = q.match(/^(?:define|definition of|meaning of)\s+([a-z][a-z' -]{0,40}?)\s*\??$/i);
    if (!m)
        return null;
    const word = m[1].trim().toLowerCase();
    if (word.length < 2)
        return [];
    const key = `define:${word}`;
    const d = ctx.data?.(key);
    if (d === undefined)
        return {pending: key};
    const web = `https://www.google.com/search?q=${encodeURIComponent(`define ${word}`)}`;
    if (!d || d.error || d.notFound) {
        return [row(`Look up “${word}”`, d?.notFound ? 'No dictionary entry · search the web' : 'Dictionary unavailable · search the web',
            {icon: ICON.dict, url: web})];
    }
    let def = d.definition ?? '';
    if (def.length > 140)
        def = `${def.slice(0, 137).replace(/\s+\S*$/, '')}…`;
    return [row(def, `${d.word}${d.phonetic ? ` ${d.phonetic}` : ''}${d.pos ? ` (${d.pos})` : ''} · Free Dictionary`,
        {icon: ICON.dict, url: d.url || `https://en.wiktionary.org/wiki/${encodeURIComponent(d.word ?? word)}`})];
}

// ------------------------------------------------------------------ main

const KEYWORD_RE = /^(?:time\s|now\s|current time|weather\b|define\s|definition of\s|meaning of\s|how many days|days?\s|today|tomorrow|yesterday|tmr\b|#|rgba?\(|ups\s|usps\s|fedex\s)/i;
const QUICK_RE = /[0-9$¥￥€£₩₹]/;

export function parse(query, ctx = {}) {
    if (typeof query !== 'string')
        return [];
    const q = query.trim().replace(/\s+/g, ' ');
    if (q.length < 2 || q.length > 120)
        return [];
    if (!QUICK_RE.test(q) && !KEYWORD_RE.test(q) && !/\stime$/i.test(q))
        return [];

    const steps = [
        () => colorAnswers(q),
        () => baseAnswers(q),
        () => packageAnswers(q),
        () => weatherAnswers(q, ctx),
        () => defineAnswers(q, ctx),
        () => timeAnswers(q, ctx),
        () => dateAnswers(q, ctx),
        () => timestampAnswers(q, ctx),
        () => flightAnswers(q, ctx),
        () => currencyAnswers(q, ctx),
        () => unitAnswers(q),
    ];
    for (const step of steps) {
        const r = step();
        if (r === null || r === undefined)
            continue;
        if (!Array.isArray(r))
            return r; // {pending}
        if (r.length)
            return r.slice(0, MAX_ROWS);
    }
    return [];
}
