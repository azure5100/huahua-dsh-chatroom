/**
 * 0.2.0-rc.2 compatibility shim for the legacy DSH connection RPC channel.
 *
 * On the 0.1.x line a plugin registered its browser channel with
 * `ctx.connection.rpc.handle(channel, handler, { authority: "trusted-host" })`,
 * which ultimately ran `owner.webServer.register(route)` on the CALLER's
 * context. On 0.2.0-rc.2 the connection service registers on its own context
 * (`dsh-client-connection` `register()` → `owner.webServer.register`), and that
 * context never injects `webServer`, so the legacy call throws
 * `cannot get property "webServer" without inject` and the whole plugin fails
 * to activate. No host plugin uses that API on this version any more; the
 * supported shape is a plain `webServer` prefix route.
 *
 * This helper registers the same channel on `webServer` and speaks the
 * documented connection envelope:
 *
 *   POST <channel>/<endpoint>
 *   { type: "client-request", rpcId, method, payload }
 *   -> { type: "server-response", rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * The trusted-host/browser fence is unchanged: it reuses the connection
 * service's own `requestRejection`, exactly like the legacy route did.
 */

const ENDPOINT_SEGMENT = /^[A-Za-z0-9._~-]+$/;

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(channel + "/")) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT.test(segment))) return undefined;
  return endpoint;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function failure(rpcId, code, message) {
  return { type: "server-response", rpcId, result: { ok: false, error: { code, message, details: {} } } };
}

/**
 * Register a legacy-style host RPC channel on the webServer service.
 * @param ctx - plugin context (must be able to inject webServer + connection).
 * @param channel - channel prefix, e.g. "/dsh-chat".
 * @param handler - `(endpoint, payload, signal) => result` returning the
 *   connection result object (`{ ok: true, value }` / `{ ok: false, error }`).
 * @returns a disposer that removes the route.
 */
export function registerHostRpc(ctx, channel, handler) {
  let disposer;
  ctx.inject(["webServer", "connection"], (hostCtx) => {
    const connection = hostCtx.connection;
    disposer = hostCtx.webServer.register({
      kind: "prefix",
      path: channel,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end(rejection === 401 ? "unauthorized" : "forbidden");
          return;
        }
        if (req.method !== "POST") { res.writeHead(404); res.end("not found"); return; }
        const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") { res.writeHead(415); res.end("content type must be application/json"); return; }
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end("body is not JSON"); return; }
        const endpoint = endpointFromPath(channel, new URL(req.url ?? "/", "http://localhost").pathname);
        if (endpoint === undefined) { res.writeHead(404); res.end("not found"); return; }
        const rpcId = typeof body?.rpcId === "string" ? body.rpcId : "invalid";
        if (body?.method !== endpoint) {
          sendJson(res, failure(rpcId, "gateway/bad-request", `method ${JSON.stringify(body?.method)} does not match endpoint ${JSON.stringify(endpoint)}`));
          return;
        }
        try {
          sendJson(res, { type: "server-response", rpcId, result: await handler(endpoint, body?.payload, req.signal) });
        } catch (error) {
          sendJson(res, failure(rpcId, "gateway/internal", String(error?.message ?? error)));
        }
      }
    });
  });
  return () => { try { disposer?.(); } catch { /* teardown is best-effort */ } };
}
