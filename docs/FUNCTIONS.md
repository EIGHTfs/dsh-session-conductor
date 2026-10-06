# 函数列表（由 dsh-git-push doc-func 维护）

<!-- dshgp-functions:start -->
## 函数列表

### lib/client-parts/apply.js（47 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `apply` | 1-28 | 28 | `function apply(ctx) {` |

### lib/client-parts/components/compaction.js（121 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `CompactionModelCard` | 32-90 | 59 | `function CompactionModelCard({ t }) {` |
| `save` | 53-68 | 16 | `const save = async () => {` |
| `apply` | 92-105 | 14 | `function apply(ctx) {` |

### lib/client-parts/components/conductor-settings.js（63 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ScsPage` | 37-49 | 13 | `function ScsPage({ t }) {` |
| `apply` | 51-55 | 5 | `function apply(ctx) {` |

### lib/client-parts/components/group.js（116 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionGroupCard` | 39-82 | 44 | `function SessionGroupCard({ t }) {` |
| `load` | 43-47 | 5 | `const load = () => {` |
| `createIn` | 49-65 | 17 | `const createIn = async (workspaceId) => {` |
| `apply` | 84-97 | 14 | `function apply(ctx) {` |

### lib/client-parts/components/panel.js（1250 行 · 25 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionManagerPanel` | 1-1248 | 1248 | `function SessionManagerPanel({ wide, t, onOpenSession }) {` |
| `insertSorted` | 24-30 | 7 | `const insertSorted = (cur, item) => {` |
| `act` | 88-118 | 31 | `const act = async (sessionId, action) => {` |
| `confirmDelete` | 120-124 | 5 | `const confirmDelete = (session) => {` |
| `undoLast` | 127-155 | 29 | `const undoLast = async (session) => {` |
| `toggleAutoRename` | 158-179 | 22 | `const toggleAutoRename = async (sessionId, enabled) => {` |
| `analyzeNow` | 181-203 | 23 | `const analyzeNow = async (sessionId) => {` |
| `scanAndRepair` | 206-238 | 33 | `const scanAndRepair = async () => {` |
| `scanAndRepairEio` | 245-277 | 33 | `const scanAndRepairEio = async () => {` |
| `scanAndRepairDual` | 284-316 | 33 | `const scanAndRepairDual = async () => {` |
| `toggleAutoContinue` | 319-335 | 17 | `const toggleAutoContinue = async (sessionId, enabled) => {` |
| `releaseNow` | 337-356 | 20 | `const releaseNow = async (sessionId) => {` |
| `releaseAll` | 358-383 | 26 | `const releaseAll = async () => {` |
| `continueNow` | 385-411 | 27 | `const continueNow = async (sessionId) => {` |
| `runFullSearch` | 415-455 | 41 | `const runFullSearch = async (keyword) => {` |
| `deleteSelected` | 458-482 | 25 | `const deleteSelected = async () => {` |
| `previewLocally` | 487-516 | 30 | `const previewLocally = () => {` |
| `previewRuleDelete` | 518-556 | 39 | `const previewRuleDelete = async () => {` |
| `runRuleDelete` | 558-595 | 38 | `const runRuleDelete = async () => {` |
| `matchesQuery` | 600-609 | 10 | `const matchesQuery = (row) => {` |
| `groupByWorkspace` | 620-641 | 22 | `const groupByWorkspace = (list) => {` |
| `norm` | 622-622 | 1 | `const norm = (p) => String(p ?? "").replace(/\/+$/, "");` |
| `groupByArchiveWs` | 645-660 | 16 | `const groupByArchiveWs = (list) => {` |
| `toggleCollapse` | 664-671 | 8 | `const toggleCollapse = (key) => {` |
| `renderRow` | 673-853 | 181 | `const renderRow = (session) => {` |

### lib/client-parts/components/processing.js（94 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `activeUserText` | 34-49 | 16 | `function activeUserText(nodes) {` |
| `ProcessingBar` | 51-70 | 20 | `function ProcessingBar({ useSession, t }) {` |
| `apply` | 72-80 | 9 | `function apply(ctx) {` |

### lib/client-parts/components/session-icon.js（14 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `SessionIcon` | 1-12 | 12 | `function SessionIcon(props) {` |

