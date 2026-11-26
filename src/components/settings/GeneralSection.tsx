/* ============================================================================
 * src/components/settings/GeneralSection.tsx —— 通用设置
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Group, Row, Segmented, Switch } from './ui';
import type { AppSettings, CloseAction, Locale, ThemeMode, ThinkingLevel } from '@shared/types';

interface AppInfo {
  version: string;
  platform: string;
  userData: string;
  runtime: { python: string | null; node: string | null };
  locale: string;
}

export function GeneralSection() {
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  const personas = useApp(s => s.personas);
  const toast = useApp(s => s.toast);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [picking, setPicking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const t = useT();

  useEffect(() => {
    invoke('app:info', undefined)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  /* -------------------------------------------------- 改默认存放位置 + 迁移 */

  const onPickRoot = async () => {
    if (!settings) return;
    const picked = await invoke('settings:pick-chat-root', undefined);
    if (!picked) return;
    if (picked.path === settings.chatRoot) return;
    const from = settings.chatRoot;
    const migrate =
      Boolean(from) &&
      (await useApp.getState().askConfirm({
        title: t('迁移已有会话？'),
        body: `${t('新的存放位置')}：${picked.path}\n${t('要现在把已有会话文件夹迁移过去吗？')}`,
        confirmText: t('迁移'),
        cancelText: t('只改设置'),
      }));
    setPicking(true);
    try {
      await saveSettings({ chatRoot: picked.path, chatRootFallback: undefined });
      if (migrate && from) {
        const res = await invoke('settings:migrate-chat-root', { from, to: picked.path });
        if (res.failed.length) {
          toast(`已迁移 ${res.moved} 个，${res.failed.length} 个失败：${res.failed[0].error}`, 'error');
        } else {
          toast(`已迁移 ${res.moved} 个会话文件夹`, 'ok');
        }
      } else {
        toast(t('存放位置已更新'), 'ok');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setPicking(false);
    }
  };

  /* -------------------------------------------------- 手动检查更新 */

  const onCheckUpdate = async () => {
    setChecking(true);
    setUpdateMsg('');
    try {
      const res = await invoke('app:check-update', undefined);
      if (!res.ok) {
        setUpdateMsg(res.reason === 'not-configured' ? t('还没有配置更新源') : res.reason || t('检查失败'));
      } else if (res.latest && res.latest !== res.current) {
        setUpdateMsg(`${t('有新版本')} ${res.latest}`);
      } else {
        setUpdateMsg(t('已经是最新版本'));
      }
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : t('检查失败'));
    } finally {
      setChecking(false);
    }
  };

  if (!settings) return null;

  const patch = (p: Partial<AppSettings>) => void saveSettings(p);

  return (
    <>
      <Group title={t('外观')} desc={t('深色是默认主题；选择「跟随系统」时会随系统外观切换。')}>
        <Row label={t('主题')}>
          <Segmented<ThemeMode>
            value={settings.theme}
            options={[
              { value: 'system', label: t('跟随系统') },
              { value: 'dark', label: t('深色') },
              { value: 'light', label: t('浅色') },
            ]}
            onChange={theme => patch({ theme })}
          />
        </Row>
        <Row label={t('界面语言')}>
          <Segmented<Locale>
            value={settings.locale}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en-US', label: 'English' },
            ]}
            onChange={locale => patch({ locale })}
          />
        </Row>
      </Group>

      <Group title={t('对话')} desc={t('默认值会在新建会话时套用，之后仍可在输入区随时切换。')}>
        <Row label={t('默认思考强度')} hint={t('Low 更快，Max 更深但更慢，也更容易花掉上下文。')}>
          <Segmented<ThinkingLevel>
            value={settings.defaultThinking}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
              { value: 'max', label: 'Max' },
            ]}
            onChange={defaultThinking => patch({ defaultThinking })}
          />
        </Row>
        <Row label={t('默认人格')}>
          <select
            className="select"
            value={settings.defaultPersonaId}
            onChange={e => patch({ defaultPersonaId: e.target.value })}
          >
            {personas.map(p => (
              <option key={p.id} value={p.id}>
                {t(p.name)}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group
        title={t('上下文压缩')}
        desc={t('自动压缩会在用量超过阈值时把更早的消息折成摘要；手动压缩永远可用，自动压缩结果不理想时可以自己再折一次。')}
      >
        <Row label={t('自动压缩上下文')} hint={t('关掉以后上下文会一直增长，直到撞上模型窗口上限才报错。')}>
          <Switch on={settings.autoCompress} onChange={autoCompress => patch({ autoCompress })} />
        </Row>
        <Row label={t('压缩阈值')} hint={t('用量达到窗口的这个比例时触发；越高手动空间越大，越低越省 token。')}>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <input
              className="input"
              data-w="sm"
              type="range"
              min={0.5}
              max={0.95}
              step={0.05}
              value={settings.compressThreshold}
              disabled={!settings.autoCompress}
              onChange={e => patch({ compressThreshold: Number(e.target.value) })}
              style={{ width: 160 }}
            />
            <span className="mono" style={{ minWidth: 42 }}>
              {Math.round(settings.compressThreshold * 100)}%
            </span>
          </div>
        </Row>
      </Group>

      <Group title={t('计费')} desc={t('用于估算「用量」页面里的费用，不影响实际扣费。')}>
        <Row label={t('输入费率')} hint={t('美元 / 百万 token')}>
          <input
            className="input"
            data-w="sm"
            type="number"
            step="0.01"
            value={settings.rates.input}
            onChange={e => patch({ rates: { ...settings.rates, input: Number(e.target.value) || 0 } })}
          />
        </Row>
        <Row label={t('输出费率')} hint={t('美元 / 百万 token')}>
          <input
            className="input"
            data-w="sm"
            type="number"
            step="0.01"
            value={settings.rates.output}
            onChange={e => patch({ rates: { ...settings.rates, output: Number(e.target.value) || 0 } })}
          />
        </Row>
      </Group>

      <Group title={t('系统')}>
        <Row label={t('桌面通知')} hint={t('定时任务跑完后发系统通知。')}>
          <Switch on={settings.notifications} onChange={notifications => patch({ notifications })} />
        </Row>
        <Row label={t('提交前确认')} hint={t('关闭后所有文件写入、命令执行都不再询问，请谨慎。')}>
          <Switch
            on={settings.permission === 'full'}
            onChange={full => patch({ permission: full ? 'full' : 'approval' })}
          />
        </Row>
        <Row label={t('关闭窗口时')} hint={t('选「最小化到托盘」时窗口只是隐藏，托盘图标里可以再打开。')}>
          <Segmented<CloseAction>
            value={settings.closeAction}
            options={[
              { value: 'tray', label: t('最小化到托盘') },
              { value: 'quit', label: t('直接退出') },
            ]}
            onChange={closeAction => patch({ closeAction })}
          />
        </Row>
      </Group>

      {/* PRD 四.1：会话默认存放位置 + 迁移 */}
      <Group
        title={t('会话存放位置')}
        desc={t('没有关联工作区的会话都放在这里，每个会话一个独立文件夹，文件夹名是会话创建时间。')}
      >
        {settings.chatRootFallback && (
          <p className="setting-hint" style={{ color: 'var(--warn)', marginTop: -2 }}>
            {t(settings.chatRootFallback)}
          </p>
        )}
        <Row label={t('当前目录')} hint={t('建议放在非系统盘，避免系统重装时一起丢掉。')}>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            <span className="mono ellipsis" style={{ fontSize: 11.5, maxWidth: 320, color: 'var(--ink-2)' }}>
              {settings.chatRoot || t('未设置')}
            </span>
            <button type="button" className="btn" data-size="sm" onClick={() => void onPickRoot()}>
              {picking ? t('选择中…') : t('更改默认存放位置')}
            </button>
          </div>
        </Row>
      </Group>

      <Group title={t('更新')} desc={t('手动检查一次新版本；没连上更新源也不会影响使用。')}>
        <Row label={t('版本检查')}>
          <div className="row gap-6">
            <button type="button" className="btn" data-size="sm" disabled={checking} onClick={() => void onCheckUpdate()}>
              {checking ? t('检查中…') : t('检查更新')}
            </button>
            {updateMsg && <span className="dim" style={{ fontSize: 11.5 }}>{updateMsg}</span>}
          </div>
        </Row>
      </Group>

      <Group title={t('内置浏览')} desc={t('右侧「浏览」标签只允许打开这些地址，一行一个，支持 * 通配。')}>
        <Row label={t('允许访问')}>
          <textarea
            className="textarea"
            data-w="md"
            data-mono
            rows={5}
            value={(settings.webviewAllowlist ?? []).join('\n')}
            onChange={e =>
              patch({
                webviewAllowlist: e.target.value
                  .split('\n')
                  .map(s => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Row>
      </Group>

      <Group title={t('关于')}>
        <div className="setting-row" style={{ alignItems: 'flex-start' }}>
          <span className="setting-label">{t('版本')}</span>
          <div className="setting-control" style={{ justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start', gap: 5 }}>
            <span className="mono" style={{ fontSize: 12 }}>NAI WA Desktop {info?.version ?? '—'}</span>
            <span className="dim" style={{ fontSize: 11.5 }}>
              {t('平台')} {info?.platform ?? '—'} · Python {info?.runtime.python ? t('已就绪') : t('未检测到')} · Node{' '}
              {info?.runtime.node ? t('已就绪') : t('未检测到')}
            </span>
            <span className="dim mono" style={{ fontSize: 10.8, overflowWrap: 'anywhere' }}>
              {info?.userData ?? ''}
            </span>
          </div>
        </div>
      </Group>
    </>
  );
}
