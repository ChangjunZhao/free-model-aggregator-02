// free-model-aggregator-02 entry: one server, two client wires, and a real free model behind
// every answer. Built from the starter in the kit (same lifecycle, same routes, same catalog)
// with its routing, failover and cooldown gaps closed: candidates ranked by the brief's
// rating_milli, 429/5xx failover down the ranked chain with the refusals reported on
// x-makefun-upstream-failures, and deterministic per-model cooldowns by prompt index.
//
// WHAT A TRIAL GIVES YOU
//   A trial runs this server as `node /bot/main.ts` from your repository's root, with Node 22's standard
//   library alone (nothing is installed; TypeScript runs directly, and a relative import needs its .ts
//   extension). The env is at $MAKEFUN_ENV_URL; your model calls go through the grader's gateway at
//   $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter on the key you pushed to the
//   competition. The brief at $MAKEFUN_PROMPT_FILE carries two documents:
//     - the free model list: each free OpenRouter model's gateway id
//       (`openrouter/<vendor>/<model>:free`), its published rating in milli-points, what it can do
//       (tools, vision, JSON mode, context length) and its free flag;
//     - the six prompts: each one's id, its api (openai or anthropic), whether it streams, its weight
//       (1 or 2) and the requirements a model must meet to serve it. Each prompt carries a unique token
//       the answer must contain.
//   The server:
//     1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there on one layout);
//     2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>, "catalog": <catalog>};
//     3. serves GET /v1/models (answering in the shape of the auth header it got: x-api-key means
//        Anthropic, Authorization means OpenAI), POST /v1/chat/completions and POST /v1/messages, each
//        with a JSON body or with server-sent events;
//     4. answers each prompt by dialling ONE free model through the gateway. OPENAI_API_KEY in the
//        sandbox is a dummy the gateway swaps for the OpenRouter key you pushed; the real key never
//        enters the sandbox;
//     5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env says {"done": true}. A
//        process still running when the wall ends scores zero, so never wait for anything else.
//   `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts; the
//   register body's catalog is that same document, byte for byte.
//
// THE MODEL RULE
//   Whatever this server reports in a response's `model` field must be the model it actually dialled.
//   The house records every gateway call and scores the model that really answered. This starter sends
//   the brief's model id in the gateway request and puts that same id back on every answer and every
//   streamed chunk (the provider's own answer spells it without the gateway's `openrouter/` prefix), so
//   its claim is the call it made, never another. A prompt whose reported model has no matching
//   successful call in the house's record earns nothing.
//
// WHAT THIS ENTRY DOES DIFFERENTLY (the starter's marked gaps, closed)
//   - quality (60%): candidates that meet the prompt's requirements are ranked by the brief's
//     rating_milli, best first, equal ratings broken by model id; the first that answers serves.
//   - failover (10%): a 429 or 5xx walks down the ranked chain (at most 8 tries a prompt); every
//     refusal is reported back on x-makefun-upstream-failures, the only way the failover column
//     can see a refusal the server retried and then served. A 401/403/400/404 is not per-model
//     and is never retried; an unreachable gateway ends the prompt at once.
//   - rate limits: refusals cool a model down deterministically, by prompt index and never by wall
//     clock, so a replay reproduces every choice: a 429 cools it for the rest of the trial, a 5xx
//     for the next prompt only. A cooling model is never dialled, so one rate-limited model cannot
//     take the later prompts down with it and no call is wasted on it (the tie-break counts calls).
//   - the catalog (5%): exactly the free models the brief names, registered and answered on both
//     auth headers, no more and no fewer.
//   The trial's rules are in the kit's RULES.txt; read them for the score's columns and the tie-break.
//
// FILES
//   main.ts            this server: the brief, the catalog, the routes, the register and the poll.
//   lib/providers.ts   the brief's types and parser, the free model list, the catalog.
//   lib/wire.ts        Anthropic <-> Chat Completions translation, the model field, the SSE writers.
//   LICENSE            MIT: keep it or replace it with another OSI-approved license.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this baseline reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** The prompt index of the request now being served, set by requirementsFor. */
let currentPromptIndex = 0;

/**
 * Per-model deterministic cooldowns, keyed by prompt index (never wall-clock time: a replay must
 * reproduce every choice from the brief, the requests and the gateway's answers alone).
 * coolUntil[model] = the prompt index before which the model is skipped; a 429 cools it for the
 * rest of the trial (a free-tier rate limit does not clear inside one six-prompt trial), a 5xx
 * cools it for the next prompt only (a transient upstream failure may clear).
 */
const coolUntil = new Map<string, number>();
/** The most models tried for one prompt: enough to walk down the rating order, few enough that a dead gateway cannot burn the tie-break (fewer gateway calls win an exact score tie). */
const MAX_ATTEMPTS_PER_PROMPT = 8;
/**
 * Refusal statuses worth failing over on: a rate limit or an upstream failure may clear on another
 * model. A 401/403 means the pushed key is missing or wrong and no model would answer; a 400/404
 * means the request itself is wrong. Neither is per-model, so neither is retried.
 */
const FAILOVER_STATUSES = new Set([429, 500, 502, 503, 504]);

