# Parent documentation verification

Search receipt: mvyrxd1bmovbp4; inspected 2026-11-02. Source: search service extracts of official docs, no live API tests.

- https://modal.com/docs/guide/sandbox-snapshots : filesystem snapshot TTL configurable, including no expiry. Memory snapshot 7-day expiry, inherited across resnapshot chains; terminates source; active Sandbox.exec blocks snapshot and exec-launched background processes not properly restored. Thus never summarize as universally resumable processes. Modal can serve persistent filesystem sessions through images/volumes plus rebuild; rejecting all Orb use is too broad.
- https://modal.com/docs/guide/sandbox-exit-snapshots says Python only, while https://modal.com/docs/sdk/js/latest/Sandbox.md exposes experimentalGetExitSnapshot. Documentation conflict: verify fixed SDK version before claiming JS support.
- https://docs.e2b.dev/sandbox/persistence : paused sandboxes retained indefinitely; default memory+filesystem; filesystem-only mode available. Auto-pause may fall back to filesystem-only after repeated memory-pause refusals under snapshot backlog. Need record actual pause mode; cannot promise every pause preserves running processes.
- https://docs.e2b.dev/faq/sandbox-lifetime : default timeout behavior kill, destructive; explicitly opt into pause.
- https://docs.e2b.dev/billing : only running billed, plan ceilings/creation rates; doc claims not account-specific verified configuration.
- https://instabox.sh/docs/api/lifecycle : suspend keeps memory and programs, requires idempotency key.
- https://instabox.sh/docs/api : completed same-key retry returns prior response; different request same key conflicts; keys retained 7 days. Not unbounded deduplication.
- https://instabox.sh/llms.txt : sizing depends on plan, stopped paid machines can resize; no live account queries performed.

Project checks:
- checkpoint.mjs:168-184 actually adds files then emits warning `possible secret file is not ignored and is included`; no secret-removal guarantee. Historical Git objects in bundle warrant separate secret-retention analysis.
- control/store.mjs:763-770 counts starting/running/needs_approval as occupied. Missing explicit needs_approval UI transition alone does not prove approval waiting frees queue slot.
- loops/tools.mjs:28-33 remote command blocking is regular expression matching; block verdict prevents human override for recognized strings, not all equivalent shell programs.
