import { Endpoint, EndpointTicket, RelayMode, SecretKey } from "@number0/iroh";
import { defineTool } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export const DSH_WEAVE_ALPN = "dsh-weave/1";
export const DSH_WEAVE_PROTOCOL_VERSION = 1;
export const DSH_WEAVE_STAGE = "transport-mvp";
export const name = "dsh-weave";
export const inject = ["connection", "tools", "agents", "sessions", "sessionTitle", "sessionPersistence", "workspaceRegistry"];
export const Config = Schema.object({
  trustedPeers: Schema.array(Schema.string()).default([]),
  secretKey: Schema.array(Schema.number()),
  identityPath: Schema.string(),
  peersPath: Schema.string(),
  persistIdentity: Schema.boolean().default(true),
  persistPeers: Schema.boolean().default(true),
  relayMode: Schema.union(["default", "disabled"]).default("default"),
  bindAddr: Schema.string().default("0.0.0.0:64605"),
  hostName: Schema.string(),
  acknowledgementTimeoutMs: Schema.number().min(100).max(120_000).default(10_000),
  shutdownTimeoutMs: Schema.number().min(1).max(30_000).default(1_000),
  maxConcurrentInbound: Schema.number().min(1).max(1_024).default(64),
  recentMessageLimit: Schema.number().min(100).max(100_000).default(10_000),
});

const ALPN_BYTES = [...new TextEncoder().encode(DSH_WEAVE_ALPN)];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
// Fix3+Fix4: 单帧上限 1MB→4MB — room.read 的批量历史响应经 ack 通道回传，
// 消息累积后远超原 64KB/4KB 限制导致 TooLong（UI 看不到历史聊天记录）；
// Fix4 覆盖 2000 条消息窗口内的最坏增量（≈2MB）+ 单条大消息裕量。
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const SYSTEM_TARGET = "dsh-weave/system/1";
const encode = (value) => [...encoder.encode(JSON.stringify(value))];
const decode = (bytes) => JSON.parse(decoder.decode(Uint8Array.from(bytes)));

