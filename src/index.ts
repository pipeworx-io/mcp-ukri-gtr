interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * UKRI Gateway to Research (GtR) MCP — every grant awarded by the UK's seven
 * research councils plus Innovate UK: recipient, subject, award value, dates.
 *
 * Keyless. Requires the vendored media-type Accept header and a browser
 * User-Agent. Upstream page size is clamped to [10, 100] by the API itself.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'UKRI Gateway to Research');
}

const BASE = 'https://gtr.ukri.org/gtr/api';
const ACCEPT = 'application/vnd.rcuk.gtr.json-v7';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** GtR rejects s<10 (HTTP 400) and s>100 (HTTP 400). */
const MIN_PAGE = 10;
const MAX_PAGE = 100;

const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * GtR fragments a single institution across dozens of duplicate organisation
 * records; the name-resolution path probes this many candidates for their grant
 * count and keeps the largest.
 */
const ORG_CANDIDATE_PROBES = 20;

const tools: McpToolExport['tools'] = [
  {
    name: 'gtr_search_projects',
    description:
      'Search UK research grants awarded by UKRI — the seven research councils (EPSRC, MRC, BBSRC, NERC, ESRC, AHRC, STFC) plus Innovate UK — by free text over titles and abstracts. Returns each grant reference, project title, funding council, grant category, lead department, award status and funding period, for questions like which UK grants fund a given topic, how many awards a council made in an area, or what a UK research group was funded to do. Narrow by funder name and by Active or Closed status.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free text, e.g. "quantum computing", "antimicrobial resistance", "offshore wind".',
        },
        funder: {
          type: 'string',
          description:
            'Funding body to restrict to, matched exactly against leadFunder: EPSRC, MRC, BBSRC, NERC, ESRC, AHRC, STFC, "Innovate UK", "Horizon Europe Guarantee", "UKRI FLF", "Newton Fund".',
        },
        status: { type: 'string', enum: ['Active', 'Closed'], description: 'Award status.' },
        search_field: {
          type: 'string',
          enum: ['all', 'title', 'abstract', 'grant_ref'],
          description: 'Which field the query text is matched against. Default "all".',
        },
        limit: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
        page: { type: 'number', description: '1-based page of upstream results. Default 1.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gtr_get_project',
    description:
      'Full detail for one UKRI-funded project, looked up by its GtR GUID or by its human grant reference such as EP/T022159/1 or 10045762. Returns the award value in pounds, the lead organisation and its address, the principal investigators, the funding period, the abstract, technical abstract and potential-impact statement, and the research subjects and topics — this is how to answer how much a specific UK grant was worth and who received it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'GtR GUID (e.g. "6C2A6F8E-C726-4AE4-B539-8C54FD60F6BD") or RCUK grant reference (e.g. "EP/T022159/1", "10045762").',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'gtr_search_organisations',
    description:
      'Find UK universities, research institutes and companies that have received UKRI research funding, by institution name. Returns the GtR organisation id, official name, postcode and region — use the id with gtr_organisation_projects to list everything that institution was funded for.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Institution name or fragment, e.g. "imperial college", "rolls-royce".' },
        limit: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
        page: { type: 'number', description: '1-based page. Default 1.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'gtr_organisation_projects',
    description:
      'List the UKRI grants held by one institution, given its GtR organisation id or its name. Returns that institution\'s grant references, project titles, funding councils, departments, statuses and funding periods together with a total award count — the way to see a university\'s or company\'s UK research funding portfolio. Narrow by funding council and by Active or Closed status.',
    inputSchema: {
      type: 'object',
      properties: {
        organisation: {
          type: 'string',
          description:
            'GtR organisation GUID (e.g. "4FC4CBFD-9E7C-4518-BB16-852553236FE1") or an institution name to resolve first.',
        },
        funder: { type: 'string', description: 'Funding body to restrict to, matched against leadFunder.' },
        status: { type: 'string', enum: ['Active', 'Closed'], description: 'Award status.' },
        limit: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
        page: { type: 'number', description: '1-based page. Default 1.' },
      },
      required: ['organisation'],
    },
  },
  {
    name: 'gtr_search_publications',
    description:
      'Search journal articles, books and conference papers that UKRI grant holders reported as outcomes of their funded work. Returns title, authors, journal, publication date, DOI, PubMed id, ISSN and the GtR id of the project that produced it — the way to trace UK public research funding through to what it published.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text over publication titles and abstracts, e.g. "graphene battery".' },
        search_field: {
          type: 'string',
          enum: ['all', 'title', 'abstract'],
          description: 'Which field the query text is matched against. Default "all".',
        },
        limit: { type: 'number', description: 'Results to return, 1-100. Default 10.' },
        page: { type: 'number', description: '1-based page. Default 1.' },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------- HTTP

async function gtr(path: string, params?: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await pwFetch(url.toString(), { headers: { Accept: ACCEPT, 'User-Agent': UA } });
  const body = await res.text();
  if (!res.ok) {
    // GtR returns {"text":"Invalid request: ..."} with the useful part in `text`.
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { text?: string };
      if (j?.text) detail = j.text;
    } catch {
      /* keep raw */
    }
    // A search that matches nothing 404s with "Page requested exceeds maximum
    // available: 0" rather than returning an empty collection. That is a zero-hit
    // result, not an error, so hand back an empty envelope and let the caller
    // produce its own found:false.
    const exceeded = detail.match(/Page requested exceeds maximum available:\s*(\d+)/);
    if (exceeded) {
      return { page: Number(url.searchParams.get('p') ?? 1), totalPages: Number(exceeded[1]), totalSize: 0 };
    }
    throw new Error(`UKRI GtR ${res.status} for ${url.pathname}${url.search}: ${detail}`);
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`UKRI GtR returned non-JSON for ${url.pathname} (${body.slice(0, 120)})`);
  }
}

