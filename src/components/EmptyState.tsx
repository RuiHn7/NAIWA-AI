/* ============================================================================
 * src/components/EmptyState.tsx —— 空会话引导
 * ==========================================================================*/

import { Icon, type IconName } from '@/components/Icon';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';

interface Suggestion {
  icon: IconName;
  title: string;
  sub: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: 'spark',
    title: '解释一个概念',
    sub: '用通俗的话讲清楚',
    prompt: '用通俗的话解释一下扩散模型是怎么生成图片的',
  },
  {
    icon: 'wrench',
    title: '写点代码',
    sub: '脚本、组件、小工具',
    prompt: '写一个 Python 脚本，把某个目录下的所有图片按拍摄时间重命名',
  },
  {
    icon: 'globe',
    title: '查点资料',
    sub: '联网搜索 + 读网页',
    prompt: '帮我查一下 Electron 45 相比 44 有哪些值得注意的变化',
  },
  {
    icon: 'folder',
    title: '整理文件',
    sub: '在工作区里动手',
    prompt: '列一下当前工作区的文件结构，并给出一份整理建议',
  },
];

export function EmptyState() {
  const t = useT();
  // 性能：只订阅会话 id，不跟着流式内容重渲染
  const chatId = useApp(s => s.chat?.id);
  const setDraft = useApp(s => s.setDraft);

  return (
    <div className="empty">
      <h1 className="empty-title">{t('有什么可以帮你？')}</h1>
      <p className="empty-sub">
        {t('可以聊天、查资料、读写文件、跑代码、生成图片 —— 需要动手时会先问你。')}
      </p>
      <div className="suggest-grid">
        {SUGGESTIONS.map(item => (
          <button
            key={item.title}
            type="button"
            className="suggest-card"
            disabled={!chatId}
            // PRD 七.4：点建议卡只把文案填进输入框，不直接发出去
            onClick={() => {
              if (chatId) setDraft(chatId, t(item.prompt));
            }}
          >
            <span className="suggest-icon">
              <Icon name={item.icon} size={15} />
            </span>
            <span className="suggest-text">
              <span className="suggest-title">{t(item.title)}</span>
              <span className="suggest-sub">{t(item.sub)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
