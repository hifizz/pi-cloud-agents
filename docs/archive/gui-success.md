# GUI 成功率矩阵（Task 15 · TEST-F02-2 / F02-3）

最近更新：2026-10-06T21:54:59.658Z · 共 66 次运行 · 单次超时 360s

任务：L1 打开页面读口令；L2 表单登录（服务端校验）后读确认码；L3 搜索指定商品→勾选→提交，读订单号（服务端核对提交内容）。
模式：A = 仅截图（desktop_screenshot/windows/launch/click/type/key/scroll）；B = A + desktop_elements（AT-SPI 无障碍树）。两种模式均无 bash/read/write/edit/web_search。

## 成功率矩阵

| 模型 | 模式 | L1 | L2 | L3 |
|---|---|---|---|---|
| claude-sonnet-5-5 | A 仅截图 | 100% (3/3) | 80% (4/5) | 100% (3/3) |
| claude-sonnet-5-5 | B 截图+无障碍树 | 100% (3/3) | 100% (5/5) | 100% (3/3) |
| glm-5.3 | A 仅截图 | 33% (1/3) | 20% (1/5) | 0% (0/3) |
| glm-5.3 | B 截图+无障碍树 | 100% (3/3) | 100% (5/5) | 100% (3/3) |
| gpt-5.6-terra | A 仅截图 | 100% (3/3) | 0% (0/5) | 0% (0/3) |
| gpt-5.6-terra | B 截图+无障碍树 | 100% (3/3) | 100% (5/5) | 100% (3/3) |

## 汇总（每模型 × 模式）

| 模型 | 模式 | 总成功率 | 平均耗时(s) | 平均工具调用 | 平均 tokens | 总成本(USD) |
|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | A 仅截图 | 91% (10/11) | 81 | 18 | 214666 | 7.165 |
| claude-sonnet-5-5 | B 截图+无障碍树 | 100% (11/11) | 43 | 13 | 133845 | 4.450 |
| glm-5.3 | A 仅截图 | 18% (2/11) | 329 | 40 | 257519 | 0.380 |
| glm-5.3 | B 截图+无障碍树 | 100% (11/11) | 41 | 8 | 37677 | 0.045 |
| gpt-5.6-terra | A 仅截图 | 27% (3/11) | 266 | 32 | 209207 | 1.156 |
| gpt-5.6-terra | B 截图+无障碍树 | 100% (11/11) | 42 | 9 | 44924 | 0.331 |

## 每次运行明细