### lib/client-parts/components/settings.js（416 行 · 21 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ensureSettingsCss` | 45-53 | 9 | `function ensureSettingsCss() {` |
| `trSettings` | 55-58 | 4 | `function trSettings(key) {` |
| `TemplateSlotCard` | 61-94 | 34 | `function TemplateSlotCard(props) {` |
| `TemplatePickerModal` | 97-128 | 32 | `function TemplatePickerModal(props) {` |
| `useTemplateFetch` | 136-158 | 23 | `function useTemplateFetch(st) {` |
| `useTemplateImports` | 161-210 | 50 | `function useTemplateImports(st, post) {` |
| `slotLabel` | 162-162 | 1 | `const slotLabel = (slot) => (slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort"));` |
| `onPickFile` | 163-173 | 11 | `const onPickFile = (slot, event) => {` |
| `openImport` | 174-192 | 19 | `const openImport = (slot) => {` |
| `browseDir` | 193-201 | 9 | `const browseDir = (path) => {` |
| `importTemplate` | 202-208 | 7 | `const importTemplate = (slot, mode, value) => {` |
| `useTemplateMutations` | 213-251 | 39 | `function useTemplateMutations(st, post, slotLabel) {` |
| `toggle` | 214-220 | 7 | `const toggle = (slot, enabled) => {` |
| `toggleEnforce` | 221-227 | 7 | `const toggleEnforce = (enforce) => {` |
| `onEdit` | 228-233 | 6 | `const onEdit = (slot, el) => {` |
| `saveEdit` | 234-242 | 9 | `const saveEdit = (slot) => {` |
| `onRemove` | 243-249 | 7 | `const onRemove = (slot) => {` |
| `MainTemplateSection` | 253-294 | 42 | `function MainTemplateSection() {` |
| `AutoRenameModelSection` | 301-379 | 79 | `function AutoRenameModelSection() {` |
| `save` | 326-346 | 21 | `const save = async (next) => {` |
| `ConductorSettingsPage` | 400-414 | 15 | `function ConductorSettingsPage() {` |

### lib/client-parts/foundation/bootstrap.js（52 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `basenameOf` | 29-34 | 6 | `function basenameOf(p) {` |
| `timeAgo` | 36-50 | 15 | `function timeAgo(ms, t) {` |

### lib/client-parts/foundation/i18n.js（75 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fill` | 40-43 | 4 | `const fill = () => {` |

### lib/client-parts/foundation/list-cache.js（21 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `readListCache` | 2-11 | 10 | `function readListCache() {` |
| `writeListCache` | 12-18 | 7 | `function writeListCache(sessions) {` |

