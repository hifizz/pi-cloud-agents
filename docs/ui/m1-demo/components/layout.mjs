import {Sidebar} from './sidebar.mjs';
import {PrototypeBar,Header} from './header.mjs';
import {Conversation} from './conversation.mjs';
import {Composer} from './composer.mjs';
import {Panels} from './panels.mjs';
import {NewWorkspaceDialog} from './new-workspace-dialog.mjs';
export function Layout(s){return `${PrototypeBar(s)}<div class="workspace-shell ${s.railOpen?'':'rail-closed'} ${s.panelOpen?'':'panel-closed'}">${s.overlay?'<button class="scrim" data-action="close-overlays" aria-label="关闭浮层" tabindex="-1"></button>':''}${s.railOpen?Sidebar(s):''}<main class="main" aria-label="工作区对话">${Header(s)}${Conversation(s)}${Composer(s)}</main>${s.panelOpen?Panels(s):''}</div><div id="toast" class="toast" role="status" aria-live="polite"></div>${NewWorkspaceDialog(s)}`;}