type FailureRow = { status: number; code: string; model: string | null };

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * Every free model that meets `requires`, best first. Quality is 60% of the score and is the sealed
 * rating of the model that really served the prompt over the best rating for a free model meeting its
 * requirements, so the order is the brief's rating_milli descending. Equal ratings break by model id,
 * so the order is the same on every run with no randomness and no wall clock. A model cooling down
 * from an earlier refusal is skipped: spending a call on it would most likely refuse again and cost
 * the tie-break.
 */
function rankedCandidates(requires: Requirement, promptIndex: number): ModelRow[] {
  const out: ModelRow[] = [];
  for (const model of freeModels(brief)) {
    if (!meetsRequirements(requires, capabilitiesOf(model))) continue;
    if ((coolUntil.get(model.id) ?? -1) > promptIndex) continue;
    out.push(model);
  }
  out.sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Cool a model down after a refusal: a 429 for the rest of the trial, a 5xx for one prompt. */
function recordRefusal(modelId: string, status: number, promptIndex: number): void {
  if (status === 429) coolUntil.set(modelId, Number.MAX_SAFE_INTEGER);
  else coolUntil.set(modelId, Math.max(coolUntil.get(modelId) ?? -1, promptIndex + 2));
}

/** The short code for one refusal, for the x-makefun-upstream-failures trail. */
function failureCode(status: number, bodyText: string): string {
  if (status === 429) return 'rate_limited';
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === 'string' && error !== '') return error.slice(0, 64);
      if (isRecord(error)) {
        if (typeof error.code === 'string' && error.code !== '') return error.code.slice(0, 64);
        if (typeof error.code === 'number') return `upstream_${error.code}`;
        if (typeof error.message === 'string' && error.message !== '') return error.message.slice(0, 64);
      }
    }
  } catch {
    // Not JSON: fall through to the generic code.
  }
  return 'upstream_error';
}

type AttemptResult = {
  upstream: Response | null;
  modelId: string | null;
  failures: FailureRow[];
  refusedStatus: number | null;
  refusedText: string;
};

/**
 * Dial the ranked candidates in order until one answers or the chain runs out. `buildRequest(model)`
 * turns the client's body into the gateway body naming `model` (for the OpenAI wire it is the body
 * itself; for the Anthropic wire it is the translation). A refusal worth failing over on tries the
 * next model; anything else ends the prompt at once. An unreachable gateway ends it too: another
 * model would dial the same dead gateway.
 */
async function attempt(body: Json, buildRequest: (model: string) => Json): Promise<AttemptResult> {
  const failures: FailureRow[] = [];
  const requires = requirementsFor(body);
  let lastStatus: number | null = null;
  let lastText = '';
  for (const candidate of rankedCandidates(requires, currentPromptIndex).slice(0, MAX_ATTEMPTS_PER_PROMPT)) {
    let tried: Response;
    try {
      tried = await dial(candidate.id, buildRequest(candidate.id));
    } catch (err) {
      return { upstream: null, modelId: null, failures, refusedStatus: null, refusedText: (err as Error).message };
    }
    if (tried.ok && tried.body !== null) {
      return { upstream: tried, modelId: candidate.id, failures, refusedStatus: null, refusedText: '' };
    }
    const text = await tried.text();
    failures.push({ status: tried.status, code: failureCode(tried.status, text), model: candidate.id });
    lastStatus = tried.status;
    lastText = text;
    if (!FAILOVER_STATUSES.has(tried.status)) {
      return { upstream: null, modelId: null, failures, refusedStatus: tried.status, refusedText: text };
    }
    recordRefusal(candidate.id, tried.status, currentPromptIndex);
  }
  return { upstream: null, modelId: null, failures, refusedStatus: lastStatus, refusedText: lastText };
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  currentPromptIndex = manifestIndex;
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // TODO(workload): the brief's prompt list is the declared source of each request's requirements; this
  // fallback is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

/**
 * The x-makefun-upstream-failures header for a prompt served after refusals. The failover column
 * can only see a recovered refusal through this trail: without it a retry that then served is
 * invisible to it. At most 8 rows, each {"status", "code", "model"}; a missing, malformed or
 * over-long header reads as no trail at all.
 */
function trailHeaders(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  const value = JSON.stringify(failures.slice(0, 8));
  if (Buffer.byteLength(value) > 8192) return {};
  return { 'x-makefun-upstream-failures': value };
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

/** A refused or broken gateway call as a 502 in the client's wire: the prompt is lost. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, text: string): void {
  if (wire === 'anthropic') {
    sendError(res, wire, 502, 'api_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`);
  } else {
    sendError(res, wire, 502, 'upstream_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`);
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const { upstream, modelId, failures, refusedStatus, refusedText } = await attempt(body, (m) => ({ ...body, model: m }));
  if (upstream === null || modelId === null) {
    if (refusedStatus !== null) return refused(res, 'openai', refusedStatus, refusedText);
    if (refusedText !== '') return sendError(res, 'openai', 502, 'upstream_unreachable', refusedText);
    return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');
  }
  const trail = trailHeaders(failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body, modelId)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, modelId), trail);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const { upstream, modelId, failures, refusedStatus, refusedText } = await attempt(body, (m) => anthropicToOpenAI(body, m));
  if (upstream === null || modelId === null) {
    if (refusedStatus !== null) return refused(res, 'anthropic', refusedStatus, refusedText);
    if (refusedText !== '') return sendError(res, 'anthropic', 502, 'api_error', refusedText);
    return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  }
  const trail = trailHeaders(failures);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body, modelId)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, modelId), trail);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