### lib/client.js（2442 行 · 65 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fill` | 40-43 | 4 | `const fill = () => {` |
| `basenameOf` | 103-108 | 6 | `function basenameOf(p) {` |
| `timeAgo` | 110-124 | 15 | `function timeAgo(ms, t) {` |
| `readListCache` | 310-319 | 10 | `function readListCache() {` |
| `writeListCache` | 320-326 | 7 | `function writeListCache(sessions) {` |
| `SessionIcon` | 329-340 | 12 | `function SessionIcon(props) {` |
| `SessionManagerPanel` | 342-1589 | 1248 | `function SessionManagerPanel({ wide, t, onOpenSession }) {` |
| `insertSorted` | 365-371 | 7 | `const insertSorted = (cur, item) => {` |
| `act` | 429-459 | 31 | `const act = async (sessionId, action) => {` |
| `confirmDelete` | 461-465 | 5 | `const confirmDelete = (session) => {` |
| `undoLast` | 468-496 | 29 | `const undoLast = async (session) => {` |
| `toggleAutoRename` | 499-520 | 22 | `const toggleAutoRename = async (sessionId, enabled) => {` |
| `analyzeNow` | 522-544 | 23 | `const analyzeNow = async (sessionId) => {` |
| `scanAndRepair` | 547-579 | 33 | `const scanAndRepair = async () => {` |
| `scanAndRepairEio` | 586-618 | 33 | `const scanAndRepairEio = async () => {` |
| `scanAndRepairDual` | 625-657 | 33 | `const scanAndRepairDual = async () => {` |
| `toggleAutoContinue` | 660-676 | 17 | `const toggleAutoContinue = async (sessionId, enabled) => {` |
| `releaseNow` | 678-697 | 20 | `const releaseNow = async (sessionId) => {` |
| `releaseAll` | 699-724 | 26 | `const releaseAll = async () => {` |
| `continueNow` | 726-752 | 27 | `const continueNow = async (sessionId) => {` |
| `runFullSearch` | 756-796 | 41 | `const runFullSearch = async (keyword) => {` |
| `deleteSelected` | 799-823 | 25 | `const deleteSelected = async () => {` |
| `previewLocally` | 828-857 | 30 | `const previewLocally = () => {` |
| `previewRuleDelete` | 859-897 | 39 | `const previewRuleDelete = async () => {` |
| `runRuleDelete` | 899-936 | 38 | `const runRuleDelete = async () => {` |
| `matchesQuery` | 941-950 | 10 | `const matchesQuery = (row) => {` |
| `groupByWorkspace` | 961-982 | 22 | `const groupByWorkspace = (list) => {` |
| `norm` | 963-963 | 1 | `const norm = (p) => String(p ?? "").replace(/\/+$/, "");` |
| `groupByArchiveWs` | 986-1001 | 16 | `const groupByArchiveWs = (list) => {` |
| `toggleCollapse` | 1005-1012 | 8 | `const toggleCollapse = (key) => {` |
| `renderRow` | 1014-1194 | 181 | `const renderRow = (session) => {` |
| `ensureSettingsCss` | 1635-1643 | 9 | `function ensureSettingsCss() {` |
| `trSettings` | 1645-1648 | 4 | `function trSettings(key) {` |
| `TemplateSlotCard` | 1651-1684 | 34 | `function TemplateSlotCard(props) {` |
| `TemplatePickerModal` | 1687-1718 | 32 | `function TemplatePickerModal(props) {` |
| `useTemplateFetch` | 1726-1748 | 23 | `function useTemplateFetch(st) {` |
| `useTemplateImports` | 1751-1800 | 50 | `function useTemplateImports(st, post) {` |
| `slotLabel` | 1752-1752 | 1 | `const slotLabel = (slot) => (slot === "plan" ? __SC_TR__("tpl.planShort") : __SC_TR__("tpl.closingShort"));` |
| `onPickFile` | 1753-1763 | 11 | `const onPickFile = (slot, event) => {` |
| `openImport` | 1764-1782 | 19 | `const openImport = (slot) => {` |
| `browseDir` | 1783-1791 | 9 | `const browseDir = (path) => {` |
| `importTemplate` | 1792-1798 | 7 | `const importTemplate = (slot, mode, value) => {` |
| `useTemplateMutations` | 1803-1841 | 39 | `function useTemplateMutations(st, post, slotLabel) {` |
| `toggle` | 1804-1810 | 7 | `const toggle = (slot, enabled) => {` |
| `toggleEnforce` | 1811-1817 | 7 | `const toggleEnforce = (enforce) => {` |
| `onEdit` | 1818-1823 | 6 | `const onEdit = (slot, el) => {` |
| `saveEdit` | 1824-1832 | 9 | `const saveEdit = (slot) => {` |
| `onRemove` | 1833-1839 | 7 | `const onRemove = (slot) => {` |
| `MainTemplateSection` | 1843-1884 | 42 | `function MainTemplateSection() {` |
| `AutoRenameModelSection` | 1891-1969 | 79 | `function AutoRenameModelSection() {` |
| `save` | 1916-1936 | 21 | `const save = async (next) => {` |
| `ConductorSettingsPage` | 1990-2004 | 15 | `function ConductorSettingsPage() {` |
| `apply` | 2006-2033 | 28 | `function apply(ctx) {` |
| `SessionGroupCard` | 2090-2133 | 44 | `function SessionGroupCard({ t }) {` |
| `load` | 2094-2098 | 5 | `const load = () => {` |
| `createIn` | 2100-2116 | 17 | `const createIn = async (workspaceId) => {` |
| `apply` | 2135-2148 | 14 | `function apply(ctx) {` |
| `activeUserText` | 2200-2215 | 16 | `function activeUserText(nodes) {` |
| `ProcessingBar` | 2217-2236 | 20 | `function ProcessingBar({ useSession, t }) {` |
| `apply` | 2238-2246 | 9 | `function apply(ctx) {` |
| `CompactionModelCard` | 2291-2349 | 59 | `function CompactionModelCard({ t }) {` |
| `save` | 2312-2327 | 16 | `const save = async () => {` |
| `apply` | 2351-2364 | 14 | `function apply(ctx) {` |
| `ScsPage` | 2416-2428 | 13 | `function ScsPage({ t }) {` |
| `apply` | 2430-2434 | 5 | `function apply(ctx) {` |

### lib/core.js（83 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `renderCompletionBlock` | 24-48 | 25 | `export function renderCompletionBlock(options = {}) {` |
| `checkCompletionText` | 56-78 | 23 | `export function checkCompletionText(text) {` |
| `hasText` | 80-82 | 3 | `function hasText(value) {` |

### lib/eio-repair.js（204 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `probeEioBoundary` | 39-62 | 24 | `export async function probeEioBoundary(filePath) {` |
| `scanEioSessions` | 70-99 | 30 | `export async function scanEioSessions(sessionsRoot, { fast = false } = {}) {` |
| `repairEioFile` | 108-158 | 51 | `export async function repairEioFile(filePath, { dryRun = false, backupDir } = {}) {` |
| `repairEioSessions` | 161-189 | 29 | `export async function repairEioSessions({ dryRun = false, fast = false } = {}) {` |
| `writeAll` | 192-199 | 8 | `function writeAll(fd, buffer) {` |
| `sessionsRootOf` | 202-204 | 3 | `export function sessionsRootOf() {` |

