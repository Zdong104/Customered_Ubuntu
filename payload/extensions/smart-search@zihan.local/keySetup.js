/**
 * First-run AeroDataBox key setup: pure helpers (no gi:// imports) shared by
 * services.js (verification) and setupDialog.js, unit-tested with plain gjs.
 */

export const SIGNUP_URL = 'https://rapid.aerodatabox.com/pricing';

export const MSG = {
    format: "That doesn't look like an API key. Copy the X-RapidAPI-Key value from RapidAPI.",
    401: 'RapidAPI rejected this key. Check you copied X-RapidAPI-Key.',
    403: "This key isn't subscribed to AeroDataBox yet. Choose Basic ($0) and click Subscribe, then try again.",
    network: "Couldn't reach AeroDataBox. Check your connection.",
};

/** Local check before anything is sent: trimmed, >= 30 chars of [A-Za-z0-9_-]. */
export function checkKeyFormat(raw) {
    const key = String(raw ?? '').trim();
    if (key.length < 30 || key.length > 200 || !/^[A-Za-z0-9_-]+$/.test(key))
        return {ok: false, error: MSG.format};
    return {ok: true, key};
}

/**
 * Map the verification request's outcome (HTTP status, or 'network') to
 * {valid, rateLimited?, message?}. 429 means the key works but is throttled.
 */
export function verifyOutcome(status) {
    if (status === 200 || status === 204 || status === 404)
        return {valid: true};
    if (status === 429)
        return {valid: true, rateLimited: true};
    if (status === 401 || status === 403)
        return {valid: false, message: MSG[status]};
    if (status === 'network' || !status)
        return {valid: false, message: MSG.network};
    return {valid: false, message: `AeroDataBox returned an error (HTTP ${status}). Try again in a minute.`};
}
