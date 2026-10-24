import {Layout} from './components/layout.mjs';
import {Sidebar} from './components/sidebar.mjs';
const workspaces=[{id:'preview',name:'修复预览断连',session:'修复与验证',branch:'tarsbot/fix-preview',sprite:'pca-7e4a9c12b0',step:5,model:'SWE-2'},{id:'upload',name:'补齐上传校验',session:'补齐校验',branch:'tarsbot/upload-check',sprite:'pca-2b6d8f34a1',step:5,model:'GLM 5.3',task:'补齐上传文件类型和大小校验，给出清晰的错误提示，并补上边界用例。'}];
const state={workspaces,active:'preview',workspace:workspaces[0],scenario:'running',railOpen:!matchMedia('(max-width:820px)').matches,panelOpen:!matchMedia('(max-width:1180px)').matches,overlay:false,tab:'changes',search:'',toolsOpen:false,diffFolded:false,selectedFile:'web/src/lib/connection.ts',draft:'',model:'SWE-2',messages:[],checkpoints:[{title:'开始修复前',time:'今天 14:31',detail:'初始代码 · 演示检查点'}],testsStale:false,prCreated:false};
const app=document.querySelector('#app');
let toastTimer,returnFocus;
const narrowRail=()=>matchMedia('(max-width:820px)').matches;
const narrowPanel=()=>matchMedia('(max-width:1180px)').matches;
// 窄屏时侧栏与面板都是浮层，同一时间只开一个，避免互相叠压。
function settleOverlays(opened){if(opened==='rail'&&state.railOpen&&narrowRail())state.panelOpen=false;if(opened==='panel'&&state.panelOpen&&narrowRail())state.railOpen=false;}
function render({scroll=false}={}){state.overlay=(state.railOpen&&narrowRail())||(state.panelOpen&&narrowPanel());const pos=app.querySelector('.conversation')?.scrollTop||0;app.innerHTML=Layout(state);const feed=app.querySelector('.conversation');feed.scrollTop=scroll?feed.scrollHeight:pos;}
function toast(text){clearTimeout(toastTimer);const el=document.querySelector('#toast');el.textContent=text;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),4200);}
function openDialog(){returnFocus=document.activeElement;document.querySelector('#new-workspace-dialog').showModal();document.querySelector('[name=name]').focus();}
function closeDialog(){document.querySelector('#new-workspace-dialog').close();returnFocus?.focus();}
function scenario(id){if(state.workspace.step<5){toast('请先用“下一步”完成工作区初始化演示');return;}state.scenario=id;state.testsStale=false;state.prCreated=false;render();}
function send(mode){if(!state.draft.trim()||state.workspace.step<5)return;if(state.scenario==='approval'){toast('请先批准或拒绝当前操作，再补充需求');return;}state.messages.push({text:state.draft.trim(),mode});state.draft='';if(state.scenario==='review')state.testsStale=true;render({scroll:true});document.querySelector('#message-input').focus();}
app.addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button||button.disabled)return;const {action,id}=button.dataset;
 switch(action){
 case 'new':openDialog();break;
 case 'close-dialog':closeDialog();break;
 case 'toggle-rail':state.railOpen=!state.railOpen;settleOverlays('rail');render();break;
 case 'toggle-panel':state.panelOpen=!state.panelOpen;settleOverlays('panel');render();break;
 case 'close-overlays':if(narrowRail())state.railOpen=false;if(narrowPanel())state.panelOpen=false;render();break;
 case 'tab':state.tab=id;render();document.querySelector(`#tab-${id}`).focus();break;
 case 'environment':case 'terminal':case 'changes':state.tab=action;state.panelOpen=true;settleOverlays('panel');render();break;
 case 'scenario':scenario(id);break;
 case 'tools':state.toolsOpen=!state.toolsOpen;render();break;
 case 'fold-diffs':case 'diff-file':state.diffFolded=!state.diffFolded;render();break;
 case 'file':state.selectedFile=id;render();break;
 case 'workspace':if(state.active===id)break;Object.assign(state.workspace,{messages:state.messages,draft:state.draft,scenario:state.scenario,checkpoints:state.checkpoints,testsStale:state.testsStale,prCreated:state.prCreated});if(narrowRail())state.railOpen=false;state.active=id;state.workspace=state.workspaces.find(w=>w.id===id);Object.assign(state,{model:state.workspace.model,messages:state.workspace.messages||[],draft:state.workspace.draft||'',scenario:state.workspace.scenario||'running',checkpoints:state.workspace.checkpoints||[],testsStale:state.workspace.testsStale||false,prCreated:state.workspace.prCreated||false});render();break;
 case 'session':toast('当前会话已打开；M1 每个工作区只有一个可写会话');break;
 case 'send':send(['running','stopping','approval'].includes(state.scenario)?'补充本轮':'继续工作');break;
 case 'queue':send('下一轮');break;
 case 'stop':state.scenario='stopping';render();toast('已发送停止请求（模拟），尚未收到执行端确认');break;
 case 'confirm-stop':state.scenario='stopped';render();toast('已收到停止确认 · 本地模拟');break;
 case 'approve':state.scenario='running';render();toast('审批已批准（模拟），任务继续；未执行真实推送');break;
 case 'reject':state.scenario='denied';render();toast('已拒绝本次推送（模拟）');break;
 case 'rerun':state.testsStale=false;render();toast('已更新演示测试结果 · 未运行真实测试');break;
 case 'pr':if(state.testsStale){toast('补充需求后，先重新验证再创建示例 PR');break;}state.prCreated=true;render();toast('示例 PR：修复预览断连 · 未访问 GitHub');break;
 case 'checkpoint':state.checkpoints.unshift({title:`手动检查点 ${state.checkpoints.length+1}`,time:'刚刚',detail:'2 个文件 · 本地模拟'});render();toast('演示检查点已保存；没有读取或存档实际文件');break;
 case 'checkpoint-info':toast(`${state.checkpoints[Number(id)].title}：保存未提交代码，恢复操作由后端接入后提供`);break;
 case 'init-next':state.workspace.step++;render();if(state.workspace.step===5)toast('工作区就绪（模拟），需求已交给 Agent');break;
 case 'about':toast('组件化界面原型 · 无外部依赖 · 所有操作仅保存在本页内存');break;
 }
});
app.addEventListener('input',event=>{if(event.target.id==='message-input'){state.draft=event.target.value;document.querySelectorAll('[data-action=send],[data-action=queue]').forEach(b=>b.disabled=!state.draft.trim());}if(event.target.id==='workspace-search'){state.search=event.target.value;const temporary=document.createElement('div');temporary.innerHTML=Sidebar(state);document.querySelector('#workspace-list').innerHTML=temporary.querySelector('#workspace-list').innerHTML;}});
app.addEventListener('change',event=>{if(event.target.id==='model-select'){state.model=event.target.value;state.workspace.model=state.model;render();toast(`已切换为 ${state.model} · 本地模拟`);}});
app.addEventListener('keydown',event=>{if(event.target.id==='message-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();send(['running','stopping','approval'].includes(state.scenario)?'补充本轮':'继续工作');}if(event.target.matches('[role=tab]')&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const tabs=['changes','files','terminal','environment'];const index=tabs.indexOf(state.tab);state.tab=tabs[(index+(event.key==='ArrowRight'?1:3))%4];render();document.querySelector(`#tab-${state.tab}`).focus();}});
app.addEventListener('submit',event=>{if(event.target.id!=='new-workspace-form')return;event.preventDefault();const form=event.target;if(!form.reportValidity())return;const values=Object.fromEntries(new FormData(form));if(!values.name.trim()||!values.task.trim()){document.querySelector('#form-error').textContent='工作区名称和需求不能只包含空格。';return;}if(/\s/.test(values.baseBranch)||values.baseBranch.includes('..')||values.baseBranch.endsWith('/')||values.baseBranch.includes('//')){document.querySelector('#form-error').textContent='请输入合法的基准分支名称。';return;}Object.assign(state.workspace,{messages:state.messages,draft:state.draft,scenario:state.scenario,checkpoints:state.checkpoints,testsStale:state.testsStale,prCreated:state.prCreated});const suffix=String(Date.now()).slice(-6);const workspace={id:`local-${suffix}`,name:values.name.trim(),branch:`tarsbot/work-${suffix}`,sprite:`pca-demo-${suffix}`,step:0,model:values.model,task:values.task.trim(),repo:values.repo,baseBranch:values.baseBranch,installCommand:values.installCommand};state.workspaces.push(workspace);Object.assign(state,{active:workspace.id,workspace,scenario:'running',model:workspace.model,messages:[],draft:'',checkpoints:[],testsStale:false,prCreated:false,search:''});if(narrowRail())state.railOpen=false;render();document.querySelector('[data-action=init-next]').focus();toast('工作区已在本页创建，用“下一步”推进初始化演示');});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!document.querySelector('dialog[open]'))openDialog();}if(event.key==='/'&&!event.target.matches('input,textarea,select')){event.preventDefault();if(!state.railOpen){state.railOpen=true;render();}document.querySelector('#workspace-search').focus();}});
render();