### lib/group.js（277 行 · 9 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `tryEnableAutoRename` | 40-45 | 6 | `function tryEnableAutoRename(hooks, sessionId) {` |
| `detectProfileName` | 47-55 | 9 | `function detectProfileName() {` |
| `detectHostPort` | 59-66 | 8 | `function detectHostPort() {` |
| `send` | 70-73 | 4 | `function send(res, code, obj) {` |
| `readJsonBody` | 75-86 | 12 | `async function readJsonBody(req, maxBytes = 1 << 20) {` |
| `wsView` | 88-97 | 10 | `function wsView(w) {` |
| `workspaceIdOfCwd` | 100-109 | 10 | `function workspaceIdOfCwd(registry, cwd) {` |
| `lastSessionCwd` | 112-136 | 25 | `async function lastSessionCwd(ctx) {` |
| `registerGroupRoutes` | 148-273 | 126 | `export async function registerGroupRoutes(ctx, config = {}, hooks = {}) {` |

### lib/index.js（4348 行 · 104 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `collectSessionTitleMessages` | 79-94 | 16 | `function collectSessionTitleMessages(events, throughSeq) {` |
| `hasApiRemoteSubagentOwner` | 98-110 | 13 | `function hasApiRemoteSubagentOwner(ctx, session, agent) {` |
| `resolveSessionPreset` | 114-122 | 9 | `function resolveSessionPreset({ header, events } = {}) {` |
| `lazyRepair` | 129-129 | 1 | `const lazyRepair = () => (_lazyRepair ??= import("./repair.js"));` |
| `lazyZstd` | 130-130 | 1 | `const lazyZstd = () => (_lazyZstd ??= import("./zstd-frames.js"));` |
| `lazySeqGap` | 131-131 | 1 | `const lazySeqGap = () => (_lazySeqGap ??= import("./seq-gap-repair.js"));` |
| `lazyEio` | 132-132 | 1 | `const lazyEio = () => (_lazyEio ??= import("./eio-repair.js"));` |
| `lazyValue` | 133-133 | 1 | `const lazyValue = () => (_lazyValue ??= import("./value.js"));` |
| `num` | 174-176 | 3 | `function num(v, min, max, dflt) {` |
| `send` | 271-274 | 4 | `function send(res, status, body) {` |
| `readJson` | 277-282 | 6 | `async function readJson(req) {` |
| `foldTitle` | 286-295 | 10 | `function foldTitle(events) {` |
| `workspaceNameOf` | 302-319 | 18 | `function workspaceNameOf(ctx, cwd) {` |
| `archiveTitleWithWs` | 322-328 | 7 | `function archiveTitleWithWs(title, ws) {` |
| `stripArchiveWsPrefix` | 331-336 | 6 | `function stripArchiveWsPrefix(title) {` |
| `hasOpenTurn` | 339-347 | 9 | `function hasOpenTurn(events) {` |
| `lastEventTime` | 350-353 | 4 | `function lastEventTime(events) {` |
| `titleString` | 359-363 | 5 | `function titleString(snapshot) {` |
| `sessionEventList` | 366-375 | 10 | `function sessionEventList(session) {` |
| `resolveSessionTitle` | 378-388 | 11 | `function resolveSessionTitle(sessionTitle, session, events) {` |
| `pluginDomain` | 398-426 | 29 | `function pluginDomain(ctx) {` |
| `pluginState` | 428-431 | 4 | `async function pluginState(ctx) {` |
| `installProcessGuards` | 441-455 | 15 | `function installProcessGuards(ctx) {` |
| `pluginConfigPath` | 467-470 | 4 | `function pluginConfigPath(ctx) {` |
| `readSwitch` | 473-476 | 4 | `function readSwitch(group, sessionId) {` |
| `patchSwitch` | 480-488 | 9 | `export async function patchSwitch(ctx, group, sessionId, patch, defaultEntry = {}) {` |
| `loadPluginConfig` | 491-505 | 15 | `export async function loadPluginConfig(ctx) {` |
| `savePluginConfig` | 508-524 | 17 | `export async function savePluginConfig(ctx) {` |
| `resetAutoContinueOnStart` | 527-535 | 9 | `export async function resetAutoContinueOnStart(ctx) {` |
| `autoRenameEnabled` | 538-540 | 3 | `function autoRenameEnabled(ctx, state, sessionId) {` |
| `effectiveAutoContinue` | 543-546 | 4 | `function effectiveAutoContinue(cfg, state, sessionId) {` |
| `scheduleAnalysis` | 554-565 | 12 | `function scheduleAnalysis(ctx, sessionId) {` |
| `runAnalysis` | 568-578 | 11 | `async function runAnalysis(ctx, sessionId, opts = {}) {` |
| `resolveModelOverride` | 585-610 | 26 | `export async function resolveModelOverride(ctx, modelArg, fallbackRoute) {` |
| `analyzeSession` | 619-697 | 79 | `async function analyzeSession(ctx, sessionId, opts = {}) {` |
| `resolveRoute` | 704-715 | 12 | `export function resolveRoute(session, llm, state) {` |
| `driftAnalysisLlm` | 731-788 | 58 | `export async function driftAnalysisLlm(llm, session, route, currentTitle, recent, onError, forceTitle = false) {` |
| `extractTitleOnly` | 791-804 | 14 | `function extractTitleOnly(raw) {` |
| `analyzeValueWithLlm` | 817-856 | 40 | `export async function analyzeValueWithLlm(ctx, sessions, texts, onError) {` |
| `parseValueJson` | 859-870 | 12 | `export function parseValueJson(raw) {` |
| `parseDriftJson` | 874-888 | 15 | `export function parseDriftJson(raw) {` |
| `interruptionInfo` | 897-936 | 40 | `export function interruptionInfo(events) {` |
| `isAutoEligible` | 950-956 | 7 | `export function isAutoEligible(info, { live = false } = {}) {` |
| `stateSuffixOf` | 963-968 | 6 | `export function stateSuffixOf(events) {` |
| `stripTitleStateSuffix` | 971-973 | 3 | `export function stripTitleStateSuffix(title) {` |
| `refreshTitleState` | 981-999 | 19 | `export async function refreshTitleState(ctx, session) {` |
| `autoContinueEffectiveForRun` | 1012-1015 | 4 | `export function autoContinueEffectiveForRun(cfg, state, sessionId) {` |
| `continueAllowed` | 1018-1031 | 14 | `function continueAllowed(cfg, state, sessionId, info) {` |
| `sessionEventsOf` | 1034-1044 | 11 | `async function sessionEventsOf(ctx, sessionId) {` |
| `readColdSessionEvents` | 1054-1067 | 14 | `async function readColdSessionEvents(ctx, sessionId) {` |
| `foldLastRoute` | 1070-1088 | 19 | `export function foldLastRoute(events) {` |
| `foldLastModelSelection` | 1096-1108 | 13 | `export function foldLastModelSelection(events) {` |
| `buildContinuePrompt` | 1111-1125 | 15 | `export function buildContinuePrompt(info) {` |
| `withDeleteLock` | 1136-1146 | 11 | `function withDeleteLock(sessionId, fn) {` |
| `cancelSessionTimers` | 1149-1161 | 13 | `function cancelSessionTimers(sessionId) {` |
| `withSessionLock` | 1164-1174 | 11 | `function withSessionLock(sessionId, fn) {` |
| `withConcurrencyGate` | 1177-1187 | 11 | `async function withConcurrencyGate(fn) {` |
| `continueSession` | 1196-1313 | 118 | `export async function continueSession(ctx, sessionId, { auto = false } = {}) {` |
| `waitTurn` | 1316-1335 | 20 | `async function waitTurn(ctx, agent) {` |
| `sendMessageToSession` | 1349-1401 | 53 | `export async function sendMessageToSession(ctx, sessionId, text, { fromSessionId = "" } = {}) {` |
| `defaultModelSelection` | 1404-1412 | 9 | `function defaultModelSelection(ctx) {` |
| `pickTeamCaller` | 1419-1440 | 22 | `function pickTeamCaller(ctx) {` |
| `memberStatusError` | 1454-1463 | 10 | `export function memberStatusError(member) {` |
| `validateModelPair` | 1473-1494 | 22 | `export async function validateModelPair(ctx, provider, model) {` |
| `findTargetAgent` | 1503-1564 | 62 | `export function findTargetAgent(ctx, target) {` |
| `waitForIdle` | 1573-1591 | 19 | `async function waitForIdle(agent, timeoutMs = 60000) {` |
| `isIdle` | 1574-1574 | 1 | `const isIdle = () => agent?.status !== "running" && !hasOpenTurn(agent?.session?.events);` |
| `getMemberModelOverride` | 1615-1632 | 18 | `export async function getMemberModelOverride(ctx, sessionId) {` |
| `applyModelOverride` | 1641-1646 | 6 | `export function applyModelOverride(resolved, override) {` |
| `appendSelectionEventToLog` | 1658-1711 | 54 | `async function appendSelectionEventToLog(ctx, sessionId, provider, model) {` |
| `switchAgentModel` | 1730-1796 | 67 | `export async function switchAgentModel(ctx, sessionId, provider, model, agent = null) {` |
| `resumeSetupFor` | 1807-1843 | 37 | `async function resumeSetupFor(ctx, meta, events, route) {` |
| `maybeScheduleContinue` | 1846-1858 | 13 | `function maybeScheduleContinue(ctx, sessionId) {` |
| `runAutoContinueSession` | 1865-1889 | 25 | `async function runAutoContinueSession(ctx, sessionId, { force = false } = {}) {` |
| `runAutoScan` | 1892-1938 | 47 | `async function runAutoScan(ctx) {` |
| `scheduleScan` | 1940-1950 | 11 | `function scheduleScan(ctx) {` |
| `detachSessionAgent` | 1962-2028 | 67 | `export async function detachSessionAgent(ctx, sessionId) {` |
| `detachAllIdleSessions` | 2031-2056 | 26 | `export async function detachAllIdleSessions(ctx) {` |
| `listCacheFilePath` | 2086-2091 | 6 | `function listCacheFilePath(ctx) {` |
| `loadListDiskCache` | 2094-2108 | 15 | `function loadListDiskCache(ctx) {` |
| `scheduleSaveListDiskCache` | 2111-2119 | 9 | `function scheduleSaveListDiskCache(ctx) {` |
| `saveListDiskCacheNow` | 2122-2136 | 15 | `function saveListDiskCacheNow(ctx) {` |
| `buildColdSessionItem` | 2140-2163 | 24 | `function buildColdSessionItem(header, inspected, derived, ctx, storeState, archived) {` |
| `invalidateSessionListCache` | 2180-2183 | 4 | `function invalidateSessionListCache() {` |
| `buildSessionListCached` | 2190-2208 | 19 | `async function buildSessionListCached(ctx, { force = false, onItem = null, serial = false } = {}) {` |
| `buildSessionList` | 2214-2358 | 145 | `async function buildSessionList(ctx, opts = {}) { // dsh-skip-func-length` |
| `unarchiveSession` | 2367-2376 | 10 | `async function unarchiveSession(ctx, sessionId) {` |
| `deleteSession` | 2380-2448 | 69 | `export async function deleteSession(ctx, sessionId) {` |
| `undoLastMessage` | 2465-2573 | 109 | `export async function undoLastMessage(ctx, sessionId, { dryRun = false } = {}) {` |
| `collectSearchableEvents` | 2588-2625 | 38 | `export function collectSearchableEvents(events) {` |
| `searchEventsText` | 2631-2647 | 17 | `export function searchEventsText(events, query, { perSessionMax = SEARCH_PER_SESSION_MAX, previewLen = SEARCH_PREVIEW_LEN } = {}) {` |
| `searchSessions` | 2654-2685 | 32 | `export async function searchSessions(ctx, query, { scope = "all", maxSessions = SEARCH_MAX_SESSIONS, perSessionMax = SEARCH_PER_SESSION_MAX } = {}) {` |
| `deleteBatchSessions` | 2692-2733 | 42 | `export async function deleteBatchSessions(ctx, sessionIds) {` |
| `deleteByRule` | 2741-2797 | 57 | `export async function deleteByRule(ctx, { archivedOnly = false, inactiveDays = 0, cwdPrefix = "", lowValue = false, dryRun = false } = {}) {` |
| `resolveDshHome` | 2808-2812 | 5 | `function resolveDshHome(ctx, c) {` |
| `resolveBrowseRoot` | 2820-2827 | 8 | `function resolveBrowseRoot(ctx, c) {` |
| `__setConfigForTest` | 2830-2851 | 22 | `export function __setConfigForTest(partial = {}) {` |
| `__timersForTest` | 2854-2855 | 2 | `export function __timersForTest() {` |
| `__switchConfigForTest` | 2859-2861 | 3 | `export function __switchConfigForTest() {` |
| `__resetForTest` | 2864-2890 | 27 | `export function __resetForTest() {` |
| `apply` | 2903-4339 | 1437 | `export async function apply(ctx, config = {}) {` |
| `servePreview` | 3081-3094 | 14 | `const servePreview = async (req, res, name) => {` |
| `buildSlotsWithContent` | 3166-3178 | 13 | `const buildSlotsWithContent = (meta2) => {` |
| `log` | 4341-4347 | 7 | `function log(ctx, message) {` |

