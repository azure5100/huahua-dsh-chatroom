# DSH Weave security model

## Trust boundaries

1. Iroh transport authentication proves possession of an endpoint key.
2. Weave pairing binds that endpoint to an approved stable host id.
3. The receiving application validates its own capability and target scope.
4. Local DSH policy makes the final execution decision.

No layer can bypass the next one.

## Defaults

- Unknown endpoint: reject.
- Known endpoint without Weave pairing: reject.
- Paired host without the application's requested capability: reject.
- Authorized task with no local approval rule: ask the local operator.
- Network loss: retain the outbox; do not guess task success.

## Secrets and privacy

Credentials remain local to their DSH installation. Session sharing is opt-in and should use redacted, bounded context objects. Operators who need control over metadata exposure should run dedicated Iroh relay and discovery infrastructure.

## Review triggers

Revisit this model before adding unattended execution, third-party node invitations, shared file transfer, or a central management service.
