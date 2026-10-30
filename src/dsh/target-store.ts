/**
 * dsh-qqbot-bridge: 控制目标持久化
 *
 * 采用 DSH 官方 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain` / `domainTable` 规范，
 * 将每个 QQ 用户（openid）当前所选中的工作区与受控会话映射安全持久化。
 *
 * 只持久化控制目标指针，会话运行时的模型、思考强度及权限状态完全由 DSH 官方服务管理。
 */

import { z } from 'zod';
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain';
import type { ControlTarget } from '../types/index.js';

/** 领域内唯一的表名（须匹配 `UNIT_NAME_RE`：`^[a-z][a-z0-9_]*$`） */
export const CONTROL_TARGET_TABLE = 'targets' as const;

/** 一条持久化记录；字段与 D28 的 `{workspaceId, targetSessionId}` 一一对应 */
export const controlTargetRecord = z.object({
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
});

export type ControlTargetRecord = z.infer<typeof controlTargetRecord>;

/** 领域规格：域名同样须匹配 `UNIT_NAME_RE` */
export const controlTargetDomainSpec = defineDomain({
  name: 'qqbot_control_target',
  version: 1,
  tables: {
    targets: domainTable<string, ControlTargetRecord>(controlTargetRecord),
  },
});

/** 未选中态的规范值（D19/D27） */
export function unselectedTarget(): ControlTarget {
  return { workspaceId: null, sessionId: null };
}

/**
 * 控制目标存储接口。
 * `get` 为**同步读**（domain 的权威内存态）；`put` 为**异步durable写**，
 * 只有后端落盘成功后才在内存生效（领域实现保证：写失败不留内存分叉）。
 */
export interface TargetStore {
  get(openid: string): ControlTarget;
  put(openid: string, target: ControlTarget): Promise<void>;
  /** 启动恢复用：枚举全部已持久化记录 */
  entries(): IterableIterator<[string, ControlTarget]>;
}

/**
 * 域句柄是否已不可用。
 *
 * 【文档明写】`@deepseek-ai/dsh-storage-domain` 的 `DomainImpl` 用两个标记控制可用性：
 * `close()` 一开始就置 `disposing=true`（此后 `enqueue` 直接拒绝新写），
 * 关闭完成后置 `closed=true`（此后 `assertReadable` 连读也拒绝）。
 * 两者任一为真，该句柄都不能再被使用——继续用就会抛
 * `domain 'qqbot_control_target' is closed`。
 *
 * 这两个字段属于运行时实现的内部状态，未出现在公开 `Domain` 类型声明中，故按结构探测。
 * 结构探测失效（字段改名/实现替换）时不能只靠它：调用方另有 `isClosedDomainError()`
 * 作为行为层面的兜底，见 `DomainTargetStore`。
 */
function isDomainDead(domain: unknown): boolean {
  const probe = domain as { closed?: boolean; disposing?: boolean };
  return probe.closed === true || probe.disposing === true;
}

/**
 * 判断某个错误是否表示「域已关闭」。
 *
 * 与 `isDomainDead()` 互补：那个靠内部字段预判，这个靠真实抛出的错误识别。
 * `DomainError` 携带 `code: 'closed'`；即便错误码将来变化，消息文本里的
 * `is closed` 仍是稳定特征。
 */
function isClosedDomainError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'closed') return true;
    return error.message.includes('is closed');
  }
  return false;
}

class DomainTargetStore implements TargetStore {
  constructor(
    private readonly tableOf: () => KvTable<string, ControlTargetRecord>,
    private readonly healNow: () => Promise<void>,
  ) {}

  get(openid: string): ControlTarget {
    try {
      const record = this.tableOf().get(openid);
      if (record === undefined) return unselectedTarget();
      return { workspaceId: record.workspaceId, sessionId: record.sessionId };
    } catch (error) {
      // 同步读无法等待重开：触发自愈后如实抛出，由下一条消息恢复
      if (isClosedDomainError(error)) void this.healNow().catch(() => undefined);
      throw error;
    }
  }

  async put(openid: string, target: ControlTarget): Promise<void> {
    const write = (): Promise<void> =>
      this.tableOf().put(openid, { workspaceId: target.workspaceId, sessionId: target.sessionId });
    try {
      await write();
    } catch (error) {
      if (!isClosedDomainError(error)) throw error;
      // 写是异步的：先完成自愈再重试一次，避免用户的这次选择直接丢失
      await this.healNow();
      await write();
    }
  }

  entries(): IterableIterator<[string, ControlTarget]> {
    try {
      const pairs: [string, ControlTarget][] = [];
      for (const [openid, record] of this.tableOf().entries()) {
        pairs.push([openid, { workspaceId: record.workspaceId, sessionId: record.sessionId }]);
      }
      return pairs[Symbol.iterator]();
    } catch (error) {
      if (isClosedDomainError(error)) void this.healNow().catch(() => undefined);
      throw error;
    }
  }
}

