/** The application-layer protocol negotiated by dsh-weave peers. */
export declare const DSH_WEAVE_ALPN: "dsh-weave/1";

export declare const DSH_WEAVE_STAGE: "transport-mvp";

/** The first public protocol revision. */
export declare const DSH_WEAVE_PROTOCOL_VERSION: 1;
export declare const name = "dsh-weave";
export declare const inject: readonly ["connection", "tools", "agents", "sessions", "sessionTitle", "sessionPersistence", "workspaceRegistry"];
export type DshWeaveHostState = "unknown" | "connecting" | "online" | "offline" | "unpaired";
export type DshWeaveSessionState = "idle" | "running" | "offline" | "host-offline" | "unknown";
export interface DshWeaveMessage { readonly id: string; readonly from: string; readonly to: string; readonly text: string; readonly peerId: string; readonly receivedAt: number; }
export interface DshWeaveConfig { trustedPeers?: readonly string[]; secretKey?: readonly number[]; identityPath?: string; peersPath?: string; persistIdentity?: boolean; persistPeers?: boolean; relayMode?: "default" | "disabled"; hostName?: string; acknowledgementTimeoutMs?: number; shutdownTimeoutMs?: number; maxConcurrentInbound?: number; recentMessageLimit?: number; }
export declare const Config: import("@standard-schema/spec").StandardSchemaV1<unknown, DshWeaveConfig>;
export interface DshWeaveClaim { claimed: true; result?: unknown; }
export declare class DshWeaveTransport {
  constructor(ctx: unknown, config?: DshWeaveConfig);
  start(): Promise<unknown>; close(): Promise<void>; ticket(): Promise<string>; trust(ticket: string): Promise<string>; untrust(peerId: string): Promise<boolean>; identify(ticket: string): string; peers(): string[]; endpoints(): Array<{ peerId: string; ticket: string }>; hosts(): Array<{ hostId: string; addressKnown: boolean; state: DshWeaveHostState }>;
  sessionStatus(hostId: string, sessionId: string): { sessionId: string; state: DshWeaveSessionState; live: boolean };
  subscribe(listener: (message: DshWeaveMessage) => void | boolean | DshWeaveClaim | Promise<void | boolean | DshWeaveClaim>): () => void;
  send(request: { ticket: string; from: string; to: string; text: string; id?: string; timeoutMs?: number }): Promise<{ id: string; peerId: string; delivered: true; result?: unknown }>;
  sendTo(request: { hostId: string; from: string; to: string; text: string; id?: string; timeoutMs?: number }): Promise<{ id: string; peerId: string; delivered: true; result?: unknown }>;
  sessionCatalog(): Promise<{ hostName: string; workspaces: Array<{ id: string; title: string; sessions: Array<{ id: string; title: string; state: "idle" | "running" | "offline"; running: boolean; updatedAt: number }> }> }>;
  remoteSessions(timeoutMs?: number): Promise<Array<{ hostId: string; hostName: string; state: "online"; workspaces: Array<{ id: string; title: string; sessions: Array<{ id: string; title: string; state: "idle" | "running" | "offline"; running: boolean; updatedAt: number }> }> }>>;
}
declare module "@deepseek-ai/cordis" { interface Context { dshWeave: DshWeaveTransport; } }
export declare function apply(ctx: Context, config?: DshWeaveConfig): void;
import type { Context } from "@deepseek-ai/cordis";