| # | 模型 | 模式 | 级别 | 结果 | 耗时(s) | 工具调用 | tokens | 成本(USD) | 备注 / 回答摘要 / 工具分布 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | claude-sonnet-5-5 | B | L1 | ✅ | 15 | 3 | 45098 | 0.1363 | 答: The access code is **AC-F5B79B**. I read it from the page in Chromium and confirmed the same text in {"launch":1,"screenshot":1,"elements":1} |
| 2 | claude-sonnet-5-5 | A | L1 | ✅ | 13 | 3 | 44594 | 0.1346 | 答: The access code is **AC-FE8E12**. {"launch":1,"screenshot":2} |
| 3 | claude-sonnet-5-5 | A | L1 | ✅ | 16 | 3 | 44660 | 0.1351 | 答: The access code is **AC-0B0F92**. I read it from the page at http://127.0.0.1:8765/l1.html, which I  {"launch":1,"screenshot":2} |
| 4 | claude-sonnet-5-5 | A | L1 | ✅ | 14 | 3 | 44656 | 0.1350 | 答: The access code is **AC-AE4204**. I read it from the page at http://127.0.0.1:8765/l1.html, which I  {"launch":1,"screenshot":2} |
| 5 | claude-sonnet-5-5 | A | L2 | ✅ | 54 | 20 | 147010 | 0.4455 | 答: The confirmation code is **CF-D96208**.  My first sign-in attempt failed because I typed before chec {"launch":1,"screenshot":8,"click":6,"type":4,"key":1} |
| 6 | claude-sonnet-5-5 | A | L2 | ✅ | 102 | 42 | 282439 | 0.8587 | 答: The confirmation code is **CF-3C6032**.  The first two sign-in attempts failed, probably because my  {"launch":1,"screenshot":14,"click":10,"type":10,"key":7} |
| 7 | claude-sonnet-5-5 | A | L2 | ❌ | 365 | 23 | 891187 | 2.7054 | 超时 · 答: My first attempt failed. I typed into the form without looking at it first. I'll retry and check eac {"launch":1,"screenshot":7,"click":7,"type":6,"key":2} |
| 8 | claude-sonnet-5-5 | A | L2 | ✅ | 91 | 24 | 222934 | 0.6761 | 答: The confirmation code is **CF-4E13D0**.  My first sign-in attempt failed because I sent the typing a {"launch":1,"screenshot":8,"click":7,"type":6,"key":2} |
| 9 | claude-sonnet-5-5 | A | L2 | ✅ | 139 | 55 | 406669 | 1.2347 | 答: The confirmation code is **CF-B824AD**.  The page title changed to "Signed in", and the page shows t {"launch":1,"screenshot":20,"click":17,"type":13,"key":4} |
| 10 | claude-sonnet-5-5 | A | L3 | ✅ | 27 | 8 | 82560 | 0.2499 | server saw 1 submission(s), last items=["p02"] · 答: The order number is **ORD-2C8531**. The result page lists the item as "USB-C Cable 2m Black".  I cli {"launch":1,"screenshot":3,"click":3,"type":1} |
| 11 | claude-sonnet-5-5 | A | L3 | ✅ | 39 | 11 | 111869 | 0.3388 | server saw 1 submission(s), last items=["p06"] · 答: The order number is **ORD-D35EC1**.  The result page listed the item as "Wireless Mouse Silver". My  {"launch":1,"screenshot":6,"click":3,"type":1} |
| 12 | claude-sonnet-5-5 | A | L3 | ✅ | 30 | 8 | 82743 | 0.2507 | server saw 1 submission(s), last items=["p08"] · 答: The order number is **ORD-CCDBF4**.  I searched for "Mechanical Keyboard Red Switch", ticked its che {"launch":1,"screenshot":3,"click":3,"type":1} |
| 13 | claude-sonnet-5-5 | B | L1 | ✅ | 12 | 3 | 45115 | 0.1365 | 答: The access code is **AC-55D838**.  I read it from the page in Chromium. The screenshot and the page' {"launch":1,"screenshot":1,"elements":1} |
| 14 | claude-sonnet-5-5 | B | L1 | ✅ | 12 | 3 | 45130 | 0.1366 | 答: The access code is **AC-9AA3A0**.  I read it from the page in Chromium. The screenshot and the page' {"launch":1,"screenshot":1,"elements":1} |
| 15 | claude-sonnet-5-5 | B | L2 | ✅ | 41 | 12 | 133992 | 0.4039 | 答: The confirmation code is **CF-68BE01**. {"launch":1,"screenshot":3,"click":4,"elements":2,"type":2} |
| 16 | claude-sonnet-5-5 | B | L2 | ✅ | 34 | 9 | 102197 | 0.3088 | 答: The confirmation code is **CF-EB9FEF**. I signed in as "agent" in Chromium, and the page showed it a {"launch":1,"screenshot":2,"click":2,"elements":2,"type":2} |
| 17 | claude-sonnet-5-5 | B | L2 | ✅ | 66 | 27 | 209751 | 0.6347 | 答: The confirmation code is **CF-CDB6C0**.  The first sign-in attempt failed because the fields got the {"launch":1,"screenshot":6,"click":6,"type":6,"key":5,"elements":3} |
| 18 | claude-sonnet-5-5 | B | L2 | ✅ | 93 | 37 | 249946 | 0.7592 | 答: The confirmation code is **CF-22EBCB**.  I read it from the page's text after signing in as "agent". {"launch":1,"screenshot":10,"click":7,"type":8,"key":9,"elements":2} |
| 19 | claude-sonnet-5-5 | B | L2 | ✅ | 31 | 8 | 101635 | 0.3065 | 答: The confirmation code is **CF-D8C12F**. I read it from the "Signed in" page in Chromium after loggin {"launch":1,"screenshot":1,"click":2,"elements":2,"type":2} |
| 20 | claude-sonnet-5-5 | B | L3 | ✅ | 56 | 14 | 183572 | 0.5540 | server saw 1 submission(s), last items=["p02"] · 答: The order number is **ORD-34658A**. The result page listed the item as "USB-C Cable 2m Black".  I se {"launch":1,"screenshot":6,"click":4,"type":2,"elements":1} |
| 21 | claude-sonnet-5-5 | B | L3 | ✅ | 44 | 12 | 141212 | 0.4266 | server saw 1 submission(s), last items=["p06"] · 答: The order number is **ORD-825B75**. The result page lists the item as "Wireless Mouse Silver".  I ne {"launch":1,"screenshot":5,"click":4,"type":2} |
| 22 | claude-sonnet-5-5 | B | L3 | ✅ | 67 | 16 | 214649 | 0.6473 | server saw 1 submission(s), last items=["p08"] · 答: The order number is **ORD-8C4A97**. The result page listed "Mechanical Keyboard Red Switch" as the o {"launch":1,"screenshot":7,"click":4,"type":3,"elements":1} |
| 23 | glm-5.3 | A | L1 | ✅ | 246 | 33 | 160800 | 0.0172 | 答: I opened the page in Chromium and retrieved its contents. The page reads "Your access code is:" foll {"launch":2,"screenshot":4,"windows":8,"key":12,"type":5,"click":2} |
| 24 | glm-5.3 | A | L1 | ❌ | 360 | 64 | 442974 | 0.0216 | 超时 · 答: The screenshots aren't rendering for me, so I'll extract the code by making it appear in a window ti {"launch":6,"screenshot":13,"windows":10,"click":5,"key":20,"type":10} |
| 25 | glm-5.3 | A | L1 | ❌ | 361 | 47 | 264025 | 0.0354 | 超时 · 答: Let me test the terminal approach more carefully — xfce4-terminal titles update with the working dir {"launch":2,"screenshot":3,"key":19,"type":10,"windows":11,"click":2} |
| 26 | glm-5.3 | A | L2 | ❌ | 360 | 34 | 187203 | 0.0336 | 超时 · 答: The POST with correct fields returns a "Signed in" page — my earlier failure is now explained: my fi {"launch":1,"screenshot":11,"type":9,"key":11,"click":2} |
| 27 | glm-5.3 | A | L2 | ❌ | 361 | 39 | 218591 | 0.0407 | 超时 · 答: Form fields are `user` and `pass`, method POST to /l2/login. Now let me submit with the correct fiel {"launch":1,"screenshot":3,"click":2,"type":8,"key":15,"windows":10} |
| 28 | glm-5.3 | A | L2 | ❌ | 360 | 39 | 238450 | 0.0416 | 超时 · no successful login on server · 答: Titles unchanged — possibly the shell is dash (echo -ne doesn't set titles). Let me retry with `prin {"launch":3,"screenshot":7,"click":8,"type":8,"windows":6,"key":7} |
| 29 | glm-5.3 | A | L2 | ✅ | 131 | 22 | 89385 | 0.0121 | 答: Signed in successfully. The confirmation code is:  **CF-4A5578** {"launch":1,"screenshot":1,"key":10,"type":6,"windows":4} |
| 30 | glm-5.3 | A | L2 | ❌ | 360 | 40 | 224273 | 0.0430 | 超时 · no successful login on server · 答: Now creating the download script file and checking its size (the size digits are my feedback): {"launch":1,"screenshot":2,"type":11,"key":16,"windows":8,"click":2} |
| 31 | glm-5.3 | A | L3 | ❌ | 360 | 66 | 625899 | 0.0420 | 超时 · server saw 1 submission(s), last items=["p01","p02"] · 答: I now have the full page structure. The plan: use keyboard navigation in Chromium (click blank area  {"launch":1,"screenshot":21,"click":9,"type":8,"key":22,"windows":5} |
| 32 | glm-5.3 | A | L3 | ❌ | 360 | 36 | 245193 | 0.0447 | 超时 · no submission on server · 答: The title-escape trick didn't take. Let me try a `zenity` dialog instead — its X window title is rea {"launch":1,"screenshot":10,"click":3,"key":12,"type":7,"windows":3} |
| 33 | glm-5.3 | A | L3 | ❌ | 360 | 24 | 135914 | 0.0480 | 超时 · no submission on server · 答: Filter works — only the **p08** row is visible. Now computing its absolute screen coordinates (inclu {"launch":1,"screenshot":1,"type":11,"windows":7,"key":4} |
| 34 | glm-5.3 | B | L1 | ✅ | 22 | 3 | 12275 | 0.0028 | 答: The page loaded in Chromium and shows the access code.  **Access code: `AC-AE0931`** {"launch":1,"screenshot":1,"elements":1} |
| 35 | glm-5.3 | B | L1 | ✅ | 20 | 3 | 12152 | 0.0017 | 答: The page loaded and displays the access code: **AC-401FF1** {"launch":1,"screenshot":1,"elements":1} |
| 36 | glm-5.3 | B | L1 | ✅ | 26 | 4 | 15786 | 0.0024 | 答: The page loaded and shows the access code:  **AC-7E2BB6** {"launch":1,"windows":1,"screenshot":1,"elements":1} |
| 37 | glm-5.3 | B | L2 | ✅ | 42 | 7 | 30404 | 0.0026 | 答: Signed in successfully. The confirmation code is:  **CF-133EE6** {"launch":1,"windows":1,"elements":2,"type":2,"click":1} |
| 38 | glm-5.3 | B | L2 | ✅ | 38 | 7 | 31218 | 0.0026 | 答: Sign-in succeeded. The confirmation code is:  **CF-79D577** {"launch":1,"screenshot":1,"elements":2,"type":2,"click":1} |
| 39 | glm-5.3 | B | L2 | ✅ | 41 | 7 | 30471 | 0.0037 | 答: Signed in successfully at http://127.0.0.1:8765/l2.html. The confirmation code is:  **CF-C592E0** {"launch":1,"windows":1,"elements":2,"type":2,"click":1} |
| 40 | glm-5.3 | B | L2 | ✅ | 48 | 9 | 42251 | 0.0049 | 答: Signed in successfully in Chromium. The confirmation code is:  **CF-567898** {"launch":1,"screenshot":2,"elements":3,"type":2,"click":1} |
| 41 | glm-5.3 | B | L2 | ✅ | 48 | 11 | 54306 | 0.0058 | 答: Signed in successfully on http://127.0.0.1:8765/l2.html (Chromium). The confirmation code is:  **CF- {"launch":1,"screenshot":2,"elements":5,"type":2,"click":1} |
| 42 | glm-5.3 | B | L3 | ✅ | 54 | 11 | 59004 | 0.0071 | server saw 1 submission(s), last items=["p02"] · 答: Done. On http://127.0.0.1:8765/l3.html I:  1. Searched for "USB-C Cable 2m Black" in the search box  {"launch":1,"screenshot":2,"elements":5,"type":1,"click":2} |
| 43 | glm-5.3 | B | L3 | ✅ | 53 | 12 | 56168 | 0.0062 | server saw 1 submission(s), last items=["p06"] · 答: Order placed successfully.  - Searched for "Wireless Mouse Silver" and ticked its checkbox (exactly  {"launch":1,"screenshot":1,"elements":7,"type":1,"click":2} |
| 44 | glm-5.3 | B | L3 | ✅ | 60 | 12 | 70416 | 0.0054 | server saw 1 submission(s), last items=["p08"] · 答: Order placed successfully.  - **Item:** Mechanical Keyboard Red Switch - **Order number: ORD-215E1D* {"launch":1,"screenshot":1,"elements":7,"type":1,"click":2} |
| 45 | gpt-5.6-terra | A | L1 | ✅ | 15 | 3 | 9394 | 0.0105 | 答: AC-3F2234 {"launch":2,"screenshot":1} |
| 46 | gpt-5.6-terra | A | L1 | ✅ | 22 | 4 | 16373 | 0.0125 | 答: AC-2A1231 {"screenshot":2,"launch":2} |
| 47 | gpt-5.6-terra | A | L1 | ✅ | 14 | 3 | 9398 | 0.0075 | 答: AC-513DCB {"launch":2,"screenshot":1} |
| 48 | gpt-5.6-terra | A | L2 | ❌ | 360 | 40 | 234061 | 0.1299 | 超时 · no successful login on server · 答:  {"launch":2,"screenshot":2,"click":33,"type":1,"key":2} |
| 49 | gpt-5.6-terra | A | L2 | ❌ | 360 | 61 | 458869 | 0.1752 | 超时 · no successful login on server · 答:  {"screenshot":2,"launch":2,"click":54,"windows":1,"type":1,"key":1} |
| 50 | gpt-5.6-terra | A | L2 | ❌ | 360 | 52 | 336315 | 0.1706 | 超时 · no successful login on server · 答:  {"launch":2,"screenshot":2,"click":44,"key":3,"type":1} |
| 51 | gpt-5.6-terra | A | L2 | ❌ | 360 | 30 | 187451 | 0.1251 | 超时 · no successful login on server · 答:  {"launch":8,"screenshot":7,"click":14,"key":1} |
| 52 | gpt-5.6-terra | A | L2 | ❌ | 360 | 29 | 184721 | 0.1143 | 超时 · no successful login on server · 答:  {"launch":5,"screenshot":5,"click":16,"key":3} |
| 53 | gpt-5.6-terra | A | L3 | ❌ | 360 | 56 | 390493 | 0.1570 | 超时 · no submission on server · 答:  {"launch":3,"screenshot":2,"click":49,"key":2} |
| 54 | gpt-5.6-terra | A | L3 | ❌ | 360 | 38 | 233853 | 0.1233 | 超时 · no submission on server · 答:  {"launch":3,"screenshot":2,"click":31,"key":1,"windows":1} |
| 55 | gpt-5.6-terra | A | L3 | ❌ | 360 | 38 | 240351 | 0.1304 | 超时 · no submission on server · 答:  {"launch":4,"screenshot":3,"click":29,"key":1,"type":1} |
| 56 | gpt-5.6-terra | B | L1 | ✅ | 18 | 4 | 13439 | 0.0157 | 答: AC-62A414 {"launch":2,"windows":1,"elements":1} |
| 57 | gpt-5.6-terra | B | L1 | ✅ | 15 | 4 | 12763 | 0.0113 | 答: AC-99293A {"launch":2,"windows":1,"screenshot":1} |
| 58 | gpt-5.6-terra | B | L1 | ✅ | 48 | 7 | 28410 | 0.0260 | 答: AC-79982C {"launch":2,"screenshot":1,"key":1,"click":1,"windows":1,"elements":1} |
| 59 | gpt-5.6-terra | B | L2 | ✅ | 51 | 11 | 62171 | 0.0352 | 答: CF-DAC538 {"screenshot":2,"launch":2,"windows":1,"elements":3,"type":2,"click":1} |
| 60 | gpt-5.6-terra | B | L2 | ✅ | 43 | 9 | 48067 | 0.0356 | 答: CF-072ADF {"screenshot":1,"launch":2,"windows":1,"elements":2,"type":2,"click":1} |
| 61 | gpt-5.6-terra | B | L2 | ✅ | 50 | 9 | 43626 | 0.0260 | 答: CF-CB82B0 {"screenshot":1,"launch":2,"windows":1,"elements":2,"type":2,"click":1} |
| 62 | gpt-5.6-terra | B | L2 | ✅ | 42 | 9 | 47456 | 0.0345 | 答: CF-2D7861 {"screenshot":2,"launch":2,"windows":1,"elements":1,"type":2,"click":1} |
| 63 | gpt-5.6-terra | B | L2 | ✅ | 43 | 9 | 48065 | 0.0315 | 答: CF-9F452B {"screenshot":1,"launch":2,"windows":1,"elements":2,"type":2,"click":1} |
| 64 | gpt-5.6-terra | B | L3 | ✅ | 38 | 10 | 42159 | 0.0277 | server saw 1 submission(s), last items=["p02"] · 答: Order number: **ORD-3D9928** {"launch":2,"windows":1,"elements":3,"type":1,"click":2,"screenshot":1} |
| 65 | gpt-5.6-terra | B | L3 | ✅ | 57 | 12 | 77777 | 0.0412 | server saw 1 submission(s), last items=["p06"] · 答: Order number: **ORD-DBF9B1** {"launch":2,"windows":1,"elements":5,"type":1,"click":2,"screenshot":1} |
| 66 | gpt-5.6-terra | B | L3 | ✅ | 62 | 12 | 70236 | 0.0466 | server saw 1 submission(s), last items=["p08"] · 答: Order number: **ORD-C2796F** {"screenshot":2,"launch":2,"windows":1,"elements":4,"type":1,"click":2} |

## 结论

**L2 成功率是否 ≥ 60%（TEST-F02-2）**：模式 B（截图 + 无障碍树）下三个模型 L2 均为 5/5 = 100%，达标；模式 A（仅截图）下只有 claude-sonnet-5-5 达标（4/5 = 80%），glm-5.3 为 1/5，gpt-5.6-terra 为 0/5。
**无障碍树的价值（TEST-F02-3）**：B 相对 A 的总成功率 sonnet 91%→100%，glm-5.3 18%→100%，terra 27%→100%；同时耗时、tokens 大幅下降（glm 平均 329s→41s，tokens 25.8 万→3.8 万）。结论：无障碍树是 GUI 成功率的决定因素，必须默认开放 `desktop_elements`，且 DESKTOP_GUIDE 保持"优先 element_token"。

**推荐默认模型：`glm-5.3`**（保持现状）。在默认配置（B 模式）下 3 个模型都是 11/11 全通过，glm-5.3 最快（平均 41s / 8 次调用 / 约 3.8 万 tokens）且最便宜（11 次运行合计约 $0.045，sonnet-5-5 约 $4.45，terra 约 $0.33）。需要视觉兜底（无障碍树不可用的 canvas / 远程桌面类页面）时，用 `claude-sonnet-5-5`：它是唯一在仅截图模式下也基本可用的模型（91%）；gpt-5.6-terra 仅截图模式下 L2/L3 全部超时失败（原因未深究，多为点击坐标与输入焦点问题）。

**注意 / 局限**
- 每格样本很小（3 或 5 次），只能看出量级差异，不是统计显著结论。
- glm-5.3 在 A 模式下的失败运行里出现"绕过 GUI"行为：通过 `desktop_launch` 打开 xfce4-terminal / zenity，再用 `desktop_type` 输入命令并靠窗口标题回读（见明细中的回答摘要）。文本模型看不到截图，这是它的补偿策略；成功的 2 次 A 模式运行未启动终端，但具体读取方式未逐条核查。
- 成本按 `src/models.mjs` 里的近似单价估算，非真实账单。
- 第 1 条记录（sonnet / B / L1 / n=0）是脚本冒烟运行，同条件、同流程，计入统计。
- 判定：L1 答案含口令；L2 要求服务端记录到成功登录且答案含确认码；L3 要求服务端最后一次提交恰好是目标商品且答案含订单号。所有口令每次运行随机生成，且不通过 HTTP 暴露。
