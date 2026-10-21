// 执行器的分派：按操作种类与恢复原因调用处理器。领取时操作已是 running 说明上一次进程在处理中退出：
// 进入崩溃恢复（写入前的阶段重新执行；写入已开始的按事实回滚或标为未知），从不重放全部写入。

import { isTerminalPhase } from '@sfe/contract';
import type { OperationRecord, OutboxRecord } from '../db/index.js';
import { isPublishKind, payloadOf } from '../domain/operations.js';
import type { Engine } from './context.js';
import { runDelete, runFrontVerify, runPreflightOp, runUnbind } from './handlers/misc.js';
import { recoverPublish, runPublish } from './handlers/publish.js';
import { recoverRoute, resumeRoute, runActivation, runNormal, runProbeSafari } from './handlers/route.js';
import { runInit, runRemerge } from './maintenance.js';

export interface DispatchHooks {
  /** 重新合并恢复节点资源后发起一次发布。 */
  enqueuePublish: () => void;
}

const WRITE_PHASES = new Set(['DEPLOYING', 'RECONCILING', 'ROLLING_BACK']);

export function createDispatcher(engine: Engine, hooks: DispatchHooks) {
  return async function dispatch(op: OperationRecord, row: OutboxRecord): Promise<void> {
    if (op.status === 'running') {
      await recover(engine, op);
      return;
    }
    if (row.resumeReason) {
      await resumeRoute(engine, op, row.resumeReason);
      return;
    }
    if (op.status !== 'queued' || isTerminalPhase(op.phase)) return;
    if (isPublishKind(op.kind)) {
      if (payloadOf(op).parentOperationId) return;
      await runPublish(engine, op);
      return;
    }
    switch (op.kind) {
      case 'route.activate':
        await runActivation(engine, op);
        return;
      case 'probe.safari':
        await runProbeSafari(engine, op);
        return;
      case 'route.normal':
        await runNormal(engine, op);
        return;
      case 'environment.delete':
        await runDelete(engine, op);
        return;
      case 'binding.unbind':
        await runUnbind(engine, op);
        return;
      case 'probe.preflight':
        await runPreflightOp(engine, op);
        return;
      case 'front.verify':
        await runFrontVerify(engine, op);
        return;
      case 'maintenance.init':
        await runInit(engine, op);
        return;
      case 'maintenance.remerge':
        await runRemerge(engine, op, hooks.enqueuePublish);
        return;
      default:
        engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { code: 'INTERNAL', message: '执行失败：不支持的操作种类' } });
    }
  };
}

async function recover(engine: Engine, op: OperationRecord): Promise<void> {
  engine.log('warn', 'operation.recover', { operationId: op.id, kind: op.kind, phase: op.phase });
  // 路由类操作，以及已部署后继续进入切换的活动环境发布（route 参数只在部署完成后写入）
  if (op.kind === 'route.activate' || op.kind === 'probe.safari' || op.kind === 'route.normal' || (isPublishKind(op.kind) && payloadOf(op).route)) {
    await recoverRoute(engine, op);
    return;
  }
  if (isPublishKind(op.kind)) {
    if (WRITE_PHASES.has(op.phase)) await recoverPublish(engine, op);
    else await runPublish(engine, { ...op, status: 'queued' });
    return;
  }
  switch (op.kind) {
    case 'environment.delete':
      await runDelete(engine, op);
      return;
    case 'binding.unbind':
      await runUnbind(engine, op);
      return;
    case 'probe.preflight':
      await runPreflightOp(engine, op);
      return;
    case 'front.verify':
      await runFrontVerify(engine, op);
      return;
    default:
      engine.updateOp(op.id, { phase: 'FAILED', status: 'failed', error: { code: 'UNKNOWN_STATE', message: '操作中断：服务重启时操作未完成，请检查后重试' } }, '服务重启时操作未完成');
  }
}
