import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { EventBridgeEvent } from 'aws-lambda';
import { ContactRepo } from '../lib/contact-repo';
import { contactRepo, logger, tenantDocClient, tracer } from '../lib/runtime';
import { OrderEventDetailSchema, buildEmail, isReservedRecipient, kindOf } from './order-email';
import { NotifyMarkerRepo } from './notify-marker-repo';

/**
 * 訂單通知信（A4d，ADR-029 D5）：EventBridge → 這個函數 → 讀聯絡人（租戶憑證＋KMS）→ SES。
 * Order e-mails: EventBridge → this function → contact (tenant credentials + KMS) → SES.
 *
 * - 函數角色名稱 `brewline-<env>-orders-notify`：可扮演租戶角色，只碰得到該租戶的資料與 KMS context。
 * - SES 由函數自己的角色呼叫，IAM 限定寄件地址（`ses:FromAddress`）。
 * - **日誌不記錄收件地址或姓名**。
 * The role may assume the tenant role; SES is called with the function's own role, restricted to the From address.
 * Recipient address and name are never logged.
 */

/** 暫時性失敗：拋出讓 Lambda 非同步重試，最後進 DLQ / Transient: rethrow so async retries (then the DLQ) apply. */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
}

/** SES 永久拒絕（例如沙盒中收件人未驗證）：不重試 / Permanent SES rejections (e.g. unverified recipient in the sandbox). */
const PERMANENT_SES_ERRORS = new Set(['MessageRejected', 'BadRequestException']);

export interface NotifierDeps {
  readonly contacts: Pick<ContactRepo, 'get'>;
  readonly markers: Pick<NotifyMarkerRepo, 'claim' | 'finish'>;
  readonly ses: Pick<SESv2Client, 'send'>;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly configurationSet: string;
  readonly envName: string;
  readonly now?: () => Date;
}

export type NotifyOutcome =
  | 'sent'
  | 'duplicate'
  | 'not_notified'
  | 'invalid_event'
  | 'skipped_no_contact'
  | 'skipped_reserved'
  | 'rejected';

export async function notify(event: Pick<EventBridgeEvent<string, unknown>, 'detail-type' | 'detail'>, d: NotifierDeps): Promise<NotifyOutcome> {
  const now = d.now ?? (() => new Date());
  const parsed = OrderEventDetailSchema.safeParse(event.detail);
  if (!parsed.success) {
    logger.warn('invalid order event', { detail_type: event['detail-type'] });
    return 'invalid_event';
  }
  const detail = parsed.data;
  const kind = kindOf(event['detail-type'], detail);
  if (!kind) return 'not_notified';
  const log = { tenant_id: detail.tenant_id, order_id: detail.order_id, event_id: detail.event_id, kind };

  const claim = await d.markers.claim(detail.tenant_id, detail.event_id, kind, detail.order_id, now());
  if (claim === 'done') {
    logger.info('duplicate event, already handled', log);
    return 'duplicate';
  }
  if (claim === 'in_flight') throw new RetryableError('another invocation is sending this event');

  const finish = (status: Parameters<NotifyMarkerRepo['finish']>[4], messageId?: string) =>
    d.markers.finish(detail.tenant_id, detail.event_id, kind, detail.order_id, status, now(), messageId);

  let contact;
  try {
    contact = await d.contacts.get(detail.tenant_id);
  } catch (err) {
    await finish('failed');
    throw err;
  }
  if (!contact) {
    await finish('skipped_no_contact');
    logger.info('no contact on file, skipped', log);
    return 'skipped_no_contact';
  }
  if (isReservedRecipient(contact.email)) {
    await finish('skipped_reserved');
    logger.info('reserved test domain, skipped', log);
    return 'skipped_reserved';
  }

  const mail = buildEmail(kind, detail, contact.name, d.envName);
  try {
    const out = await d.ses.send(
      new SendEmailCommand({
        FromEmailAddress: `"${d.fromName}" <${d.fromAddress}>`,
        Destination: { ToAddresses: [contact.email] },
        ConfigurationSetName: d.configurationSet,
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: mail.text, Charset: 'UTF-8' } },
          },
        },
        EmailTags: [
          { Name: 'kind', Value: kind },
          { Name: 'env', Value: d.envName },
        ],
      }),
    );
    await finish('sent', out.MessageId);
    logger.info('order e-mail sent', { ...log, message_id: out.MessageId });
    return 'sent';
  } catch (err) {
    const name = (err as Error).name;
    if (PERMANENT_SES_ERRORS.has(name)) {
      await finish('rejected');
      // 不印 SES 的錯誤訊息：裡面可能有收件地址 / SES messages may contain the address, so log the name only.
      logger.warn('SES rejected the message (not retried)', { ...log, error: name });
      return 'rejected';
    }
    await finish('failed');
    logger.error('SES send failed (will retry)', { ...log, error: name });
    throw err;
  }
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

let deps: NotifierDeps | undefined;

export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<{ outcome: NotifyOutcome }> => {
  deps ??= {
    contacts: contactRepo(),
    markers: new NotifyMarkerRepo(tenantDocClient, requiredEnv('TABLE_NAME')),
    ses: tracer.captureAWSv3Client(new SESv2Client({})),
    fromAddress: requiredEnv('FROM_ADDRESS'),
    fromName: requiredEnv('FROM_NAME'),
    configurationSet: requiredEnv('CONFIGURATION_SET'),
    envName: requiredEnv('ENV_NAME'),
  };
  return { outcome: await notify(event, deps) };
};
