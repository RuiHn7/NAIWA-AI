/* ============================================================================
 * src/components/message/PlanCard.tsx —— ReAct 执行计划可视化
 * ==========================================================================*/

import type { TaskPlan } from '@shared/types';
import { Icon } from '@/components/Icon';
import { useT } from '@/lib/i18n';

export function PlanCard({ plan }: { plan: TaskPlan }) {
  const t = useT();
  const done = plan.steps.filter(s => s.status === 'done').length;

  return (
    <div className="plan">
      <div className="plan-head">
        <Icon name="spark" size={13} />
        <span>{t('执行计划')}</span>
        <span className="plan-goal">{plan.goal}</span>
        <div className="grow" />
        <span className="mono" style={{ fontSize: 10.5 }}>
          {done}/{plan.steps.length}
        </span>
      </div>
      <ol className="plan-steps">
        {plan.steps.map((step, i) => (
          <li key={step.id} className="plan-step" data-status={step.status}>
            <span className="plan-step-num">
              {step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : i + 1}
            </span>
            <span className="plan-step-text">
              {step.title}
              {step.note && <span className="plan-step-note">{step.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