/** 已打开的控制目标存储（调用方持有生命周期） */
export interface OpenedTargetStore {
  store: TargetStore;
  close(): Promise<void>;
}

type ControlTargetDomain = Domain<typeof controlTargetDomainSpec>;

/**
 * 当前持有的域句柄。
 *
 * `owned` 是**生命周期归属**，不是可有可无的标记：
 * - `true` —— 本 store 通过 `open()` 自己开出来的，`close()` 时应当关闭；
 * - `false` —— 复用其他实例已经打开的域，**绝不能关闭**，否则会把别人的活域抽走，
 *   对方之后每一次读写都会抛 `domain is closed`（与本 PR 所修复的故障同源、方向相反）。
 */
interface DomainHandle {
  domain: ControlTargetDomain;
  owned: boolean;
}

/**
 * 取一个**可用**的控制目标域。
 *
 * `facility.get()` 只按名字取回句柄，**不判断该域是否仍然开着**；插件重载或重复装配时，
 * 上一个实例留下的句柄可能正处于 `disposing` 或已 `closed`。直接复用这种死句柄，会让之后
 * 每一次 `get/put` 都抛 `domain 'qqbot_control_target' is closed`，在真机上表现为
 * 「每条 QQ 消息都回处理失败」。
 *
 * 因此只复用仍然活着的域；句柄已死则等它彻底释放域名后重新 `open`。
 *
 * @param ctx - 携带 `storageDomain` 设施的装配上下文
 * @param dead - 已知失效的旧句柄，重新打开前先等它关闭完成（仅当本 store 拥有它时才代为关闭）
 */
async function acquireDomain(
  ctx: { storageDomain: DomainFacility },
  dead?: DomainHandle,
): Promise<DomainHandle> {
  // `DomainFacility.get()` 未收录进公开类型，按结构显式读取（不做 `as any` 兜底）。
  // 它返回的是运行时实现 `DomainImpl`，与 `Domain<S>` 的 `global` 字段不兼容，故在此收窄。
  const lookup = (): ControlTargetDomain | undefined => {
    const raw = (ctx.storageDomain as { get?: (name: string) => unknown }).get?.(
      controlTargetDomainSpec.name,
    );
    return raw as ControlTargetDomain | undefined;
  };

  // 只关闭自己开出来的域；借来的域由它的主人负责释放，我们只是不再使用它
  if (dead !== undefined && dead.owned) {
    try {
      await dead.domain.close();
    } catch {
      // 关闭失败不影响后续 open；真有问题会由 open 报出
    }
  }

  const existing = lookup();
  if (existing !== undefined) {
    if (!isDomainDead(existing)) return { domain: existing, owned: false };
    try {
      // 已是死句柄，close() 幂等，不会影响他人
      await existing.close();
    } catch {
      // 同上
    }
  }

  try {
    return { domain: await ctx.storageDomain.open(controlTargetDomainSpec), owned: true };
  } catch (error) {
    // 竞态：另一处刚把同名域打开（`open` 会报 already-open）——只要它还活着就复用它
    const again = lookup();
    if (again !== undefined && !isDomainDead(again)) return { domain: again, owned: false };
    throw error;
  }
}

/**
 * 在真实 DSH 装配上打开控制目标域。
 * 调用方（`src/index.ts` 接线层 / 契约测试）负责在插件卸载时调用 `close()`。
 */
export async function openTargetStore(ctx: { storageDomain: DomainFacility }): Promise<OpenedTargetStore> {
  let current = await acquireDomain(ctx);
  /** 进行中的重开任务；并发调用共享同一次 */
  let healing: Promise<void> | null = null;
  /** ctx 失效后重开不可能成功，置位以停止巡检 */
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopWatchdog = (): void => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
  };

  /** 当前域已失效则重开；并发调用共享同一次重开 */
  const heal = async (): Promise<void> => {
    if (stopped || !isDomainDead(current.domain)) return;
    if (healing !== null) return healing;
    healing = (async () => {
      const dead = current;
      try {
        current = await acquireDomain(ctx, dead);
      } catch (error) {
        // `inactive context` = 插件实例已卸载，巡检重开永远不可能成功，停掉避免每秒空转
        if (error instanceof Error && error.message.includes('inactive context')) stopWatchdog();
        throw error;
      } finally {
        healing = null;
      }
    })();
    return healing;
  };

  // 兜底巡检：域在运行期被设施关闭时，最多 1 秒内自动重开，避免之后的消息全部失败
  timer = setInterval(() => {
    void heal().catch(() => undefined);
  }, 1000);
  (timer as { unref?: () => void }).unref?.();

  const tableOf = (): KvTable<string, ControlTargetRecord> => {
    if (isDomainDead(current.domain)) void heal().catch(() => undefined);
    return current.domain.table(CONTROL_TARGET_TABLE);
  };

  return {
    store: new DomainTargetStore(tableOf, heal),
    close: async () => {
      stopWatchdog();
      // 借来的域不关：它的生命周期归打开它的那个实例
      if (current.owned) await current.domain.close();
    },
  };
}
