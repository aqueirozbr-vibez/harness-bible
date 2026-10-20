import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import { AppError } from "@/lib/errors";

import { MODEL_PRICES } from "@/lib/gateway/prices";
import { requestWithinLimit } from "@/lib/improve/media";

import { answer, chunks, CountTokensRequestSchema, mediaTokensOf, requestText, StubCauseSchema, StubRefusalSchema, StubRequestSchema, tokensOf, type StubAnswer, type StubRefusalCategory, parseStubGrade, STUB_ADJUDICATIONS, STUB_CLAIMS, STUB_GRADES } from "./answer";
import { embeddings, EmbeddingsRequestSchema } from "./embed";
import { budgetExceeded, budgetMessage, charge, deleteKeys, DeleteKeysSchema, findKey, GenerateKeySchema, keyInfo, mintKey, type KeyRecord, type KeyTable } from "./keys";
import { reranked, RerankRequestSchema } from "./rerank";
import { hasWebTools, isPlanning, isWriting, PLAN_HEADER, planningOutput, RESEARCH_HEADER, researchAnswer, StubPlanSchema, StubResearchSchema, StubWriteSchema, unknownTool, WRITE_HEADER, writingOutput, type StubResearchAnswer } from "./research";

/*
 * The stub gateway (feature-specs/11 § 4): the surface `lib/gateway/client.ts` and the key script use, in
 * LiteLLM's shapes, and nothing more. `/v1/messages` (streaming and non-streaming) and
 * `/v1/messages/count_tokens` in the Anthropic Messages format with the Anthropic error envelope the proxy's
 * native route returns; `/v1/embeddings` in the OpenAI shape LiteLLM's route answers, with the deterministic
 * vectors of `embed.ts`, and `/rerank` in the Cohere shape it normalises to, with the overlap scores of
 * `rerank.ts` (feature-specs/12 § 9) — both refuse a key whose budget is spent and neither charges it, because
 * `lib/gateway/prices.ts` has no rate for either pin (12 § 3, BLOCKED), so § 9's "count against the stub's key and
 * budget table" is deliberately half done until the rates arrive, not an oversight; `/key/generate`, `/key/delete`, `/key/info` over an in-memory
 * table under the master key; the budget refusal before any answer (HTTP 429, `rate_limit_error`, "Budget has been exceeded!", the
 * proxy's own form at the pinned image); `x-hb-stub-fail: 500 | timeout` for the fail-closed tests and
 * `x-hb-stub-refusal: <category>` for the provider's safety stop (HTTP 200, `stop_reason: "refusal"`);
 * `x-hb-stub-claim: uncited` for an answer with one claim its section does not support; and
 * `x-litellm-call-id` on every answer (§ 3.5). It never sees a provider key and never logs a virtual key.
 * Since unit 58a (feature-specs/41 § 3) a request carrying the provider's two web tools gets the researcher's
 * answer of `research.ts` — tool-use and tool-result blocks for fixture pages, then the findings, `pause_turn` and
 * its continuation for the `pause` fixture — named by `x-hb-stub-research`, and a planner's request on `hb-small`
 * gets the plan `x-hb-stub-plan` names; a tool of any other type is refused with 400, as the provider refuses a tool
 * it does not know, and so is a streamed tool turn, which the product never sends. Since unit 69d (feature-specs/48
 * § 5.8) a request to `hb-frontier` with no tool that carries the research writer's heading gets the report
 * `x-hb-stub-write` names.
 */