/** Fetch a linked resource by rel, tolerating upstream failure. */
async function fetchLinked(collection: string, id: string | undefined): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  try {
    return await gtr(`/${collection}/${id}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- helpers

function clampLimit(v: unknown, dflt = 10): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));
}

function clampPage(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** GtR embeds HTML entities in titles and abstracts (`Simulation &amp; Analytics`). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? decodeEntities(v.trim()) : null;
}

/** GtR writes the literal string "Unknown" into empty address fields. */
function addrText(v: unknown): string | null {
  const s = text(v);
  return s && s.toLowerCase() !== 'unknown' ? s : null;
}

/** Epoch millis -> ISO date. GtR sends dates as numbers, often null. */
function isoDate(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const d = new Date(v);
  const s = d.toISOString();
  return s.slice(0, 10);
}

type GtrLink = { href?: unknown; rel?: unknown; start?: unknown; end?: unknown };

function linksOf(obj: Record<string, unknown>): GtrLink[] {
  const links = obj.links as { link?: unknown } | null | undefined;
  const arr = links?.link;
  return Array.isArray(arr) ? (arr as GtrLink[]) : [];
}

function linkByRel(obj: Record<string, unknown>, rel: string): GtrLink | undefined {
  return linksOf(obj).find((l) => l.rel === rel);
}

function linksByRel(obj: Record<string, unknown>, rel: string): GtrLink[] {
  return linksOf(obj).filter((l) => l.rel === rel);
}

/**
 * Pull the trailing GUID out of a link href. Hrefs are `http://` (not https) and
 * occasionally contain a doubled slash (`/gtr/api//outcomes/...`), so never fetch
 * them directly — extract the id and rebuild the URL against BASE.
 */
function idFromHref(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const m = href.match(/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\s*$/);
  return m ? m[1] : undefined;
}

/** The human grant reference (`EP/T022159/1`, `10045762`) lives in identifiers as type RCUK. */
function grantRefs(project: Record<string, unknown>): string[] {
  const ids = project.identifiers as { identifier?: unknown } | null | undefined;
  const arr = ids?.identifier;
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ value?: unknown; type?: unknown }>)
    .filter((i) => typeof i.value === 'string')
    .map((i) => i.value as string);
}

