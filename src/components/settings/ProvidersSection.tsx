/* ============================================================================
 * src/components/settings/ProvidersSection.tsx —— 接入模型
 *   一个「接入项」= 协议 + BaseURL + API Key + 勾选的模型
 *   拉取模型列表 / 测试连通性都不要求先保存，用表单里当前的值直接试
 * ==========================================================================*/

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { formatContext } from '@/lib/format';
import { Card, Empty, Group } from './ui';
import type { ProviderConfig, ProviderKind, RemoteModel, ThinkingLevel } from '@shared/types';

const KIND_LABEL: Record<ProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

const KIND_DEFAULT_URL: Record<ProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

interface Draft {
  id?: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  defaultThinking: ThinkingLevel;
  enabled: boolean;
  /** 拉取到的全部模型 */
  all: RemoteModel[];
  /** 勾选保留的模型 id */
  chosen: string[];
}

function emptyDraft(): Draft {
  return {
    kind: 'openai',
    label: '',
    baseUrl: KIND_DEFAULT_URL.openai,
    apiKey: '',
    defaultThinking: 'high',
    enabled: true,
    all: [],
    chosen: [],
  };
}

/** 单个模型的测试结果 */
type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; ms: number; reply: string }
  | { status: 'fail'; message: string };

export function ProvidersSection() {
  const t = useT();
  const providers = useApp(s => s.providers);
  const reloadProviders = useApp(s => s.reloadProviders);
  const toast = useApp(s => s.toast);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const beginNew = () => {
    setDraft(emptyDraft());
    setFilter('');
    setTests({});
  };

  const beginEdit = (p: ProviderConfig) => {
    setDraft({
      id: p.id,
      kind: p.kind,
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: '',
      defaultThinking: p.defaultThinking,
      enabled: p.enabled,
      all: p.models,
      chosen: p.models.map(m => m.id),
    });
    setFilter('');
    setTests({});
  };

  /** 拉模型列表：不需要先保存，用表单里当前的 protocol + URL + Key */
  const pull = async () => {
    if (!draft) return;
    if (!draft.baseUrl.trim()) {
      toast(t('请先填写接口地址'), 'warn');
      return;
    }
    setPulling(true);
    try {
      const res = await invoke('provider:pull-models', {
        providerId: draft.id,
        kind: draft.kind,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey || undefined,
      });
      if (!res.ok) {
        toast(res.message, 'error');
        return;
      }
      const known = new Set(draft.all.map(m => m.id));
      const merged = [...draft.all, ...res.models.filter(m => !known.has(m.id))];
      setDraft({ ...draft, all: merged, chosen: draft.chosen.length ? draft.chosen : res.models.map(m => m.id) });
      toast(`${t('拉到')} ${res.models.length} ${t('个模型')}`, 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPulling(false);
    }
  };

  /** 测试某个模型能不能通：发一句 ping，显示耗时或错误 */
  const testModel = async (modelId: string) => {
    if (!draft) return;
    setTests(cur => ({ ...cur, [modelId]: { status: 'running' } }));
    try {
      const res = await invoke('provider:test', {
        providerId: draft.id,
        kind: draft.kind,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey || undefined,
        model: modelId,
      });
      if (res.ok) {
        setTests(cur => ({ ...cur, [modelId]: { status: 'ok', ms: res.ms, reply: res.reply } }));
      } else {
        setTests(cur => ({ ...cur, [modelId]: { status: 'fail', message: res.message } }));
        toast(`${modelId}：${res.message}`, 'error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTests(cur => ({ ...cur, [modelId]: { status: 'fail', message } }));
      toast(message, 'error');
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.label.trim()) {
      toast(t('给这个接入项起个名字'), 'warn');
      return;
    }
    setSaving(true);
    try {
      const wanted = new Set(draft.chosen);
      await invoke('provider:save', {
        id: draft.id,
        kind: draft.kind,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey || undefined,
        defaultThinking: draft.defaultThinking,
        enabled: draft.enabled,
        models: draft.all.filter(m => wanted.has(m.id)),
      });
      await reloadProviders();
      toast(t('已保存'), 'ok');
      setDraft(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: ProviderConfig) => {
    await invoke('provider:delete', { id: p.id });
    await reloadProviders();
    toast(`${t('已删除')} ${p.label}`, 'ok');
  };

  const toggleModel = (id: string) => {
    if (!draft) return;
    const has = draft.chosen.includes(id);
    setDraft({ ...draft, chosen: has ? draft.chosen.filter(x => x !== id) : [...draft.chosen, id] });
  };

  /* ---------------------------------------------------------------- 编辑态 */

  if (draft) {
    const visible = draft.all.filter(m => (filter ? m.id.toLowerCase().includes(filter.toLowerCase()) : true));
    const failed = Object.values(tests).filter(x => x.status === 'fail').length;
    const passed = Object.values(tests).filter(x => x.status === 'ok').length;

    return (
      <>
        <Group
          title={draft.id ? t('编辑接入项') : t('新增接入项')}
          desc={t('保存后 Key 会通过系统安全存储加密，界面上只显示「已保存」，不会再回填明文。')}
        >
          <div className="form-grid">
            <div className="field">
              <label className="field-label">{t('协议')}</label>
              <select
                className="select"
                style={{ width: '100%' }}
                value={draft.kind}
                onChange={e => {
                  const kind = e.target.value as ProviderKind;
                  setDraft({ ...draft, kind, baseUrl: KIND_DEFAULT_URL[kind] });
                }}
              >
                {(Object.keys(KIND_LABEL) as ProviderKind[]).map(k => (
                  <option key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label">{t('显示名称')}</label>
              <input
                className="input"
                value={draft.label}
                placeholder={t('例如：OpenAI 官方')}
                onChange={e => setDraft({ ...draft, label: e.target.value })}
              />
            </div>

            <div className="field full">
              <label className="field-label">Base URL</label>
              <input
                className="input mono"
                value={draft.baseUrl}
                placeholder={KIND_DEFAULT_URL[draft.kind]}
                onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
              />
              <span className="field-hint">
                {t('OpenAI 兼容请填到')} <code className="mono">/v1</code>{' '}
                {t('为止；Anthropic 填域名即可，会自动拼')}{' '}
                <code className="mono">/v1/messages</code>。
              </span>
            </div>

            <div className="field full">
              <label className="field-label">API Key</label>
              <input
                className="input"
                type="password"
                value={draft.apiKey}
                placeholder={draft.id ? t('留空表示不修改已保存的 Key') : 'sk-…'}
                onChange={e => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field-label">{t('默认思考强度')}</label>
              <select
                className="select"
                style={{ width: '100%' }}
                value={draft.defaultThinking}
                onChange={e => setDraft({ ...draft, defaultThinking: e.target.value as ThinkingLevel })}
              >
                <option value="low">Low</option>
                <option value="high">High</option>
                <option value="max">Max</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label">{t('启用')}</label>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={draft.enabled}
                data-on={draft.enabled ? 'true' : 'false'}
                onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              />
            </div>
          </div>

          <div className="row gap-8" style={{ marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => void pull()} disabled={pulling}>
              <Icon name="refresh" size={13} />
              {pulling ? t('拉取中…') : t('拉取模型列表')}
            </button>
            <span className="dim" style={{ fontSize: 11.5 }}>
              {t('已选')} {draft.chosen.length} / {draft.all.length}
            </span>
            {passed > 0 && (
              <span className="badge" data-tone="ok">
                {t('通过')} {passed}
              </span>
            )}
            {failed > 0 && (
              <span className="badge" data-tone="danger">
                {t('失败')} {failed}
              </span>
            )}
            <div className="grow" />
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              {t('取消')}
            </button>
            <button type="button" className="btn" data-variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('保存中…') : t('保存')}
            </button>
          </div>
          <p className="field-hint" style={{ marginTop: 8 }}>
            {t('填好地址和 Key 就能直接「拉取模型列表」，不必先保存。')}
          </p>
        </Group>

        {draft.all.length > 0 && (
          <Group
            title={t('可用模型')}
            desc={t('取消勾选的模型不会出现在输入区与顶栏的切换菜单里；每个模型都可以单独发一句 ping 试试能不能通。')}
          >
            <input
              className="input"
              placeholder={t('按名称过滤…')}
              value={filter}
              onChange={e => setFilter(e.target.value)}
              style={{ marginBottom: 9 }}
            />
            <div className="model-grid">
              {visible.map(m => {
                const on = draft.chosen.includes(m.id);
                const st = tests[m.id] ?? { status: 'idle' as const };
                return (
                  <div key={m.id} className="model-chip" data-on={on}>
                    <button
                      type="button"
                      className="model-chip-main"
                      onClick={() => toggleModel(m.id)}
                      title={`${m.id}\n${t('上下文')} ${formatContext(m.contextWindow)}`}
                    >
                      <span className="model-chip-text">
                        <span className="ellipsis">{m.label || m.id}</span>
                        <span className="model-chip-meta">
                          <span className="tag" data-tone="accent">
                            {formatContext(m.contextWindow)}
                          </span>
                          <span className="tag" data-tone={m.vision ? 'ok' : undefined}>
                            {m.vision ? t('支持图片') : t('仅文本')}
                          </span>
                          {m.reasoning && <span className="tag">{t('推理')}</span>}
                        </span>
                      </span>
                      <Icon name={on ? 'check' : 'plus'} size={12} />
                    </button>
                    <button
                      type="button"
                      className="model-chip-test"
                      data-state={st.status}
                      title={
                        st.status === 'ok'
                          ? `${t('连接正常')} · ${st.ms} ms\n${st.reply}`
                          : st.status === 'fail'
                            ? st.message
                            : t('测试连通性')
                      }
                      aria-label={t('测试连通性')}
                      onClick={() => void testModel(m.id)}
                    >
                      {st.status === 'running' ? (
                        <span className="tool-spinner" />
                      ) : st.status === 'ok' ? (
                        <span className="model-chip-ms">{st.ms}ms</span>
                      ) : st.status === 'fail' ? (
                        <Icon name="alert" size={11} />
                      ) : (
                        <Icon name="shield" size={11} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {visible.some(m => (tests[m.id]?.status ?? 'idle') === 'fail') && (
              <div className="model-test-errors">
                {visible
                  .filter(m => tests[m.id]?.status === 'fail')
                  .map(m => {
                    const st = tests[m.id];
                    if (!st || st.status !== 'fail') return null;
                    return (
                      <p key={m.id} className="model-test-error">
                        <span className="mono">{m.id}</span> · {st.message}
                      </p>
                    );
                  })}
              </div>
            )}
          </Group>
        )}
      </>
    );
  }

  /* ---------------------------------------------------------------- 列表态 */

  return (
    <Group
      title={t('接入项')}
      desc={t('可以同时接入多个服务，输入区里按会话随时切换。')}
    >
      {providers.length === 0 ? (
        <Card title={t('还没有接入任何模型')}>
          <Empty
            icon="spark"
            title={t('先加一个接入项')}
            desc={t('填 Base URL 与 API Key，拉取模型列表后勾选可用的模型。')}
          />
        </Card>
      ) : (
        providers.map(p => (
          <Card
            key={p.id}
            title={
              <span className="row gap-6">
                {p.label}
                {!p.enabled && <span className="badge">{t('已停用')}</span>}
                {!p.hasKey && (
                  <span className="badge" data-tone="warn">
                    {t('缺 Key')}
                  </span>
                )}
              </span>
            }
            sub={`${t(KIND_LABEL[p.kind])} · ${p.models.length} ${t('个模型')}`}
            actions={
              <>
                <button type="button" className="btn" data-size="sm" onClick={() => beginEdit(p)}>
                  <Icon name="edit" size={12} />
                  {t('编辑')}
                </button>
                <button type="button" className="btn" data-size="sm" data-variant="danger" onClick={() => void remove(p)}>
                  <Icon name="trash" size={12} />
                </button>
              </>
            }
          >
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              {p.models.slice(0, 8).map(m => (
                <span key={m.id} className="tag">
                  {m.label || m.id}
                </span>
              ))}
              {p.models.length > 8 && <span className="dim">+{p.models.length - 8}</span>}
              {p.models.length === 0 && <span className="dim">{t('还没拉取模型')}</span>}
            </div>
          </Card>
        ))
      )}

      <div className="row gap-8" style={{ marginTop: 12 }}>
        <button type="button" className="btn" data-variant="primary" onClick={beginNew}>
          <Icon name="plus" size={13} />
          {t('新增接入项')}
        </button>
      </div>
    </Group>
  );
}
