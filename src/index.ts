interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * UKRI Gateway to Research (GtR) MCP — every grant awarded by the UK's seven
 * research councils plus Innovate UK: recipient, subject, award value, dates.
 *
 * Keyless. Requires the vendored media-type Accept header and a browser
 * User-Agent. Upstream page size is clamped to [10, 100] by the API itself.
 */


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
  const res = await fetch(url.toString(), { headers: { Accept: ACCEPT, 'User-Agent': UA } });
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