### lib/repair.js（399 行 · 12 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `parseLineEvents` | 21-28 | 8 | `export function parseLineEvents(line) {` |
| `validateSessionText` | 35-93 | 59 | `export function validateSessionText(text) {` |
| `fixToolResultStringContent` | 100-135 | 36 | `export function fixToolResultStringContent(text) {` |
| `encodeSessionText` | 138-149 | 12 | `export async function encodeSessionText(text) {` |
| `repairCorruptSessions` | 157-242 | 86 | `export async function repairCorruptSessions(ctx, { dryRun = false } = {}) {` |
| `scanCorruptSessions` | 245-247 | 3 | `export async function scanCorruptSessions(ctx) {` |
| `supportsRepair` | 250-253 | 4 | `export function supportsRepair(ctx) {` |
| `sessionsRootOf` | 260-263 | 4 | `function sessionsRootOf() {` |
| `scanCorruptFrames` | 269-271 | 3 | `export async function scanCorruptFrames() {` |
| `repairCorruptFrames` | 278-305 | 28 | `export async function repairCorruptFrames({ dryRun = false } = {}) {` |
| `scanDualFormatSessions` | 320-350 | 31 | `export async function scanDualFormatSessions() {` |
| `repairDualFormatSessions` | 358-398 | 41 | `export async function repairDualFormatSessions({ dryRun = false, skipIds = [] } = {}) {` |

