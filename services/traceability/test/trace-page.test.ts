import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CloudFormationCustomResourceEvent, EventBridgeEvent } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import type { ProductMetaItem } from '../../ordering/src/lib/model';
import type { LotItem, RoastItem } from '../../ordering/src/lib/trace-model';
import type { TraceRepo } from '../../ordering/src/lib/trace-repo';
import { buildProjection, projectionKey, PROJECTION_CACHE_CONTROL } from '../src/projection';
import { handler as projector, setClientsForTesting } from '../src/projector';
import { handler as sitePublisher, setClientForTesting as setSiteClient, SITE_FILES } from '../src/site-publisher';

const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';
const ROAST_ID = `r_${'3'.repeat(26)}`;
const NOW = new Date('2026-11-19T02:00:00Z');

const lot: LotItem = {
  pk: 'LOT#L-2026-001', sk: 'META', entity: 'Lot', lot_id: 'L-2026-001', producer_display_name: 'Fictional Farm',
  origin_country: 'ET', region: 'Yirgacheffe', altitude_m: 2000, variety: 'Ethiopian landrace', process: 'washed',
  cup_score: 87.5, harvest: '2025/26', updated_at: 'x',
};
const product = { id: 'p-0001', name: 'Highland Washed Lot 1', name_zh: '高地水洗一號', lot_id: 'L-2026-001', price_per_kg: 1450 } as unknown as ProductMetaItem;
const roast = (extra: Partial<RoastItem> = {}): RoastItem => ({
  pk: `ROAST#${ROAST_ID}`, sk: 'META', entity: 'RoastBatch', roast_id: ROAST_ID, product_id: 'p-0001', lot_id: 'L-2026-001',
  roast_date: '2026-11-18', roast_level: 'light', kg: 12, status: 'ROASTED', request_hash: 'secret-hash',
  created_by: 'staff-sub-secret', created_at: 'x', qr_token: TOKEN, ...extra,
});

describe('buildProjection (allow-list, RSK-019)', () => {
  test('publishes only allow-listed fields under v1/<token>.json', () => {
    const r = buildProjection(roast(), lot, product, NOW);
    expect(r).toMatchObject({ kind: 'publish', key: `v1/${TOKEN}.json` });
    if (r.kind !== 'publish') throw new Error('expected publish');
    expect(r.body).toEqual({
      schema: 1,
      product: { name: 'Highland Washed Lot 1', name_zh: '高地水洗一號' },
      lot: { producer_display_name: 'Fictional Farm', origin_country: 'ET', region: 'Yirgacheffe', altitude_m: 2000, variety: 'Ethiopian landrace', process: 'washed', cup_score: 87.5, harvest: '2025/26' },
      roast: { roast_date: '2026-11-18', roast_level: 'light' },
      recall: undefined,
      demo: false,
      generated_at: NOW.toISOString(),
    });
    // 反向：內部欄位、鍵、價格、批次 ID、token 本身都不在內容裡 / Negative: no internal fields.
    const json = JSON.stringify(r.body);
    for (const f of ['staff-sub-secret', 'secret-hash', 'created_by', 'ROAST#', 'LOT#', ROAST_ID, TOKEN, 'price', '1450', '"kg"', 'tenant', 'pk']) {
      expect(json).not.toContain(f);
    }
  });
  test('recall notice and demo flag are projected', () => {
    const r = buildProjection(roast({ recall: { at: '2026-11-19T01:00:00Z', notice: 'Please stop using this batch.', by: 'staff-sub-secret' }, synthetic: true }), lot, product, NOW);
    if (r.kind !== 'publish') throw new Error('expected publish');
    expect(r.body.recall).toEqual({ at: '2026-11-19T01:00:00Z', notice: 'Please stop using this batch.' });
    expect(r.body.demo).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('staff-sub-secret');
  });
  test.each([
    ['not roasted', roast({ status: 'SCHEDULED', qr_token: undefined }), 'not_roasted'],
    ['no token', roast({ qr_token: undefined }), 'no_token'],
    ['lot mismatch', roast({ lot_id: 'L-2026-002' }), 'lot_mismatch'],
  ])('skips when %s', (_n, r, reason) => {
    expect(buildProjection(r, lot, product, NOW)).toEqual({ kind: 'skip', reason });
  });
});

