import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Readable } from "node:stream";

/*
 * The connection the fetcher makes (feature-specs/32 § 4.1, § 4.2): to the address the guard checked, with the
 * name as SNI and as `Host`, so that a second resolution of the name cannot answer differently from the first. It
 * is `node:https` with the address in `host` and the name in `servername`: TLS validates the certificate against
 * the name, and the socket opens to the address. Nothing is followed, retried or remembered here; the fetcher
 * decides what a response means. `transportOf` takes the request function so that the fetcher's tests run the
 * same code against a local `node:http` server with the address replaced by the server's.
 */

export interface Target {
  readonly url: URL;
  /** The address the guard passed, which the socket opens to. */
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The body as it arrives; destroying it abandons the connection. */
  readonly body: Readable;
}

export interface Transport {
  request(target: Target, signal: AbortSignal): Promise<TransportResponse>;
}

export interface Endpoint {
  readonly host?: string;
  readonly port?: number;
}

/** The options of one request: the socket to the address, the certificate and the `Host` header for the name. */
export function requestOptionsOf(target: Target, endpoint: Endpoint = {}): RequestOptions {
  return {
    host: endpoint.host ?? target.address,
    port: endpoint.port ?? 443,
    servername: target.url.hostname,
    method: "GET",
    path: `${target.url.pathname}${target.url.search}`,
    headers: { ...target.headers, host: target.url.hostname },
    setHost: false,
    /* One socket per fetch, closed with it: nothing of a stranger's page lingers in an agent's pool. */
    agent: false,
  };
}

type RequestFunction = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export function transportOf(request: RequestFunction, endpoint: Endpoint = {}): Transport {
  return {
    request(target, signal) {
      return new Promise<TransportResponse>((resolve, reject) => {
        const client = request({ ...requestOptionsOf(target, endpoint), signal }, (response) => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response });
        });
        client.on("error", reject);
        client.end();
      });
    },
  };
}

/** The real one: TLS to the checked address on 443. */
export const httpsTransport: Transport = transportOf(httpsRequest);