### lib/seq-gap-repair.js（223 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `loadSessionFile` | 24-40 | 17 | `async function loadSessionFile(path) {` |
| `detectSeqGap` | 43-50 | 8 | `export function detectSeqGap(events) {` |
| `foldFix` | 53-80 | 28 | `function foldFix(events, patch) {` |
| `verifyTokenSurface` | 83-103 | 21 | `function verifyTokenSurface(events) {` |
| `repairSeqGap` | 111-198 | 88 | `export async function repairSeqGap(path, { dryRun = false, backupDir } = {}) {` |
| `scanSeqGapSessions` | 201-222 | 22 | `export async function scanSeqGapSessions(sessionsRoot) {` |

### lib/session-codec.js（38 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `decodeStorageRecord` | 19-28 | 10 | `export function decodeStorageRecord(record) {` |
| `packChunkRuns` | 35-37 | 3 | `export function packChunkRuns(events) {` |

### lib/session-log.js（47 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `findSessionLog` | 20-37 | 18 | `export function findSessionLog(sessionDir) {` |
| `isSessionLogName` | 44-46 | 3 | `export function isSessionLogName(name) {` |

### lib/template-inject.js（268 行 · 16 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `sanitizeForPrompt` | 42-44 | 3 | `function sanitizeForPrompt(text) {` |
| `templateRoot` | 47-49 | 3 | `export function templateRoot(dshHome) {` |
| `templateFile` | 51-53 | 3 | `function templateFile(dshHome, slot) {` |
| `validSlot` | 55-57 | 3 | `function validSlot(slot) {` |
| `saveTemplate` | 60-72 | 13 | `export async function saveTemplate(dshHome, slot, { name, content }) {` |
| `saveTemplateFromUrl` | 79-108 | 30 | `export async function saveTemplateFromUrl(dshHome, slot, url) {` |
| `removeTemplate` | 111-117 | 7 | `export async function removeTemplate(dshHome, slot) {` |
| `readTemplateSync` | 120-129 | 10 | `export function readTemplateSync(dshHome, slot) {` |
| `collectTemplateSlotText` | 135-148 | 14 | `export function collectTemplateSlotText(dshHome, slot, meta = TEMPLATE_DEFAULTS) {` |
| `collectTemplatesTextSync` | 150-159 | 10 | `export function collectTemplatesTextSync(dshHome, meta = TEMPLATE_DEFAULTS) {` |
| `listTemplateDir` | 166-189 | 24 | `export async function listTemplateDir(root, path) {` |
| `saveTemplateFromPath` | 198-216 | 19 | `export async function saveTemplateFromPath(browseRoot, slot, path, saveRoot) {` |
| `planEnforceDenyMessage` | 224-224 | 1 | `export const planEnforceDenyMessage = (toolName) =>` |
| `planGateMessageText` | 230-234 | 5 | `function planGateMessageText(ev) {` |
| `planGateIsInjectedUserText` | 237-239 | 3 | `function planGateIsInjectedUserText(text) {` |
| `planGateAllows` | 242-267 | 26 | `export function planGateAllows(events) {` |

