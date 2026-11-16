import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvName, LambdaSettings, MailSettings } from '../config';
import { BrewlineFunction } from '../constructs/brewline-function';
import { TenantAccessRole } from '../constructs/tenant-access-role';
import { DataStack } from './data-stack';
import { EventsStack } from './events-stack';
import { OpsStack, notifyAlarms } from './ops-stack';

export interface NotifyStackProps extends StackProps {
  readonly envName: EnvName;
  readonly lambda: LambdaSettings;
  readonly mail: MailSettings;
}

/** 寄信時機（ADR-029 D5）：OrderStatusChanged 只處理這些新狀態 / Status changes that send an e-mail. */
export const NOTIFIED_STATUSES = ['CONFIRMED', 'SHIPPED', 'CANCELLED'] as const;

/** DMARC（ADR-029 E3）/ DMARC policy. */
export const DMARC_POLICY = 'v=DMARC1; p=quarantine; adkim=s; aspf=r';

/**
 * 訂單通知信（A4d，ADR-029 D1／D5）：SES 網域身分（Easy DKIM、MAIL FROM、DMARC）＋ 通知函數。
 * Order e-mail: SES domain identity (Easy DKIM, MAIL FROM, DMARC) plus the notifier function.
 *
 * DNS：Prod 用註冊網域時建立的 hosted zone；Dev 由這個 stack 建立 `dev.<網域>` 的 zone，
 * 再由 Prod 依 config 的 NS 值建立委派記錄（不需要跨帳號角色，ADR-029 E2）。
 * DNS: Prod imports the zone created by the registration; Dev creates `dev.<domain>` and Prod delegates it using the
 * NS values in config (no cross-account role).
 */
export class NotifyStack extends Stack {
  public readonly zone: route53.IPublicHostedZone;
  public readonly fromAddress: string;

