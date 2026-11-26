/* ============================================================================
 * src/components/ErrorBoundary.tsx —— 崩溃兜底
 * ==========================================================================*/

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 主进程日志里也留一份
    console.error('[NAI WA] render crash', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-card">
          <h2 className="crash-title">{t('界面出了点问题')}</h2>
          <p className="crash-detail">{error.message || String(error)}</p>
          <div className="row gap-8">
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => this.setState({ error: null })}
            >
              {t('重试')}
            </button>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              {t('重新加载窗口')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
