// Reading the brief: the model list, the prompt list, and the catalog they make.
//
// A trial hands the server one file (MAKEFUN_PROMPT_FILE) that is mostly prose with two JSON
// documents embedded in it. Nothing in the prose is trusted: each document is located by the
// `schema` string it carries, and a document counts only when its schema belongs to this contest.
// The two documents are:
//
//   - the model list, schema `free-model-aggregator-02/models/v1`: one entry per free model,
//     keyed by the gateway id (`openrouter/<vendor>/<model>:free`), carrying the public rating in
//     milli-points, the capabilities a prompt may demand (tools, vision, JSON mode, context
//     length) and the free flag. A paid row is never served: this entry routes free models only.
//   - the prompt list, schema `free-model-aggregator-02/prompts/v1`: the six prompts the house's
//     client will send, in arrival order, each with its id, its wire (`openai` or `anthropic`),
//     whether it streams, its weight, and the requirements a serving model must meet. The server
//     reads both lists before the first request so it can route each arrival by its row.
//
// The brief may spell the lists under the sibling contest's names (`ratings` for the models,
// `manifest` for the prompts), and one document may carry both lists: the search below looks for
// arrays under either name, never for a name alone. Parsing is strict about shape and lenient
// about spelling: a row missing its id is dropped, a capability the brief does not state stays
// unknown (null) and never satisfies a requirement, and a model the brief does not call free is
// still free unless it says `free: false`.
//
// Nothing here consults a clock or a random source, so the catalog this file builds is the same
// on a live pass and on its replay, byte for byte — which is what the register body and
// `node main.ts --list` both print.

import { readFileSync } from 'node:fs';

export const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1';
export const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1';

/** Every schema in this contest's brief starts with this prefix; documents are found by it. */
const SCHEMA_PREFIX = 'free-model-aggregator-02/';

/** Where the free models live in public: the endpoint the gateway reaches for them. */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** The variable an entrant's OpenRouter key is pushed under: an entry secret, never in the sandbox. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  /** Which provider the model belongs to, as the brief names it (`openrouter`). */
  provider: string;
  display_name: string;
  /** The published rating in milli-points: the quality column is scored in these. */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What one prompt demands of a model: a model lacking it cannot serve the prompt. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt the client will send, as the brief lists it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

/** The brief as this file reads it. `error` is set when a document could not be read. */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** One model in the catalog document. */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** One provider in the catalog document. */
export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** What `--list` prints and what the entry POSTs to /register: the same document, byte for byte. */
export interface CatalogReport {
  providers: CatalogProvider[];
}

/** What a model can do, taken from its brief row (null: the brief did not say). */
export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** A string field, or '' when the value is not a string. */
function textOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** A finite number field, or null when the value is not one. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A boolean field, or null when the value is not one. */
function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * The index of the `}` that closes the object opening at `open`, or -1 when the text runs out
 * first. Braces inside strings do not count, and a backslash inside a string escapes the next
 * character, so an escaped quote does not end the string.
 */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Every JSON object in `text` that carries a string `schema`, in the order they appear. A `{`
 * that does not parse as JSON on its own is skipped and the scan moves on to the next one.
 */
function schemaDocuments(text: string): Json[] {
  const found: Json[] = [];
  let at = text.indexOf('{');
  while (at !== -1) {
    const end = closingBrace(text, at);
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(at, end + 1));
        if (isRecord(value) && typeof value.schema === 'string') found.push(value);
      } catch {
        // Not JSON on its own: look on.
      }
    }
    at = text.indexOf('{', at + 1);
  }
  return found;
}

/**
 * The first document under this contest's prefix that carries one of `keys` as an array, and the
 * key it was found under. A brief that spells its lists in the sibling's names still reads.
 */
function listDocument(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (!textOrEmpty(doc.schema).includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) {
      if (Array.isArray(doc[key])) return { doc, key };
    }
  }
  return null;
}

/**
 * One model row, or null when the row names no model. The id comes from `id`, or from `model`
 * under the provider that names it: a row giving the bare OpenRouter id (`vendor/model:free`)
 * and naming `openrouter` is routed as the gateway spells it (`openrouter/vendor/model:free`).
 * A row is free unless it says `free: false`, and a paid row is never routed.
 */
function toModel(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const bare = textOrEmpty(v.id) !== '' ? textOrEmpty(v.id) : textOrEmpty(v.model);
  if (bare === '') return null;
  const named = textOrEmpty(v.provider) !== '' ? textOrEmpty(v.provider) : textOrEmpty(v.wire);
  const id = named === 'openrouter' && !bare.toLowerCase().startsWith('openrouter/') ? `openrouter/${bare}` : bare;
  const shown = textOrEmpty(v.display_name) !== '' ? textOrEmpty(v.display_name) : bare;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: shown,
    rating_milli: finiteOrNull(v.rating_milli) ?? 0,
    context_length: finiteOrNull(v.context_length),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
    free: v.free !== false,
  };
}

/** One prompt row, or null when the row names no prompt. Only demands the brief states as true count. */
function toPrompt(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = textOrEmpty(v.id);
  if (id === '') return null;
  const needs = isRecord(v.requires) ? v.requires : {};
  const requires: Requirement = {};
  if (needs.tools === true) requires.tools = true;
  if (needs.vision === true) requires.vision = true;
  if (needs.json === true) requires.json = true;
  const floor = finiteOrNull(needs.min_context);
  if (floor !== null) requires.min_context = floor;
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires,
  };
}

/** The brief at `path`, its two documents found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = schemaDocuments(text);
  const modelsDoc = listDocument(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  }
  const models: ModelRow[] = [];
  for (const v of modelsDoc.doc[modelsDoc.key] as unknown[]) {
    const m = toModel(v);
    if (m !== null) models.push(m);
  }
  const promptsDoc = listDocument(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  }
  const prompts: PromptRow[] = [];
  for (const v of promptsDoc.doc[promptsDoc.key] as unknown[]) {
    const p = toPrompt(v);
    if (p !== null) prompts.push(p);
  }
  return { models, prompts, error: null };
}

/** The models this entry may serve: the brief's free ones, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** What a model can do, as its brief row states it. */
export function capabilitiesOf(model: ModelRow): Capabilities {
  return {
    context_length: model.context_length,
    tools: model.tools,
    vision: model.vision,
    json: model.json,
  };
}

/** Whether a model's capabilities meet one prompt's demands. An unknown capability never meets one. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}

/**
 * The catalog the brief's free model list makes: one provider, the models it serves.
 *
 * The base_url is the provider's public endpoint, never the gateway's trial-local address: the
 * gateway's origin differs between a live pass and its replay, and the catalog is part of the
 * state export a replay must reproduce byte for byte.
 *
 * This lists every free model in the brief — exactly the fourteen dialable ids the catalog
 * column scores — so keep it that way: register this set and keep GET /v1/models (both auth
 * headers) exactly that set, since listing fewer loses the column as surely as listing more.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