  constructor(scope: Construct, id: string, props: NotifyStackProps) {
    super(scope, id, props);
    const { envName, mail } = props;
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const dataPrefix = DataStack.parameterPrefix(envName);
    const tableName = param(`${dataPrefix}/table-name`);
    const keyArn = param(`${dataPrefix}/kms-key-arn`);
    const busArn = param(`${EventsStack.parameterPrefix(envName)}/bus-arn`);
    const opsTopic = sns.Topic.fromTopicArn(this, 'OpsTopic', param(`${OpsStack.parameterPrefix(envName)}/alerts-topic-arn`));
    this.fromAddress = `${mail.fromLocalPart}@${mail.domain}`;

    // --- 1) Hosted zone ---
    if (mail.hostedZoneId) {
      this.zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: mail.hostedZoneId,
        zoneName: mail.domain,
      });
    } else {
      const zone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: mail.domain,
        comment: `BrewLine ${envName} mail subdomain (delegated from the parent zone in Prod)`,
      });
      // 重建 zone 會換名稱伺服器 → 上層的委派記錄失效；保留 / Recreating changes the name servers; keep it.
      zone.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.zone = zone;
      new CfnOutput(this, 'MailZoneNameServers', {
        description: 'Copy these into the Prod mail.delegations config (ADR-029 E2)',
        value: Fn.join(',', zone.hostedZoneNameServers!),
      });
    }

    // --- 2) 子網域委派（Prod）/ Subdomain delegation (Prod) ---
    for (const d of mail.delegations) {
      if (d.nameServers.length === 0) continue;
      if (d.nameServers.length !== 4) throw new Error(`delegation ${d.subdomain}: expected 4 name servers`);
      new route53.NsRecord(this, `Delegate-${d.subdomain}`, {
        zone: this.zone,
        recordName: d.subdomain,
        values: [...d.nameServers],
        ttl: Duration.hours(1),
      });
    }

    // --- 3) DMARC ---
    // adkim=s：DKIM 網域必須和 From 完全相同（SES Easy DKIM 簽 d=<網域>）。aspf=r：MAIL FROM 是 mail.<網域>，
    // 寬鬆比對才算一致 → DKIM 與 SPF 兩條都能通過。
    // adkim=s: the DKIM domain must equal the From domain. aspf=r: the MAIL FROM is mail.<domain>, so SPF aligns only
    // in relaxed mode → both DKIM and SPF pass.
    new route53.TxtRecord(this, 'Dmarc', {
      zone: this.zone,
      recordName: '_dmarc',
      values: [DMARC_POLICY],
      ttl: Duration.hours(1),
    });

    // --- 4) Configuration set：退信、投訴、拒絕 → 維運主題（E5）/ Bounces etc. → ops topic ---
    const configurationSet = new ses.ConfigurationSet(this, 'ConfigurationSet', {
      configurationSetName: `brewline-${envName}-mail`,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      reputationMetrics: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    configurationSet.addEventDestination('ToOpsTopic', {
      configurationSetEventDestinationName: 'ops-alerts',
      destination: ses.EventDestination.snsTopic(opsTopic),
      events: [
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });

    // --- 5) SES 網域身分：Easy DKIM（RSA 2048）＋ MAIL FROM；DNS 記錄由 CDK 寫入 zone ---
    //        Domain identity; CDK writes the DKIM CNAMEs and MAIL FROM MX/SPF records into the zone.
    const identity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(this.zone),
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      mailFromDomain: `mail.${mail.domain}`,
      // MAIL FROM 的 MX 查不到時拒寄，而不是退回 amazonses.com（那樣 SPF 就不一致）
      // Refuse to send rather than silently fall back to amazonses.com (which would break SPF alignment).
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.REJECT_MESSAGE,
      configurationSet,
    });

    // CDK 內建的區域資料認為台北沒有這 3 種 SES 資源類型，但 2026-11-16 以 `cloudformation describe-type`
    // 在 ap-east-2 實測都存在 → 明確略過這項離線驗證。
    // CDK's bundled region data says these SES types are missing in ap-east-2; `describe-type` confirmed on
    // 2026-11-16 that all three exist, so acknowledge the offline check.
    const typeCheck = {
      id: 'CloudFormation-Validate::F3006',
      reason: 'Verified with `aws cloudformation describe-type --region ap-east-2` (2026-11-16): the SES type exists; CDK region data is stale.',
    };
    const sesTypes = [ses.CfnConfigurationSet, ses.CfnConfigurationSetEventDestination, ses.CfnEmailIdentity];
    for (const child of [...configurationSet.node.findAll(), ...identity.node.findAll()]) {
      if (sesTypes.some((t) => child instanceof t)) Validations.of(child).acknowledge(typeCheck);
    }

    // --- 6) 通知函數 / Notifier ---
    const dlq = new sqs.Queue(this, 'NotifyDlq', {
      queueName: `brewline-${envName}-notify-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(dlq).acknowledge({
      id: 'AwsSolutions-SQS3',
      reason: 'This queue is itself the dead-letter queue for the notifier (failed async invocations and rule deliveries).',
    });

    const notifier = new BrewlineFunction(this, 'Notifier', {
      envName,
      lambda: props.lambda,
      module: 'notifications',
      name: 'order-notifier',
      entry: 'ordering/src/notifications/order-notifier.ts',
      description: 'Order e-mails (created/confirmed/shipped/cancelled) via SES; reads the contact with tenant credentials',
      reservedConcurrency: props.lambda.reservedConcurrency.notifier,
      // 角色名稱符合 brewline-<env>-orders-* → 可扮演租戶角色（讀聯絡人、KMS 解密、寫寄送記錄）
      // Matches brewline-<env>-orders-*, so it may assume the tenant role (contact, KMS, delivery record).
      roleName: `${TenantAccessRole.callerRolePrefix(envName)}notify`,
      environment: {
        TABLE_NAME: tableName,
        KMS_KEY_ARN: keyArn,
        TENANT_ROLE_ARN: `arn:aws:iam::${this.account}:role/${TenantAccessRole.roleName(envName)}`,
        FROM_ADDRESS: this.fromAddress,
        FROM_NAME: mail.fromName,
        CONFIGURATION_SET: configurationSet.configurationSetName,
        ENV_NAME: envName,
        POWERTOOLS_SERVICE_NAME: 'notifications-order-notifier',
      },
    });
    notifier.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeTenantRole',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [`arn:aws:iam::${this.account}:role/${TenantAccessRole.roleName(envName)}`],
      }),
    );
    // 沙盒中 SES 也會以「收件人的已驗證身分」評估授權 → 資源用 identity/*，但寄件地址鎖死。
    // In the sandbox SES also authorizes against the recipient's verified identity → identity/*, From address pinned.
    notifier.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SendOrderMail',
        actions: ['ses:SendEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configurationSet.configurationSetName}`,
        ],
        conditions: { StringEquals: { 'ses:FromAddress': this.fromAddress } },
      }),
    );
    Validations.of(notifier.role).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:aws:ses:${this.region}:${this.account}:identity/*]`,
      reason: 'In the SES sandbox the recipient identity is also authorized; the From address is pinned by ses:FromAddress.',
    });
    // 非同步呼叫：重試 2 次、最多 6 小時，之後進 DLQ / Async: 2 retries within 6 hours, then the DLQ.
    notifier.function.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.hours(6),
      onFailure: new destinations.SqsDestination(dlq),
    });

    // --- 7) 規則 / Rules ---
    const bus = events.EventBus.fromEventBusArn(this, 'Bus', busArn);
    const target = new targets.LambdaFunction(notifier.function, {
      deadLetterQueue: dlq,
      retryAttempts: 3,
      maxEventAge: Duration.hours(2),
    });
    new events.Rule(this, 'OrderCreatedRule', {
      eventBus: bus,
      ruleName: `brewline-${envName}-mail-order-created`,
      description: 'OrderCreated → order e-mail (ADR-029 D5)',
      eventPattern: { source: ['brewline.ordering'], detailType: ['OrderCreated'] },
      targets: [target],
    });
    new events.Rule(this, 'OrderStatusRule', {
      eventBus: bus,
      ruleName: `brewline-${envName}-mail-order-status`,
      description: 'OrderStatusChanged to CONFIRMED/SHIPPED/CANCELLED → order e-mail (ADR-029 D5)',
      eventPattern: {
        source: ['brewline.ordering'],
        detailType: ['OrderStatusChanged'],
        detail: { status: [...NOTIFIED_STATUSES] },
      },
      targets: [target],
    });

    // --- 8) 告警 / Alarms ---
    new cloudwatch.Alarm(this, 'NotifyDlqAlarm', {
      alarmName: `brewline-${envName}-notify-dlq-not-empty`,
      alarmDescription: 'Order e-mails that could not be sent after retries (OPS-A05). Runbook RB-OPS-02.',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    notifyAlarms(this, envName);

    new CfnOutput(this, 'MailDomain', { value: mail.domain });
    new CfnOutput(this, 'HostedZoneId', { value: this.zone.hostedZoneId });
    new CfnOutput(this, 'FromAddress', { value: this.fromAddress });
    new CfnOutput(this, 'ConfigurationSetName', { value: configurationSet.configurationSetName });
    new CfnOutput(this, 'EmailIdentityName', { value: identity.emailIdentityName });
    new CfnOutput(this, 'NotifierFunctionName', { value: notifier.function.functionName });
    new CfnOutput(this, 'NotifyDlqUrl', { value: dlq.queueUrl });
  }
}
