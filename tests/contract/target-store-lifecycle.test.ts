/**
 * 契约测试：控制目标存储的生命周期与句柄自愈
 *
 * 覆盖本次修复的两类故障（真机均已复现）：
 *   1. `facility.get()` 取回的句柄可能**已经关闭**——直接复用会让此后每次读写都抛
 *      `domain 'qqbot_control_target' is closed`（表现为「每条 QQ 消息都处理失败」）；
 *   2. 复用他人域时**不得关闭**它——否则会把对方正在使用的活域抽走，制造同源故障。
 *
 * 替身范围（AGENTS.md §3.1 允许）：仅隔离 `storageDomain` 设施本身（外部服务），
 * 被测对象是真实的 `openTargetStore` 实现，不对其做任何桩化。
 */

import { describe, expect, it } from 'vitest';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { CONTROL_TARGET_TABLE, openTargetStore, type ControlTargetRecord } from '../../src/dsh/target-store.js';

// ══════════════════ 最小可用的存储设施替身 ══════════════════

interface FakeTable {
  readonly size: number;
  readonly closed: boolean;
  get(key: string): ControlTargetRecord | undefined;
  put(key: string, value: ControlTargetRecord): Promise<void>;
  entries(): IterableIterator<[string, ControlTargetRecord]>;
  keys(): IterableIterator<string>;
  delete(key: string): Promise<boolean>;
  update(key: string, fn: (current: ControlTargetRecord) => ControlTargetRecord): Promise<ControlTargetRecord>;
  close(): void;
}

/** 一张内存表；关闭后读写都抛「域已关闭」，模拟真实域名关闭后的行为 */
function createTable(): FakeTable {
  const records = new Map<string, ControlTargetRecord>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("domain 'qqbot_control_target' is closed");
  };

  return {
    get size() {
      return records.size;
    },
    get closed() {
      return closed;
    },
    get(key: string): ControlTargetRecord | undefined {
      assertOpen();
      return records.get(key);
    },
    async put(key: string, value: ControlTargetRecord): Promise<void> {
      assertOpen();
      records.set(key, value);
    },
    entries(): IterableIterator<[string, ControlTargetRecord]> {
      assertOpen();
      return records.entries();
    },
    keys(): IterableIterator<string> {
      assertOpen();
      return records.keys();
    },
    async delete(key: string): Promise<boolean> {
      assertOpen();
      return records.delete(key);
    },
    async update(
      key: string,
      fn: (current: ControlTargetRecord) => ControlTargetRecord,
    ): Promise<ControlTargetRecord> {
      assertOpen();
      const current = records.get(key);
      if (current === undefined) throw new Error(`missing record '${key}'`);
      const next = fn(current);
      records.set(key, next);
      return next;
    },
    close(): void {
      closed = true;
    },
  };
}

interface FakeDomain {
  readonly name: string;
  readonly closed: boolean;
  readonly disposing: boolean;
  table(name: string): FakeTable;
  close(): Promise<void>;
}

/** 构造域句柄；`state.closed` 为真时行为与真实 `DomainImpl` 一致——读写皆抛 */
function createDomain(state: { closed?: boolean } = {}): FakeDomain {
  const table = createTable();
  let closedFlag = state.closed === true;
  if (closedFlag) table.close();

  return {
    name: 'qqbot_control_target',
    get closed() {
      return closedFlag;
    },
    get disposing() {
      return false;
    },
    table(_name: string) {
      return table;
    },
    async close(): Promise<void> {
      closedFlag = true;
      table.close();
    },
  };
}

interface FakeFacility {
  readonly openedCount: number;
  readonly lastOpened: FakeDomain | undefined;
  get(name: string): FakeDomain | undefined;
  open(spec: unknown): Promise<FakeDomain>;
}

function createFacility(seed?: FakeDomain): FakeFacility {
  let existing = seed;
  let openedCount = 0;
  let lastOpened: FakeDomain | undefined;

  return {
    get openedCount() {
      return openedCount;
    },
    get lastOpened() {
      return lastOpened;
    },
    get: () => existing,
    async open(): Promise<FakeDomain> {
      openedCount += 1;
      const created = createDomain();
      lastOpened = created;
      // 真实设施在 open 后会把域登记进设施，供后续 get() 取回
      existing = created;
      return created;
    },
  };
}

function asFacility(facility: FakeFacility): DomainFacility {
  return facility as unknown as DomainFacility;
}

// ══════════════════ 用例 ══════════════════

describe('openTargetStore：句柄生命周期', () => {
  it('复用仍然存活的既有域（不重复 open）且读写正常', async () => {
    const live = createDomain();
    const facility = createFacility(live);

    const opened = await openTargetStore({ storageDomain: asFacility(facility) });

    await opened.store.put('u1', { workspaceId: 'w1', sessionId: 's1' });
    expect(opened.store.get('u1')).toEqual({ workspaceId: 'w1', sessionId: 's1' });
    expect(facility.openedCount).toBe(0);
    await opened.close();
  });

  it('复用他人域时，close() 不得关闭该域（所有权归对方）', async () => {
    const live = createDomain();
    const facility = createFacility(live);

    const opened = await openTargetStore({ storageDomain: asFacility(facility) });
    await opened.close();

    expect(live.closed).toBe(false);
    // 对方仍可继续使用
    await expect(
      live.table(CONTROL_TARGET_TABLE).put('u2', { workspaceId: null, sessionId: null }),
    ).resolves.toBeUndefined();
  });

  it('自己 open 出来的域，close() 必须关闭它', async () => {
    const facility = createFacility(undefined);

    const opened = await openTargetStore({ storageDomain: asFacility(facility) });
    const owned = facility.lastOpened as FakeDomain;
    expect(owned).toBeDefined();

    await opened.close();
    expect(owned.closed).toBe(true);
  });

  it('facility.get() 返回已关闭的句柄时，必须重开而不是复用', async () => {
    const dead = createDomain({ closed: true });
    const facility = createFacility(dead);

    const opened = await openTargetStore({ storageDomain: asFacility(facility) });

    await opened.store.put('u1', { workspaceId: 'w1', sessionId: 's1' });
    expect(opened.store.get('u1')).toEqual({ workspaceId: 'w1', sessionId: 's1' });
    expect(facility.openedCount).toBe(1);
    await opened.close();
  });

  it('运行期域被外部关闭后，put 触发自愈并重试成功', async () => {
    const live = createDomain();
    const facility = createFacility(live);

    const opened = await openTargetStore({ storageDomain: asFacility(facility) });

    // 模拟设施在运行期关闭该域（插件热重载 / closeAll）
    await live.close();
    expect(live.closed).toBe(true);

    // 写是异步的：应自愈重开并完成本次写入，而不是把用户的选择丢掉
    await opened.store.put('u1', { workspaceId: 'w1', sessionId: 's1' });
    expect(opened.store.get('u1')).toEqual({ workspaceId: 'w1', sessionId: 's1' });
    expect(facility.openedCount).toBe(1);
    await opened.close();
  });
});
