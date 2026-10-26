// 将 components/*.mjs + app.mjs 按依赖顺序拼成自包含 demo.html（不加依赖）。
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const read=file=>readFileSync(join(root,file),'utf8');
const order=['shared','tool-card','conversation','composer','sidebar','header','panels','new-workspace-dialog','layout'].map(n=>`components/${n}.mjs`).concat('app.mjs');
const code=order.map(file=>{
  const source=read(file).replace(/^import\s[^;]+;\s*$/gm,'').replace(/^export\s+(?=(const|function)\b)/gm,'');
  if(/^\s*(import|export)\s/m.test(source)) throw new Error(`${file} 含有 build.mjs 不支持的 import/export 形式`);
  return `/* ${file} */\n${source.trim()}`;
}).join('\n\n');
if(/<\/script/i.test(code)) throw new Error('脚本中不得出现 </script');
const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>PI · 工作区原型</title>
<!-- 由 build.mjs 生成，勿手改；源文件见 components/ -->
<style>\n${read('tokens.css')}\n${read('styles.css')}\n</style></head><body><div id="app"></div>
<script type="module">\n${code}\n</script></body></html>
`;
writeFileSync(join(root,'demo.html'),html);
console.log(`demo.html ${(html.length/1024).toFixed(1)} KB`);
