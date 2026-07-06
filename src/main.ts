import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import './styles.css';

type Theme = 'system' | 'dark' | 'light';
type ToastType = 'success' | 'error';

interface AppConfig {
  skillDir: string;
  shortcut: string;
  theme: Theme;
  fuzzySearch: boolean;
  maxResults: number;
}

interface SkillResult {
  id: string;
  folderPath: string;
  skillMdPath: string;
  name: string;
  shortDesc: string;
  usageCount: number;
  globalUsageCount: number;
}

interface SearchResponse {
  results: SkillResult[];
  totalSkills: number;
  recentQueries: string[];
}

interface BootstrapState extends SearchResponse {
  config: AppConfig;
}

interface AppState {
  config: AppConfig | null;
  settingsDraft: AppConfig | null;
  totalSkills: number;
  recentQueries: string[];
  results: SkillResult[];
  query: string;
  selectedIndex: number;
  settingsOpen: boolean;
  error: string | null;
  searchRequestId: number;
}

const state: AppState = {
  config: null,
  settingsDraft: null,
  totalSkills: 0,
  recentQueries: [],
  results: [],
  query: '',
  selectedIndex: 0,
  settingsOpen: false,
  error: null,
  searchRequestId: 0,
};

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

root.innerHTML = `
  <main class="skillquick-shell relative flex h-full flex-col rounded-3xl border border-white/10 p-4">
    <div id="toast" class="pointer-events-none absolute left-1/2 top-4 z-40 hidden max-w-[520px] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm shadow-2xl"></div>
    <section id="settingsPanel" class="skillquick-settings-panel absolute inset-0 z-30 hidden bg-slate-950/82 p-5 backdrop-blur-xl"></section>

    <div class="skillquick-search-box flex items-center gap-3 rounded-2xl bg-white/[0.075] px-4 py-3 ring-1 ring-white/10">
      <span class="skillquick-search-icon text-xl text-slate-300" aria-hidden="true">⌕</span>
      <input
        id="searchInput"
        class="min-w-0 flex-1 bg-transparent text-[19px] font-medium text-white outline-none placeholder:text-slate-500"
        autocomplete="off"
        spellcheck="false"
        placeholder="搜索技能名称或描述..."
      />
    </div>

    <div id="errorBox" class="mt-3 hidden rounded-xl border border-red-400/25 bg-red-500/12 px-3 py-2 text-sm text-red-100"></div>
    <div id="recentRow" class="skillquick-recent-row mt-3 hidden items-center gap-2 overflow-hidden"></div>
    <div id="listHeader" class="skillquick-list-header mb-2 mt-3 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-500"></div>
    <div id="resultsList" class="min-h-0 flex-1 overflow-y-auto pr-1"></div>

    <footer class="skillquick-footer mt-3 flex items-center justify-between border-t border-white/10 pt-3 text-xs text-slate-500">
      <span id="totalSkills">共 0 个技能</span>
      <span id="shortcutText">快捷键：CommandOrControl+Shift+S</span>
      <button id="settingsButton" type="button" class="skillquick-footer-button rounded-lg px-2 py-1 text-slate-400 hover:bg-white/10 hover:text-white">
        ⚙ 设置
      </button>
    </footer>
  </main>
`;

const searchInput = getElement<HTMLInputElement>('searchInput');
const toastBox = getElement<HTMLDivElement>('toast');
const settingsPanel = getElement<HTMLElement>('settingsPanel');
const errorBox = getElement<HTMLDivElement>('errorBox');
const recentRow = getElement<HTMLDivElement>('recentRow');
const listHeader = getElement<HTMLDivElement>('listHeader');
const resultsList = getElement<HTMLDivElement>('resultsList');
const totalSkills = getElement<HTMLSpanElement>('totalSkills');
const shortcutText = getElement<HTMLSpanElement>('shortcutText');
const settingsButton = getElement<HTMLButtonElement>('settingsButton');
const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

