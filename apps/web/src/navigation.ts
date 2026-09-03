export const CONSOLE_NAV_ITEMS = [
  { key: 'projects', label: '研究项目', description: '管理持续研究项目' },
  { key: 'competitors', label: '竞品库', description: '登记竞品并管理监控入口' },
  { key: 'runs', label: '分析运行', description: '查看分析队列与运行详情' },
  { key: 'evidence', label: '证据审核', description: '审核待确认的研究证据' },
] as const;

export type ConsoleTab = (typeof CONSOLE_NAV_ITEMS)[number]['key'];

export interface ConsoleRoute {
  tab: ConsoleTab;
  runId: string | null;
}

function isConsoleTab(value: string): value is ConsoleTab {
  return CONSOLE_NAV_ITEMS.some((item) => item.key === value);
}

/** 将地址栏 hash 解析为控制台路由，非法地址安全回退到研究项目首页。 */
export function routeFromHash(hash: string): ConsoleRoute {
  const normalized = hash.replace(/^#\/?/, '');
  const [segment, ...rest] = normalized.split('/');

  if (segment === 'runs' && rest.length > 0) {
    const encodedRunId = rest.join('/');
    if (encodedRunId) {
      try {
        return { tab: 'runs', runId: decodeURIComponent(encodedRunId) };
      } catch {
        // 地址栏可能包含不完整的转义序列，回退到列表页即可继续使用控制台。
      }
    }
  }

  return { tab: isConsoleTab(segment) ? segment : 'projects', runId: null };
}

export function routeToHash(route: ConsoleRoute): string {
  if (route.tab === 'runs' && route.runId) {
    return '#runs/' + encodeURIComponent(route.runId);
  }
  return '#' + route.tab;
}
