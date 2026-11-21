/**
 * 貨運邊（LOT#…/SHIP#…、VESSEL#…/VOY#…）允許的欄位。訂艙函數的 IAM 以 dynamodb:Attributes 限定只能寫這些欄位，
 * 所以它寫不了 LOT#…/META（生豆批次需要生產者等欄位）。沒有相依套件：CDK（infra/app）也匯入這個檔案。
 * Attributes allowed on shipment edge items. The booking function's IAM policy pins dynamodb:Attributes to this list,
 * so it can never overwrite a lot's META. Dependency-free because the CDK app imports it too.
 */
export const EDGE_ATTRIBUTES = ['pk', 'sk', 'entity', 'shipment_id', 'planned_departure', 'pol', 'pod', 'status', 'synthetic'] as const;
