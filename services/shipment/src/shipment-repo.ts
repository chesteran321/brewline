import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { AdvanceResult, TrackPoint } from './detector-core';
import {
  CreateShipmentRequest,
  DcsaTransportEvent,
  LOT_SHIP_EDGE_PREFIX,
  META_SK,
  ShipmentEdge,
  ShipmentEdgeSchema,
  ShipmentEventItemSchema,
  ShipmentItem,
  ShipmentItemSchema,
  TrackItemSchema,
  VESSEL_VOY_EDGE_PREFIX,
  bookingReference,
  equipmentFor,
  lotPk,
  lotShipEdgeSk,
  shipPk,
  shipmentIdFromKey,
  shipmentRequestHash,
  vesselPk,
  vesselVoyEdgeSk,
} from './model';
import { ShipmentSeeds, routeForLot, seeds } from './seeds';

/**
 * 貨運 repo（P2b-1）：函數自己的角色（不扮演租戶角色）；IAM 依前綴限制在 SHIP#／LOT#／VESSEL#，
 * 邊的寫入另以 dynamodb:Attributes 限定欄位（寫不了 LOT#…/META）。
 * Shipment repo using the function's own role; IAM limits it to SHIP#/LOT#/VESSEL#, and edge writes are limited to
 * the edge attributes (so a lot's META can never be overwritten).
 */

const THROTTLE_CODES = new Set(['ThrottlingError', 'ProvisionedThroughputExceeded', 'RequestLimitExceeded', 'TransactionConflict']);
const THROTTLE_ERRORS = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException']);

export interface Caller {
  /** 'staff:<sub>' 或 'roastery:<sub>' / Who acts. */
  readonly actor: string;
  /** token 帶 synthetic → 只能建立、讀取模擬貨運 / A synthetic caller touches synthetic shipments only. */
  readonly synthetic: boolean;
}

export type CreateShipmentResult =
  | { readonly kind: 'created' | 'replayed'; readonly shipment: ShipmentItem }
  | { readonly kind: 'key_conflict' }
  | { readonly kind: 'lot_not_found' }
  /** 批次沒有海運（例如台灣國產批次）/ The lot has no sea leg (e.g. the Taiwan-grown lot). */
  | { readonly kind: 'no_sea_route' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'busy' };

export interface ShipmentDetail {
  readonly shipment: ShipmentItem;
  readonly events: DcsaTransportEvent[];
  readonly track: Array<[number, number, string]>;
}

