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
export function problem(statusCode: number, code: string, message: string): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error: { code, message } });
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
