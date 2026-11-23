Author: d3vn0mi.

# The viewer

The viewer draws a mapped repository as a map that a person can read, search and walk from the
keyboard. This page says how to run it, how to read it, how a link opens one node of it, how another
server can serve it, and what it promises about security, speed and accessibility.

Every example uses `observatory`, the synthetic sample in
[`fixtures/observatory/`](../fixtures/observatory/).

## What the viewer is

The viewer is a window onto the answers the agents get, not a second model of the code.

- **One store.** It reads the store that `hakutaku map` built, the one the agents' tools read,
  through the same query functions. Every count, list, rank and name it shows comes from there; it
  adds no analysis of its own. Only the drawing is its own: where each dot sits, and how each curve
  bends.
- **The same answers.** Its Agent tab shows, for the selected node, the exact call an agent would
  make and the tool's own answer to it, as the tool's handler wrote it.
- **One build.** A page draws the build it loaded. When the repository is rebuilt while the page is
  open, at a new commit or at the same one (another detail, without sources, another profile), the
  page's next call to its server finds the new build, draws nothing of it, and says "The map was
  rebuilt at `<commit>`. Reload to see it.", or "The map was rebuilt. Reload to see it." when the
  answer that found it names no commit, as a refusal does. It never mixes two builds.
- **Nothing from outside.** Its fonts and libraries are bundled into it. It asks nothing of any
  server but its own, and an exported page asks nothing at all.

## Running it