export class ShipmentRepo {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly seedData: ShipmentSeeds = seeds(),
  ) {}

  async lotExists(lotId: string): Promise<boolean> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: lotPk(lotId), sk: META_SK }, ProjectionExpression: 'pk, entity' }),
    );
    return out.Item?.entity === 'Lot';
  }

  async getShipment(id: string, consistent = false): Promise<ShipmentItem | undefined> {
    const out = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk: shipPk(id), sk: META_SK }, ConsistentRead: consistent }));
    const p = ShipmentItemSchema.safeParse(out.Item);
    return p.success && p.data.shipment_id === id ? p.data : undefined;
  }

  /**
   * 建立貨運：一個交易＝META（attribute_not_exists）＋批次邊＋船邊。POL／POD 由種子依批次決定。
   * One transaction: META (attribute_not_exists) + lot edge + vessel edge. POL/POD come from the seed.
   */
  async createShipment(req: CreateShipmentRequest, idempotencyKey: string, caller: Caller, now: Date): Promise<CreateShipmentResult> {
    const id = shipmentIdFromKey(idempotencyKey);
    const hash = shipmentRequestHash(req);
    const replay = async (): Promise<CreateShipmentResult | undefined> => {
      const existing = await this.getShipment(id, true);
      if (!existing) return undefined;
      return existing.request_hash === hash ? { kind: 'replayed', shipment: existing } : { kind: 'key_conflict' };
    };
    const prior = await replay();
    if (prior) return prior;

    if (!(await this.lotExists(req.lot_id))) return { kind: 'lot_not_found' };
    const route = routeForLot(req.lot_id, this.seedData);
    if (!route) return { kind: 'no_sea_route' };

    const at = now.toISOString();
    const syn = caller.synthetic ? { synthetic: true as const } : {};
    const shipment: ShipmentItem = {
      pk: shipPk(id),
      sk: META_SK,
      entity: 'Shipment',
      shipment_id: id,
      lot_id: req.lot_id,
      route_id: route.id,
      pol: route.pol.locode,
      pod: route.pod.locode,
      carrier_booking_reference: bookingReference(id),
      carrier_voyage_number: req.carrier_voyage_number,
      vessel: { vessel_id: req.vessel_id, vessel_name: req.vessel_name },
      equipment: equipmentFor(id),
      planned_departure: req.planned_departure,
      planned_arrival: req.planned_arrival,
      status: 'PLANNED',
      request_hash: hash,
      version: 1,
      created_by: caller.actor,
      created_at: at,
      ...syn,
    };
    const edge = (pk: string, sk: string, entity: ShipmentEdge['entity']): ShipmentEdge => ({
      pk,
      sk,
      entity,
      shipment_id: id,
      planned_departure: req.planned_departure,
      pol: shipment.pol,
      pod: shipment.pod,
      status: 'PLANNED',
      ...syn,
    });

    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: shipment, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: this.tableName, Item: edge(lotPk(req.lot_id), lotShipEdgeSk(req.planned_departure, id), 'LotShipment') } },
            { Put: { TableName: this.tableName, Item: edge(vesselPk(req.vessel_id), vesselVoyEdgeSk(req.planned_departure, id), 'VesselVoyage') } },
          ],
        }),
      );
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) {
        if (THROTTLE_ERRORS.has((err as Error).name)) return { kind: 'busy' };
        throw err;
      }
      const codes = (err.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
      // 同一個 key 的另一個請求先寫入 → 當作重送 / A concurrent request with the same key won the race.
      if (codes[0] === 'ConditionalCheckFailed') return (await replay()) ?? { kind: 'conflict' };
      if (codes.some((c) => THROTTLE_CODES.has(c))) return { kind: 'busy' };
      return { kind: 'conflict' };
    }
    return { kind: 'created', shipment };
  }

  /** META＋事件＋航跡（同一個 pk 的 Query）/ META, events and track in one Query. */
  async getDetail(id: string): Promise<ShipmentDetail | undefined> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': shipPk(id) },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start && items.length < 500);
    let shipment: ShipmentItem | undefined;
    const events: DcsaTransportEvent[] = [];
    let track: Array<[number, number, string]> = [];
    for (const raw of items) {
      const m = ShipmentItemSchema.safeParse(raw);
      if (m.success && m.data.shipment_id === id) {
        shipment = m.data;
        continue;
      }
      const e = ShipmentEventItemSchema.safeParse(raw);
      if (e.success) {
        events.push(e.data.event);
        continue;
      }
      const t = TrackItemSchema.safeParse(raw);
      if (t.success) track = t.data.points;
    }
    if (!shipment) return undefined;
    events.sort((a, b) => a.eventDateTime.localeCompare(b.eventDateTime));
    return { shipment, events, track };
  }

  /** 批次的貨運（新到舊，最多 limit 筆）/ Shipments of a lot, newest first. */
  async listByLot(lotId: string, limit: number): Promise<ShipmentItem[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': lotPk(lotId), ':p': LOT_SHIP_EDGE_PREFIX },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const ids = (out.Items ?? []).flatMap((raw) => {
      const p = ShipmentEdgeSchema.safeParse(raw);
      return p.success ? [p.data.shipment_id] : [];
    });
    if (ids.length === 0) return [];
    const found: ShipmentItem[] = [];
    let keys: Record<string, unknown>[] | undefined = ids.map((id) => ({ pk: shipPk(id), sk: META_SK }));
    for (let attempt = 0; keys && keys.length > 0 && attempt < 3; attempt++) {
      const res = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
      for (const raw of res.Responses?.[this.tableName] ?? []) {
        const p = ShipmentItemSchema.safeParse(raw);
        if (p.success) found.push(p.data);
      }
      keys = res.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, unknown>[] | undefined;
    }
    return found.sort((a, b) => b.planned_departure.localeCompare(a.planned_departure));
  }

  // --- P2b-2 偵測器 / Detector ---

  /**
   * 船的候選貨運：船邊（VESSEL#/VOY#…）中未抵港的，再讀 META（強一致）。只看最近 120 天開航的。
   * Candidate shipments of a vessel: its not-yet-arrived voyage edges, then their META (strongly consistent).
   */
  async vesselShipments(vesselId: string, sinceIso: string): Promise<ShipmentItem[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND sk >= :from',
        ExpressionAttributeValues: { ':pk': vesselPk(vesselId), ':from': `${VESSEL_VOY_EDGE_PREFIX}${sinceIso}` },
        Limit: 50,
      }),
    );
    const ids = (out.Items ?? []).flatMap((raw) => {
      const p = ShipmentEdgeSchema.safeParse(raw);
      return p.success && p.data.status !== 'ARRIVED' ? [p.data.shipment_id] : [];
    });
    const found: ShipmentItem[] = [];
    for (const id of ids) {
      const s = await this.getShipment(id, true);
      if (s) found.push(s);
    }
    return found;
  }

  async getTrack(id: string): Promise<TrackPoint[]> {
    const out = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { pk: shipPk(id), sk: 'TRACK' }, ConsistentRead: true }));
    const p = TrackItemSchema.safeParse(out.Item);
    return p.success ? (p.data.points as TrackPoint[]) : [];
  }

  /**
   * 一個交易寫入偵測結果：META（樂觀鎖 version）＋新的運輸事件（attribute_not_exists）＋航跡＋（狀態改變時）兩條邊的狀態。
   * 版本衝突 → 丟錯讓 Lambda 重試（重讀後只會處理比 last_position_at 新的點）。
   * One transaction: META (optimistic lock) + new transport events + track + edge statuses on a status change.
   * A version conflict throws so Lambda retries with a fresh read.
   */
  async applyAdvance(s: ShipmentItem, r: AdvanceResult, track: TrackPoint[] | undefined, now: Date): Promise<void> {
    const at = now.toISOString();
    const set = ['#st = :st', '#tr = :tr', '#v = :next', '#u = :at'];
    const values: Record<string, unknown> = { ':st': r.status, ':tr': r.tracking, ':next': s.version + 1, ':at': at, ':v': s.version };
    for (const [k, v] of [['atd', r.atd], ['ata', r.ata], ['eta', r.eta]] as const) {
      if (v !== undefined) {
        set.push(`${k} = :${k}`);
        values[`:${k}`] = v;
      }
    }
    const statusChanged = r.status !== s.status;
    const edgeUpdate = (pk: string, sk: string) => ({
      Update: {
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: 'SET #st = :st',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':st': r.status },
      },
    });
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: shipPk(s.shipment_id), sk: META_SK },
              UpdateExpression: `SET ${set.join(', ')}`,
              ConditionExpression: '#v = :v',
              ExpressionAttributeNames: { '#st': 'status', '#tr': 'tracking', '#v': 'version', '#u': 'updated_at' },
              ExpressionAttributeValues: values,
            },
          },
          ...r.events.map((e) => ({
            Put: {
              TableName: this.tableName,
              Item: { pk: shipPk(s.shipment_id), sk: `EVT#${e.eventDateTime}#${e.eventID}`, entity: 'TransportEvent', event: e },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          })),
          ...(track ? [{ Put: { TableName: this.tableName, Item: { pk: shipPk(s.shipment_id), sk: 'TRACK', entity: 'Track', points: track } } }] : []),
          ...(statusChanged
            ? [
                edgeUpdate(lotPk(s.lot_id), lotShipEdgeSk(s.planned_departure, s.shipment_id)),
                edgeUpdate(vesselPk(s.vessel.vessel_id), vesselVoyEdgeSk(s.planned_departure, s.shipment_id)),
              ]
            : []),
        ],
      }),
    );
  }
}
