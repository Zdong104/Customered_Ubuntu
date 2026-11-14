/**
 * AeroDataBox flight-status logic, pure JS (no gi:// imports) so both the
 * parser (card formatting) and services.js (which dates to fetch) share it
 * and it can be unit tested with plain gjs.
 *
 * Input items are the array returned by
 *   GET /flights/number/{flight}/{YYYY-MM-DD}
 * (one item per leg, plus duplicates for codeshares).
 */

const HOUR = 3600 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const STATUS_TEXT = {
    Unknown: 'Scheduled',
    Expected: 'Scheduled',
    CheckIn: 'Check-in',
    Boarding: 'Boarding',
    GateClosed: 'Gate closed',
    Departed: 'Departed',
    EnRoute: 'In flight',
    Delayed: 'Delayed',
    Approaching: 'Landing soon',
    Arrived: 'Landed',
    Canceled: 'Canceled',
    CanceledUncertain: 'Possibly canceled',
    Diverted: 'Diverted',
};
const PRE_DEPARTURE = new Set(['Unknown', 'Expected', 'CheckIn', 'Boarding', 'GateClosed', 'Delayed']);
const ALERT = new Set(['Canceled', 'CanceledUncertain', 'Diverted']);

/** "2026-11-14 12:07Z" | "2026-11-14T12:07:00Z" -> epoch ms | null */
function parseUtc(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z$/.exec(s ?? '');
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) : null;
}

/** "2026-11-14 07:07-05:00" -> {date: '2026-11-14', h: 7, mi: 7} | null */
function parseLocal(s) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(s ?? '');
    return m ? {date: m[1], h: +m[2], mi: +m[3]} : null;
}

function moment(t) {
    if (!t)
        return null;
    const utc = parseUtc(t.utc);
    const local = parseLocal(t.local);
    return utc === null && !local ? null : {utc, local};
}

const normNum = s => String(s ?? '').replace(/\s+/g, '').toUpperCase();

function side(s) {
    return {
        iata: s?.airport?.iata || s?.airport?.icao || '???',
        city: s?.airport?.municipalityName || s?.airport?.name || '',
        sched: moment(s?.scheduledTime),
        rev: moment(s?.revisedTime),
        runway: moment(s?.runwayTime),
        pred: moment(s?.predictedTime),
        terminal: s?.terminal || null,
        gate: s?.gate || null,
        belt: s?.baggageBelt || null,
    };
}

export function normalizeLeg(item) {
    return {
        number: String(item?.number ?? '').replace(/\s+/g, ' ').trim(),
        status: item?.status ?? 'Unknown',
        codeshare: item?.codeshareStatus ?? 'Unknown',
        airline: item?.airline?.name ?? '',
        dep: side(item?.departure),
        arr: side(item?.arrival),
    };
}

const startOf = l => l.dep.rev?.utc ?? l.dep.sched?.utc ?? l.dep.runway?.utc ?? null;
const endOf = l => l.arr.runway?.utc ?? l.arr.rev?.utc ?? l.arr.sched?.utc ?? startOf(l);

/**
 * Normalize, drop unusable items, collapse codeshare duplicates (same route
 * and scheduled departure), sort by departure. Within a duplicate group the
 * operating carrier's item wins (the card is still labelled with the queried
 * number and says "operated as ..."), then the item matching the query.
 */
export function dedupeLegs(items, query) {
    const q = normNum(query);
    const groups = new Map();
    for (const raw of Array.isArray(items) ? items : []) {
        const l = normalizeLeg(raw);
        if (startOf(l) === null && endOf(l) === null)
            continue;
        const k = `${l.dep.iata}>${l.arr.iata}@${l.dep.sched?.utc ?? l.dep.sched?.local?.date ?? startOf(l)}`;
        // operator first (it carries the gate/terminal data), then the queried number
        l.score = (l.codeshare === 'IsOperator' ? 2 : 0) + (normNum(l.number) === q ? 1 : 0);
        const prev = groups.get(k);
        if (!prev || l.score > prev.score)
            groups.set(k, l);
    }
    return [...groups.values()].sort((a, b) => (startOf(a) ?? 0) - (startOf(b) ?? 0));
}

/** True when tomorrow's date must be fetched too: no usable leg today, or all landed > 2 h ago. */
export function needsTomorrow(items, query, now) {
    const legs = dedupeLegs(items, query);
    return legs.length === 0 || legs.every(l => (endOf(l) ?? 0) + 2 * HOUR < now);
}