function rcukRef(project: Record<string, unknown>): string | null {
  const ids = project.identifiers as { identifier?: unknown } | null | undefined;
  const arr = ids?.identifier;
  if (!Array.isArray(arr)) return null;
  const hit = (arr as Array<{ value?: unknown; type?: unknown }>).find(
    (i) => i.type === 'RCUK' && typeof i.value === 'string',
  );
  if (hit) return hit.value as string;
  const any = (arr as Array<{ value?: unknown }>).find((i) => typeof i.value === 'string');
  return any ? (any.value as string) : null;
}

function classifications(project: Record<string, unknown>, wrapper: string, inner: string): string[] {
  const w = project[wrapper] as Record<string, unknown> | null | undefined;
  const arr = w?.[inner];
  if (!Array.isArray(arr)) return [];
  return (arr as Array<{ text?: unknown }>)
    .map((x) => (typeof x.text === 'string' ? decodeEntities(x.text) : null))
    .filter((x): x is string => !!x && x !== 'Unclassified');
}

/**
 * Project `start`/`end` are null on essentially every record; the real funding
 * period is carried on the FUND link. Prefer the project fields, fall back to
 * the link.
 */
function fundingPeriod(project: Record<string, unknown>): { start: string | null; end: string | null } {
  const fund = linkByRel(project, 'FUND');
  return {
    start: isoDate(project.start) ?? isoDate(fund?.start),
    end: isoDate(project.end) ?? isoDate(fund?.end),
  };
}

function compactProject(project: Record<string, unknown>): Record<string, unknown> {
  const period = fundingPeriod(project);
  return {
    grant_ref: rcukRef(project),
    project_id: typeof project.id === 'string' ? project.id : null,
    title: text(project.title),
    status: text(project.status),
    funder: text(project.leadFunder),
    grant_category: text(project.grantCategory),
    lead_department: text(project.leadOrganisationDepartment),
    start: period.start,
    end: period.end,
    fund_id: idFromHref(linkByRel(project, 'FUND')?.href) ?? null,
    lead_organisation_id: idFromHref(linkByRel(project, 'LEAD_ORG')?.href) ?? null,
  };
}

function compactOrganisation(org: Record<string, unknown>): Record<string, unknown> {
  const addrs = (org.addresses as { address?: unknown } | null | undefined)?.address;
  const a = Array.isArray(addrs) ? (addrs[0] as Record<string, unknown> | undefined) : undefined;
  return {
    organisation_id: typeof org.id === 'string' ? org.id : null,
    name: text(org.name),
    postcode: a ? addrText(a.postCode) : null,
    city: a ? addrText(a.city) : null,
    region: a ? addrText(a.region) : null,
    country: a ? addrText(a.country) : null,
    website: text(org.website),
  };
}

function compactPublication(pub: Record<string, unknown>): Record<string, unknown> {
  return {
    publication_id: typeof pub.id === 'string' ? pub.id : null,
    title: text(pub.title),
    type: text(pub.type),
    author: text(pub.author),
    journal: text(pub.journalTitle),
    date_published: isoDate(pub.datePublished),
    volume: text(pub.volumeTitle),
    issue: text(pub.issue),
    doi: text(pub.doi),
    pubmed_id: text(pub.pubMedId),
    issn: text(pub.issn),
    isbn: text(pub.isbn),
    url: text(pub.publicationUrl),
    project_id: idFromHref(linkByRel(pub, 'PROJECT')?.href) ?? null,
  };
}