export const STUB_PORT = 4001;
export const SMALL_ALIAS = "hb-small";
export const FRONTIER_ALIAS = "hb-frontier";
const FAIL_HEADER = "x-hb-stub-fail";
const CAUSE_HEADER = "x-hb-stub-cause";
const REFUSAL_HEADER = "x-hb-stub-refusal";
const WALK_HEADER = "x-hb-stub-walk";
const CLAIM_HEADER = "x-hb-stub-claim";
const GRADE_HEADER = "x-hb-stub-grade";
const ADJUDICATE_HEADER = "x-hb-stub-adjudicate";
/* `400` (unit 49f) stands in for the provider refusing a well-formed request it cannot read (a PDF's pages, its encryption). */
const FailSchema = z.enum(["500", "timeout", "400"]);
const WalkSchema = z.enum(["invent"]);
const ClaimSchema = z.enum(STUB_CLAIMS);
const GradeSchema = z.enum(STUB_GRADES);
const AdjudicateSchema = z.enum(STUB_ADJUDICATIONS);

export interface StubOptions {
  readonly masterKey: string;
  /** Alias → pinned model id, read from `infra/gateway/litellm.yaml` by `aliasesFromConfig`. */
  readonly aliases: ReadonlyMap<string, string>;
  readonly host?: string;
  /** 0 asks the operating system for a free port (tests). */
  readonly port?: number;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface RunningStub {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface StubState {
  readonly keys: KeyTable;
  /** sha256 of every cacheable prefix answered so far: the second request with the same prefix reads the cache. */
  readonly prefixes: Set<string>;
}

/** `model_name` / `model` pairs of the gateway configuration, the provider prefix dropped (`anthropic/claude-opus-5` → `claude-opus-5`). */
export function aliasesFromConfig(yaml: string): ReadonlyMap<string, string> {
  const names = [...yaml.matchAll(/^\s*-\s+model_name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const models = [...yaml.matchAll(/^\s*model:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/^[^/]+\//, ""));
  if (names.length === 0 || names.length !== models.length) throw new AppError("GATEWAY_STUB_CONFIG", "litellm.yaml: every model_name needs one model");
  return new Map(names.map((name, i) => [name, models[i]]));
}

type Principal = { readonly kind: "master" } | { readonly kind: "key"; readonly record: KeyRecord };

/** A refusal the stub answers with `status`; `code` names the HTTP status in the error catalogue's form. */
class StubRefusal extends AppError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GATEWAY_STUB_${status}`, message);
    this.name = "StubRefusal";
    this.status = status;
  }
}

/** HTTP status → the Anthropic error type (LiteLLM's `ANTHROPIC_ERROR_TYPE_MAP`). */
const ERROR_TYPES: Readonly<Record<number, string>> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

function anthropicError(status: number, message: string): Readonly<Record<string, unknown>> {
  return { type: "error", error: { type: ERROR_TYPES[status] ?? "api_error", message } };
}

/** LiteLLM's management routes answer in the OpenAI error form, not the Anthropic envelope. */
function managementError(status: number, message: string): Readonly<Record<string, unknown>> {
  return { error: { message, type: status === 401 ? "auth_error" : "invalid_request_error", param: "None", code: String(status) } };
}

function bearerOf(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * A model request's body, refused with the provider's 413 `request_too_large` past its documented 32 MB (unit 49f;
 * lib/improve/media.ts `PROVIDER_REQUEST_MAX_BYTES`): the product checks the size itself before it sends, and the
 * stub holds it to that, as the provider would.
 */
async function readModelBody(req: IncomingMessage): Promise<string> {
  const body = await readBody(req);
  if (!requestWithinLimit(Buffer.byteLength(body))) throw new StubRefusal(413, "the request exceeds the 32 MB maximum request size");
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new StubRefusal(400, "the request body is not JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

/** How the answer stopped: `end_turn`, or the provider's refusal with its category (`x-hb-stub-refusal`). */
interface StubStop {
  readonly stop_reason: "end_turn" | "refusal";
  readonly stop_details: { readonly type: "refusal"; readonly category: StubRefusalCategory; readonly explanation: null } | null;
}

function stopOf(category: StubRefusalCategory | null): StubStop {
  return category === null ? { stop_reason: "end_turn", stop_details: null } : { stop_reason: "refusal", stop_details: { type: "refusal", category, explanation: null } };
}

/** The stream the SDK's `finalMessage()` reassembles: message_start … message_stop, the usage split as the API splits it. */
function writeStream(res: ServerResponse, message: Readonly<Record<string, unknown>>, result: StubAnswer, callId: string, stop: StubStop): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-litellm-call-id": callId });
  const event = (type: string, data: Readonly<Record<string, unknown>>): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 1 } } });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const piece of chunks(result.text)) event("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { ...stop, stop_sequence: null }, usage: result.usage });
  event("message_stop", {});
  res.end();
}

/**
 * The stream of a tool turn (feature-specs/41 § 3; the reader streams since 2026-10-10): a tool-use or tool-result block
 * arrives whole in its `content_block_start`, as the API sends them, and a text block as its deltas; the usage of the
 * `message_delta` carries the tool counts, which is where the SDK's `finalMessage()` reads them.
 */
function writeToolStream(res: ServerResponse, message: Readonly<Record<string, unknown>>, result: StubResearchAnswer, callId: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-litellm-call-id": callId });
  const event = (type: string, data: Readonly<Record<string, unknown>>): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...result.usage, output_tokens: 1, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } } } });
  result.content.forEach((block, index) => {
    if (block.type === "text") {
      event("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const piece of chunks(String(block.text))) event("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    } else {
      event("content_block_start", { index, content_block: block });
    }
    event("content_block_stop", { index });
  });
  event("message_delta", { delta: { stop_reason: result.stop_reason, stop_details: null, stop_sequence: null }, usage: { ...result.usage, server_tool_use: result.serverToolUse } });
  event("message_stop", {});
  res.end();
}

/** Starts the stub; `close()` stops it. Exported so the tests run it in-process on a free port. */
export function startStub(options: StubOptions): Promise<RunningStub> {
  const now = options.now ?? ((): Date => new Date());
  const log = options.log ?? ((line: string): void => console.log(line));
  const state: StubState = { keys: new Map(), prefixes: new Set() };

  function authenticate(req: IncomingMessage): Principal {
    const bearer = bearerOf(req);
    if (bearer === null) throw new StubRefusal(401, "No API key provided");
    if (bearer === options.masterKey) return { kind: "master" };
    const record = findKey(state.keys, bearer, now());
    if (record === null) throw new StubRefusal(401, "Authentication Error, Invalid proxy server token passed");
    return { kind: "key", record };
  }

  function requireMaster(req: IncomingMessage): void {
    if (bearerOf(req) !== options.masterKey) throw new StubRefusal(401, "Authentication Error, only the master key may manage keys");
  }

  /** `x-hb-stub-refusal`: the answer stops as the provider's safety stop, in its category, on both paths. */
  function refusalSwitch(req: IncomingMessage): StubRefusalCategory | null {
    const value = req.headers[REFUSAL_HEADER];
    if (value === undefined) return null;
    const parsed = StubRefusalSchema.safeParse(value);
    if (!parsed.success) throw new StubRefusal(400, `${REFUSAL_HEADER} must be one of ${StubRefusalSchema.options.join(", ")}`);
    return parsed.data;
  }

  /**
   * `x-hb-stub-fail`: a 500 answers at once; a timeout never answers, until the client gives up; a 400 is the
   * provider refusing a well-formed request it cannot read (unit 49f: a PDF's pages or its encryption), answered here.
   */
  function failSwitch(req: IncomingMessage): "500" | "timeout" | null {
    const value = req.headers[FAIL_HEADER];
    if (value === undefined) return null;
    const parsed = FailSchema.safeParse(value);
    if (!parsed.success) throw new StubRefusal(400, `${FAIL_HEADER} must be 500, 400 or timeout`);
    if (parsed.data === "400") throw new StubRefusal(400, "the provider could not read the request (x-hb-stub-fail: 400)");
    return parsed.data;
  }

  /** The key's own model list, as the proxy enforces it. */
  function requireKeyModel(alias: string, principal: Principal): void {
    if (principal.kind === "key" && principal.record.models.length > 0 && !principal.record.models.includes(alias)) {
      throw new StubRefusal(401, `key not allowed to access model. This key can only access models=${principal.record.models.join(",")}. Tried to access ${alias}`);
    }
  }

  /** `/v1/messages` serves the two aliases `lib/gateway/prices.ts` prices; an embedding alias there is a defect. */
  function messagesModelOf(alias: string, principal: Principal): string {
    const pinned = options.aliases.get(alias);
    if (pinned === undefined || MODEL_PRICES[pinned] === undefined) throw new StubRefusal(400, `model ${alias} is not a messages alias of the gateway`);
    requireKeyModel(alias, principal);
    return pinned;
  }

  /** `/v1/embeddings` and `/rerank` serve the aliases `lib/gateway/prices.ts` has no rate for yet (12 § 3). */
  function unpricedModelOf(alias: string, principal: Principal): string {
    const pinned = options.aliases.get(alias);
    if (pinned === undefined) throw new StubRefusal(400, `model ${alias} is not an alias of the gateway`);
    requireKeyModel(alias, principal);
    return pinned;
  }

  async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = authenticate(req);
    const parsed = StubRequestSchema.safeParse(parseJson(await readModelBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    const request = parsed.data;
    const pinned = messagesModelOf(request.model, principal);
    const fail = failSwitch(req);
    if (fail === "timeout") return;
    if (fail === "500") throw new StubRefusal(500, "the stub gateway failed on request (x-hb-stub-fail)");
    const causeHeader = req.headers[CAUSE_HEADER];
    const cause = StubCauseSchema.safeParse(causeHeader ?? "none");
    if (!cause.success) throw new StubRefusal(400, `${CAUSE_HEADER} must be one of ${StubCauseSchema.options.join(", ")}`);
    const stop = stopOf(refusalSwitch(req));
    if (principal.kind === "key" && budgetExceeded(principal.record)) throw new StubRefusal(429, budgetMessage(principal.record));

    const walkHeader = req.headers[WALK_HEADER];
    const walk = walkHeader === undefined ? null : WalkSchema.safeParse(walkHeader);
    if (walk !== null && !walk.success) throw new StubRefusal(400, `${WALK_HEADER} must be one of ${WalkSchema.options.join(", ")}`);
    const claimHeader = req.headers[CLAIM_HEADER];
    const claim = claimHeader === undefined ? null : ClaimSchema.safeParse(claimHeader);
    if (claim !== null && !claim.success) throw new StubRefusal(400, `${CLAIM_HEADER} must be one of ${ClaimSchema.options.join(", ")}`);
    const gradeHeader = req.headers[GRADE_HEADER];
    const grade = typeof gradeHeader === "string" ? parseStubGrade(gradeHeader) : null;
    if (gradeHeader !== undefined && grade === null) throw new StubRefusal(400, `${GRADE_HEADER} must be one of ${GradeSchema.options.join(", ")}, or a tier with its relevance and stake (B:direct:none)`);
    const adjudicateHeader = req.headers[ADJUDICATE_HEADER];
    const adjudicate = adjudicateHeader === undefined ? null : AdjudicateSchema.safeParse(adjudicateHeader);
    if (adjudicate !== null && !adjudicate.success) throw new StubRefusal(400, `${ADJUDICATE_HEADER} must be one of ${AdjudicateSchema.options.join(", ")}`);

    const stranger = unknownTool(request);
    if (stranger !== null) throw new StubRefusal(400, `tools: ${stranger} is not a tool this gateway knows (the provider's web_search_20260209 and web_fetch_20260209 are)`);
    if (hasWebTools(request)) {
      const fixtureHeader = req.headers[RESEARCH_HEADER];
      const fixture = StubResearchSchema.safeParse(fixtureHeader ?? "found");
      if (!fixture.success) throw new StubRefusal(400, `${RESEARCH_HEADER} must be one of ${StubResearchSchema.options.join(", ")}`);
      const research = researchAnswer({ request, price: MODEL_PRICES[pinned], fixture: fixture.data, prefixSeen: (sha) => state.prefixes.has(sha), now: now(), log });
      if (research.prefixSha256 !== null) state.prefixes.add(research.prefixSha256);
      if (principal.kind === "key") charge(state.keys, principal.record, research.costUsd);
      const callId = randomUUID();
      const researchMessage = { id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model: pinned, stop_sequence: null };
      if (request.stream === true) {
        writeToolStream(res, researchMessage, research, callId);
        return;
      }
      sendJson(res, 200, { ...researchMessage, content: research.content, stop_reason: research.stop_reason, stop_details: null, usage: { ...research.usage, server_tool_use: research.serverToolUse } }, { "x-litellm-call-id": callId });
      return;
    }
    const planHeader = req.headers[PLAN_HEADER];
    const plan = StubPlanSchema.safeParse(planHeader ?? "research");
    if (!plan.success) throw new StubRefusal(400, `${PLAN_HEADER} must be one of ${StubPlanSchema.options.join(", ")}`);
    const writeHeader = req.headers[WRITE_HEADER];
    const write = StubWriteSchema.safeParse(writeHeader ?? "report");
    if (!write.success) throw new StubRefusal(400, `${WRITE_HEADER} must be one of ${StubWriteSchema.options.join(", ")}`);

    const text = requestText(request);
    const result = answer({ request, smallAlias: SMALL_ALIAS, price: MODEL_PRICES[pinned], cause: cause.data, prefixSeen: (sha) => state.prefixes.has(sha), walk: walk === null ? null : walk.data, claim: claim === null ? null : claim.data, grade: grade === null ? null : grade.grade, classes: grade === null ? null : grade.classes, adjudicate: adjudicate === null ? null : adjudicate.data, planned: isPlanning(request.model, SMALL_ALIAS, text) ? planningOutput(text, plan.data) : null, written: isWriting(request.model, FRONTIER_ALIAS, text) ? writingOutput(requestText({ messages: request.messages }), write.data) : null });
    if (result.prefixSha256 !== null) state.prefixes.add(result.prefixSha256);
    if (principal.kind === "key") charge(state.keys, principal.record, result.costUsd);

    const callId = randomUUID();
    const message = { id: `msg_${randomUUID().replace(/-/g, "")}`, type: "message", role: "assistant", model: pinned, stop_sequence: null };
    if (request.stream === true) {
      writeStream(res, message, result, callId, stop);
      return;
    }
    sendJson(res, 200, { ...message, content: [{ type: "text", text: result.text }], ...stop, usage: result.usage }, { "x-litellm-call-id": callId });
  }

  async function countTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = authenticate(req);
    const parsed = CountTokensRequestSchema.safeParse(parseJson(await readModelBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    messagesModelOf(parsed.data.model, principal);
    const fail = failSwitch(req);
    if (fail === "timeout") return;
    if (fail === "500") throw new StubRefusal(500, "the stub gateway failed on request (x-hb-stub-fail)");
    sendJson(res, 200, { input_tokens: tokensOf(requestText(parsed.data)) + mediaTokensOf(parsed.data) });
  }

  /**
   * `/v1/embeddings` (feature-specs/12 § 9): the deterministic vectors of `embed.ts` under the same key, budget and
   * failure switches as a messages call. The cost is 0 because `lib/gateway/prices.ts` has no rate for the
   * embedding pin yet (12 § 3, BLOCKED), so the key's spend does not move for indexing.
   */
  async function embeddingsRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = authenticate(req);
    const parsed = EmbeddingsRequestSchema.safeParse(parseJson(await readBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    const pinned = unpricedModelOf(parsed.data.model, principal);
    const fail = failSwitch(req);
    if (fail === "timeout") return;
    if (fail === "500") throw new StubRefusal(500, "the stub gateway failed on request (x-hb-stub-fail)");
    if (principal.kind === "key" && budgetExceeded(principal.record)) throw new StubRefusal(429, budgetMessage(principal.record));
    const result = embeddings(parsed.data.input);
    sendJson(res, 200, { object: "list", model: pinned, ...result }, { "x-litellm-call-id": randomUUID() });
  }

  /**
   * `/rerank` (feature-specs/12 § 9): the overlap scores of `rerank.ts` under the same key, budget and failure
   * switches as an embeddings call, in the Cohere shape LiteLLM's route answers. The cost is 0 for the same reason
   * (no rate for the pin yet, 12 § 3, BLOCKED), so the key's spend does not move for re-ranking either.
   */
  async function rerankRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const principal = authenticate(req);
    const parsed = RerankRequestSchema.safeParse(parseJson(await readBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    const pinned = unpricedModelOf(parsed.data.model, principal);
    const fail = failSwitch(req);
    if (fail === "timeout") return;
    if (fail === "500") throw new StubRefusal(500, "the stub gateway failed on request (x-hb-stub-fail)");
    if (principal.kind === "key" && budgetExceeded(principal.record)) throw new StubRefusal(429, budgetMessage(principal.record));
    sendJson(res, 200, { id: randomUUID(), model: pinned, ...reranked(parsed.data) }, { "x-litellm-call-id": randomUUID() });
  }

  async function keyGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireMaster(req);
    const parsed = GenerateKeySchema.safeParse(parseJson(await readBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    const record = mintKey(state.keys, parsed.data, now());
    sendJson(res, 200, keyInfo(record, true));
  }

  async function keyDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requireMaster(req);
    const parsed = DeleteKeysSchema.safeParse(parseJson(await readBody(req)));
    if (!parsed.success) throw new StubRefusal(400, issuesOf(parsed.error));
    const deleted = deleteKeys(state.keys, parsed.data.keys);
    if (deleted.length === 0) throw new StubRefusal(404, "No keys found");
    sendJson(res, 200, { deleted_keys: deleted });
  }

  function keyInfoRoute(req: IncomingMessage, res: ServerResponse, url: URL): void {
    requireMaster(req);
    const key = url.searchParams.get("key");
    if (key === null) throw new StubRefusal(400, "key is required");
    const record = findKey(state.keys, key, now());
    if (record === null) throw new StubRefusal(404, "Key not found");
    sendJson(res, 200, { key, info: keyInfo(record, false) });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const management = path.startsWith("/key/");
    try {
      if (method === "GET" && path === "/health/liveliness") return sendJson(res, 200, "I'm alive!");
      if (method === "POST" && path === "/v1/messages") return await messages(req, res);
      if (method === "POST" && path === "/v1/messages/count_tokens") return await countTokens(req, res);
      if (method === "POST" && path === "/v1/embeddings") return await embeddingsRoute(req, res);
      if (method === "POST" && path === "/rerank") return await rerankRoute(req, res);
      if (method === "POST" && path === "/key/generate") return await keyGenerate(req, res);
      if (method === "POST" && path === "/key/delete") return await keyDelete(req, res);
      if (method === "GET" && path === "/key/info") return keyInfoRoute(req, res, url);
      throw new StubRefusal(404, `${method} ${path} is not part of the stub gateway`);
    } catch (error: unknown) {
      const refusal = error instanceof StubRefusal ? error : new StubRefusal(500, error instanceof Error ? error.message : String(error));
      sendJson(res, refusal.status, management ? managementError(refusal.status, refusal.message) : anthropicError(refusal.status, refusal.message));
    } finally {
      log(`${method} ${path} ${res.headersSent ? res.statusCode : "held"}`);
    }
  }

  const server = createServer((req, res) => {
    void route(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? STUB_PORT, options.host ?? "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error === undefined ? done() : fail(error)));
          }),
      });
    });
  });
}
