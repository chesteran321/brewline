import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EnvName } from '../config';

export interface PipelineCheckStackProps extends StackProps {
  readonly envName: EnvName;
  /** 部署來源的 commit SHA；本機為 "local" / Source commit SHA, "local" when run locally. */
  readonly commitSha: string;
}

/**
 * 管線驗證用的最小 stack：只有一個 Standard tier SSM 參數（免費）。
 * Minimal stack to prove OIDC → CDK roles → CloudFormation: one free Standard-tier SSM parameter.
 *
 * 參數值是 commit SHA，部署後可用來確認「這次部署的確是這個 commit」。
 * The value is the commit SHA, so a deploy can be traced back to its commit.
 */
export class PipelineCheckStack extends Stack {
  public readonly parameterName: string;

  constructor(scope: Construct, id: string, props: PipelineCheckStackProps) {
    super(scope, id, props);

    this.parameterName = `/brewline/${props.envName}/pipeline-check`;

    const param = new ssm.StringParameter(this, 'PipelineCheck', {
      parameterName: this.parameterName,
      stringValue: props.commitSha,
      tier: ssm.ParameterTier.STANDARD,
      description: 'BrewLine CI/CD pipeline check. Value = deployed commit SHA. Safe to delete.',
    });

    new CfnOutput(this, 'PipelineCheckParameterName', { value: param.parameterName });
    new CfnOutput(this, 'PipelineCheckCommit', { value: props.commitSha });
  }
}