let searchTimer: number | undefined;
let toastTimer: number | undefined;
let closeTimer: number | undefined;
let unlisteners: UnlistenFn[] = [];

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  state.selectedIndex = 0;
  scheduleSearch();
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void hideAndReset();
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    state.selectedIndex = Math.min(state.selectedIndex + 1, Math.max(0, state.results.length - 1));
    renderResults();
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    renderResults();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    const selected = state.results[state.selectedIndex];
    if (selected) {
      void selectSkill(selected);
    }
  }
});

settingsButton.addEventListener('click', () => {
  openSettings();
});

recentRow.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-query]');
  if (!button) return;
  state.query = button.dataset.query ?? '';
  searchInput.value = state.query;
  state.selectedIndex = 0;
  void performSearch();
  searchInput.focus();
});

resultsList.addEventListener('mouseover', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-skill-index]');
  if (!item) return;
  state.selectedIndex = Number(item.dataset.skillIndex ?? 0);
  renderResults();
});

resultsList.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-skill-index]');
  if (!item) return;
  const skill = state.results[Number(item.dataset.skillIndex ?? -1)];
  if (skill) {
    void selectSkill(skill);
  }
});

settingsPanel.addEventListener('input', (event) => {
  updateSettingsDraft(event.target);
});

settingsPanel.addEventListener('change', (event) => {
  updateSettingsDraft(event.target);
});

settingsPanel.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'close-settings') closeSettings();
  if (action === 'choose-directory') void chooseDirectory();
  if (action === 'save-settings') void saveSettings();
  if (action === 'rescan') void rescanSkills();
  if (action === 'clear-history') void clearHistory();
  if (action === 'open-directory') void openSkillDirectory();
});

mediaQuery.addEventListener('change', () => {
  if (state.config?.theme === 'system') {
    applyTheme(state.config);
  }
});

void bootstrap();

async function bootstrap() {
  renderLoading();
  try {
    const boot = await invoke<BootstrapState>('bootstrap');
    applyBootstrap(boot);
    await attachTauriListeners();
    searchInput.focus();
  } catch (error) {
    state.error = formatError(error);
    renderAll();
  }
}

async function attachTauriListeners() {
  for (const unlisten of unlisteners) {
    unlisten();
  }
  unlisteners = [];

  unlisteners.push(await listen('skillquick://focus-search', () => {
    closeSettings();
    window.setTimeout(() => {
      searchInput.focus();
      searchInput.select();
    }, 25);
  }));

  unlisteners.push(await listen('skillquick://skills-changed', () => {
    void rescanSkills(false);
  }));

  unlisteners.push(await getCurrentWindow().onFocusChanged(({ payload }) => {
    if (!payload && !state.settingsOpen) {
      void hideAndReset();
    }
  }));
}

function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    void performSearch();
  }, 120);
}

async function performSearch() {
  const requestId = ++state.searchRequestId;
  const query = state.query;
  try {
    const response = await invoke<SearchResponse>('search_skills', { query });
    if (requestId !== state.searchRequestId) return;
    applySearchResponse(response);
    state.error = null;
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.error = formatError(error);
    renderAll();
  }
}

async function selectSkill(skill: SkillResult) {
  try {
    await invoke<string>('select_skill', {
      request: {
        query: state.query,
        skillMdPath: skill.skillMdPath,
      },
    });
    showToast(`已复制：${skill.skillMdPath}`, 'success');
    await performSearch();

    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      void hideAndReset();
    }, 1500);
  } catch (error) {
    showToast(`复制失败：${formatError(error)}`, 'error', 2600);
  }
}

async function hideAndReset() {
  window.clearTimeout(closeTimer);
  try {
    await invoke('hide_search_window');
  } catch {
    // The window may already be hidden during startup or app shutdown.
  }
  state.query = '';
  state.selectedIndex = 0;
  state.settingsOpen = false;
  state.settingsDraft = null;
  searchInput.value = '';
  renderAll();
  void performSearch();
}

