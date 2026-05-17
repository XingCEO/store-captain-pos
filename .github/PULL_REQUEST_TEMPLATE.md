<!--
店長 AI POS PR template. Every field is required. See docs/ai-engineering-rules.md
for the 9-field spec; this is the engineering counterpart.
-->

## 背景 / Why
<!-- What problem does this PR solve? Link the spec or ticket. -->

## 變更摘要 / What
<!-- Concise list of behaviour and code changes. -->

## 不做範圍 / Out of scope
<!-- What this PR explicitly does NOT include, so reviewers don't ask. -->

## 影響範圍 / Surface
- [ ] Backend (src/)
- [ ] Frontend (public/)
- [ ] Service Worker (bump VERSION in public/sw.js if SHELL changed)
- [ ] DB schema / migrations
- [ ] CI / workflows
- [ ] Docs (docs/)

## 測試 / Tests
<!-- npm run lint && npm test outputs, smoke result, any manual QA -->

## 高風險檢查 / High-risk checklist
- [ ] No new PII handling without privacy review
- [ ] No payment / invoice handler mislabels its operating mode
- [ ] No new endpoint without `tenant_id` scope
- [ ] No new endpoint without `idempotencyKey` if it mutates money / inventory
- [ ] No new audit-worthy action without `runtime.addAudit(...)`
- [ ] Service Worker `VERSION` bumped if SHELL contents changed

## 待確認 / Open questions
<!-- Who confirms what, by when. Don't merge with open blockers. -->
