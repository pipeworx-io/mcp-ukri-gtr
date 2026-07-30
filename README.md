# @pipeworx/ukri-gtr

UKRI Gateway to Research MCP — every research grant awarded by the UK's seven research councils (EPSRC, MRC, BBSRC, NERC, ESRC, AHRC, STFC) plus Innovate UK: who was funded, for what, how much, and when. Keyless.

## Tools

- `gtr_search_projects(query, funder?, status?, search_field?, limit?, page?)` — free-text search over UK grants; returns grant reference, title, status, funding council, grant category, lead department and funding period.
- `gtr_get_project(project)` — one project by GtR GUID **or** by human grant reference (`EP/T022159/1`, `10045762`). Follows the FUND and LEAD_ORG links to return the **award value in pounds**, the lead organisation and its address, the principal investigators, and the full abstract / technical abstract / potential-impact text.
- `gtr_search_organisations(name, limit?, page?)` — find funded UK institutions by name; returns organisation id, name, postcode and region.
- `gtr_organisation_projects(organisation, funder?, status?, limit?, page?)` — one institution's funding portfolio, by organisation id or by name.
- `gtr_search_publications(query, search_field?, limit?, page?)` — journal articles and papers grant holders reported as outcomes; returns DOI, PubMed id, journal, date and the originating project id.

## Auth

None. Keyless and unmetered — no key, account or registration.

Two headers are mandatory and are set by the pack: `Accept: application/vnd.rcuk.gtr.json-v7` (the vendored media type; a plain `Accept: application/json` gets you the wrong representation) and a normal browser `User-Agent`.

## Data sources

- API root: `https://gtr.ukri.org/gtr/api`
- Projects: `https://gtr.ukri.org/gtr/api/projects?q=cancer&s=10&p=1`
- Single project: `https://gtr.ukri.org/gtr/api/projects/{guid}`
- Funds (award values): `https://gtr.ukri.org/gtr/api/funds/{guid}`
- Organisations: `https://gtr.ukri.org/gtr/api/organisations?q=imperial+college&s=10&f=org.n`
- Organisation portfolio: `https://gtr.ukri.org/gtr/api/organisations/{guid}/projects`
- Publication outcomes: `https://gtr.ukri.org/gtr/api/outcomes/publications?q=cancer&s=10`
- Human-facing site: https://gtr.ukri.org

### Gotchas

The page-size parameter `s` is rejected outside **10–100** — `s=1` returns HTTP 400 `Page size cannot be less than 10`, `s=200` returns `Page size cannot be greater than 100`, so the pack clamps every request into that band and slices the result down to the caller's `limit`. **The award value is not on the project object**: money lives on the fund reached through `links.link[]` where `rel === 'FUND'`, and `gtr_get_project` follows that link (plus `LEAD_ORG` and `PI_PER`) so an agent asking what a grant was worth gets an answer in one call — a fund's `amount` can legitimately be `0`. The project's own `start` and `end` fields are **null on essentially every record** (0 of 100 populated in a sample), so the pack takes the funding period from the FUND link's `start`/`end` instead; both are epoch milliseconds and are emitted as ISO dates. The collection key in the response envelope **changes per endpoint** — `project`, `organisation`, `person`, `fund`, `publication` — and the `links.link[]` array is large and useless to a model, so it is stripped from all output and used only internally.

The nastiest trap: **`/projects/{guid}` never 404s.** Given an unknown GUID it matches on GUID *segments* and returns HTTP 200 with a completely unrelated project (`00000000-0000-0000-0000-000000000000` returns a BBSRC studentship whose id merely contains `0000`), so `gtr_get_project` compares the returned `id` against the requested one and reports `found: false` rather than answering about the wrong grant. `/organisations/{guid}` does error correctly. A search that matches nothing also 404s, with `Page requested exceeds maximum available: 0`, which the pack converts into an empty result rather than an exception.

GtR has **no server-side filter for funder or status**. Its search does honour a Lucene-ish `AND` across a multi-field query, so pairing the text field with `pro.lf` narrows to roughly 95% pure upstream; the pack does that and then matches `leadFunder` and `status` exactly client-side, walking up to 5 upstream pages of 100 to fill the requested `limit`. Matches in a big portfolio cluster unevenly across pages, so a `found: false` from a filtered call returns the page to resume from rather than implying the grants do not exist. Restricting a search to one field uses `f=` — valid project fields are `pro.t` (title), `pro.a` (abstract), `pro.gr` (grant reference), `pro.lf` (lead funder); anything else returns HTTP 400 naming the invalid field.

Organisation search is unusable without `f=org.n`: the default multi-field search for `imperial college` returns Jilin University and NYU, while the name-scoped search returns the Imperial records. GtR then **fragments each institution across dozens of duplicate records** — "University of Cambridge" has 40+, holding 6,949 / 1,547 / 305 / 163 grants respectively, and the largest is not the highest-ranked. So `gtr_organisation_projects` resolves a name by probing up to 20 candidates for their grant count, keeps the fullest, and returns the runners-up as `alternatives` with their counts. Address fields carry the literal string `"Unknown"` rather than null, which the pack normalises. Finally, `/organisations/{id}/projects` counts a grant when the institution **leads or merely participates**, so a row's `lead_organisation_id` is often a different body. Titles and abstracts arrive HTML-escaped (`Simulation &amp; Analytics`) and are decoded.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ukri-gtr": {
      "url": "https://gateway.pipeworx.io/ukri-gtr/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1375+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ukri Gtr data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