function openSettings() {
  if (!state.config) return;
  state.settingsOpen = true;
  state.settingsDraft = { ...state.config };
  renderSettings();
}

function closeSettings() {
  state.settingsOpen = false;
  state.settingsDraft = null;
  settingsPanel.classList.add('hidden');
}

async function chooseDirectory() {
  if (!state.settingsDraft) return;
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: state.settingsDraft.skillDir,
    title: '选择 skill-manage 目录',
  });

  if (typeof selected === 'string') {
    state.settingsDraft.skillDir = selected;
    renderSettings();
  }
}

async function saveSettings() {
  if (!state.settingsDraft) return;
  try {
    const boot = await invoke<BootstrapState>('update_config', {
      config: normalizeConfig(state.settingsDraft),
    });
    applyBootstrap(boot);
    closeSettings();
    showToast('设置已保存', 'success');
  } catch (error) {
    showToast(`保存失败：${formatError(error)}`, 'error', 2800);
  }
}

async function rescanSkills(showSuccess = true) {
  try {
    const response = await invoke<SearchResponse>('rescan');
    applySearchResponse(response);
    if (state.query) {
      await performSearch();
    }
    if (showSuccess) {
      showToast('已重新扫描技能目录', 'success');
    }
  } catch (error) {
    showToast(`重新扫描失败：${formatError(error)}`, 'error', 2800);
  }
}

async function clearHistory() {
  try {
    await invoke('clear_history');
    await performSearch();
    showToast('历史记录已清除', 'success');
  } catch (error) {
    showToast(`清除失败：${formatError(error)}`, 'error', 2600);
  }
}

async function openSkillDirectory() {
  const path = state.settingsDraft?.skillDir ?? state.config?.skillDir;
  if (!path) return;
  try {
    await invoke('open_path', { path });
  } catch (error) {
    showToast(`打开目录失败：${formatError(error)}`, 'error', 2600);
  }
}

function updateSettingsDraft(target: EventTarget | null) {
  if (!state.settingsDraft || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }

  const field = target.name as keyof AppConfig;
  if (!field) return;

  if (field === 'fuzzySearch' && target instanceof HTMLInputElement) {
    state.settingsDraft.fuzzySearch = target.checked;
    return;
  }

  if (field === 'maxResults') {
    state.settingsDraft.maxResults = Number(target.value) || 30;
    return;
  }

  state.settingsDraft = {
    ...state.settingsDraft,
    [field]: target.value,
  };
}

function applyBootstrap(boot: BootstrapState) {
  state.config = boot.config;
  state.totalSkills = boot.totalSkills;
  state.recentQueries = boot.recentQueries;
  state.results = boot.results;
  state.selectedIndex = 0;
  state.error = null;
  applyTheme(boot.config);
  renderAll();
}

function applySearchResponse(response: SearchResponse) {
  state.totalSkills = response.totalSkills;
  state.recentQueries = response.recentQueries;
  state.results = response.results;
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, response.results.length - 1));
  renderAll();
}

function normalizeConfig(config: AppConfig): AppConfig {
  return {
    skillDir: config.skillDir.trim(),
    shortcut: config.shortcut.trim() || 'CommandOrControl+Shift+S',
    theme: ['system', 'dark', 'light'].includes(config.theme) ? config.theme : 'system',
    fuzzySearch: Boolean(config.fuzzySearch),
    maxResults: Math.min(50, Math.max(5, Number(config.maxResults) || 30)),
  };
}

function applyTheme(config: AppConfig) {
  const isLight = config.theme === 'light' || (config.theme === 'system' && mediaQuery.matches);
  document.documentElement.classList.toggle('light', isLight);
}

function renderLoading() {
  resultsList.innerHTML = `
    <div class="flex h-full items-center justify-center rounded-2xl border border-white/10 text-sm text-slate-400">
      正在启动 SkillQuick...
    </div>
  `;
}