function collection(env: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const arr = env[key];
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

function envelope(env: Record<string, unknown>): { page: number | null; total_pages: number | null; total: number | null } {
  return {
    page: typeof env.page === 'number' ? env.page : null,
    total_pages: typeof env.totalPages === 'number' ? env.totalPages : null,
    total: typeof env.totalSize === 'number' ? env.totalSize : null,
  };
}

const PROJECT_FIELDS: Record<string, string | undefined> = {
  all: undefined,
  title: 'pro.t',
  abstract: 'pro.a',
  grant_ref: 'pro.gr',
};

const PUBLICATION_FIELDS: Record<string, string | undefined> = {
  all: undefined,
  title: 'pub.t',
  abstract: 'pub.a',
};

/**
 * Distinguish "this query has no hits" from "you paged past the end", which GtR
 * signals the same way.
 */
function pastLastPage(env: Record<string, unknown>, page: number): string | null {
  const tp = env.totalPages;
  if (page > 1 && typeof tp === 'number' && tp > 0 && page > tp) {
    return `Page ${page} is past the last page (${tp}). Re-request an earlier page.`;
  }
  return null;
}

function eq(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

/** Upstream pages scanned when a client-side filter has to do the narrowing. */
const MAX_FILTER_SCAN_PAGES = 5;

function applyProjectFilters(
  rows: Array<Record<string, unknown>>,
  funder?: string,
  status?: string,
): Array<Record<string, unknown>> {
  let out = rows;
  if (funder) out = out.filter((r) => eq(r.funder as string | null, funder));
  if (status) out = out.filter((r) => eq(r.status as string | null, status));
  return out;
}

interface ProjectScan {
  rows: Array<Record<string, unknown>>;
  raw: number;
  env: Record<string, unknown>;
  pages_scanned: number;
  last_page_scanned: number;
}

/**
 * Fetch project rows, applying the funder/status filters GtR has no parameter
 * for. With no filter this is one page. With a filter it walks up to
 * MAX_FILTER_SCAN_PAGES full pages, because a single 100-row page of a 6,000-grant
 * institution routinely contains nothing matching a specific council.
 */
async function scanProjects(
  path: string,
  params: Record<string, string | number | undefined>,
  page: number,
  limit: number,
  funder?: string,
  status?: string,
): Promise<ProjectScan> {
  const filtering = !!(funder || status);
  if (!filtering) {
    const env = await gtr(path, { ...params, s: Math.max(MIN_PAGE, limit), p: page });
    const raw = collection(env, 'project');
    return { rows: raw.map(compactProject), raw: raw.length, env, pages_scanned: 1, last_page_scanned: page };
  }

  const rows: Array<Record<string, unknown>> = [];
  let raw = 0;
  let env: Record<string, unknown> = {};
  let p = page;
  let lastFetched = page;
  let scanned = 0;

  while (rows.length < limit && scanned < MAX_FILTER_SCAN_PAGES) {
    env = await gtr(path, { ...params, s: MAX_PAGE, p });
    const batch = collection(env, 'project');
    scanned += 1;
    lastFetched = p;
    raw += batch.length;
    rows.push(...applyProjectFilters(batch.map(compactProject), funder, status));
    const totalPages = env.totalPages;
    if (batch.length < MAX_PAGE) break;
    if (typeof totalPages === 'number' && p >= totalPages) break;
    p += 1;
  }

  return { rows, raw, env, pages_scanned: scanned, last_page_scanned: lastFetched };
}

// ---------------------------------------------------------------- tools

async function searchProjects(args: Record<string, unknown>): Promise<unknown> {
  const query = reqStr(args, 'query', '"quantum computing"');
  const funder = optStr(args, 'funder');
  const status = optStr(args, 'status');
  const field = optStr(args, 'search_field') ?? 'all';
  if (!(field in PROJECT_FIELDS)) {
    throw new Error(`search_field must be one of ${Object.keys(PROJECT_FIELDS).join(', ')}.`);
  }
  const limit = clampLimit(args.limit);
  const page = clampPage(args.page);

  // Funder is not a server-side filter, but GtR's search does honour a Lucene-ish
  // AND across a multi-field search, so pairing the funder-name field with the
  // text field narrows the candidate set upstream (~95% pure) and the exact
  // leadFunder match below removes the leakage.
  let q = query;
  let f = PROJECT_FIELDS[field];
  if (funder) {
    q = `${query} AND "${funder}"`;
    f = `${f ?? 'pro.a'},pro.lf`;
  }

  const filtering = !!(funder || status);
  const scan = await scanProjects('/projects', { q, f }, page, limit, funder, status);
  const results = scan.rows.slice(0, limit);

  if (results.length === 0) {
    const overrun = pastLastPage(scan.env, page);
    return {
      found: false,
      reason: overrun
        ? 'page_out_of_range'
        : scan.raw === 0
          ? 'no_matching_projects'
          : 'filters_excluded_all_results',
      hint:
        overrun ??
        (scan.raw === 0
          ? `No UKRI projects matched "${query}"${
              field === 'all' ? '. Try broader or fewer words' : `. Try search_field "all" rather than "${field}"`
            }${funder ? `, and confirm "${funder}" is spelled as GtR writes it (EPSRC, MRC, "Innovate UK")` : ''}.`
          : `Scanned ${scan.raw} projects matching "${query}" (pages ${page}-${scan.last_page_scanned} of ${
              (scan.env.totalPages as number | undefined) ?? '?'
            }); none had funder=${funder ?? 'any'} and status=${
              status ?? 'any'
            }. Matches can sit deeper in the result set — re-call with page ${
              scan.last_page_scanned + 1
            } to keep scanning, or drop a filter.`),
      query,
      ...envelope(scan.env),
    };
  }

  return {
    found: true,
    query,
    filters: { funder: funder ?? null, status: status ?? null },
    filtered_client_side: filtering
      ? `funder and status are matched exactly in this pack; upstream GtR has no parameter for them, so ${scan.raw} candidate projects were scanned across ${scan.pages_scanned} page(s) and the totals below are for the unfiltered text search`
      : null,
    ...envelope(scan.env),
    next_page: filtering ? scan.last_page_scanned + 1 : page + 1,
    returned: results.length,
    note: 'Award values are not on the project record. Call gtr_get_project with a grant_ref for the value in pounds.',
    projects: results,
  };
}

async function resolveProject(input: string): Promise<Record<string, unknown> | { miss: unknown }> {
  if (GUID_RE.test(input)) {
    let hit: Record<string, unknown> | null = null;
    try {
      hit = await gtr(`/projects/${input}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ 40[04] | 500 /.test(msg)) throw err;
    }
    // GtR does NOT 404 on an unknown project GUID — it matches on GUID *segments*
    // and returns HTTP 200 with a completely unrelated project. Without this
    // equality check the tool confidently answers about the wrong grant.
    if (hit && typeof hit.id === 'string' && hit.id.toLowerCase() === input.toLowerCase()) return hit;
    return {
      miss: {
        found: false,
        reason: 'project_not_found',
        hint: `No GtR project has id ${input}${
          hit && typeof hit.id === 'string' ? ` (upstream loosely matched the unrelated project ${hit.id}, which this pack rejected)` : ''
        }. If this is a grant reference rather than a GUID, pass it as-is (e.g. "EP/T022159/1"); otherwise find the project with gtr_search_projects.`,
      },
    };
  }

  // Grant reference: search the dedicated grant-reference field, then fall back
  // to the default multi-field search.
  let env = await gtr('/projects', { q: input, s: MIN_PAGE, f: 'pro.gr' });
  let rows = collection(env, 'project');
  if (rows.length === 0) {
    env = await gtr('/projects', { q: input, s: MIN_PAGE });
    rows = collection(env, 'project');
  }

  const wanted = input.toLowerCase();
  const exact = rows.find((r) => grantRefs(r).some((v) => v.toLowerCase() === wanted));
  if (exact) return exact;
  if (rows.length === 1) return rows[0];

  return {
    miss: {
      found: false,
      reason: rows.length === 0 ? 'project_not_found' : 'ambiguous_grant_reference',
      hint:
        rows.length === 0
          ? `No UKRI project carries the grant reference "${input}". References look like "EP/T022159/1" (council-prefixed) or "10045762" (Innovate UK). Search by topic with gtr_search_projects instead.`
          : `"${input}" did not match a grant reference exactly. Candidates on the first page: ${rows
              .slice(0, 5)
              .map((r) => `${rcukRef(r) ?? '?'} (${text(r.title) ?? ''})`)
              .join('; ')}. Re-call with one of those references or its project_id.`,
      candidates: rows.slice(0, 5).map(compactProject),
    },
  };
}

async function getProject(args: Record<string, unknown>): Promise<unknown> {
  const input = reqStr(args, 'project', '"EP/T022159/1"');
  const resolved = await resolveProject(input);
  if ('miss' in resolved) return resolved.miss;
  const project = resolved;

  const fundLink = linkByRel(project, 'FUND');
  const orgLink = linkByRel(project, 'LEAD_ORG');
  const piLinks = linksByRel(project, 'PI_PER').slice(0, 4);

  const [fund, org, ...pis] = await Promise.all([
    fetchLinked('funds', idFromHref(fundLink?.href)),
    fetchLinked('organisations', idFromHref(orgLink?.href)),
    ...piLinks.map((l) => fetchLinked('persons', idFromHref(l.href))),
  ]);

  const value = fund?.valuePounds as { currencyCode?: unknown; amount?: unknown } | null | undefined;
  // A fund can legitimately record amount 0, so test for a number, not truthiness.
  const amount = typeof value?.amount === 'number' ? value.amount : null;

  const period = fundingPeriod(project);

  const outcomeCounts: Record<string, number> = {};
  for (const l of linksOf(project)) {
    if (typeof l.rel === 'string') outcomeCounts[l.rel] = (outcomeCounts[l.rel] ?? 0) + 1;
  }

  const participants = (project.participantValues as { participant?: unknown } | null | undefined)?.participant;

  return {
    found: true,
    grant_ref: rcukRef(project),
    project_id: typeof project.id === 'string' ? project.id : null,
    title: text(project.title),
    status: text(project.status),
    funder: text(project.leadFunder),
    grant_category: text(project.grantCategory),
    award: {
      amount,
      currency: typeof value?.currencyCode === 'string' ? value.currencyCode : amount === null ? null : 'GBP',
      category: text(fund?.category),
      type: text(fund?.type),
      fund_id: typeof fund?.id === 'string' ? fund.id : (idFromHref(fundLink?.href) ?? null),
      unavailable_reason: amount === null ? (fund ? 'fund_record_has_no_value' : 'no_fund_link_on_project') : null,
    },
    lead_organisation: org ? compactOrganisation(org) : null,
    lead_department: text(project.leadOrganisationDepartment),
    principal_investigators: pis
      .filter((p): p is Record<string, unknown> => !!p)
      .map((p) => ({
        person_id: typeof p.id === 'string' ? p.id : null,
        name: [text(p.firstName), text(p.otherNames), text(p.surname)].filter(Boolean).join(' '),
        orcid: text(p.orcidId),
      })),
    start: period.start,
    end: period.end,
    abstract: text(project.abstractText),
    technical_abstract: text(project.techAbstractText),
    potential_impact: text(project.potentialImpact),
    health_categories: classifications(project, 'healthCategories', 'healthCategory'),
    research_activities: classifications(project, 'researchActivities', 'researchActivity'),
    research_subjects: classifications(project, 'researchSubjects', 'researchSubject'),
    research_topics: classifications(project, 'researchTopics', 'researchTopic'),
    rcuk_programmes: classifications(project, 'rcukProgrammes', 'rcukProgramme'),
    participant_values: Array.isArray(participants) ? participants : [],
    linked_record_counts: outcomeCounts,
    gtr_url: `https://gtr.ukri.org/projects?ref=${encodeURIComponent(rcukRef(project) ?? '')}`,
  };
}

async function searchOrganisations(args: Record<string, unknown>): Promise<unknown> {
  const name = reqStr(args, 'name', '"imperial college"');
  const limit = clampLimit(args.limit);
  const page = clampPage(args.page);

  // The default multi-field organisation search ranks terribly (a query for
  // "imperial college" returns unrelated bodies); pinning it to the name field
  // makes it behave.
  const env = await gtr('/organisations', { q: name, s: Math.max(MIN_PAGE, limit), p: page, f: 'org.n' });
  const rows = collection(env, 'organisation');

  if (rows.length === 0) {
    const overrun = pastLastPage(env, page);
    return {
      found: false,
      reason: overrun ? 'page_out_of_range' : 'no_matching_organisations',
      hint:
        overrun ??
        `No UKRI-funded organisation name matched "${name}". Try a shorter fragment ("imperial" rather than "Imperial College London, Dept of Physics"), or the trading name for a company.`,
      name,
      ...envelope(env),
    };
  }

  return {
    found: true,
    name,
    ...envelope(env),
    returned: Math.min(rows.length, limit),
    note: 'GtR holds several records for the same institution (differing case and legacy entries). Pick the id whose project count looks right via gtr_organisation_projects.',
    organisations: rows.slice(0, limit).map(compactOrganisation),
  };
}

async function organisationProjects(args: Record<string, unknown>): Promise<unknown> {
  const input = reqStr(args, 'organisation', '"4FC4CBFD-9E7C-4518-BB16-852553236FE1"');
  const funder = optStr(args, 'funder');
  const status = optStr(args, 'status');
  const limit = clampLimit(args.limit);
  const page = clampPage(args.page);

  let orgId = input;
  let resolvedFrom: Record<string, unknown> | null = null;
  let alternatives: Array<Record<string, unknown>> = [];
  let resolutionNote: string | null = null;

  if (GUID_RE.test(input)) {
    // Organisations, unlike projects, do error on an unknown GUID — so this both
    // validates the id and gets the institution name for the response.
    const org = await fetchLinked('organisations', input);
    if (!org || typeof org.id !== 'string') {
      return {
        found: false,
        reason: 'organisation_not_found',
        hint: `GtR has no organisation ${input}. Resolve the institution name with gtr_search_organisations and pass the organisation_id it returns.`,
      };
    }
    resolvedFrom = compactOrganisation(org);
  } else {
    const env = await gtr('/organisations', { q: input, s: 50, f: 'org.n' });
    const rows = collection(env, 'organisation').filter((r) => typeof r.id === 'string');
    if (rows.length === 0) {
      return {
        found: false,
        reason: 'organisation_not_found',
        hint: `No UKRI-funded organisation name matched "${input}". Look it up with gtr_search_organisations and pass the organisation_id.`,
      };
    }

    // GtR splits one institution across many duplicate records, most of them
    // near-empty ("University of Cambridge" alone has 40+). Name order lands on a
    // stub, so probe a bounded slice for grant counts and keep the fullest.
    // Exact name matches are probed first, then near matches ("Rolls-Royce" vs
    // "ROLLS-ROYCE PLC") fill the budget so they can be offered as alternatives.
    const isExact = (r: Record<string, unknown>) => eq(text(r.name), input);
    const pool = [...rows.filter(isExact), ...rows.filter((r) => !isExact(r))].slice(0, ORG_CANDIDATE_PROBES);
    const counts = await Promise.all(
      pool.map(async (r) => {
        try {
          const e = await gtr(`/organisations/${r.id as string}/projects`, { s: MIN_PAGE, p: 1 });
          return typeof e.totalSize === 'number' ? e.totalSize : 0;
        } catch {
          return 0;
        }
      }),
    );
    const ranked = pool
      .map((r, i) => ({ org: r, count: counts[i], exact: isExact(r) }))
      .sort((a, b) => b.count - a.count);

    // An exact name match wins over a merely similar one, but only if it holds
    // grants — otherwise the stub would beat the real record.
    const best = ranked.find((r) => r.exact && r.count > 0) ?? ranked[0];
    orgId = best.org.id as string;
    resolvedFrom = { ...compactOrganisation(best.org), grant_count: best.count };
    alternatives = ranked
      .filter((r) => r !== best && r.count > 0)
      .slice(0, 5)
      .map((r) => ({ ...compactOrganisation(r.org), grant_count: r.count }));
    resolutionNote = `Resolved "${input}" by probing ${pool.length} of ${
      env.totalSize ?? pool.length
    } name matches and keeping the record with the most grants. GtR duplicates institutions across dozens of records, so this portfolio is a lower bound — check gtr_search_organisations for a fuller record if the count looks low.`;
  }

  const filtering = !!(funder || status);

  let scan: ProjectScan;
  try {
    scan = await scanProjects(`/organisations/${orgId}/projects`, {}, page, limit, funder, status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ 40[04] | 500 /.test(msg)) {
      return {
        found: false,
        reason: 'organisation_not_found',
        hint: `GtR has no organisation ${orgId}. Resolve the name with gtr_search_organisations first.`,
      };
    }
    throw err;
  }

  const results = scan.rows.slice(0, limit);

  if (results.length === 0) {
    const overrun = pastLastPage(scan.env, page);
    return {
      found: false,
      reason: overrun
        ? 'page_out_of_range'
        : scan.raw === 0
          ? 'no_projects_for_organisation'
          : 'filters_excluded_all_results',
      hint:
        overrun ??
        (scan.raw === 0
          ? `Organisation ${orgId} has no UKRI grants on page ${page}. GtR keeps duplicate records per institution — try another id from gtr_search_organisations.`
          : `Scanned ${scan.raw} of this organisation's grants (pages ${page}-${scan.last_page_scanned} of ${
              (scan.env.totalPages as number | undefined) ?? '?'
            }); none had funder=${funder ?? 'any'} and status=${
              status ?? 'any'
            }. A large portfolio spreads matches unevenly across pages — re-call with page ${
              scan.last_page_scanned + 1
            } to keep scanning, or drop a filter.`),
      organisation_id: orgId,
      resolved_from: resolvedFrom,
      alternatives,
      ...envelope(scan.env),
    };
  }

  return {
    found: true,
    organisation_id: orgId,
    resolved_from: resolvedFrom,
    resolution_note: resolutionNote,
    alternatives,
    filters: { funder: funder ?? null, status: status ?? null },
    filtered_client_side: filtering
      ? `funder and status are matched exactly in this pack; upstream GtR has no parameter for them, so ${scan.raw} of this organisation's grants were scanned across ${scan.pages_scanned} page(s) and the totals below cover its whole portfolio`
      : null,
    ...envelope(scan.env),
    next_page: filtering ? scan.last_page_scanned + 1 : page + 1,
    returned: results.length,
    note: 'GtR counts a grant against this organisation when it leads OR participates, so lead_organisation_id on a row can be a different institution.',
    projects: results,
  };
}

async function searchPublications(args: Record<string, unknown>): Promise<unknown> {
  const query = reqStr(args, 'query', '"graphene battery"');
  const field = optStr(args, 'search_field') ?? 'all';
  if (!(field in PUBLICATION_FIELDS)) {
    throw new Error(`search_field must be one of ${Object.keys(PUBLICATION_FIELDS).join(', ')}.`);
  }
  const limit = clampLimit(args.limit);
  const page = clampPage(args.page);

  const env = await gtr('/outcomes/publications', {
    q: query,
    s: Math.max(MIN_PAGE, limit),
    p: page,
    f: PUBLICATION_FIELDS[field],
  });
  const rows = collection(env, 'publication');

  if (rows.length === 0) {
    const overrun = pastLastPage(env, page);
    return {
      found: false,
      reason: overrun ? 'page_out_of_range' : 'no_matching_publications',
      hint:
        overrun ??
        `No UKRI-reported publication matched "${query}". Only outputs that grant holders self-reported are indexed, so coverage is patchy for recent work — try broader wording or search the funding side with gtr_search_projects.`,
      query,
      ...envelope(env),
    };
  }

  return {
    found: true,
    query,
    ...envelope(env),
    returned: Math.min(rows.length, limit),
    publications: rows.slice(0, limit).map(compactPublication),
  };
}

// ---------------------------------------------------------------- dispatch

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'gtr_search_projects':
      return searchProjects(args);
    case 'gtr_get_project':
      return getProject(args);
    case 'gtr_search_organisations':
      return searchOrganisations(args);
    case 'gtr_organisation_projects':
      return organisationProjects(args);
    case 'gtr_search_publications':
      return searchPublications(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
