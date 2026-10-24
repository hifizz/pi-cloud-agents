export const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function icon(name, size=16) {
  const paths={plus:'M12 5v14M5 12h14',search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',branch:'M6 8v9a3 3 0 0 0 3 3h5a4 4 0 0 0 4-4V8M6 2v2m12-2v2M3 6a3 3 0 1 0 6 0 3 3 0 0 0-6 0m12 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0',box:'m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M8 5l9 5',chevron:'m9 5 7 7-7 7',check:'m5 12 4 4L19 6',file:'M14 2H5v20h14V7l-5-5Zm0 0v6h5',terminal:'m4 5 6 7-6 7m9 0h7',panel:'M3 3h18v18H3V3Zm10 0v18',stop:'M6 6h12v12H6z',arrow:'M12 20V4m-6 6 6-6 6 6',close:'m6 6 12 12M6 18 18 6',clock:'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',git:'m7 7 10 10M7 7h8m-8 0v8',folder:'M3 6h7l2 2h9v12H3V6Z',save:'M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8',refresh:'M20 7a9 9 0 1 0 1 8M20 2v6h-6',settings:'M4 7h16M4 17h16M8 4v6m8 4v6',chat:'M3 4h18v13H9l-6 4V4Z'};
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
}
export const modelOptions = ['SWE-2','GLM 5.3','GPT-6.1-sol'];
export function statusInfo(s){
 if(s.workspace.step<5) return {label:'正在准备环境',tone:'warn',detail:'初始化步骤可接续'};
 return ({running:{label:'执行中',tone:'accent',detail:'正在运行回归检查'},approval:{label:'等待审批',tone:'warn',detail:'推送分支需要你的批准'},review:{label:'待验收',tone:'ok',detail:'后续交付态 · 演示结果'},stopping:{label:'停止待确认',tone:'warn',detail:'已请求停止，等待执行端确认'},stopped:{label:'已停止',tone:'muted',detail:'执行端已确认 · 本地模拟'},denied:{label:'审批已拒绝',tone:'muted',detail:'推送未执行 · 本地模拟'}})[s.scenario];
}