describe('projector handler', () => {
  const s3 = mockClient(S3Client);
  const fakeRepo = (r: RoastItem | undefined) =>
    ({ getRoast: jest.fn(async () => r), getLot: jest.fn(async () => lot), getProduct: jest.fn(async () => product) }) as unknown as TraceRepo;
  const event = (detail: unknown) => ({ 'detail-type': 'RoastBatchRoasted', detail }) as unknown as EventBridgeEvent<string, unknown>;

  beforeEach(() => {
    s3.reset();
    process.env.TABLE_NAME = 'tbl';
    process.env.BUCKET_NAME = 'bucket';
  });
  afterAll(() => setClientsForTesting(undefined, undefined));

  test('writes the projection with JSON content type and a 5-minute Cache-Control', async () => {
    const repo = fakeRepo(roast());
    setClientsForTesting(repo, s3 as unknown as S3Client);
    await expect(projector(event({ roast_id: ROAST_ID, event_id: 'e1' }))).resolves.toEqual({ outcome: 'published' });
    expect(repo.getRoast).toHaveBeenCalledWith(ROAST_ID, true); // 強一致讀取 / strongly consistent
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: 'bucket', Key: projectionKey(TOKEN), ContentType: 'application/json; charset=utf-8', CacheControl: PROJECTION_CACHE_CONTROL });
    expect(PROJECTION_CACHE_CONTROL).toBe('public, max-age=300');
  });
  test('roast batch already deleted (Dev smoke cleanup) → skipped, nothing written', async () => {
    setClientsForTesting(fakeRepo(undefined), s3 as unknown as S3Client);
    await expect(projector(event({ roast_id: ROAST_ID }))).resolves.toEqual({ outcome: 'skipped' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  test('missing lot or product → throws (EventBridge retries, then the DLQ alarm)', async () => {
    const repo = { getRoast: jest.fn(async () => roast()), getLot: jest.fn(async () => undefined), getProduct: jest.fn(async () => product) } as unknown as TraceRepo;
    setClientsForTesting(repo, s3 as unknown as S3Client);
    await expect(projector(event({ roast_id: ROAST_ID }))).rejects.toThrow('Lot or product not found');
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  test('malformed detail → ignored without touching S3', async () => {
    setClientsForTesting(fakeRepo(roast()), s3 as unknown as S3Client);
    await expect(projector(event({ roast_id: '../../index' }))).resolves.toEqual({ outcome: 'ignored' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  test('not yet roasted → skipped, nothing written', async () => {
    setClientsForTesting(fakeRepo(roast({ status: 'SCHEDULED', qr_token: undefined })), s3 as unknown as S3Client);
    await expect(projector(event({ roast_id: ROAST_ID }))).resolves.toEqual({ outcome: 'skipped' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe('site publisher', () => {
  const s3 = mockClient(S3Client);
  const cfn = (type: 'Create' | 'Update' | 'Delete', files: Array<{ Key: string; Body: string }>) =>
    ({ RequestType: type, LogicalResourceId: 'Site', PhysicalResourceId: 'trace-site-Site', ResourceProperties: { ServiceToken: 'x', BucketName: 'bucket', Files: files } }) as unknown as CloudFormationCustomResourceEvent;
  beforeEach(() => {
    s3.reset();
    setSiteClient(s3 as unknown as S3Client);
  });
  afterAll(() => setSiteClient(undefined));

  test('writes each file with its content type', async () => {
    await sitePublisher(cfn('Create', [{ Key: 'index.html', Body: Buffer.from('<p>x</p>').toString('base64') }]));
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: 'bucket', Key: 'index.html', ContentType: 'text/html; charset=utf-8', CacheControl: 'public, max-age=300' });
    expect(Buffer.from(put.Body as Buffer).toString()).toBe('<p>x</p>');
  });
  test('rejects keys outside the site (cannot overwrite v1/ projections)', async () => {
    await expect(sitePublisher(cfn('Update', [{ Key: `v1/${TOKEN}.json`, Body: '' }]))).rejects.toThrow();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
  test('Delete leaves the bucket alone', async () => {
    await expect(sitePublisher(cfn('Delete', []))).resolves.toEqual({ PhysicalResourceId: 'trace-site-Site' });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe('static site files', () => {
  const dir = path.join(__dirname, '..', 'site');
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');

  test('every published file exists', () => {
    for (const f of Object.keys(SITE_FILES)) expect(read(f).length).toBeGreaterThan(0);
  });
  test('the page script never uses innerHTML/eval and calls only its own origin', () => {
    const js = read('app.js');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'http://', 'https://']) {
      expect(js).not.toContain(bad);
    }
    expect(js).toContain("fetch('/v1/' + token + '.json'");
    expect(js).toContain('/^[A-Za-z0-9_-]{22}$/'); // 與 QrTokenSchema 相同 / same as QrTokenSchema
  });
  test('index.html has a strict CSP, no inline script or style, and no external resources', () => {
    const html = read('index.html');
    expect(html).toContain("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).not.toMatch(/style=|onclick=|https?:\/\//);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });
  test('robots.txt disallows everything (token pages are not for indexing)', () => {
    expect(read('robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });
});
