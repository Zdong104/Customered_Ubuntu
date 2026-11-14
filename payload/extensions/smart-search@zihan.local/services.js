/**
 * Network / cache / config glue for the Quick Answers provider.
 *
 * Everything here is asynchronous except two tiny reads at enable time
 * (config.json). The parser asks for data through ctx.data(key):
 *   undefined     -> not cached (or expired): the provider calls fetch(key)
 *   {error}       -> last fetch failed (kept 60 s so typing does not hammer)
 *   anything else -> the cached payload
 *
 * Keys: 'rates' (frankfurter, 12 h, stale copy served while refreshing,
 * persisted to ~/.cache/smart-search/rates.json), 'weather:<city>'
 * (Open-Meteo, 15 min), 'define:<word>' (dictionaryapi.dev, 24 h),
 * 'flight:<IATA+num>' (AeroDataBox via RapidAPI, 5 min, see _fetchFlight).
 *
 * AeroDataBox key: ~/.config/smart-search/aerodatabox.key (one line, chmod
 * 600), else config.json flightStatus.apiKey. Both files are watched with a
 * Gio.FileMonitor, so adding the key takes effect without re-enabling.
 * Free plan is ~200 calls/month: every HTTP call is counted in
 * ~/.cache/smart-search/aerodatabox-usage.json and lookups stop at 190.
 *
 * Tests inject {httpGet(url, headers) -> Promise<{status, json}>, now(),
 * configDir, cacheDir, tz, monitorConfig: false}.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {makeTz} from './tzinfo.js';
import {needsTomorrow} from './flightCard.js';
import {checkKeyFormat, verifyOutcome} from './keySetup.js';
import {tzCity} from './parser.js';

const RATES_URL = 'https://api.frankfurter.dev/v1/latest?from=USD';
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const TTL = {rates: 12 * HOUR, weather: 15 * MINUTE, define: 24 * HOUR, flight: 5 * MINUTE};
const ADB_HOST = 'aerodatabox.p.rapidapi.com';
export const FLIGHT_QUOTA = 190;
const ERROR_TTL = 60 * 1000;
const REQUEST_TIMEOUT_S = 5;
const HARD_TIMEOUT_MS = 7000;
const MAX_ENTRIES = 300;

const kindOf = key => key.split(':')[0];

/** An error that carries a user-facing reason and how long to remember it. */
function flightError(reason, ttl) {
    const e = new Error(reason);
    e.reason = reason;
    e.ttl = ttl;
    return e;
}