/** Legs to show: the leg nearest to now, plus its neighbour if it is part of a multi-leg journey. */
export function pickLegs(legs, now) {
    if (!legs.length)
        return [];
    const dist = l => {
        const s = startOf(l) ?? endOf(l), e = endOf(l) ?? s;
        return now < s ? s - now : now > e ? now - e : 0;
    };
    // journeys: consecutive legs where B departs from where A landed, within a day
    const journeyOf = new Map();
    let jid = 0;
    legs.forEach((l, i) => {
        const p = legs[i - 1];
        const connects = p && p.arr.iata === l.dep.iata &&
            (startOf(l) ?? 0) - (endOf(p) ?? 0) >= -HOUR && (startOf(l) ?? 0) - (endOf(p) ?? 0) <= 24 * HOUR;
        if (!connects)
            jid++;
        journeyOf.set(l, jid);
    });
    // legs still relevant (not landed more than 2 h ago) win over finished ones
    const live = legs.filter(l => (endOf(l) ?? 0) + 2 * HOUR >= now);
    const pool = live.length ? live : legs;
    let best = pool[0];
    for (const l of pool) {
        if (dist(l) < dist(best))
            best = l;
    }
    const journey = legs.filter(l => journeyOf.get(l) === journeyOf.get(best));
    if (journey.length < 2)
        return [best];
    const i = journey.indexOf(best);
    return i + 1 < journey.length ? [best, journey[i + 1]] : [journey[i - 1], best];
}

function clock(local) {
    const h12 = local.h % 12 === 0 ? 12 : local.h % 12;
    return `${h12}:${String(local.mi).padStart(2, '0')} ${local.h < 12 ? 'AM' : 'PM'}`;
}

function shownTime(s, todayStr) {
    const sched = s.sched, rev = s.rev;
    const useRev = rev?.local && (!sched?.local || rev.utc !== sched.utc);
    const t = useRev ? rev : sched ?? rev;
    if (!t?.local)
        return null;
    let out = clock(t.local);
    if (t.local.date !== todayStr) {
        const [, mo, d] = t.local.date.split('-').map(Number);
        out += ` (${MON[mo - 1]} ${d})`;
    }
    return out;
}

function delayMin(s) {
    const actual = s.rev?.utc ?? s.runway?.utc;
    if (actual === null || actual === undefined || s.sched?.utc === null || s.sched?.utc === undefined)
        return null;
    return Math.round((actual - s.sched.utc) / 60000);
}

function fmtMin(m) {
    const a = Math.abs(m);
    return a >= 60 ? `${Math.floor(a / 60)} h${a % 60 ? ` ${a % 60} min` : ''}` : `${a} min`;
}

function terminalText(t) {
    return /^\d/.test(t) ? `T${t}` : `T ${t}`;
}

function endText(prefix, s, withBelt) {
    const parts = [];
    if (s.terminal)
        parts.push(`${prefix} ${terminalText(s.terminal)}`);
    if (s.gate)
        parts.push(`${parts.length ? '' : `${prefix} `}Gate ${s.gate}`);
    if (withBelt && s.belt)
        parts.push(`${parts.length ? '' : `${prefix} `}Belt ${s.belt}`);
    return parts.join(' · ');
}

/** One card: {title, desc}. */
export function legCard(l, todayStr, queryLabel) {
    const status = STATUS_TEXT[l.status] ?? l.status;
    const dep = shownTime(l.dep, todayStr);
    let arr = shownTime(l.arr, todayStr);
    // Same non-today date on both ends: show it once, after departure.
    const dd = dep?.match(/ \(.+\)$/)?.[0];
    if (dd && arr?.endsWith(dd))
        arr = arr.slice(0, -dd.length);
    const label = queryLabel
        ? queryLabel.toUpperCase().replace(/^([A-Z0-9]{2})\s*(\d{1,4})$/, '$1 $2')
        : l.number;
    // status lives in the desc so the times (and the arrival date) fit the list row
    const title = `${label} · ${l.dep.iata}${dep ? ` ${dep}` : ''} → ${l.arr.iata}${arr ? ` ${arr}` : ''}`;

    const parts = [status];
    const d = endText('Dep', l.dep, false), a = endText('Arr', l.arr, true);
    if (d && a)
        parts.push(`${d} → ${a}`);
    else if (d || a)
        parts.push(d || a);
    if (!ALERT.has(l.status)) {
        const pre = PRE_DEPARTURE.has(l.status);
        const m = pre ? delayMin(l.dep) ?? delayMin(l.arr) : delayMin(l.arr) ?? delayMin(l.dep);
        if (m !== null && Math.abs(m) >= 5)
            parts.push(m > 0 ? `+${fmtMin(m)} late` : `${fmtMin(m)} early`);
        // No airline estimate yet: show AeroDataBox's model prediction, labelled as such.
        else if (m === null && l.arr.pred?.local && l.arr.sched?.utc != null &&
                 Math.abs(l.arr.pred.utc - l.arr.sched.utc) >= 5 * 60000)
            parts.push(`arr. predicted ${clock(l.arr.pred.local)}`);
    }
    if (queryLabel && normNum(l.number) !== normNum(queryLabel) && l.number)
        parts.push(`operated as ${l.number}`);
    // attribution is the separate "Flight data by AeroDataBox" row shown with every card
    return {title, desc: parts.join(' · ')};
}

/** data = {items, fetchedAt, ...} from services; -> 0..2 cards */
export function flightCards(data, {query, now, todayStr}) {
    const legs = pickLegs(dedupeLegs(data?.items, query), now);
    return legs.map(l => legCard(l, todayStr, query));
}
