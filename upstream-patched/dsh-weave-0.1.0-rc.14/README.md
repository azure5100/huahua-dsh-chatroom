# DSH Weave

[English](README.md) | [简体中文](README.zh.md)

> A private, peer-to-peer fabric for connecting DeepSeek Harness nodes across machines.

**DSH Weave** turns a collection of local DSH installations into an intentional network: nodes can discover trusted peers, exchange session-aware events, hand off work, and recover after a connection drops — without placing a central server in the execution path.

| Status | Transport | Scope |
| --- | --- | --- |
| Transport MVP | Iroh + QUIC | Explicitly trusted DSH nodes |

## What it gives you

- Persistent local node identity and explicit peer trust.
- Encrypted QUIC connectivity with direct paths and relay fallback through Iroh.
- A remote Host, workspace, and session directory for higher-level plugins.
- Separate reachability and agent-presence states, so offline is not mistaken for idle.
- A DSH Settings page for ticket exchange, relay status, and trusted peers.

## Product boundary

`dsh-bridge` is the local contract: it connects sessions in one DSH host.
`dsh-weave` carries approved messages between those hosts. `dsh-chat` is the
optional Web group-chat surface above both layers.

```text
DSH node A ── dsh-bridge ── dsh-weave ── Iroh ── Iroh ── dsh-weave ── dsh-bridge ── DSH node B
```

Iroh supplies authenticated, encrypted QUIC connections, direct peer-to-peer paths where possible, and relay fallback where required. Weave owns DSH host identity, host trust, endpoint refresh, reachability, the workspace/session directory, and authenticated request delivery. Higher-level plugins own their domain membership and capabilities; for example, Chat owns rooms and room capabilities.

The remote directory reports agent state as `idle`, `running`, or `offline`.
Host reachability is tracked separately as `unknown`, `connecting`, `online`,
or `offline`; waking a persisted session remains a `dsh-bridge` responsibility.

## Quick start

The transport MVP provides an Iroh endpoint, ticket exchange, explicit peer
trust, and a message frame that is handed to `dsh-bridge` when both plugins
run in the same host. It deliberately does not auto-trust a peer that merely
knows an endpoint address.

```bash
dsh plugin --profile web add dsh-weave@next
dsh web
```

Open **Settings → Weave** on both Hosts, copy each node's ticket to the other
Host, and explicitly trust it. Knowing an endpoint ticket does not grant trust
until the receiving Host accepts it.

```js
import {
  DSH_WEAVE_ALPN,
  DSH_WEAVE_PROTOCOL_VERSION,
  DSH_WEAVE_STAGE,
} from "dsh-weave";

console.log(DSH_WEAVE_ALPN);             // dsh-weave/1
console.log(DSH_WEAVE_PROTOCOL_VERSION); // 1
console.log(DSH_WEAVE_STAGE);            // design-preview
```

## The first protocol

| Plane | What it carries | Delivery rule |
| --- | --- | --- |
| Control | invite, membership, heartbeat, capability updates | request/acknowledgement |
| Task | offer, accept, progress, result, cancellation | idempotent at-least-once |
| Session | user-approved context or trajectory references | explicit sharing only |

Every node has a persistent network identity. Joining a mesh requires an expiring invite and an explicit local approval. A transport connection alone never grants permission to execute a task.

## Security posture

- End-to-end encryption is supplied by Iroh's authenticated QUIC transport.
- A mesh allowlist and capability grants sit above transport identity.
- Remote work is denied by default until the receiving node approves it.
- Secrets, provider credentials, and raw filesystem access never travel as ordinary session events.
- A self-hosted relay/discovery deployment is the production path; public relays are for development only.

See [architecture](./docs/ARCHITECTURE.md), [wire protocol](./docs/PROTOCOL.md), and [security model](./docs/SECURITY.md).

## Pairing and delivery

Exchange each node's ticket out of band, then explicitly trust it before
sending. `dsh-weave` rejects a frame from an untrusted endpoint even though
Iroh has already encrypted the connection. This separates transport identity
from DSH authorization. The node's Iroh identity is persisted locally under
`~/.dsh/dsh-weave/identity.json` with owner-only permissions, so a restart
does not silently create a new peer identity. Explicitly trusted peer IDs and
their last accepted endpoint tickets are also stored locally with owner-only
permissions, so paired-host discovery survives a restart. An endpoint ticket
also carries addressing hints; trust a fresh ticket again when a peer changes
its reachable addresses.
The trusted-host `/dsh-weave/ticket` RPC exposes that current ticket for
pairing UIs.

The Web profile contributes a dedicated **Settings → Weave** page. It shows
the current Iroh ticket and relay mode, accepts trusted peer tickets, and lists
paired endpoint identities. Higher-level plugins such as `dsh-chat` consume
the paired-host workspace/session catalog and send by stable host id. They
never receive or persist peer endpoint tickets and do not own transport
identity, pairing, or relay policy.

## Roadmap

- [x] Publish the v1 protocol contract
- [x] `dsh-bridge` local event adapter
- [x] Iroh endpoint adapter and ticket-based trust flow
- [ ] Remote task request / approval / result streams
- [ ] Durable outbox and reconnect replay
- [ ] Self-hosted relay and discovery guidance

## Development

```bash
npm run check
```

## License

MIT © Xiang Bai
