import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/** 所有回應共用的標頭 / Headers on every response. */
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

/** 錯誤回應：只有代碼與一般訊息，不帶內部細節 / Error body: code and a generic message only. */
export function problem(
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error: { code, message, ...details } });
}

/**
 * 縱深防禦：Gateway 已依 scope 授權，handler 再檢查一次，避免日後有人誤改路由設定。
 * Defense in depth: the gateway already enforces scopes; check again in case a route is misconfigured later.
 */
export function hasScope(event: APIGatewayProxyEventV2WithJWTAuthorizer, scope: string): boolean {
  const jwt = event.requestContext.authorizer?.jwt;
  const scopes = jwt?.scopes ?? String(jwt?.claims?.scope ?? '').split(' ');
  return scopes.includes(scope);
}

/** 已驗證 JWT 中的 claim（字串）/ A string claim from the verified JWT. */
export function claim(event: APIGatewayProxyEventV2WithJWTAuthorizer, name: string): string | undefined {
  const v = event.requestContext.authorizer?.jwt?.claims?.[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** HTTP API v2 的標頭鍵一律小寫 / HTTP API v2 lowercases header names. */
export function header(event: { headers?: Record<string, string | undefined> }, name: string): string | undefined {
  return event.headers?.[name.toLowerCase()];
}

/** 解析 JSON body（含 base64）；失敗回 undefined / Parse the JSON body (base64 aware). */
export function jsonBody(event: { body?: string; isBase64Encoded?: boolean }, maxBytes: number): unknown {
  if (!event.body) return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