export class DshWeaveTransport {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.identityPath = config.identityPath ?? join(homedir(), ".dsh", "dsh-weave", "identity.json");
    this.peersPath = config.peersPath ?? join(homedir(), ".dsh", "dsh-weave", "peers.json");
    this.hostName = config.hostName ?? hostname();
    this.endpoint = undefined;
    this.starting = undefined;
    this.trustedPeers = new Set();
    this.peerTickets = new Map();
    this.hostStates = new Map();
    this.remoteSessionStates = new Map();
    this.ready = this.#loadPeers(config.trustedPeers ?? []);
    this.listeners = new Set();
    this.recentMessages = new Map();
    this.inbound = new Set();
    this.saveTail = Promise.resolve();
    this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error("dsh-weave transport is closed");
    await this.ready;
    if (this.endpoint) return this.endpoint;
    if (!this.starting) this.starting = this.#start().catch((error) => { this.starting = undefined; throw error; });
    return this.starting;
  }
  async #start() {
    const builder = Endpoint.builder();
    builder.applyN0(); builder.alpns([ALPN_BYTES]);
    if (this.config.relayMode === "disabled") builder.relayMode(RelayMode.disabled());
    // Fix2: 固定端口 — DSH_WEAVE_PORT 环境变量优先，否则用 config.bindAddr
    const weavePort = Number(process.env.DSH_WEAVE_PORT ?? "");
    if (Number.isInteger(weavePort) && weavePort > 0 && weavePort < 65536) {
      builder.bindAddr("0.0.0.0:" + weavePort);
    } else if (this.config.bindAddr) {
      builder.bindAddr(this.config.bindAddr);
    }
    builder.secretKey(await this.#secretKey());
    const endpoint = await builder.bind();
    if (this.closed) { await endpoint.close(); throw new Error("dsh-weave transport closed while starting"); }
    this.endpoint = endpoint; void this.#acceptLoop(); return endpoint;
  }
  async #secretKey() {
    if (Array.isArray(this.config.secretKey) && this.config.secretKey.length === 32) return this.config.secretKey;
    if (this.config.persistIdentity === false) return SecretKey.generate().toBytes();
    try {
      const saved = JSON.parse(await readFile(this.identityPath, "utf8"));
      if (Array.isArray(saved?.secretKey) && saved.secretKey.length === 32 && saved.secretKey.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
        await chmod(dirname(this.identityPath), 0o700); await chmod(this.identityPath, 0o600);
        return saved.secretKey;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const secretKey = SecretKey.generate().toBytes();
    await mkdir(dirname(this.identityPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.identityPath), 0o700);
    const temporary = `${this.identityPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, secretKey })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.identityPath); await chmod(this.identityPath, 0o600);
    return secretKey;
  }
  async #loadPeers(configuredPeers) {
    for (const peerId of configuredPeers) if (typeof peerId === "string" && peerId) this.trustedPeers.add(peerId);
    if (this.config.persistPeers === false) return;
    try {
      const saved = JSON.parse(await readFile(this.peersPath, "utf8"));
      if (Array.isArray(saved?.peerIds)) for (const peerId of saved.peerIds) if (typeof peerId === "string" && peerId) this.trustedPeers.add(peerId);
      if (Array.isArray(saved?.tickets)) for (const entry of saved.tickets) {
        if (!entry || typeof entry.peerId !== "string" || typeof entry.ticket !== "string") continue;
        try {
          const ticketPeer = EndpointTicket.fromString(entry.ticket).endpointAddr().id().toString();
          if (ticketPeer !== entry.peerId) continue;
          this.trustedPeers.add(entry.peerId); this.peerTickets.set(entry.peerId, entry.ticket);
        } catch {}
      }
      await chmod(dirname(this.peersPath), 0o700); await chmod(this.peersPath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  async #savePeers() {
    if (this.config.persistPeers === false) return;
    const save = this.saveTail.then(async () => {
      await mkdir(dirname(this.peersPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.peersPath), 0o700);
      const temporary = `${this.peersPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 2, peerIds: this.peers(), tickets: this.endpoints() })}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.peersPath); await chmod(this.peersPath, 0o600);
    });
    this.saveTail = save.catch(() => {});
    return save;
  }
  async close() {
    this.closed = true;
    this.starting = undefined;
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    if (endpoint && !endpoint.isClosed()) await endpoint.close();
    if (this.inbound.size) {
      let timer;
      await Promise.race([
        Promise.allSettled([...this.inbound]),
        new Promise((resolve) => { timer = setTimeout(resolve, this.config.shutdownTimeoutMs ?? 1_000); timer.unref?.(); })
      ]).finally(() => clearTimeout(timer));
    }
  }
  async ticket() { return EndpointTicket.fromAddr((await this.start()).addr()).toString(); }
  async trust(ticket) { await this.ready; const id = EndpointTicket.fromString(ticket).endpointAddr().id().toString(); this.trustedPeers.add(id); this.peerTickets.set(id, ticket); await this.#savePeers(); return id; }
  async untrust(peerId) {
    await this.ready;
    if (typeof peerId !== "string" || !peerId) throw new Error("a peer id is required");
    const removed = this.trustedPeers.delete(peerId) || this.peerTickets.delete(peerId);
    this.peerTickets.delete(peerId); this.hostStates.delete(peerId);
    for (const key of this.remoteSessionStates.keys()) if (key.startsWith(`${peerId}:`)) this.remoteSessionStates.delete(key);
    await this.#savePeers();
    return removed;
  }
  /** Parse a legacy endpoint ticket without changing trust. Migration use only. */
  identify(ticket) { return EndpointTicket.fromString(ticket).endpointAddr().id().toString(); }
  peers() { return [...this.trustedPeers].sort(); }
  endpoints() { return [...this.peerTickets].map(([peerId, ticket]) => ({ peerId, ticket })).sort((a, b) => a.peerId.localeCompare(b.peerId)); }
  hosts() { return this.peers().map((hostId) => ({ hostId, addressKnown: this.peerTickets.has(hostId), state: this.peerTickets.has(hostId) ? (this.hostStates.get(hostId) ?? "unknown") : "unpaired" })); }
  sessionStatus(hostId, sessionId) {
    const hostState = this.hostStates.get(hostId) ?? "unknown";
    if (hostState === "offline") return { sessionId: String(sessionId), state: "host-offline", live: false };
    const state = this.remoteSessionStates.get(`${hostId}:${sessionId}`) ?? "unknown";
    return { sessionId: String(sessionId), state, live: state === "idle" || state === "running" };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async sendTo({ hostId, from, to, text, id, timeoutMs }) {
    await this.ready;
    const ticket = this.peerTickets.get(hostId);
    if (!ticket) throw new Error(`trusted host ${hostId} has no current endpoint ticket; pair it again in Weave settings`);
    this.hostStates.set(hostId, "connecting");
    try {
      const result = await this.send({ ticket, from, to, text, id, timeoutMs });
      this.hostStates.set(hostId, "online");
      return result;
    } catch (error) {
      this.hostStates.set(hostId, "offline");
      throw error;
    }
  }
  async sessionCatalog() {
    const agents = this.ctx?.get?.("agents") ?? this.ctx?.agents;
    const sessions = this.ctx?.get?.("sessions") ?? this.ctx?.sessions;
    const persistence = this.ctx?.get?.("sessionPersistence") ?? this.ctx?.sessionPersistence;
    const titles = this.ctx?.get?.("sessionTitle") ?? this.ctx?.sessionTitle;
    const registry = this.ctx?.get?.("workspaceRegistry") ?? this.ctx?.workspaceRegistry;
    const archived = new Set(registry?.archivedSessionIds ?? []);
    const live = new Map((sessions?.list?.() ?? []).map((session) => [String(session.id), session]));
    const liveAgents = new Map((agents?.list?.() ?? []).map((agent) => [String(agent.id), agent]));
    const headers = persistence ? await persistence.list() : [...live.values()].map((session) => session.header);
    const items = [];
    for (const header of headers ?? []) {
      const id = String(header.id); const active = live.get(id);
      if (archived.has(id)) continue;
      let title = active ? titles?.get?.(active)?.title : undefined;
      let updatedAt = header.createdAt ?? 0;
      if (!title && persistence) {
        try {
          const inspected = await persistence.inspect(header.id);
          title = [...inspected.events].reverse().find((event) => event.type === "session/title")?.data?.title;
          updatedAt = inspected.events.at(-1)?.time ?? updatedAt;
        } catch {}
      }
      const activeAgent = liveAgents.get(id);
      items.push({ id, title: title || id, state: activeAgent?.status ?? "offline", running: Boolean(activeAgent), updatedAt });
    }
    const sessionsById = new Map(items.map((session) => [session.id, session]));
    const workspaces = (registry?.list?.() ?? []).filter((workspace) => workspace.archived !== true).map((workspace) => ({
      id: String(workspace.id), title: String(workspace.title),
      sessions: workspace.sessionIds.map((id) => sessionsById.get(String(id))).filter(Boolean)
    })).filter((workspace) => workspace.sessions.length > 0);
    return { hostName: this.hostName, workspaces };
  }
  async remoteSessions(timeoutMs = 3_000) {
    const catalogs = await Promise.all(this.endpoints().map(async ({ peerId }) => {
      try {
        const sent = await this.sendTo({ hostId: peerId, from: "weave-session-catalog", to: SYSTEM_TARGET, text: JSON.stringify({ kind: "session.catalog" }), timeoutMs });
        if (!sent?.result || !Array.isArray(sent.result.workspaces)) return undefined;
        for (const workspace of sent.result.workspaces) for (const session of workspace.sessions ?? []) this.remoteSessionStates.set(`${peerId}:${session.id}`, session.state ?? (session.running ? "idle" : "offline"));
        return { hostId: peerId, hostName: String(sent.result.hostName || peerId.slice(0, 8)), state: "online", workspaces: sent.result.workspaces };
      } catch { return undefined; }
    }));
    return catalogs.filter(Boolean);
  }
  async send({ ticket, from, to, text, id = crypto.randomUUID(), timeoutMs = this.config.acknowledgementTimeoutMs ?? 10_000 }) {
    if (typeof text !== "string" || text.trim() === "") throw new Error("dsh-weave text must not be empty");
    const endpoint = await this.start(); const address = EndpointTicket.fromString(ticket).endpointAddr(); const peerId = address.id().toString();
    if (!this.trustedPeers.has(peerId)) throw new Error(`peer ${peerId} is not trusted; call trust(ticket) first`);
    const connection = await endpoint.connect(address, ALPN_BYTES);
    try {
      const stream = await connection.openBi();
      await stream.send.writeAll(encode({ kind: "dsh-weave/message", version: 1, id, from, to, text })); await stream.send.finish();
      let timer;
      const acknowledgement = decode(await Promise.race([
        stream.recv.readToEnd(MAX_FRAME_BYTES), // Fix3: 原 4096 太小，room.read 批量响应必超
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`dsh-weave acknowledgement timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); }),
      ]).finally(() => clearTimeout(timer)));
      if (acknowledgement?.ok !== true || acknowledgement.id !== id) throw new Error(acknowledgement?.error ?? "peer rejected message");
      return { id, peerId, delivered: true, result: acknowledgement.result };
    } finally { connection.close(0n, []); }
  }
  async #acceptLoop() {
    const endpoint = this.endpoint; if (!endpoint) return;
    try { while (!endpoint.isClosed()) {
      const maximum = this.config.maxConcurrentInbound ?? 64;
      if (this.inbound.size >= maximum) await Promise.race(this.inbound);
      const incoming = await endpoint.acceptNext(); if (!incoming) return;
      const task = this.#accept(incoming).finally(() => this.inbound.delete(task));
      this.inbound.add(task);
    } }
    catch (error) { if (!endpoint.isClosed()) console.warn("dsh-weave accept loop stopped", error); }
  }
  async #accept(incoming) {
    let connection; let stream; let messageId;
    try {
      connection = await (await incoming.accept()).connect(); const peerId = connection.remoteId().toString(); stream = await connection.acceptBi();
      if (!this.trustedPeers.has(peerId)) throw new Error(`peer ${peerId} is not trusted`);
      this.hostStates.set(peerId, "online");
      const message = decode(await stream.recv.readToEnd(MAX_FRAME_BYTES));
      messageId = message?.id;
      if (message?.kind !== "dsh-weave/message" || message.version !== 1 || ![message.id, message.from, message.to, message.text].every((value) => typeof value === "string" && value)) throw new Error("invalid dsh-weave frame");
      const received = Object.freeze({ ...message, peerId, receivedAt: Date.now() });
      const dedupeKey = `${peerId}:${message.id}`;
      let processing = this.recentMessages.get(dedupeKey);
      if (processing) {
        const duplicateResult = await processing;
        await stream.send.writeAll(encode({ ok: true, id: message.id, result: duplicateResult })); await stream.send.finish();
        return;
      }
      processing = this.#dispatch(received).catch((error) => { this.recentMessages.delete(dedupeKey); throw error; });
      this.recentMessages.set(dedupeKey, processing);
      const limit = this.config.recentMessageLimit ?? 10_000;
      while (this.recentMessages.size > limit) this.recentMessages.delete(this.recentMessages.keys().next().value);
      const result = await processing;
      await stream.send.writeAll(encode({ ok: true, id: message.id, result })); await stream.send.finish();
    } catch (error) {
      this.ctx?.logger?.warn?.("dsh-weave rejected incoming frame", error);
      if (stream && typeof messageId === "string") {
        try { await stream.send.writeAll(encode({ ok: false, id: messageId, error: String(error?.message ?? error) })); await stream.send.finish(); } catch {}
      }
    }
    finally { connection?.close(0n, []); }
  }
  async #dispatch(received) {
      const message = received;
      let claimed = false; let result;
      if (message.to === SYSTEM_TARGET) {
        let payload; try { payload = JSON.parse(message.text); } catch {}
        if (payload?.kind === "session.catalog") { claimed = true; result = await this.sessionCatalog(); }
      }
      for (const listener of this.listeners) {
        const outcome = await listener(received);
        if (outcome === true) claimed = true;
        else if (outcome && typeof outcome === "object" && outcome.claimed === true) { claimed = true; result = outcome.result; }
      }
      let bridge;
      try { bridge = this.ctx?.dshBridge ?? this.ctx?.get?.("dshBridge"); } catch { bridge = undefined; }
      if (!claimed && bridge) await bridge.deliverExternal(`weave:${message.peerId}:${message.from}`, message.to, message.text, { id: message.id, transport: "weave" });
      if (!claimed && !bridge) throw new Error(`no handler claimed Weave target ${message.to} and dsh-bridge is unavailable`);
      return result;
  }
}

export function apply(ctx, config) {
  const weave = new DshWeaveTransport(ctx, config);
  // This must be a Cordis service, rather than a plain accessor.  Consumers
  // such as dsh-chat use inject(["dshWeave"]) so their protocol listeners
  // are active even when no UI has been opened yet.
  ctx.provide("dshWeave", weave);
  // A loopback-only host RPC gives the local web client the currently valid
  // endpoint ticket.  Tickets include live addressing information and must
  // not be recovered from an old room record after an endpoint restart.
  ctx.connection.rpc.handle("/dsh-weave", async (endpoint, payload) => {
    if (endpoint === "ticket") return { ok: true, value: { ticket: await weave.ticket() } };
    if (endpoint === "peers") return { ok: true, value: { peers: weave.peers() } };
    if (endpoint === "endpoints") return { ok: true, value: { endpoints: weave.hosts() } };
    if (endpoint === "status") return { ok: true, value: { relayMode: weave.config.relayMode ?? "default", peerCount: weave.peers().length } };
    if (endpoint === "trust") return { ok: true, value: { peerId: await weave.trust(payload?.args?.ticket) } };
    if (endpoint === "untrust") return { ok: true, value: { removed: await weave.untrust(payload?.args?.peerId) } };
    throw new Error(`unknown dsh-weave endpoint: ${endpoint}`);
  }, { authority: "trusted-host" });
  ctx.tools.register(defineTool({
    name: "weave_ticket",
    description: "Create the local DSH Weave Iroh ticket for an out-of-band peer pairing.",
    parameters: {},
    output: { schema: { type: "object", additionalProperties: false, properties: { ticket: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: value.ticket }] },
    async execute() { return { ticket: await weave.ticket() }; }
  }));
  ctx.tools.register(defineTool({
    name: "weave_trust",
    description: "Explicitly trust a DSH Weave peer ticket before sending that node a message.",
    parameters: { ticket: { type: "string", required: true, description: "The peer's Iroh endpoint ticket received out of band." } },
    output: { schema: { type: "object", additionalProperties: false, properties: { peerId: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: `Trusted ${value.peerId}` }] },
    async execute(args) { return { peerId: await weave.trust(args.ticket) }; }
  }));
  ctx.tools.register(defineTool({
    name: "weave_peers",
    description: "List trusted DSH Weave peer identities in this host.",
    parameters: {},
    output: { schema: { type: "array", items: { type: "string" } }, render: (_args, value) => [{ type: "text", text: value.join("\n") || "No trusted peers." }] },
    async execute() { return weave.peers(); }
  }));
  ctx.effect(() => async () => weave.close(), "dsh-weave.transport");
}
