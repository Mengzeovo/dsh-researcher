/** Product copy for the research.view namespace. */
export const en = {
  title: 'View', target: 'Research target', diagram: 'Research diagram',
  refresh: 'Refresh', loading: 'Loading research view…', rendering: 'Rendering diagram…',
  live: 'Live', liveRetry: 'Disconnected · retry', close: 'Close', planSelect: 'Choose plan',
  unbound: 'No research target is bound to this session.',
  loadHint: 'Choose an existing research target with /research-load.',
  loadTarget: 'Choose research target', noTargets: 'No loadable targets in this workspace.',
  empty: 'This target has no saved plan versions yet.', chooseNode: 'Select a plan or experiment to inspect it; click an arrow description to read it in full.',
  unavailable: 'Diagram unavailable', error: 'The view could not finish this request.',
  plan: 'Plan {id}', revision: 'Version {revision}', versions: '{count} versions', runs: '{count} experiments', experiment: 'Experiment {name}',
  warnings: '{count} warnings', runPages: 'Experiments for version {revision}',
  page: 'Page {page} of {count}', previous: 'Previous page', next: 'Next page',
  selected: 'Selected version', pendingState: 'State publication pending',
  'run.unsealed': 'Unsealed', 'run.completed': 'Completed', 'run.failed': 'Failed',
  'state.active': 'Active', 'state.paused': 'Paused', 'state.blocked': 'Blocked', 'state.complete': 'Complete',
  createdAt: 'Created', path: 'Record path', hash: 'SHA-256', metrics: 'Metrics', record: 'Record',
  provenance: 'Relations', usesPlan: 'Uses plan', informsPlan: 'Informs plan', revisesPlan: 'Revises plan', outside: 'Open linked page',
  diagnostics: 'Diagnostics', fit: 'Fit diagram', downloadSvg: 'Download SVG',
  edgeDescription: 'Full arrow description', copy: 'Copy', copied: 'Copied', footnotes: 'Footnotes',
  invalidTarget: 'Invalid research target: {id}',
} satisfies Record<string, string>
export type ResearchViewKey = keyof typeof en
export const zh = {
  title: '视图', target: '研究目标', diagram: '研究关系图',
  refresh: '刷新', loading: '正在读取研究视图…', rendering: '正在渲染关系图…',
  live: '实时', liveRetry: '已断开 · 重试', close: '关闭', planSelect: '选择方案',
  unbound: '此会话尚未绑定研究目标。',
  loadHint: '通过 /research-load 选择已有研究目标。',
  loadTarget: '选择研究目标', noTargets: '此工作区没有可加载的目标。',
  empty: '此目标尚无已保存的方案版本。', chooseNode: '点击方案或实验查看详情；点击箭头描述查看完整内容。',
  unavailable: '关系图不可用', error: '本次视图请求未能完成。',
  plan: '方案 {id}', revision: '版本 {revision}', versions: '{count} 个版本', runs: '{count} 个实验', experiment: '实验 {name}',
  warnings: '{count} 条警告', runPages: '版本 {revision} 的实验',
  page: '第 {page} / {count} 页', previous: '上一页', next: '下一页',
  selected: '选中版本', pendingState: '状态尚待发布',
  'run.unsealed': '未封存', 'run.completed': '已完成', 'run.failed': '执行失败',
  'state.active': '活动', 'state.paused': '已暂停', 'state.blocked': '受阻', 'state.complete': '已完成',
  createdAt: '创建时间', path: '记录路径', hash: 'SHA-256', metrics: '指标', record: '记录',
  provenance: '关联关系', usesPlan: '使用方案', informsPlan: '支持方案', revisesPlan: '修订上一版', outside: '打开关联页面',
  diagnostics: '诊断', fit: '适配关系图', downloadSvg: '下载 SVG',
  edgeDescription: '完整箭头描述', copy: '复制', copied: '已复制', footnotes: '脚注',
  invalidTarget: '无效研究目标：{id}',
} satisfies Record<ResearchViewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'research.view': ResearchViewKey }
}
