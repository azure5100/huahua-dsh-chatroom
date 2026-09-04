# DSH Weave architecture

## Goal

DSH Weave connects trusted DeepSeek Harness nodes across hosts while preserving a local-first execution model. It is not a shared shell, a credential synchronizer, or an unauthenticated agent swarm.

## Layers

```text
DSH plugin surface
  ├─ dsh-bridge: same-host session delivery
  ├─ dsh-chat: rooms, room membership, room capabilities, chat outbox
  └─ dsh-weave: host identity, host trust, host/session directory, routing
       └─ Iroh adapter: Endpoint, discovery, QUIC streams, relay fallback
```

Iroh is responsible for encrypted connectivity and endpoint authentication.
Weave binds that endpoint to an explicitly paired DSH host and retains its
latest addressing ticket. Application plugins receive only the stable host id;
they define and validate their own domain capabilities. Chat, for example,
checks room membership and room capabilities after Weave authenticates the host.

## Node identity and membership

Each node stores a long-lived Iroh key and a paired-host record. Future task
handoff policy may extend that record with roles and capabilities, but those
grants do not replace application-specific authorization:

```ts
type MeshNode = {
  nodeId: string;
  endpointId: string;
  displayName: string;
  publicKey: string;
  roles: ("operator" | "worker" | "observer")[];
  capabilities: string[];
  joinedAt: string;
  revokedAt?: string;
};
```

An invite contains a mesh identifier, intended roles, a short expiry, and a signature from an existing operator. The joining node must show the invite locally and require an approval action before storing membership.

## Data flow

1. A user approves a task handoff from DSH node A.
2. The task plugin asks Weave to address the paired host by stable host id.
3. Weave resolves the latest endpoint ticket and opens an Iroh bidirectional stream using `dsh-weave/1`.
4. Node B validates host trust; the task plugin validates its capability and asks its local DSH policy for approval.
5. Node B sends an acknowledgement, emits progress events, and finally returns a result reference.
6. Node A de-duplicates events by message id and records the terminal outcome.

## Operational choices

- Use Iroh's standard discovery and relay services for local development.
- Use a dedicated relay map and controlled discovery service for production meshes.
- Keep domain outboxes in the owning application until Weave offers a generic durable-delivery contract; do not rely on relay delivery as durable storage.
- Treat a missing heartbeat as a reachability signal, never as proof that a task failed.
