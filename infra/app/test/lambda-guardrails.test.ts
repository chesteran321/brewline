import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LambdaGuardrailsChecker } from '../lib/aspects/lambda-guardrails';
import { ENVIRONMENTS } from '../lib/config';
import { BrewlineFunction } from '../lib/constructs/brewline-function';

function bareStack() {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new Stack(app, 'Bare', { env: { account: '111111111111', region: 'ap-east-2' } });
  LambdaGuardrailsChecker.attach(app);
  return stack;
}

/** 一個符合標準的 L2 函數，再用 overrides 逐項破壞 / A compliant function, broken one property at a time. */
function rawFunction(stack: Stack, overrides: Partial<lambda.FunctionProps> = {}) {
  const logGroup = new logs.LogGroup(stack, 'LG', { retention: logs.RetentionDays.ONE_WEEK });
  return new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    tracing: lambda.Tracing.ACTIVE,
    reservedConcurrentExecutions: 1,
    logGroup,
    handler: 'index.handler',
    code: lambda.Code.fromInline('export const handler = async () => {};'),
    ...overrides,
  });
}

const errors = (stack: Stack, pattern: string) =>
  Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp(pattern));

describe('LambdaGuardrailsChecker', () => {
  test('accepts a compliant function', () => {
    const stack = bareStack();
    rawFunction(stack);
    expect(errors(stack, 'LambdaGuardrails')).toHaveLength(0);
  });

  test('accepts BrewlineFunction for both environments', () => {
    for (const envName of ['dev', 'prod'] as const) {
      const stack = bareStack();
      new BrewlineFunction(stack, 'F', {
        envName,
        lambda: ENVIRONMENTS[envName].lambda,
        module: 'test',
        name: 'fn',
        entry: 'identity/src/pre-token-generation.ts',
        description: 'test',
        reservedConcurrency: 1,
      });
      expect(errors(stack, 'LambdaGuardrails')).toHaveLength(0);
    }
  });

  // 反向 / Negative
  test('errors on Node.js 22', () => {
    const stack = bareStack();
    rawFunction(stack, { runtime: lambda.Runtime.NODEJS_22_X });
    expect(errors(stack, 'runtime must be nodejs24.x')).toHaveLength(1);
  });

  test('errors on x86_64', () => {
    const stack = bareStack();
    rawFunction(stack, { architecture: lambda.Architecture.X86_64 });
    expect(errors(stack, 'must run on arm64')).toHaveLength(1);
  });

  test('errors without X-Ray tracing', () => {
    const stack = bareStack();
    rawFunction(stack, { tracing: lambda.Tracing.DISABLED });
    expect(errors(stack, 'X-Ray tracing')).toHaveLength(1);
  });

  test('errors without reserved concurrency', () => {
    const stack = bareStack();
    rawFunction(stack, { reservedConcurrentExecutions: undefined });
    expect(errors(stack, 'reserved concurrency')).toHaveLength(1);
  });

  test('errors without an explicit log group', () => {
    const stack = bareStack();
    rawFunction(stack, { logGroup: undefined });
    expect(errors(stack, 'explicit log group')).toHaveLength(1);
  });

  test('errors on a log group that never expires', () => {
    const stack = bareStack();
    new logs.LogGroup(stack, 'Forever', { retention: logs.RetentionDays.INFINITE });
    expect(errors(stack, 'retention period')).toHaveLength(1);
  });

  test('exempt() suppresses checks for that scope only, with a recorded reason', () => {
    const stack = bareStack();
    const fn = rawFunction(stack, { runtime: lambda.Runtime.NODEJS_22_X });
    LambdaGuardrailsChecker.exempt(fn, 'test: CDK-internal provider');
    new logs.LogGroup(stack, 'Forever', { retention: logs.RetentionDays.INFINITE });
    expect(errors(stack, 'runtime')).toHaveLength(0);
    expect(errors(stack, 'retention period')).toHaveLength(1);
    expect(fn.node.metadata.find((m) => m.type === 'brewline:lambda-guardrails-exempt')?.data).toBe(
      'test: CDK-internal provider',
    );
  });
});
