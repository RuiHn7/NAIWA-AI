/* ============================================================================
 * src/components/settings/UsageSection.tsx —— 用量统计
 *   数据来自本地记录，费率为「设置 → 通用」里填的单价。
 * ==========================================================================*/

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { formatCost, formatTokens } from '@/lib/format';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Empty, Group } from './ui';
import type { UsageRecord } from '@shared/types';

type Range = 'today' | 'week' | 'month' | 'all';

const RANGE_LABEL: Record<Range, string> = {
  today: '今天',
  week: '近 7 天',
  month: '近 30 天',
  all: '全部',
};

const RANGE_MS: Record<Range, number> = {
  today: 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  month: 30 * 24 * 3600_000,
  all: Number.POSITIVE_INFINITY,
};

export function UsageSection() {
  const t = useT();
  const providers = useApp(s => s.providers);
  const locale = useApp(s => s.settings?.locale);
  const [records, setRecords] = useState<UsageRecord[] | null>(null);
  const [range, setRange] = useState<Range>('week');
  const [busy, setBusy] = useState(false);

  /** 把 prov-mock 这种内部 id 换成界面上显示的名字 */
  const prettyProvider = (id: string) => {
    const p = providers.find(x => x.id === id);
    return p?.label || p?.kind || id;
  };

  const load = async () => {
    setBusy(true);
    try {
      setRecords(await invoke('usage:list', undefined));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = records ?? [];
  const cutoff = Date.now() - RANGE_MS[range];
  const scoped = list.filter(r => range === 'all' || r.at >= cutoff);

  const totals = scoped.reduce(
    (acc, r) => {
      acc.prompt += r.promptTokens;
      acc.completion += r.completionTokens;
      acc.total += r.totalTokens;
      acc.cost += r.cost;
      return acc;
    },
    { prompt: 0, completion: 0, total: 0, cost: 0 },
  );

  const byModel = useMemo(() => {
    const map = new Map<string, { tokens: number; cost: number; calls: number }>();
    for (const r of scoped) {
      const key = `${prettyProvider(r.providerId)} · ${r.modelId}`;
      const cur = map.get(key) ?? { tokens: 0, cost: 0, calls: 0 };
      cur.tokens += r.totalTokens;
      cur.cost += r.cost;
      cur.calls += 1;
      map.set(key, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  }, [scoped, providers]);

  const maxTokens = byModel[0]?.[1].tokens ?? 1;

  const clear = async () => {
    const ok = await useApp.getState().askConfirm({
      title: t('清空用量记录'),
      body: t('清空全部用量记录？此操作不可恢复。'),
      danger: true,
    });
    if (!ok) return;
    await invoke('usage:clear', undefined);
    await load();
  };

  return (
    <>
      <Group title={t('统计范围')}>
        <div className="row gap-6">
          {(Object.keys(RANGE_LABEL) as Range[]).map(r => (
            <button
              key={r}
              type="button"
              className="btn"
              data-size="sm"
              data-variant={r === range ? 'primary' : undefined}
              onClick={() => setRange(r)}
            >
              {t(RANGE_LABEL[r])}
            </button>
          ))}
          <div className="grow" />
          <button type="button" className="btn" data-size="sm" onClick={() => void load()} disabled={busy}>
            <Icon name="refresh" size={12} />
            {t('刷新')}
          </button>
        </div>
      </Group>

      <Group title={t('合计')}>
        <div className="usage-summary">
          <div className="stat">
            <span className="stat-label">{t('总 token')}</span>
            <span className="stat-value">{formatTokens(totals.total)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">{t('输入')}</span>
            <span className="stat-value">{formatTokens(totals.prompt)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">{t('输出')}</span>
            <span className="stat-value">{formatTokens(totals.completion)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">{t('预估费用')}</span>
            <span className="stat-value">{formatCost(totals.cost)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">{t('请求数')}</span>
            <span className="stat-value">{scoped.length}</span>
          </div>
        </div>
      </Group>

      <Group title={t('按模型')} desc={t('费用按「通用」里填的单价估算，不是真实账单。')}>
        {byModel.length === 0 ? (
          <Card title={t('没有记录')}>
            <Empty icon="chart" title={t('还没有用量')} desc={t('开始对话以后这里会自动累计。')} />
          </Card>
        ) : (
          <div className="usage-bars">
            {byModel.map(([key, v]) => (
              <div key={key} className="usage-bar-row">
                <span className="ellipsis mono" style={{ fontSize: 11.3 }} title={key}>
                  {key}
                </span>
                <div className="track">
                  <div className="fill" style={{ width: `${Math.max(2, (v.tokens / maxTokens) * 100)}%` }} />
                </div>
                <span className="val mono">
                  {formatTokens(v.tokens)} · {formatCost(v.cost)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Group>

      <Group title={t('最近记录')}>
        {scoped.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>
            {t('这个范围里没有记录。')}
          </div>
        ) : (
          scoped.slice(0, 40).map(r => (
            <div key={r.id} className="list-item">
              <div className="list-item-main">
                <div className="list-item-text ellipsis">{r.chatTitle || t('（未命名会话）')}</div>
                <div className="list-item-meta">
                  <span className="mono dim" style={{ fontSize: 10.8 }}>
                    {r.modelId}
                  </span>
                  <span className="dim">
                    · ↑{formatTokens(r.promptTokens)} ↓{formatTokens(r.completionTokens)}
                  </span>
                  <span className="dim">· {new Date(r.at).toLocaleString(locale ?? 'zh-CN')}</span>
                </div>
              </div>
              <div className="list-item-actions mono dim" style={{ fontSize: 11.3 }}>
                {formatCost(r.cost)}
              </div>
            </div>
          ))
        )}
      </Group>

      <Group title={t('清理')}>
        <button type="button" className="btn" data-variant="danger" onClick={() => void clear()}>
          <Icon name="trash" size={13} />
          {t('清空全部记录')}
        </button>
      </Group>
    </>
  );
}
