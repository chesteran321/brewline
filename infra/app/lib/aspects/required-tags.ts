import { Annotations, AspectPriority, Aspects, CfnResource, IAspect, TagManager, Tags } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { REQUIRED_TAG_KEYS } from '../config';

export interface StandardTagProps {
  readonly env: string;
  readonly module: string;
  readonly owner?: string;
}

/**
 * 套用標籤規範（docs/02 §6）。Tags.of() 本身就是一個 MUTATING 優先序的 Aspect。
 * Apply the tagging policy. Tags.of() is itself a MUTATING-priority Aspect.
 */
export function applyStandardTags(scope: IConstruct, props: StandardTagProps): void {
  Tags.of(scope).add('project', 'brewline');
  Tags.of(scope).add('env', props.env);
  Tags.of(scope).add('module', props.module);
  Tags.of(scope).add('owner', props.owner ?? 'chester');
}

/**
 * 唯讀檢查：任何可貼標籤的資源缺少必填標籤時，於 synth 階段報錯。
 * Read-only check: error at synth time if a taggable resource lacks a required tag.
 *
 * 以 READONLY 優先序執行，保證在所有 Tags（MUTATING）套用之後才檢查。
 * Runs at READONLY priority so it sees the tree after all Tags aspects have applied.
 */
export class RequiredTagsChecker implements IAspect {
  public visit(node: IConstruct): void {
    // 只檢查實際的 CloudFormation 資源；Stack 本身也可貼標籤，但它只是把標籤傳下去。
    // Only check real CloudFormation resources; a Stack is taggable but merely propagates tags.
    if (!(node instanceof CfnResource) || !TagManager.isTaggable(node)) {
      return;
    }
    const present = node.tags.tagValues();
    const missing = REQUIRED_TAG_KEYS.filter((key) => !(key in present));
    if (missing.length > 0) {
      Annotations.of(node).addError(`Missing required tags: ${missing.join(', ')}`);
    }
  }

  /** 掛到 scope 上 / Attach the checker to a scope. */
  public static attach(scope: IConstruct): void {
    Aspects.of(scope).add(new RequiredTagsChecker(), { priority: AspectPriority.READONLY });
  }
}