### lib/value.js（393 行 · 12 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `lastAssistantText` | 25-58 | 34 | `export function lastAssistantText(events) {` |
| `classifySessionValue` | 68-81 | 14 | `export function classifySessionValue(s, lastText, now = new Date(), staleDays = 3) {` |
| `lastUserText` | 89-107 | 19 | `export function lastUserText(events) {` |
| `summarizeText` | 110-118 | 9 | `export function summarizeText(text, maxLen = 140) {` |
| `analyzeSessionValues` | 121-142 | 22 | `export function analyzeSessionValues(sessions, textsById, userTextsById, now = new Date(), staleDays = 3) {` |
| `mapValuePriority` | 154-168 | 15 | `export function mapValuePriority(status, llmValue = null, llmReason = "") {` |
| `analyzeSessionValuesWithPriority` | 180-199 | 20 | `export function analyzeSessionValuesWithPriority(sessions, textsById, userTextsById, llmById = {}, now = new Date(), staleDays = 3) {` |
| `assessValue` | 219-248 | 30 | `export function assessValue(f = {}) {` |
| `buildValueFeatures` | 257-294 | 38 | `export function buildValueFeatures(events, session, now = new Date()) {` |
| `keywordMatch` | 303-309 | 7 | `export function keywordMatch(title, lastUserText, keywords) {` |
| `analyzeValuesWithKeywords` | 323-361 | 39 | `export function analyzeValuesWithKeywords(sessions, textsById, userTextsById, featuresById = {}, keywords = [], llmById = {}, now = new Date(), staleDays = 3) {` |
| `filterSessionsByKeywords` | 373-392 | 20 | `export function filterSessionsByKeywords(sessions, textsById, userTextsById, keywords, now = new Date()) {` |

