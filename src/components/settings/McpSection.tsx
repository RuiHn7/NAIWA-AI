/* ============================================================================
 * src/components/settings/McpSection.tsx —— MCP 外部工具
 *   stdio（本地命令）或 http（远端地址）两种传输
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Empty, Group } from './ui';
import type { McpServerConfig, McpServerState } from '@shared/types';

interface Draft {
  id?: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  enabled: boolean;
}

const EMPTY: Draft = {
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  env: '',
  url: '',
  enabled: true,
};

const STATUS_TONE: Record<McpServerState['status'], string> = {
  connected: 'ok',
  connecting: 'warn',
  error: 'danger',
  disconnected: '',
};

const STATUS_LABEL: Record<McpServerState['status'], string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '出错',
  disconnected: '未连接',
};

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function McpSection() {
  const t = useT();
  const configs = useApp(s => s.mcpConfigs);
  const states = useApp(s => s.mcpStates);
  const reloadMcp = useApp(s => s.reloadMcp);
  const toast = useApp(s => s.toast);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void reloadMcp();
  }, [reloadMcp]);

  const stateOf = (id: string): McpServerState | undefined => states.find(s => s.id === id);

  const beginNew = () => setDraft({ ...EMPTY });
  const beginEdit = (c: McpServerConfig) =>
    setDraft({
      id: c.id,
      name: c.name,
      transport: c.transport,
      command: c.command ?? '',
      args: (c.args ?? []).join(' '),
      env: Object.entries(c.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      url: c.url ?? '',
      enabled: c.enabled,
    });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast(t('给这个 Server 起个名字'), 'warn');
      return;
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      toast(t('stdio 传输需要填写启动命令'), 'warn');
      return;
    }
    if (draft.transport === 'http' && !draft.url.trim()) {
      toast(t('http 传输需要填写地址'), 'warn');
      return;
    }
    try {
      await invoke('mcp:save', {
        id: draft.id,
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.transport === 'stdio' ? draft.command.trim() : undefined,
        args: draft.transport === 'stdio' ? draft.args.split(/\s+/).filter(Boolean) : undefined,
        env: draft.transport === 'stdio' ? parseEnv(draft.env) : undefined,
        url: draft.transport === 'http' ? draft.url.trim() : undefined,
        enabled: draft.enabled,
      });
      await reloadMcp();
      setDraft(null);
      toast(t('已保存'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const connect = async (id: string) => {
    setBusyId(id);
    try {
      const state = await invoke('mcp:connect', { id });
      await reloadMcp();
      if (state.status === 'error') toast(state.error ?? t('连接失败'), 'error');
      else toast(`${t('已连接，发现')} ${state.tools.length} ${t('个工具')}`, 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (id: string) => {
    await invoke('mcp:disconnect', { id });
    await reloadMcp();
  };

  const remove = async (id: string) => {
    await invoke('mcp:delete', { id });
    await reloadMcp();
    toast(t('已删除'), 'ok');
  };

  const toggleTool = async (serverId: string, tool: string, enabled: boolean) => {
    await invoke('mcp:set-tool', { serverId, tool, enabled });
    await reloadMcp();
  };

  const doImport = async () => {
    try {
      const res = await invoke('mcp:import', { json: importText });
      await reloadMcp();
      setImportText('');
      setShowImport(false);
      toast(
        `${t('导入')} ${res.imported} ${t('个')}${res.errors.length ? `，${res.errors.length} ${t('个失败')}` : ''}`,
        res.errors.length ? 'warn' : 'ok',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  if (draft) {
    return (
      <Group
        title={draft.id ? t('编辑 MCP Server') : t('新增 MCP Server')}
        desc={t('stdio 会在本机起一个进程；http 直接连远端地址。')}
      >
        <div className="form-grid">
          <div className="field">
            <label className="field-label">{t('名称')}</label>
            <input
              className="input"
              autoFocus
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">{t('传输方式')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={draft.transport}
              onChange={e => setDraft({ ...draft, transport: e.target.value as 'stdio' | 'http' })}
            >
              <option value="stdio">{t('stdio（本地进程）')}</option>
              <option value="http">{t('http（远端地址）')}</option>
            </select>
          </div>

          {draft.transport === 'stdio' ? (
            <>
              <div className="field full">
                <label className="field-label">{t('启动命令')}</label>
                <input
                  className="input mono"
                  placeholder="npx"
                  value={draft.command}
                  onChange={e => setDraft({ ...draft, command: e.target.value })}
                />
              </div>
              <div className="field full">
                <label className="field-label">{t('参数')}</label>
                <input
                  className="input mono"
                  placeholder="-y @modelcontextprotocol/server-filesystem D:\AIGC"
                  value={draft.args}
                  onChange={e => setDraft({ ...draft, args: e.target.value })}
                />
                <span className="field-hint">{t('按空格拆分；路径含空格时先加引号。')}</span>
              </div>
              <div className="field full">
                <label className="field-label">{t('环境变量')}</label>
                <textarea
                  className="textarea mono"
                  rows={3}
                  placeholder="API_KEY=xxx"
                  value={draft.env}
                  onChange={e => setDraft({ ...draft, env: e.target.value })}
                />
                <span className="field-hint">{t('一行一个 KEY=VALUE。')}</span>
              </div>
            </>
          ) : (
            <div className="field full">
              <label className="field-label">{t('地址')}</label>
              <input
                className="input mono"
                placeholder="https://example.com/mcp"
                value={draft.url}
                onChange={e => setDraft({ ...draft, url: e.target.value })}
              />
            </div>
          )}

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

        <div className="row gap-8" style={{ marginTop: 14 }}>
          <div className="grow" />
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('取消')}
          </button>
          <button type="button" className="btn" data-variant="primary" onClick={() => void save()}>
            {t('保存')}
          </button>
        </div>
      </Group>
    );
  }

  return (
    <>
      <Group
        title="MCP Server"
        desc={t(
          '连上以后，它暴露的工具会和内置工具一起出现在对话里；每次调用前都会先问你。',
        )}
      >
        {configs.length === 0 ? (
          <Card title={t('还没有 MCP Server')}>
            <Empty
              icon="mcp"
              title={t('接一个外部工具集')}
              desc={t('支持 stdio 本地进程与 http 远端地址，也可以直接粘贴 mcpServers JSON 导入。')}
            />
          </Card>
        ) : (
          configs.map(c => {
            const st = stateOf(c.id);
            const tone = STATUS_TONE[st?.status ?? 'disconnected'];
            return (
              <Card
                key={c.id}
                title={
                  <span className="row gap-6">
                    {c.name}
                    <span className="badge" data-tone={tone || undefined}>
                      {t(STATUS_LABEL[st?.status ?? 'disconnected'])}
                    </span>
                    {!c.enabled && <span className="badge">{t('已停用')}</span>}
                  </span>
                }
                sub={`${c.transport} · ${st?.tools.length ?? 0} ${t('个工具')}${
                  st?.restarts ? ` · ${t('重启')} ${st.restarts} ${t('次')}` : ''
                }`}
                actions={
                  <>
                    {st?.status === 'connected' ? (
                      <button type="button" className="btn" data-size="sm" onClick={() => void disconnect(c.id)}>
                        {t('断开')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        data-size="sm"
                        onClick={() => void connect(c.id)}
                        disabled={busyId === c.id}
                      >
                        {busyId === c.id ? t('连接中…') : t('连接')}
                      </button>
                    )}
                    <button type="button" className="btn" data-size="sm" onClick={() => beginEdit(c)}>
                      <Icon name="edit" size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      data-variant="danger"
                      onClick={() => void remove(c.id)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </>
                }
              >
                <div className="mono dim" style={{ fontSize: 10.8, overflowWrap: 'anywhere' }}>
                  {c.transport === 'stdio' ? `${c.command} ${(c.args ?? []).join(' ')}` : c.url}
                </div>
                {st?.error && (
                  <div className="dim" style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 6 }}>
                    {st.error}
                  </div>
                )}
                {st && st.tools.length > 0 && (
                  <div style={{ marginTop: 9 }}>
                    {st.tools.map(tool => (
                      <div key={tool.name} className="mcp-tool-row">
                        <button
                          type="button"
                          className="switch"
                          role="switch"
                          aria-checked={tool.enabled}
                          data-on={tool.enabled ? 'true' : 'false'}
                          onClick={() => void toggleTool(c.id, tool.name, !tool.enabled)}
                        />
                        <span className="mcp-tool-name mono">{tool.name}</span>
                        <span className="dim ellipsis" style={{ fontSize: 11 }}>
                          {tool.description}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })
        )}

        <div className="row gap-8" style={{ marginTop: 12 }}>
          <button type="button" className="btn" data-variant="primary" onClick={beginNew}>
            <Icon name="plus" size={13} />
            {t('新增 Server')}          </button>
          <button type="button" className="btn" onClick={() => setShowImport(v => !v)}>
            <Icon name="download" size={13} />
            {t('粘贴 JSON 导入')}
          </button>
        </div>
      </Group>

      {showImport && (
        <Group title={t('从 JSON 导入')} desc={t('支持 mcpServers 或 servers 两种写法，同名的会被跳过。')}>
          <textarea
            className="textarea mono"
            rows={8}
            placeholder={
              '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\AIGC"]\n    }\n  }\n}'
            }
            value={importText}
            onChange={e => setImportText(e.target.value)}
          />
          <div className="row gap-8" style={{ marginTop: 10 }}>
            <div className="grow" />
            <button type="button" className="btn" onClick={() => setShowImport(false)}>
              {t('取消')}
            </button>
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => void doImport()}
              disabled={!importText.trim()}
            >
              {t('导入')}
            </button>
          </div>
        </Group>
      )}
    </>
  );
}