function renderAll() {
  searchInput.value = state.query;
  renderError();
  renderRecentQueries();
  renderHeader();
  renderResults();
  renderFooter();
  if (state.settingsOpen) {
    renderSettings();
  }
}

function renderError() {
  if (!state.error) {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
    return;
  }
  errorBox.textContent = state.error;
  errorBox.classList.remove('hidden');
}

function renderRecentQueries() {
  if (state.query.trim() || state.recentQueries.length === 0) {
    recentRow.classList.add('hidden');
    recentRow.innerHTML = '';
    return;
  }

  recentRow.classList.remove('hidden');
  recentRow.classList.add('flex');
  recentRow.innerHTML = `
    <span class="shrink-0 text-xs text-slate-500">最近搜索</span>
    ${state.recentQueries.slice(0, 6).map((query) => `
      <button type="button" data-query="${escapeAttr(query)}" class="skillquick-query-chip rounded-full bg-white/8 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/12 hover:text-white">
        ${escapeHtml(query)}
      </button>
    `).join('')}
  `;
}

function renderHeader() {
  listHeader.innerHTML = state.query.trim()
    ? `<span aria-hidden="true">⌁</span><span>搜索结果</span>`
    : `<span aria-hidden="true">✦</span><span>热门技能</span>`;
}

function renderResults() {
  if (state.results.length === 0) {
    resultsList.innerHTML = `
      <div class="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
        未找到匹配的 skill
      </div>
    `;
    return;
  }

  resultsList.innerHTML = `
    <div class="space-y-2">
      ${state.results.map((skill, index) => renderSkillItem(skill, index)).join('')}
    </div>
  `;

  const selected = resultsList.querySelector<HTMLElement>(`[data-skill-index="${state.selectedIndex}"]`);
  selected?.scrollIntoView({ block: 'nearest' });
}

function renderSkillItem(skill: SkillResult, index: number) {
  const active = index === state.selectedIndex;
  const activeClass = active
    ? 'border-blue-300/45 bg-blue-400/16 shadow-lg shadow-blue-950/20'
    : 'border-white/8 bg-white/[0.045] hover:border-white/14 hover:bg-white/[0.075]';
  const query = state.query.trim();
  const usage = skill.usageCount > 0
    ? `<span class="rounded-full bg-emerald-400/16 px-2 py-0.5 text-[11px] text-emerald-100">已选 ${skill.usageCount} 次</span>`
    : skill.globalUsageCount > 0 && !query
      ? `<span class="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">全局 ${skill.globalUsageCount} 次</span>`
      : '';

  return `
    <button type="button" data-skill-index="${index}" class="skillquick-result-item ${active ? 'is-active' : ''} block w-full rounded-2xl border px-3.5 py-3 text-left transition ${activeClass}">
      <div class="flex items-center justify-between gap-3">
        <div class="skillquick-result-title min-w-0 truncate text-[15px] font-semibold text-white">${highlight(skill.name, query)}</div>
        ${usage}
      </div>
      <p class="skillquick-result-desc mt-1 line-clamp-2 text-sm leading-5 text-slate-400">${highlight(skill.shortDesc || '无描述', query)}</p>
      <p class="skillquick-result-path mt-2 truncate font-mono text-[11px] text-slate-600">${escapeHtml(skill.skillMdPath)}</p>
    </button>
  `;
}

function renderFooter() {
  totalSkills.textContent = `共 ${state.totalSkills} 个技能`;
  shortcutText.textContent = `快捷键：${state.config?.shortcut ?? 'CommandOrControl+Shift+S'}`;
}

