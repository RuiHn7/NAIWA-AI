/* ============================================================================
 * src/main.tsx —— 渲染进程入口
 * ==========================================================================*/

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
