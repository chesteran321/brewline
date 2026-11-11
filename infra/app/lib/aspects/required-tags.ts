import { Annotations, AspectPriority, Aspects, CfnResource, IAspect, Stack, TagManager, Tags } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { IConstruct } from 'constructs';
import { DATA_CLASS_TAG, DATA_CLASS_VALUES, REQUIRED_TAG_KEYS } from '../config';

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

/** 需要 data-class 標籤的資料資源 / Data resources that must carry a data-class tag. */
function isDataResource(node: CfnResource): boolean {
  return node instanceof dynamodb.CfnTable || node instanceof dynamodb.CfnGlobalTable || node instanceof s3.CfnBucket;
}

/**
 * 取得資源的標籤。回傳陣列：一般資源一組；GlobalTable 每個 replica 一組。
 * 不可貼標籤的資源回傳 undefined。
 * Return the tag sets of a resource: one set normally, one per replica for a GlobalTable,
 * or undefined when the resource cannot be tagged.
 *
 * 為什麼要特別處理 GlobalTable：它的標籤寫在 Replicas[].Tags，資源本身不是 ITaggable，
 * 只用 TagManager.isTaggable() 會讓 TableV2 的資料表被默默跳過。
 * Why GlobalTable is special: tags live in Replicas[].Tags and the resource itself is not
 * ITaggable, so a plain isTaggable() check would silently skip every TableV2 table.
 */
function tagSetsOf(node: CfnResource): Array<{ label: string; tags: Record<string, string> }> | undefined {
  if (node instanceof dynamodb.CfnGlobalTable) {
    const replicas = (Stack.of(node).resolve(node.replicas) ?? []) as Array<{
      region?: string;
      tags?: Array<{ key: string; value: string }>;
    }>;
    return replicas.map((r) => ({
      label: `replica ${r.region ?? '(primary)'}`,
      tags: Object.fromEntries((r.tags ?? []).map((t) => [t.key, t.value])),
    }));
  }
  if (TagManager.isTaggable(node)) {
    return [{ label: '', tags: node.tags.tagValues() }];
  }
  return undefined;
}

/**
 * 唯讀檢查：任何可貼標籤的資源缺少必填標籤時，於 synth 階段報錯；資料資源另外檢查 data-class。
 * Read-only check: error at synth time if a taggable resource lacks a required tag;
 * data resources must also carry a valid data-class tag.
 *
 * 以 READONLY 優先序執行，保證在所有 Tags（MUTATING）套用之後才檢查。
 * Runs at READONLY priority so it sees the tree after all Tags aspects have applied.
 */
export class RequiredTagsChecker implements IAspect {
  public visit(node: IConstruct): void {
    // 只檢查實際的 CloudFormation 資源；Stack 本身也可貼標籤，但它只是把標籤傳下去。
    // Only check real CloudFormation resources; a Stack is taggable but merely propagates tags.
    if (!(node instanceof CfnResource)) {
      return;
    }
    const sets = tagSetsOf(node);
    if (!sets) {
      return;
    }
    const required: string[] = [...REQUIRED_TAG_KEYS];
    if (isDataResource(node)) {
      required.push(DATA_CLASS_TAG);
    }
    for (const { label, tags } of sets) {
      const where = label ? ` (${label})` : '';
      const missing = required.filter((key) => !(key in tags));
      if (missing.length > 0) {
        Annotations.of(node).addError(`Missing required tags${where}: ${missing.join(', ')}`);
      }
      const dataClass = tags[DATA_CLASS_TAG];
      if (dataClass !== undefined && !(DATA_CLASS_VALUES as readonly string[]).includes(dataClass)) {
        Annotations.of(node).addError(
          `Invalid ${DATA_CLASS_TAG} "${dataClass}"${where}; use one of ${DATA_CLASS_VALUES.join(', ')}`,
        );
      }
    }
  }

  /** 掛到 scope 上 / Attach the checker to a scope. */
  public static attach(scope: IConstruct): void {
    Aspects.of(scope).add(new RequiredTagsChecker(), { priority: AspectPriority.READONLY });
  }
}