function renderSettings() {
  const config = state.settingsDraft;
  if (!config) return;

  settingsPanel.classList.remove('hidden');
  settingsPanel.innerHTML = `
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold text-white">设置</h2>
        <p class="text-xs text-slate-400">配置技能目录、快捷键和搜索行为。修改后点击保存才会重新扫描。</p>
      </div>
      <button type="button" data-action="close-settings" class="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="关闭设置">×</button>
    </div>

    <div class="mt-5 space-y-4">
      <label class="block">
        <span class="text-sm font-medium text-slate-200">skill-manage 目录</span>
        <div class="mt-2 flex gap-2">
          <input name="skillDir" value="${escapeAttr(config.skillDir)}" class="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/8 px-3 py-2 font-mono text-xs text-white outline-none focus:border-blue-300/60" />
          <button type="button" data-action="choose-directory" class="rounded-lg bg-white/10 px-3 text-sm text-white hover:bg-white/15">选择</button>
        </div>
      </label>

      <label class="block">
        <span class="text-sm font-medium text-slate-200">全局快捷键</span>
        <input name="shortcut" value="${escapeAttr(config.shortcut)}" placeholder="CommandOrControl+Shift+S" class="mt-2 w-full rounded-lg border border-white/10 bg-white/8 px-3 py-2 font-mono text-sm text-white outline-none focus:border-blue-300/60" />
        <p class="mt-1 text-xs text-slate-500">格式示例：CommandOrControl+Shift+S。保存后会重新注册。</p>
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="text-sm font-medium text-slate-200">主题</span>
          <select name="theme" class="mt-2 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none">
            <option value="system" ${config.theme === 'system' ? 'selected' : ''}>跟随系统</option>
            <option value="dark" ${config.theme === 'dark' ? 'selected' : ''}>深色</option>
            <option value="light" ${config.theme === 'light' ? 'selected' : ''}>浅色</option>
          </select>
        </label>

        <label class="block">
          <span class="text-sm font-medium text-slate-200">最大结果数</span>
          <input name="maxResults" type="number" min="5" max="50" value="${config.maxResults}" class="mt-2 w-full rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm text-white outline-none" />
        </label>
      </div>

      <label class="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.045] px-3 py-2">
        <span class="text-sm text-slate-200">启用模糊搜索</span>
        <input name="fuzzySearch" type="checkbox" ${config.fuzzySearch ? 'checked' : ''} class="h-4 w-4 accent-blue-400" />
      </label>

      <div class="grid grid-cols-3 gap-2 pt-2">
        <button type="button" data-action="rescan" class="rounded-lg bg-blue-500/18 px-3 py-2 text-sm text-blue-100 hover:bg-blue-500/26">重新扫描</button>
        <button type="button" data-action="clear-history" class="rounded-lg bg-red-500/16 px-3 py-2 text-sm text-red-100 hover:bg-red-500/24">清除历史</button>
        <button type="button" data-action="open-directory" class="rounded-lg bg-white/10 px-3 py-2 text-sm text-white hover:bg-white/15">打开目录</button>
      </div>

      <button type="button" data-action="save-settings" class="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-400">
        保存设置
      </button>
    </div>
  `;
}

function showToast(text: string, type: ToastType, duration = 1500) {
  window.clearTimeout(toastTimer);
  toastBox.textContent = text;
  toastBox.className = [
    'absolute left-1/2 top-4 z-40 flex max-w-[520px] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm shadow-2xl',
    type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white',
  ].join(' ');
  toastTimer = window.setTimeout(() => {
    toastBox.classList.add('hidden');
    toastBox.textContent = '';
  }, duration);
}

function highlight(value: string, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return escapeHtml(value);
  }

  const lower = value.toLowerCase();
  const index = lower.indexOf(normalized);
  if (index < 0) {
    return escapeHtml(value);
  }

  const end = index + normalized.length;
  return [
    escapeHtml(value.slice(0, index)),
    '<mark>',
    escapeHtml(value.slice(index, end)),
    '</mark>',
    escapeHtml(value.slice(end)),
  ].join('');
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value: string) {
  return escapeHtml(value);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