### lib/zstd-frames.js（178 行 · 6 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `scanZstdFrames` | 20-50 | 31 | `export function scanZstdFrames(buffer) {` |
| `decodeFrame` | 53-61 | 9 | `export function decodeFrame(buf) {` |
| `decodeAllFrames` | 64-69 | 6 | `export async function decodeAllFrames(buf) {` |
| `validateHeaderFrame` | 75-107 | 33 | `export function validateHeaderFrame(buf) {` |
| `fixZstdFile` | 115-149 | 35 | `export async function fixZstdFile(path, backupDir = join(dirname(path), '.zstd-fix-backup')) {` |
| `scanAllCorruptFrames` | 156-177 | 22 | `export async function scanAllCorruptFrames(sessionsRoot) {` |

### test/unit/test-archive-ws-prefix.mjs（39 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `archiveTitleWithWs` | 6-12 | 7 | `function archiveTitleWithWs(title, ws) {` |
| `stripArchiveWsPrefix` | 13-18 | 6 | `function stripArchiveWsPrefix(title) {` |
| `check` | 21-25 | 5 | `function check(desc, actual, expected) {` |

### test/unit/test-auto-continue.mjs（346 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `interruptedEvents` | 35-35 | 1 | `const interruptedEvents = () => [` |
| `completedEvents` | 41-41 | 1 | `const completedEvents = () => [` |
| `makeDomain` | 47-56 | 10 | `function makeDomain() {` |
| `makeCtx` | 58-106 | 49 | `function makeCtx({ events = interruptedEvents(), live = null, agent = null, agentsList = [], resumeHandler, domain = null, settings = {} } = {}) {` |

### test/unit/test-auto-rename.mjs（256 行 · 3 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `fakeLlm` | 46-52 | 7 | `function fakeLlm(chunks) {` |
| `textChunks` | 54-62 | 9 | `function textChunks(fullText) {` |
| `onError` | 68-68 | 1 | `const onError = (message) => errors.push(message);` |

### test/unit/test-delete-session.mjs（177 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `tick` | 15-15 | 1 | `const tick = () => new Promise((r) => setTimeout(r, 5));` |
| `interruptedEvents` | 19-19 | 1 | `const interruptedEvents = () => [` |
| `makeDomain` | 27-34 | 8 | `function makeDomain(seed = {}) {` |
| `makeCtx` | 36-92 | 57 | `function makeCtx({ events = interruptedEvents(), live = null, domain = null, persistenceOverrides = {}, agentsOverrides = {} } = {}) {` |

### test/unit/test-detach.mjs（151 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeAgent` | 14-23 | 10 | `function makeAgent({ running = false, scopeDispose = async () => {} } = {}) {` |
| `makeCtx` | 25-60 | 36 | `function makeCtx({ sessions = [], agentsById = {}, subagentOrigin = false } = {}) {` |

### test/unit/test-group.mjs（179 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeCtx` | 33-47 | 15 | `function makeCtx({ sessions = [], cold = [] } = {}) {` |
| `makeApp` | 50-75 | 26 | `async function makeApp(extraCtx = {}, hooks = {}) {` |
| `callApi` | 78-100 | 23 | `async function callApi(handler, method, path, body, mockFetch) {` |
| `check` | 103-106 | 4 | `function check(name, cond, detail = "") {` |

### test/unit/test-interruption.mjs（53 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `check` | 7-8 | 2 | `function check(name, cond) { if (cond) pass++; else { fail++; console.log("FAIL:", name); } }` |

### test/unit/test-list-cache.mjs（259 行 · 4 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeTmpHome` | 22-27 | 6 | `function makeTmpHome() {` |
| `interruptedEvents` | 30-36 | 7 | `function interruptedEvents() {` |
| `titledEvents` | 39-45 | 7 | `function titledEvents(title) {` |
| `makeCtx` | 51-87 | 37 | `function makeCtx({ snapshots, eventsById = {}, inspectFails = new Set() }) {` |

### test/unit/test-member-model.mjs（288 行 · 2 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `agent` | 18-26 | 9 | `const agent = (id, title) => {` |
| `makeCtx` | 28-64 | 37 | `function makeCtx({ agents = [], titles = {}, catalog = null, selectModel = null, teamMembers = null, persistenceArtifacts = null } = {}) {` |

### test/unit/test-search-delete.mjs（272 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeCtx` | 24-83 | 60 | `function makeCtx({ sessions = [] } = {}) {` |

### test/unit/test-template-inject.mjs（260 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ok` | 38-41 | 4 | `async function ok(name, fn) {` |

### test/unit/test-undo.mjs（168 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `makeCtx` | 42-52 | 11 | `function makeCtx({ openTurn = false, artifacts = [] } = {}) {` |

### test/unit/test-value.mjs（206 行 · 1 个函数）

| 函数 | 行号 | 行数 | 签名 |
|------|------|------|------|
| `ok` | 19-22 | 4 | `function ok(name, fn) {` |

<!-- dshgp-functions:end -->
