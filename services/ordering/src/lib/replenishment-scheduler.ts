import { ConflictException, CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient } from '@aws-sdk/client-scheduler';
import { ReplenishmentItem, SCHEDULE_TIMEZONE, scheduleExpression } from './replenishment-model';

/**
 * EventBridge Scheduler 包裝（A4e）。排程只帶 ID 與觸發時間，品項等內容由函數從 DynamoDB 讀 → 改品項不用改排程。
 * Scheduler wrapper. The schedule carries only ids and the firing time; contents are read from DynamoDB.
 */
export interface ScheduleTarget {
  readonly groupName: string;
  readonly functionArn: string;
  readonly roleArn: string;
  readonly dlqArn: string;
}

export class ReplenishmentScheduler {
  constructor(
    private readonly client: Pick<SchedulerClient, 'send'>,
    private readonly target: ScheduleTarget,
  ) {}

  async create(r: ReplenishmentItem): Promise<void> {
    try {
      await this.client.send(
        new CreateScheduleCommand({
          Name: r.schedule_name,
          GroupName: this.target.groupName,
          Description: `BrewLine replenishment ${r.replenishment_id} (${r.frequency})`,
          ScheduleExpression: scheduleExpression(r),
          ScheduleExpressionTimezone: SCHEDULE_TIMEZONE,
          FlexibleTimeWindow: { Mode: 'OFF' },
          State: 'ENABLED',
          Target: {
            Arn: this.target.functionArn,
            RoleArn: this.target.roleArn,
            // <aws.scheduler.*> 由 Scheduler 在觸發時代入 / Filled in by Scheduler at firing time.
            Input: JSON.stringify({
              tenant_id: r.tenant_id,
              replenishment_id: r.replenishment_id,
              scheduled_time: '<aws.scheduler.scheduled-time>',
            }),
            RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 },
            DeadLetterConfig: { Arn: this.target.dlqArn },
          },
        }),
      );
    } catch (err) {
      // 同名排程已存在（重試）→ 視為成功 / Already exists (a retry) → treat as created.
      if (!(err instanceof ConflictException) && (err as Error).name !== 'ConflictException') throw err;
    }
  }

  /** 刪除（冪等：不存在也算成功）/ Delete; idempotent. */
  async delete(r: Pick<ReplenishmentItem, 'schedule_name'>): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({ Name: r.schedule_name, GroupName: this.target.groupName }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException) && (err as Error).name !== 'ResourceNotFoundException') throw err;
    }
  }
}
