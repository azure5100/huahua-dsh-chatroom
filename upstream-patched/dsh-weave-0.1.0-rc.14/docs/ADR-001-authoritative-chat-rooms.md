# ADR-001: Authoritative DSH Chat rooms over Weave

**Status:** Accepted  
**Date:** 2026-08-18  
**Decider:** Xiang Bai

## Context

DSH sessions on multiple machines need a shared group-chat experience. Ordinary
room messages are for people viewing the room; they must not become agent
follow-ups unless a message explicitly mentions a session. Copying the room
record and its message log to every Iroh node would introduce conflict,
membership, and retention problems without improving agent delivery.

## Decision

The node that creates a room is its authoritative host. A remote member stores
only a room link (stable Weave host id, room id, capability, addressed local
session id, and last read cursor) plus an optional disposable UI cache. Endpoint
tickets remain exclusively in Weave. The host durably owns membership, the
ordered event log, and any pending targeted delivery.

`dsh-chat/2` uses Weave request/reply frames over Iroh QUIC:

- `room.invite`: creates a local room link, never a room replica.
- `room.read`: returns events after a cursor for a currently open room view.
- `room.post`: appends a public message at the host.
- `room.delivery`: carries an explicitly targeted mention to a member node.

Every room request is bound to the authenticated Weave host id. A targeted
delivery additionally validates the room capability and exact local recipient.
The room view long-polls `room.read` while open and resumes from its cursor on
reconnect. A public event is rendered by the client only. The host creates a
`room.delivery` event only for `@session-id` or `@all`; the recipient node then
uses Bridge to wake just the addressed live session(s).

## Options considered

| Option | Decision |
| --- | --- |
| Per-node room replicas | Rejected: requires convergence and creates stale membership/history. |
| Iroh Gossip topic per room | Rejected: dissemination is broadcast-oriented and does not provide authoritative history or targeted agent wake-ups. |
| Iroh Docs/CRDT | Rejected: replicas are the feature; current Node binding also does not expose this higher-level protocol. |
| Authoritative host + cursor reads | Accepted: small durable surface, explicit delivery, predictable recovery. |

## Consequences

- The room host must be reachable to read history or post.
- Offline targeted delivery is retained by the host until acknowledgement or expiry.
- Host migration is an explicit future protocol, not an accidental side effect
  of a peer reconnecting.
- `@all` is the only broadcast that wakes agents; messages with no mention
  never broadcast.