export class Services {
    constructor(opts = {}) {
        this._cache = new Map();      // key -> {data, time, error, ttl, retryAt}
        this._flightGood = new Map(); // flight key -> last data with legs (stale fallback)
        this._inflight = new Map();   // key -> Promise
        this._requests = new Set();   // {cancellable, timeoutId}
        this._config = {};
        this._flightKey = '';
        this._usage = {month: '', calls: 0};
        this._now = opts.now ?? (() => Date.now());
        this._httpGet = opts.httpGet ?? null;
        this._fixedTz = opts.tz ?? null;
        this._tz = this._fixedTz ?? makeTz();
        this._tzTime = this._now();
        this._monitorConfig = opts.monitorConfig ?? true;
        this._monitor = null;
        this._monitorId = 0;
        this._reloadId = 0;
        this._destroyed = false;
        this._session = this._httpGet ? null : new Soup.Session({
            timeout: REQUEST_TIMEOUT_S,
            idle_timeout: 30,
            user_agent: 'smart-search-gnome-extension/1',
        });
        this._configDir = opts.configDir ?? GLib.build_filenamev([GLib.get_user_config_dir(), 'smart-search']);
        this._cacheDir = opts.cacheDir ?? GLib.build_filenamev([GLib.get_user_cache_dir(), 'smart-search']);
        this._ratesFile = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, 'rates.json']));
        this._usageFile = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, 'aerodatabox-usage.json']));
        this._ready = Promise.resolve();
    }

    /** Returns a promise that resolves once the on-disk caches are loaded. */
    start() {
        this._loadConfig();
        if (this._monitorConfig)
            this._watchConfig();
        this._ready = Promise.all([this._loadRatesCache(), this._loadUsage()]);
        return this._ready;
    }

    destroy() {
        this._destroyed = true;
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        this._monitor = null;
        for (const req of this._requests) {
            if (req.timeoutId)
                GLib.source_remove(req.timeoutId);
            req.timeoutId = 0;
            req.cancellable.cancel();
        }
        this._requests.clear();
        this._session?.abort();
        this._session = null;
        this._cache.clear();
        this._flightGood.clear();
        this._flightKey = '';
        this._inflight.clear();
        this._tz = null;
    }

    get config() {
        return this._config;
    }

    get hasFlightKey() {
        return !!this._flightKey;
    }

    ctx() {
        if (!this._fixedTz && this._now() - this._tzTime > 60 * 1000) {
            // pick up a system time-zone change without re-enabling
            this._tz = makeTz();
            this._tzTime = this._now();
        }
        return {
            now: this._now(),
            tz: this._tz,
            config: this._config,
            flightLookup: !!this._flightKey,
            data: key => this._get(key),
        };
    }

    isInflight(key) {
        return this._inflight.has(key);
    }

    /** Pause before a network lookup. Flights cost quota: wait until typing has clearly stopped. */
    debounceFor(key) {
        if (kindOf(key) !== 'flight')
            return 250;
        const digits = key.replace(/^flight:[A-Z0-9]{2}/, '');
        return digits.length <= 2 ? 1500 : 600;
    }

    _get(key) {
        if (kindOf(key) === 'flight')
            return this._getFlight(key);
        const e = this._cache.get(key);
        if (!e)
            return undefined;
        const now = this._now();
        if (e.data === undefined)
            return now - e.time < ERROR_TTL ? {error: e.error} : undefined;
        const ttl = TTL[kindOf(key)] ?? HOUR;
        if (now - e.time < ttl)
            return e.data;
        if (kindOf(key) === 'rates') {
            // serve stale rates; refresh in the background (throttled)
            if (!this._inflight.has(key) && now >= (e.retryAt ?? 0))
                this.fetch(key).catch(() => {});
            return e.data;
        }
        return undefined;
    }

    _set(key, entry) {
        this._cache.delete(key);
        this._cache.set(key, entry);
        // evict least recently written entries (never the rates)
        for (const k of this._cache.keys()) {
            if (this._cache.size <= MAX_ENTRIES)
                break;
            if (k !== 'rates')
                this._cache.delete(k);
        }
    }

    /** Fetch and cache `key`; resolves when done (never rejects). Deduplicated. */
    fetch(key) {
        if (this._destroyed)
            return Promise.resolve();
        let p = this._inflight.get(key);
        if (p)
            return p;
        p = this._fetchKey(key).then(data => {
            if (this._destroyed)
                return;
            this._set(key, {data, time: this._now()});
            if (key === 'rates')
                this._saveRatesCache(data);
            if (kindOf(key) === 'flight' && data?.items?.length)
                this._flightGood.set(key, data);
        }, err => {
            if (this._destroyed)
                return;
            const old = this._cache.get(key);
            if (old?.data !== undefined && kindOf(key) === 'rates') {
                old.retryAt = this._now() + ERROR_TTL;
            } else {
                const reason = err?.reason ?? (kindOf(key) === 'flight' ? 'lookup failed' : String(err?.message ?? err));
                this._set(key, {data: undefined, error: reason, ttl: err?.ttl ?? ERROR_TTL, time: this._now()});
            }
            if (!(err instanceof GLib.Error && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                console.log(`[smart-search] fetch ${key} failed: ${err?.message ?? err}`);
        }).finally(() => {
            this._inflight.delete(key);
        });
        this._inflight.set(key, p);
        return p;
    }

    _fetchKey(key) {
        const i = key.indexOf(':');
        const kind = i < 0 ? key : key.slice(0, i);
        const arg = i < 0 ? '' : key.slice(i + 1);
        switch (kind) {
        case 'rates':
            return this._fetchRates();
        case 'weather':
            return this._fetchWeather(arg);
        case 'define':
            return this._fetchDefinition(arg);
        case 'flight':
            return this._fetchFlight(arg);
        default:
            return Promise.reject(new Error(`unknown key ${key}`));
        }
    }

    // ------------------------------------------------------------ HTTP

    _getJson(url, headers = {}, {timeoutMs = HARD_TIMEOUT_MS} = {}) {
        if (this._httpGet)
            return this._destroyed ? Promise.reject(new Error('destroyed')) : this._httpGet(url, headers);
        return new Promise((resolve, reject) => {
            if (this._destroyed) {
                reject(new Error('destroyed'));
                return;
            }
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`bad URL ${url}`));
                return;
            }
            msg.request_headers.append('Accept', 'application/json');
            for (const [k, v] of Object.entries(headers))
                msg.request_headers.append(k, v);
            const req = {cancellable: new Gio.Cancellable(), timeoutId: 0};
            req.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                req.timeoutId = 0;
                req.cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
            this._requests.add(req);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, req.cancellable, (session, res) => {
                if (req.timeoutId)
                    GLib.source_remove(req.timeoutId);
                req.timeoutId = 0;
                this._requests.delete(req);
                try {
                    const bytes = session.send_and_read_finish(res);
                    const raw = bytes?.get_data();
                    const text = raw ? new TextDecoder().decode(raw) : '';
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        json = null;
                    }
                    resolve({status: msg.get_status(), json});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    async _fetchRates() {
        const r = await this._getJson(RATES_URL);
        if (r.status !== 200 || !r.json?.rates)
            throw new Error(`rates HTTP ${r.status}`);
        return {date: r.json.date, rates: {...r.json.rates, USD: 1}};
    }

    async _fetchWeather(city) {
        const name = city || this._config.weatherCity || tzCity(this._tz?.local);
        const g = await this._getJson(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
        if (g.status !== 200)
            throw new Error(`geocoding HTTP ${g.status}`);
        const p = g.json?.results?.[0];
        if (!p)
            return {notFound: true};
        const f = await this._getJson(
            `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}` +
            '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min' +
            '&timezone=auto&forecast_days=1');
        const cur = f.json?.current, daily = f.json?.daily;
        if (f.status !== 200 || !cur || !daily)
            throw new Error(`forecast HTTP ${f.status}`);
        return {
            name: p.name,
            country: p.country_code ?? '',
            tempC: cur.temperature_2m,
            code: cur.weather_code,
            hiC: daily.temperature_2m_max?.[0],
            loC: daily.temperature_2m_min?.[0],
        };
    }

    async _fetchDefinition(word) {
        const r = await this._getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
        if (r.status === 404)
            return {notFound: true};
        if (r.status !== 200 || !Array.isArray(r.json) || !r.json.length)
            throw new Error(`dictionary HTTP ${r.status}`);
        const e = r.json[0];
        const meaning = e.meanings?.find(m => m.definitions?.length) ?? e.meanings?.[0];
        const definition = meaning?.definitions?.[0]?.definition;
        if (!definition)
            return {notFound: true};
        return {
            word: e.word ?? word,
            phonetic: e.phonetic ?? e.phonetics?.find(p => p.text)?.text ?? '',
            pos: meaning.partOfSpeech ?? '',
            definition,
            url: e.sourceUrls?.[0] ?? '',
        };
    }

    // ---------------------------------------------------------- flights

    _getFlight(key) {
        const now = this._now();
        const today = this._localDate(now);
        const e = this._cache.get(key);
        const good = this._flightGood.get(key);
        const goodToday = good?.day === today ? good : null;
        const stale = reason => (goodToday ? {...goodToday, stale: true, reason} : {error: reason});
        if (e?.data !== undefined && e.data?.day === today && now - e.time < TTL.flight)
            return e.data;
        if (e && e.data === undefined && now - e.time < (e.ttl ?? ERROR_TTL))
            return stale(e.error);
        if (!this._flightKey)
            return stale('no API key');
        if (this._quotaLeft() <= 0)
            return stale('monthly quota reached');
        return undefined;
    }

    /**
     * Today's legs; tomorrow's too when today has none or all of them landed
     * more than 2 h ago (one extra call, only then).
     */
    async _fetchFlight(flight) {
        await this._ready;
        if (!this._flightKey)
            throw flightError('no API key', ERROR_TTL);
        const now = this._now();
        const today = this._localDate(now);
        let items = await this._adbCall(flight, today);
        if (needsTomorrow(items, flight, now) && this._quotaLeft() > 0) {
            try {
                items = items.concat(await this._adbCall(flight, this._localDate(now, 1)));
            } catch (e) {
                if (!items.length)
                    throw e;
            }
        }
        return {flight, day: today, items, fetchedAt: now, notFound: items.length === 0};
    }

    async _adbCall(flight, date) {
        if (this._quotaLeft() <= 0)
            throw flightError('monthly quota reached', TTL.flight);
        this._countCall();
        const url = `https://${ADB_HOST}/flights/number/${encodeURIComponent(flight)}/${date}` +
            '?withAircraftImage=false&withLocation=false';
        let r;
        try {
            r = await this._getJson(url, {'X-RapidAPI-Key': this._flightKey, 'X-RapidAPI-Host': ADB_HOST});
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw flightError('lookup failed (network)', ERROR_TTL);
        }
        if (r.status === 200)
            return Array.isArray(r.json) ? r.json : [];
        if (r.status === 204 || r.status === 404)
            return [];
        if (r.status === 401 || r.status === 403)
            throw flightError(`API key rejected (${r.status})`, 6 * HOUR); // cleared when the key changes
        if (r.status === 429)
            throw flightError('rate limited (429)', 15 * MINUTE);
        throw flightError(`lookup failed (HTTP ${r.status})`, ERROR_TTL);
    }

    /**
     * First-run setup: check the pasted key with ONE real request (the flight
     * the user searched, today), then save it 0600 and seed the cache with
     * the answer. Resolves {ok, message?, requested, rateLimited?}; never
     * rejects. The key is never logged and only travels in the header.
     */
    async verifyAndSaveFlightKey(rawKey, flight) {
        const fmt = checkKeyFormat(rawKey);
        if (!fmt.ok)
            return {ok: false, requested: false, message: fmt.error};
        await this._ready;
        if (this._destroyed)
            return {ok: false, requested: false, message: 'Extension was disabled.'};
        const f = /^[A-Z0-9]{2}\d{1,4}$/.test(flight ?? '') ? flight : 'DL1';
        const now = this._now();
        const today = this._localDate(now);
        this._countCall();
        let r = null;
        try {
            r = await this._getJson(
                `https://${ADB_HOST}/flights/number/${encodeURIComponent(f)}/${today}` +
                '?withAircraftImage=false&withLocation=false',
                {'X-RapidAPI-Key': fmt.key, 'X-RapidAPI-Host': ADB_HOST}, {timeoutMs: 10000});
        } catch {
            r = null;
        }
        if (this._destroyed)
            return {ok: false, requested: true, message: 'Extension was disabled.'};
        const out = verifyOutcome(r ? r.status : 'network');
        if (!out.valid)
            return {ok: false, requested: true, message: out.message};
        try {
            await this._saveFlightKey(fmt.key);
        } catch (e) {
            return {ok: false, requested: true, message: `Couldn't save the key: ${e.message}`};
        }
        this._flightKey = fmt.key;
        for (const ck of [...this._cache.keys()]) {
            if (kindOf(ck) === 'flight')
                this._cache.delete(ck);
        }
        if (!out.rateLimited) {
            const items = r.status === 200 && Array.isArray(r.json) ? r.json : [];
            // seed only when today's answer is complete (no tomorrow lookup needed)
            if (!needsTomorrow(items, f, now)) {
                const data = {flight: f, day: today, items, fetchedAt: now, notFound: false};
                this._set(`flight:${f}`, {data, time: now});
                this._flightGood.set(`flight:${f}`, data);
            }
        }
        return {ok: true, requested: true, rateLimited: !!out.rateLimited};
    }

    /** Atomic write (temp file + rename), created 0600 (Gio PRIVATE). */
    _saveFlightKey(key) {
        return new Promise((resolve, reject) => {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([this._configDir, 'aerodatabox.key']));
            const bytes = new GLib.Bytes(new TextEncoder().encode(`${key}\n`));
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _localDate(ms, addDays = 0) {
        let dt = GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000));
        const tz = this._tz?.local && this._tz.local !== 'UTC'
            ? GLib.TimeZone.new_identifier(this._tz.local) : GLib.TimeZone.new_utc();
        dt = dt.to_timezone(tz ?? GLib.TimeZone.new_local());
        if (addDays)
            dt = dt.add_days(addDays);
        return dt.format('%Y-%m-%d');
    }

    _quotaLeft() {
        const month = this._localDate(this._now()).slice(0, 7);
        if (this._usage.month !== month)
            this._usage = {month, calls: 0};
        return FLIGHT_QUOTA - this._usage.calls;
    }

    get flightCallsThisMonth() {
        this._quotaLeft();
        return this._usage.calls;
    }

    _countCall() {
        this._quotaLeft();
        this._usage.calls++;
        this._writeJson(this._usageFile, this._usage);
    }

    _loadUsage() {
        return this._readJson(this._usageFile).then(j => {
            if (j && typeof j.month === 'string' && Number.isFinite(j.calls)) {
                // keep calls counted before the file finished loading
                const pending = this._usage.month === j.month ? this._usage.calls : 0;
                this._usage = {month: j.month, calls: j.calls + pending};
            }
        });
    }

    // ------------------------------------------------------ config/cache

    /**
     * config.json + aerodatabox.key. Tiny synchronous reads: at enable time
     * and from the (debounced) file-monitor callback, never on the search path.
     */
    _loadConfig() {
        const read = name => {
            const path = GLib.build_filenamev([this._configDir, name]);
            try {
                const [ok, bytes] = GLib.file_get_contents(path);
                return ok ? {path, text: new TextDecoder().decode(bytes)} : null;
            } catch (e) {
                if (!(e instanceof GLib.Error && e.matches(GLib.FileError, GLib.FileError.NOENT)))
                    console.log(`[smart-search] cannot read ${path}: ${e.message}`);
                return null;
            }
        };
        let cfg = {};
        const c = read('config.json');
        if (c) {
            try {
                const j = JSON.parse(c.text);
                if (j && typeof j === 'object')
                    cfg = j;
            } catch (e) {
                console.log(`[smart-search] ignoring ${c.path}: ${e.message}`);
            }
        }
        let key = '';
        const k = read('aerodatabox.key');
        if (k) {
            key = k.text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
            try {
                const info = Gio.File.new_for_path(k.path).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
                if (info.get_attribute_uint32('unix::mode') & 0o077)
                    console.log(`[smart-search] ${k.path} is readable by others; chmod 600 it`);
            } catch {
            }
        }
        const fs = cfg.flightStatus;
        if (!key && fs && (!fs.provider || fs.provider === 'aerodatabox') && typeof fs.apiKey === 'string')
            key = fs.apiKey.trim();
        if (key !== this._flightKey) {
            // a new key gets a fresh start: forget remembered errors (e.g. 401)
            for (const ck of [...this._cache.keys()]) {
                if (kindOf(ck) === 'flight')
                    this._cache.delete(ck);
            }
        }
        this._config = cfg;
        this._flightKey = key;
    }

    _watchConfig() {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o700);
            const dir = Gio.File.new_for_path(this._configDir);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_m, file, other) => {
                const names = [file?.get_basename(), other?.get_basename()];
                if (!names.some(n => n === 'config.json' || n === 'aerodatabox.key'))
                    return;
                if (this._reloadId)
                    GLib.source_remove(this._reloadId);
                this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    this._reloadId = 0;
                    if (!this._destroyed)
                        this._loadConfig();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.log(`[smart-search] cannot watch ${this._configDir}: ${e.message}`);
        }
    }

    _readJson(file) {
        return new Promise(resolve => {
            const req = {cancellable: new Gio.Cancellable(), timeoutId: 0};
            this._requests.add(req);
            file.load_contents_async(req.cancellable, (f, res) => {
                this._requests.delete(req);
                try {
                    const [, bytes] = f.load_contents_finish(res);
                    resolve(this._destroyed ? null : JSON.parse(new TextDecoder().decode(bytes)));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    _writeJson(file, obj) {
        try {
            GLib.mkdir_with_parents(this._cacheDir, 0o700);
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(obj)));
            const req = {cancellable: new Gio.Cancellable(), timeoutId: 0};
            this._requests.add(req);
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, req.cancellable, (f, res) => {
                    this._requests.delete(req);
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        if (!this._destroyed)
                            console.log(`[smart-search] could not write ${f.get_path()}: ${e.message}`);
                    }
                });
        } catch (e) {
            console.log(`[smart-search] could not write ${file.get_path()}: ${e.message}`);
        }
    }

    _loadRatesCache() {
        return this._readJson(this._ratesFile).then(j => {
            if (j?.rates && j.date && typeof j.fetched === 'number' && !this._cache.has('rates'))
                this._cache.set('rates', {data: {date: j.date, rates: j.rates}, time: j.fetched});
        });
    }

    _saveRatesCache(data) {
        this._writeJson(this._ratesFile, {...data, fetched: this._now()});
    }
}