hakutaku is not on npm yet: this page gives the commands as 0.1 will run them, as the README's
[quick start](../README.md#quick-start-planned-for-01) does. From a clone of this repository, after
`npm ci` and `npm run build`, `node dist/cli/main.js` stands in for `hakutaku`.

Map the repository first, then view it by the id that `map` registered. To try it on the sample,
write the sample first with `node fixtures/observatory/make.mjs <dir>`, from a clone of this
repository:

```sh
hakutaku map <dir>/observatory
hakutaku view observatory
```

`hakutaku view` serves the viewer on `127.0.0.1`, on a free port, and prints one line, its link:
`http://127.0.0.1:<port>/?s=<session>`. The session is new each time, and every call the page makes
to its server must carry it. The server runs until it is interrupted (Ctrl-C, or SIGTERM). It opens
the store on every request, so a rebuild is served as soon as it is in place.

```text
usage: hakutaku view <id> [--open] [--export <file.html> [--with-source]]
```

- `--open` also opens the link in the platform's browser: `xdg-open` on Linux, `open` on macOS.
- `--export <file.html>` serves nothing. It writes the map as one self-contained page, then prints
  the page's absolute path. The page holds the map with every file's outline, the change activity,
  and, for each node, the answer its Agent tab shows.
- `--with-source` puts the repository's redacted sources in the exported page, for its Source tab.
  Without it, the page holds no line of source, in its Source tab or in any answer. A repository
  mapped without sources, or with snippets off, has none to give: the page is written without them,
  and `view` says so.

The exported page asks nothing of any server, so it opens from a file. Its script opens with the
licence of every package bundled into it, and its styles with the fonts' licence, so the page holds
the notices those licences ask every copy to keep. Its answers stop above 2,000
production files: the page of a larger repository holds none, and its Agent tab says "This export
holds no agent answer for this node."

`--open` and `--export` exclude each other, and `--with-source` goes with `--export` only. `view`
exits 0 once the server has closed or the page is written, 1 on a failure (a repository with no
usable store, whose message names `hakutaku map`, or a page that cannot be written), and 2 on a
usage error.

## Reading the map

**The stat band**, over the map, counts the code files, entry points, components, cycles and tests.
Each count is a button:

- *code files* shows every file again, at Files depth, under the Structure lens;
- *entry points* marks the entry points in orange, and a second press unmarks them;
- *components* switches to Components depth;
- *cycles* switches to the Risk lens and selects the first file of the first cycle;
- *tests* shows the tests.

**The galaxy.** Production files sit on a disc. The more of the code depends on a file, the closer
it sits to the centre: its distance follows its PageRank rank. Its angle falls within its group's
sector, and sectors are sized by their file counts. Tests sit on a ring outside the disc, the
groups' hubs on a ring beyond, and the libraries outside everything, each near the files that import
it. There is no force simulation: the same store always draws the same picture.

**Curves.** Imports are curves, bent toward the centre, so that the imports between groups bundle
through the middle. At Components depth they join the hubs, thicker for more imports. With a
selection, only its own curves are drawn, and an import that runs in a loop is orange.

**Size and labels.** A file's size follows the lens. Labels name the lens's top 8 files and the
selection, besides the hubs and the libraries, and a pointer over a dot shows its name.

**Depth**, on the D key or the Depth control:

1. **Components:** the hubs only, with the imports between them. The big picture.
2. **Core:** the core set, plus every entry point, every hotspot above 0.35, and each component's
   top file. Small, but no part of the repository vanishes. A line under the legend says what the
   core set covers: "`<n>` of `<total>` production files (`<share>`%) carry at least half of what
   the code depends on". Core is the default above 400 production files.
3. **Files:** every production file, with the tests and the libraries a toggle away. The default for
   smaller repositories.

Inside a file, the Inside tab shows its definitions, and the Source tab its source. The breadcrumb
always says where you are (Map, component, file, definition), and Esc climbs one level.

**Lenses**, on the keys 1, 2 and 3. Each has its legend, one line under the map:

| Lens | Colour and size | Legend |
|---|---|---|
| **Structure** | Brightness and size by rank; with the entry points marked from the stat band, they show in orange | "Each dot is a file. The closer to the centre, the more of the code depends on it. Curves through the middle are imports between components." |
| **Risk** | Orange for hotspots and for files in a cycle, with the cycle curves orange; size by hotspot | "Orange marks hotspots: files the code depends on that also change often. Orange curves are imports that run in a loop." |
| **History** | Brightness and size by churn over 90 days; a selected file's co-change partners are joined to it by dashed curves | "Brighter files changed more in the last 90 days. Select one to see, dashed, the files that change together with it." |
| **Ownership** | Disabled, for now | |

With the entry points marked, the legend reads "Orange marks entry points: where code starts running
(scripts, plugin entries, routes, units)."

**Group by** gathers the files of a sector, and its hub, by component, by top-level folder or by
language.

**The bottom lists:** *Core*, what the rest depends on; *Change activity*, the commits of each of the
last 26 weeks; and *Hotspots*, depended on and changing often. Each row is a button that selects its
file.

**The details panel** names the selected node: its kind, its name, its stable ID with Copy ID and
Copy #link, and a line with its rank and whether it is an entry point, in a cycle or a hotspot. Its
tabs:

- **Overview:** a file's facts (lines, imported by, imports, changes in 90 days, definitions), then
  the files that import it, the files it imports, the files that change together with it, its
  libraries and the entry points that launch it. Every row selects its node. A component lists its
  files, one dot each, its core files and its entry points; a library, the files that import it.
- **Inside:** one dot per definition, in file order, and the list of definitions with their glyph,
  name, users and line. A dot is ivory when other files use the definition, dimmed when it is
  exported but unused, and faint when it is internal; it is round for a method; an orange ring says
  that no test mentions it. A dot opens the source at its line.
- **Source:** the file's source, from the store's redacted copy, highlighted for TypeScript,
  JavaScript, Python, shell, JSON, YAML, TOML, INI and Markdown, and shown as plain text in any other
  language. The gutter marks each definition's first line; with a definition selected, its line is
  flashed and its call sites in the file are marked by their label. A list of the marked lines
  follows the code. A file over 2,500 lines or 16,384 characters is highlighted in a worker and
  added a chunk of lines at a time; an exported page, which has no worker, shows such a file as
  plain text, a chunk at a time, and says so above it.
- **Agent:** the call an agent would make for the node, `code_explain` for a file or a definition,
  `code_overview` for a component and `code_references` for a library, above the tool's own answer,
  as `hakutaku query` prints it.

Wide and Narrow widen the details, or give the room back to the map.

## Find, filters, the list view and the keys

**Find**, on F or /, is one box over the files, the definitions, each shown with its file's name, and
the libraries. Exact matches come first, then prefixes, then a match inside a name. Within each, the
more important come first: a production file by how much of the code depends on it, a definition by
the files that use it and whether it is exported, a library by the files that import it. Find lists
the best 14. The arrows move through them, Enter or a click picks one, and Esc closes the list. A
definition opens on its Source tab.

**Show** turns on or off the code files, the tests, the libraries and the import curves, each with
its count. The map draws tests at Files depth only; at Core and Components depth the Tests toggle is
off, and says so, unless the list view is open.

**Filters**, in the left panel: language, component, entry points only, files in a cycle, changed in
the last 7, 30 or 90 days, and a hotspot above a threshold you set. A filter dims what it leaves out
and moves nothing, so the picture stays the one you learnt.

**The list view**, on L, gives the same files as a ranked list, under the filters: the production
files by rank, then, with Tests on, the tests by path, 200 at a time. Each row is a button that
reads its path, its rank and its importers. Over the map, L or Esc closes it again. In a browser
without WebGL, which cannot draw the map, the list view stands in its place.

**The keys:**

| Key | What it does |
|---|---|
| `F` or `/` | Find: puts the focus in the Find box |
| `Esc` | Back: climbs one level |
| `1` | The Structure lens |
| `2` | The Risk lens |
| `3` | The History lens |
| `D` | The next depth |
| `L` | The list view |

Arrows and Enter work in Find's matches, and Tab moves through the panels. A key typed into the Find
box or a select belongs to it, and so does a key pressed with Ctrl, Alt or Meta; on a checkbox or a
slider, the viewer's keys still work.

## Link tokens

A link token is the URL fragment that opens one node in the viewer. Every answer about one node ends
with a `view` field, `#` and the node's token, so that a person can open the node an agent cited.

| Node | ID | Token |
|---|---|---|
| file | `observatory:web/src/orbits/kepler.ts` | `web~src~orbits~kepler.ts` |
| definition | `observatory:web/src/orbits/kepler.ts#Orbit.position` | `web~src~orbits~kepler.ts--Orbit.position` |
| directory | `observatory:web/src/orbits/` | `web~src~orbits~` |
| external module | `observatory:npm:react` | `npm:react` |
| repo | `observatory:` | (empty) |

**Encoding.** One function, `enc`, applies to each part of an ID: a path, a qualified name, or an
external module's name, each raw, as git tracks the path.

1. Percent-encode every character except `A`-`Z`, `a`-`z`, `0`-`9`, `.`, `_`, `-` and `/`, as its
   UTF-8 bytes in upper-case hex. That covers `~`, `:`, `#`, `%`, `@`, spaces and anything outside
   ASCII.
2. Percent-encode, as `%2D`, every `-` that is followed by another `-` or that ends the part.
3. Turn every `/` into `~`.

A file's or a directory's token is `enc(path)`; a directory's path keeps its final `/`, so its token
ends in `~`. A definition's is `enc(path)`, then `--`, then `enc(qualname)`. An external module's is
its ecosystem, then `:`, then `enc(name)`. The repo's is empty.

**Decoding.** An empty token is the repo. A token that holds a `:` is an external module, whose
ecosystem is what precedes the `:`. Otherwise the first `--`, if there is one, separates the path
from the qualified name. In each part, every `~` becomes `/`, and only then are the escapes decoded.
A path that ends in `/` is a directory. After `enc`, a part holds no `:` and no `--` and does not end
in `-`, so one token always names one node.

**Two worked examples.**

1. `observatory:web/src/orbits/kepler.ts#Orbit.position`. No character needs an escape, and no `-`
   is doubled or last, so step 3 alone gives `web~src~orbits~kepler.ts` and `Orbit.position`, and
   the token is `web~src~orbits~kepler.ts--Orbit.position`. Reading it back, there is no `:`, the
   first `--` follows `kepler.ts`, and each `~` becomes `/`: the same ID.
2. The function `main` in the script `scripts/sync-`, `observatory:scripts/sync-#main`. The last `-`
   ends the path, so step 2 makes it `%2D`, and the token is `scripts~sync%2D--main`. Reading it
   back, the first `--` follows `%2D`, so the parts are `scripts~sync%2D` and `main`, which give back
   `scripts/sync-` and `main`. Without step 2 the token would be `scripts~sync---main`, whose first
   `--` gives the path `scripts/sync` and the name `-main`: `observatory:scripts/sync#-main`, the
   wrong file.

**More cases:**

| ID | Token |
|---|---|
| `observatory:web/a--b/c.ts` (an inner `--`) | `web~a%2D-b~c.ts` |
| `observatory:notes~old/x.md` (a literal `~`) | `notes%7Eold~x.md` |
| `observatory:tools/foo-/` (a directory whose name ends in `-`) | `tools~foo-~` |
| `observatory:npm:@types/node` (a scoped npm name) | `npm:%40types~node` |
| `observatory:web/src/orbits/kepler.test.ts#<module>` (module scope) | `web~src~orbits~kepler.test.ts--%3Cmodule%3E` |

**In the viewer.** The page reads the token on load and on every change of the fragment, exactly as
it stands: it splits the token first and decodes each part afterwards, so a `%2D` never turns back
into part of a separator. Every selection writes its token into the address, and the address reopens
the same node. A token the map does not hold is said in a message, and the selection stays as it
was. Copy ID copies the node's ID, and Copy #link its `#` and token.

Tokens are relative. A host that serves the viewer at a known address can turn a token into a full
link for people.

## Mounting the viewer in another server

The package's main export, `hakutaku` once it is on npm (`dist/index.js` in a built clone), holds the
page and the API for a host that serves the viewer itself, behind its own login:

```ts
import { viewerApi, viewerStatic } from "hakutaku";
```

- `viewerStatic(path, { base, apiBase })` answers the page and its assets. `path` is the request
  path under `base`, without its first `/`: `""` or `index.html` for the page, `assets/<name>` for
  an asset; anything else is 404. `base` is where the page is served, and `apiBase` where the API
  is, `<base>api/` unless given. Each is an absolute path of plain segments (letters, digits, `.`,
  `_`, `~` and `-`) that ends in `/`; anything else throws `TypeError`.
- `viewerApi(host, ctx, repo, req)` answers one API call for the mounted repo. `host` is the same
  `Host` the tools take, `ctx` the caller as the host knows it, which is passed back to the host and
  never read, and `repo` the repo the page shows. `req` is `{ method, path, query, body }`: `path` is
  relative to `apiBase` (`map`, `outline`, `source`, `history`, or `tool/<name>`), `query` holds the
  first value of each query parameter, and `body` is the request's body as text, when it has one. It
  answers `{ status, headers, body }` and never throws: an exception becomes the internal error, and
  its details go only to `console.error`.

The API: `GET map`, `GET outline?file=<file ID>`, `GET source?file=<file ID>`, `GET history`, and
`POST tool/<name>` with the tool's arguments as a JSON object, for the read-only tools.

A host must:

- **serve every answer exactly as returned,** headers included, so that the page's policy,
  `VIEWER_CSP`, holds;
- **serve the page and the API from one origin,** since the page connects to its own origin only;
- **authenticate each API call before calling `viewerApi`,** which checks no session, cookie or Host
  header itself. The page sends the origin's cookies with every call, and an `x-hakutaku-session`
  header holding its own address's `s` parameter when it has one;
- **cap the size of a request's body;** `hakutaku view` refuses one over 65,536 bytes.

`tool/code_refresh` is refused, with 404: a host that authenticates with a cookie would otherwise let
a page of another site start a build. A tool call runs on the mounted repo only: a `repo` argument
naming another is refused with 400, and an ID of another repo by the tool itself, with 422.

**Headers.** Every answer, from both, carries these:

| Header | Value |
|---|---|
| `x-content-type-options` | `nosniff` |
| `referrer-policy` | `no-referrer` |
| `cache-control` | `no-store` |
| `cross-origin-resource-policy` | `same-origin` |

The page also carries `content-type: text/html; charset=utf-8` and `content-security-policy` with
`VIEWER_CSP` (see Security); each asset, its own type and `content-security-policy: default-src 'none'`;
and every API answer and every error, `content-type: application/json; charset=utf-8`. An error's
body is an object `{ "error": { "code": ..., "message": ... } }`, as the tools write their errors. No
answer carries an access-control header. Every answer `viewerApi` makes once the repo's store is open,
a tool's and a refusal's included, also carries `x-hakutaku-build`: the first 16 hex characters of
the store's content hash, which the map, outline, source and history bodies also carry as `build`.
It changes with every rebuild that changes what the store holds, at the same commit too, so the
page can tell an answer of another build from its own.

**Statuses** of `viewerApi` and `viewerStatic`:

| Status | Error code | When |
|---|---|---|
| 200 | | The answer: the data as compact JSON, or the tool's answer as indented JSON |
| 400 | `invalid_argument` | A `file` that is not the ID of a file of the repo; a tool body that is not a JSON object; a `repo` argument naming another repo |
| 404 | `not_found` | An unknown path, an unknown tool or `code_refresh`; a file the store does not hold; no page or asset of that name |
| 404 | `denied_file` | A file the denylist keeps out of every store |
| 404 | `no_source` | Sources not stored for the repo, snippets off, or no stored source for the file |
| 404 | `unknown_repo` | A repo the host does not serve |
| 405 | `invalid_argument` | Another method than `GET` for data, or than `POST` for a tool |
| 422 | the tool's own | The tool's own error, as the tool wrote it |
| 500 | `internal` | An exception, or no built viewer bundle |
| 503 | `not_built` | A repo with no usable store |

`hakutaku view`'s own server, which serves the page at `/` and the API under `/api/`, answers these
besides, in plain text:

| Status | Body | When |
|---|---|---|
| 400 | `bad request` | A request target that is not a path, or a request it cannot parse |
| 403 | `forbidden` | An API call without the session, or with another |
| 405 | `method not allowed` | An `OPTIONS` request, or another method than `GET` outside the API |
| 413 | `payload too large` | A body over 65,536 bytes |
| 421 | `misdirected request` | A `Host` header that is not `127.0.0.1:<port>` or `localhost:<port>` |
| 500 | `internal error` | An exception |

## Security

**The served page's policy,** `VIEWER_CSP`, allows its own origin and nothing else:

```text
default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
```

The page has no inline script and no `<style>` block. Each asset carries `default-src 'none'`, so
the worker that highlights large files, which runs under its own script's policy, can fetch and
import nothing.

**The exported page's policy** sits in a `<meta>` tag, first in its head. It allows exactly the
page's one script and one style block, by their SHA-256 hashes, and the bundled fonts as `data:`
URIs:

```text
default-src 'none'; script-src 'sha256-<script hash>'; style-src 'sha256-<style hash>'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'
```

No markup carries a `style` attribute, which a hash cannot allow; computed values, such as positions
and sizes, go through `element.style`, which no policy blocks.

**Escaping.** Everything a repository controls, its paths and names as well as its text, reaches the
page as text, or through an escaping function. highlight.js's output is the only HTML built from
source, and highlight.js escapes what it reads; code in a language it does not highlight is escaped
by the viewer itself. An exported page's data block writes every `<`, `>` and `&` as a JSON escape,
so nothing in it can end the block; and the build, like every export, refuses a script or styles
that could end their element early, or keep it from ending.

**The session and the Host.** The link's session is 32 random bytes, which every API call must send
as `x-hakutaku-session`; the server compares it in constant time, and answers 403 without it. The
`Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, or the answer is 421: a page of
another site, reached through a name that resolves to `127.0.0.1`, cannot talk to the server. There
is no CORS header and no preflight, and the server is read-only: it runs the read-only tools only.

**Framing.** The served page forbids framing (`frame-ancestors 'none'`). An exported page cannot: a
policy in a `<meta>` tag cannot carry `frame-ancestors`, so any site can frame a published export. It
holds no session and asks nothing of anyone, but think before publishing one written with
`--with-source`.

## Performance

**The budgets,** for a mid-range laptop (4 cores, integrated graphics) running current Chrome and
Firefox:

| Production files | First map | Pan and zoom | Find | Tab memory |
|---|---|---|---|---|
| Up to 2,000 | 1 s or less | 60 fps | 30 ms or less | 250 MB or less |
| Up to 20,000 | 3 s or less, at Core depth | 30 fps or more | 50 ms or less | 600 MB or less |

Find takes 50 ms or less over 100,000 items, and no step blocks the page for more than 50 ms.

**How the viewer keeps to them:**

- the map comes as compact arrays, with the outlines and the files that change together; above
  2,000 production files those two are fetched one file at a time, when they are needed, and the
  source of a file always is;
- at most 15,000 curves are drawn in a frame; beyond that, only the core view's and the selection's;
- labels go through a grid, and the layout is computed, never simulated;
- Find keeps the best matches in one pass, and never sorts every match;
- a file over 2,500 lines or 16,384 characters is highlighted in a worker, never on the page, and
  added at most 100 lines and 65,536 characters at a time, one chunk per task; a chunk is laid out
  only once it comes near the view, and then whole.

**How they are checked.** Two spec files, `test/e2e/first-run.spec.ts` and
`test/e2e/performance.spec.ts`, measure the budgets in Chromium and Firefox. CI runs them on every
push, with the bounds a shared runner can keep: a runner has no GPU, so both browsers run headless
there, Chromium drawing WebGL in software (SwiftShader), and CI checks only what does not depend on
the display. The bench runs the same files on the laptop, with the budgets themselves as bounds,
and adds the frame rate and the memory. It runs Chromium and Firefox headed, in windows on the
laptop's own display and GPU, with no software renderer forced, one test at a time; each browser
must draw the map with WebGL, and the memory is read in Chromium only. So it needs a desktop
session, never a CI runner:

```sh
npm run build
npm run bench:viewer
```

| Check | CI | Bench |
|---|---|---|
| First map, sample | 3,000 ms or less | 1,000 ms or less |
| First map, 20,000 files at Core depth | 9,000 ms or less | 3,000 ms or less |
| Find, sample | 50 ms or less | 30 ms or less |
| Find, 20,000 files | 50 ms or less | 50 ms or less |
| Pan and zoom, sample and 20,000 files | not checked | 57 fps or more, and 30 fps or more |
| Tab memory, sample and 20,000 files (Chromium) | not checked | 250 MB or less, and 600 MB or less |
| Longest task during Find, a selection and the 6,000-line Source tab (Chromium) | under 200 ms | under 50 ms |
| The same interaction, from its first key to the Source tab's last line (Firefox) | under 10 s | under 3 s |

- *First map* is the performance mark `hakutaku:first-map`, which the page sets on the map's first
  frame, from the start of the page's navigation. In a browser without WebGL it is the moment the
  list view takes the map's place.
- *Find* is the performance measure `hakutaku:find`, which times each search.
- *Pan and zoom* counts the frames drawn during a scripted pan and zoom of 2 s; 57 fps is 60 fps,
  allowing for the timing of `requestAnimationFrame`.
- *Tab memory* is Chromium's JS heap total, read through the DevTools protocol.
- *Longest task* reads Chromium's long-task entries. Chromium reports a long frame only when some
  script runs in it, so the check asks for a callback on every frame, and a frame that only lays
  out and paints counts too. Firefox reports none, so there the whole interaction is timed instead.

The 20,000-file repository is made by `fixtures/scale/generate.mjs` when CI is set, or when
`HAKUTAKU_E2E_WITH_SCALE=1`, which `npm run bench:viewer` sets along with `HAKUTAKU_BENCH=1`. The
bench's numbers will be published here once they are measured on a reference laptop.

**The exported page's size,** as `hakutaku view --export` writes it, with and without
`--with-source`, rounded, since every change to the viewer's own script moves it by a few kilobytes:

| Repository | Without sources | With sources |
|---|---|---|
| `observatory`, the sample: 71 production files of 142, 301 definitions, 469 answers | about 1.1 MB | about 1.3 MB |
| A generated repository, `--files 2298`: 1,998 production files of 2,298, 15,456 definitions, 17,782 answers | about 27 MB | about 33.5 MB |
| A generated repository, `--files 2304`: 2,003 production files of 2,304, over the limit, so no answers | about 1.2 MB | about 7.7 MB |

Each repository was mapped at the default detail, the generated ones as
`node fixtures/scale/generate.mjs --files <n> --out <dir>` writes them. The answers make most of a
page, one for each file, definition, component and library, and above 2,000 production files the
page holds none.

## Accessibility

- **Keyboard.** Everything works from the keyboard (the keys are above). Tab moves through the
  panels, a selection moves the focus to the details' heading, and the focus shows as an orange
  outline, 2 px or wider, drawn whole and on top.
- **Screen readers.** A screen reader cannot read the map's canvas, so its content also exists as
  HTML: the list view, the Core and Hotspots lists, and the details panel, whose tabs are tabs and
  whose rows are buttons. A polite live region says each selection, and each change of lens or
  depth. The Source tab lists its marked lines after the code.
- **Colour is never the only signal.** Hotspots are also larger, cycles are also listed and
  filtered, and "no test mentions it" is also in each definition's dot title and in the definitions
  list.
- **Contrast.** Text reaches 4.5:1, WCAG AA. The faintest ink is for decoration only, and the marks
  and the curves that carry meaning reach 3:1.
- **Hit targets.** Every target meets WCAG 2.2's target size, by its own size or by its spacing; the
  13 px definition dots also have full-size rows in the definitions list.
- **Reduced motion** turns the camera's moves and the source view's smooth scrolling off.
- **One theme:** a dark one, with `color-scheme: dark`.

CI holds the viewer to these: an axe scan of each panel, in each state it takes, finds nothing
serious or critical, the target size included, and the page's headings read in order under its one
level-one heading; a keyboard-only walk reaches every level; and wherever Tab goes, the focus ring
shows whole.

## Credits

The viewer bundles [sigma.js](https://github.com/jacomyal/sigma.js) and
[graphology](https://github.com/graphology/graphology), with graphology's utilities and the
[events](https://github.com/browserify/events) package,
[highlight.js](https://github.com/highlightjs/highlight.js) and the
[IBM Plex](https://github.com/IBM/plex) fonts. [NOTICE](../NOTICE) names each, with its version,
licence and copyright line, and the tools the viewer is built and tested with. The viewer's
scripts, served or inlined into an exported page, open with the full licence of each package
bundled into them, and its styles with the fonts' licence, the SIL Open Font License 1.1.
