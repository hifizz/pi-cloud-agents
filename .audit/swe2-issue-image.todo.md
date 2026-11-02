# SWE-2 issue image E2E

Goal: issue 正文图片链接 → 获取真实图片 → SWE-2 看像素并识别内容。

Bug-fix playbook steps:
- [x] Read poteto-mode SKILL.md
- [x] Reproduce/identify root cause: src/models.mjs swe-2 `input: ["text"]` but TokenRouter declares imageInput=true; pi-ai drops image blocks for non-image models
- [ ] Minimal fix: swe-2 input `["text","image"]` in models.mjs; update test that asserted swe-2 is text-only
- [ ] Check error-branch `output` type vs durable ToolResultMessage["content"] contract (string is valid)
- [ ] Offline regression: npm test
- [ ] Serialize check: prove image block reaches request for swe-2 (unit-level, openai-completions transform)
- [ ] Live E2E on demo (8092/5183): dedicated test issue in tars-sandbox-playground with image URL, no answer in text; session downloads image via curl, view_image, SWE-2 reads pixel-only text
- [ ] Merge fix commit to demo/wia, restart 8092+5183 via scripts/demo.mjs
- [ ] Screenshots to docs/acceptance/swe2-issue-image/ (no creds)
- [ ] Final report
