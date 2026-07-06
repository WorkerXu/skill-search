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

interface SkillPreset {
  id: string;
  name: string;
  icon: string;
  skillCount: number;
}

interface SearchResponse {
  results: SkillResult[];
  totalSkills: number;
  allSkillCount: number;
  recentQueries: string[];
  presets: SkillPreset[];
}

interface BootstrapState extends SearchResponse {
  config: AppConfig;
}

interface AppState {
  config: AppConfig | null;
  settingsDraft: AppConfig | null;
  totalSkills: number;
  allSkillCount: number;
  presets: SkillPreset[];
  selectedPresetId: string | null;
  recentQueries: string[];
  results: SkillResult[];
  query: string;
  selectedIndex: number;
  settingsOpen: boolean;
  error: string | null;
  searchRequestId: number;
  copiedPath: string | null;
  presetMenuOpen: boolean;
}

const state: AppState = {
  config: null,
  settingsDraft: null,
  totalSkills: 0,
  allSkillCount: 0,
  presets: [],
  selectedPresetId: null,
  recentQueries: [],
  results: [],
  query: '',
  selectedIndex: 0,
  settingsOpen: false,
  error: null,
  searchRequestId: 0,
  copiedPath: null,
  presetMenuOpen: false,
};

const appWindow = getCurrentWindow();
const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

root.innerHTML = `
  <main id="appShell" data-tauri-drag-region="deep" class="skillquick-shell relative flex h-full select-none flex-col overflow-hidden rounded-[24px] border p-4">
    <div id="toast" class="skillquick-toast pointer-events-none absolute left-1/2 top-4 z-40 hidden max-w-[560px] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm"></div>
    <section id="settingsPanel" class="skillquick-settings-panel absolute inset-0 z-30 hidden p-5"></section>

    <div class="skillquick-search-box flex h-[58px] items-center gap-3 rounded-2xl px-5">
      <button id="presetButton" type="button" class="skillquick-preset-button hidden shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5" aria-haspopup="listbox" aria-expanded="false">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9.5 7.5V6.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2v1.3M5.5 8h13A2.5 2.5 0 0 1 21 10.5v6A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-6A2.5 2.5 0 0 1 5.5 8Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3 12.5h18M9.5 13.5h5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
        <span id="presetButtonText" class="max-w-[260px] truncate">全部技能</span>
        <svg class="skillquick-preset-chevron h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div id="presetDivider" class="skillquick-search-divider hidden h-7 w-px shrink-0"></div>
      <svg class="skillquick-search-icon h-[19px] w-[19px] shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m21 21-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <input
        id="searchInput"
        class="skillquick-search-input min-w-0 flex-1 bg-transparent text-[17px] font-semibold outline-none"
        autocomplete="off"
        spellcheck="false"
        placeholder="搜索技能名称或描述..."
      />
      <div id="presetMenu" class="skillquick-preset-menu absolute left-5 top-[calc(100%+10px)] z-50 hidden w-[360px] rounded-2xl border p-2" role="listbox"></div>
    </div>

    <div id="errorBox" class="skillquick-error mt-3 hidden rounded-xl px-3 py-2 text-sm"></div>
    <div id="recentRow" class="skillquick-recent-row mt-4 hidden items-center gap-3 overflow-hidden px-1"></div>
    <div id="listHeader" class="skillquick-list-header mb-3 mt-5 flex items-center gap-3 px-1 text-xs font-semibold uppercase tracking-[0.18em]"></div>
    <div id="resultsList" class="skillquick-results min-h-0 flex-1 overflow-y-auto pr-1"></div>

    <footer class="skillquick-footer mt-4 flex h-10 items-center justify-between gap-3 border-t px-1 pt-3 text-xs">
      <span id="totalSkills" class="skillquick-footer-count">共 0 个技能</span>
      <span id="shortcutText" class="skillquick-shortcut ml-auto"></span>
      <button id="settingsButton" type="button" class="skillquick-footer-button flex items-center gap-1.5 rounded-xl px-2.5 py-1.5" aria-label="打开设置">
        <svg class="h-4 w-4 transition-transform duration-200" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" stroke="currentColor" stroke-width="1.7"/>
          <path d="M19.14 13.5a7.8 7.8 0 0 0 .06-1.5l2.02-1.54-1.9-3.3-2.38.95a7.77 7.77 0 0 0-1.3-.75L15.3 4.8h-3.8l-.36 2.56c-.46.2-.9.45-1.3.75l-2.38-.95-1.9 3.3L7.58 12a7.8 7.8 0 0 0 .06 1.5l-2.08 1.6 1.9 3.3 2.45-.98c.38.27.8.5 1.23.68l.36 2.6h3.8l.36-2.6c.44-.18.85-.41 1.23-.68l2.45.98 1.9-3.3-2.08-1.6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        </svg>
        <span>设置</span>
      </button>
    </footer>
  </main>
`;

const searchInput = getElement<HTMLInputElement>('searchInput');
const toastBox = getElement<HTMLDivElement>('toast');
const settingsPanel = getElement<HTMLElement>('settingsPanel');
const appShell = getElement<HTMLElement>('appShell');
const errorBox = getElement<HTMLDivElement>('errorBox');
const presetButton = getElement<HTMLButtonElement>('presetButton');
const presetButtonText = getElement<HTMLSpanElement>('presetButtonText');
const presetDivider = getElement<HTMLDivElement>('presetDivider');
const presetMenu = getElement<HTMLDivElement>('presetMenu');
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
let dragCandidate: { x: number; y: number; target: HTMLElement } | null = null;
let suppressNextClick = false;

appShell.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('#presetButton, #presetMenu')) {
    closePresetMenu();
  }

  if (event.button !== 0 || !canStartWindowDrag(event.target)) return;

  if (target.closest('[data-skill-index]')) {
    dragCandidate = { x: event.clientX, y: event.clientY, target };
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void startWindowDrag();
});

appShell.addEventListener('mousemove', (event) => {
  if (!dragCandidate || event.buttons !== 1) return;
  const distance = Math.hypot(event.clientX - dragCandidate.x, event.clientY - dragCandidate.y);
  if (distance < 6) return;

  event.preventDefault();
  suppressNextClick = true;
  dragCandidate = null;
  void startWindowDrag();
});

appShell.addEventListener('mouseup', () => {
  dragCandidate = null;
});

appShell.addEventListener('click', (event) => {
  if (!suppressNextClick) return;
  suppressNextClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener('blur', () => {
  dragCandidate = null;
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  state.selectedIndex = 0;
  scheduleSearch();
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (state.presetMenuOpen) {
      closePresetMenu();
      return;
    }
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

presetButton.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  togglePresetMenu();
});

presetMenu.addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLElement>('[data-preset-id]');
  if (!item) return;
  const presetId = item.dataset.presetId === '__all__' ? null : item.dataset.presetId ?? null;
  void setSelectedPreset(presetId);
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

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    togglePresetMenu();
    return;
  }

  if (state.presetMenuOpen && event.key === 'Escape') {
    event.preventDefault();
    closePresetMenu();
    searchInput.focus();
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

mediaQuery.addEventListener('change', () => applyTheme());

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

  unlisteners.push(await appWindow.onFocusChanged(({ payload }) => {
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
    const response = await invoke<SearchResponse>('search_skills', {
      query,
      presetId: state.selectedPresetId,
    });
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
    state.copiedPath = skill.skillMdPath;
    renderResults();
    await invoke<string>('select_skill', {
      request: {
        query: state.query,
        skillMdPath: skill.skillMdPath,
      },
    });
    showToast(`已复制：${skill.skillMdPath}`, 'success', 500);

    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      void hideAndReset();
    }, 500);

    await performSearch();
  } catch (error) {
    state.copiedPath = null;
    renderResults();
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
  state.copiedPath = null;
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
    if (state.query || state.selectedPresetId) {
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
  state.allSkillCount = boot.allSkillCount;
  state.presets = boot.presets;
  ensureSelectedPreset();
  state.recentQueries = boot.recentQueries;
  state.results = boot.results;
  state.selectedIndex = 0;
  state.error = null;
  applyTheme(boot.config);
  renderAll();
  if (state.selectedPresetId) {
    void performSearch();
  }
}

function applySearchResponse(response: SearchResponse) {
  state.totalSkills = response.totalSkills;
  state.allSkillCount = response.allSkillCount;
  state.presets = response.presets;
  ensureSelectedPreset();
  state.recentQueries = response.recentQueries;
  state.results = response.results;
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, response.results.length - 1));
  renderAll();
}

async function setSelectedPreset(presetId: string | null) {
  state.selectedPresetId = presetId;
  state.selectedIndex = 0;
  state.presetMenuOpen = false;
  persistSelectedPreset();
  renderAll();
  await performSearch();
  searchInput.focus();
}

function ensureSelectedPreset() {
  if (state.presets.length === 0) {
    state.selectedPresetId = null;
    return;
  }

  if (state.selectedPresetId && hasPreset(state.selectedPresetId)) {
    return;
  }

  const savedPresetId = window.localStorage.getItem('skillquick:selectedPresetId');
  if (savedPresetId === '__all__') {
    state.selectedPresetId = null;
    return;
  }
  if (savedPresetId && hasPreset(savedPresetId)) {
    state.selectedPresetId = savedPresetId;
    return;
  }

  state.selectedPresetId = [...state.presets]
    .sort((a, b) => b.skillCount - a.skillCount || a.name.localeCompare(b.name))
    [0]?.id ?? null;
  persistSelectedPreset();
}

function hasPreset(presetId: string) {
  return state.presets.some((preset) => preset.id === presetId);
}

function persistSelectedPreset() {
  if (state.selectedPresetId) {
    window.localStorage.setItem('skillquick:selectedPresetId', state.selectedPresetId);
  } else {
    window.localStorage.setItem('skillquick:selectedPresetId', '__all__');
  }
}

function getSelectedPreset() {
  if (!state.selectedPresetId) return null;
  return state.presets.find((preset) => preset.id === state.selectedPresetId) ?? null;
}

function togglePresetMenu() {
  if (state.presets.length === 0) return;
  state.presetMenuOpen = !state.presetMenuOpen;
  renderPresetControl();
}

function closePresetMenu() {
  if (!state.presetMenuOpen) return;
  state.presetMenuOpen = false;
  renderPresetControl();
}

function normalizeConfig(config: AppConfig): AppConfig {
  return {
    skillDir: config.skillDir.trim(),
    shortcut: config.shortcut.trim() || 'CommandOrControl+Shift+S',
    theme: 'dark',
    fuzzySearch: Boolean(config.fuzzySearch),
    maxResults: Math.min(50, Math.max(5, Number(config.maxResults) || 30)),
  };
}

function applyTheme(_config?: AppConfig) {
  document.documentElement.classList.remove('light');
  document.documentElement.classList.add('dark');
}

function renderLoading() {
  resultsList.innerHTML = `
    <div class="skillquick-empty-state flex h-full flex-col items-center justify-center rounded-2xl text-center">
      <div class="skillquick-empty-icon mb-3">⌘</div>
      <div class="text-sm font-medium">正在启动 SkillQuick...</div>
      <p class="mt-1 text-xs">正在扫描本地技能目录</p>
    </div>
  `;
}

function renderAll() {
  searchInput.value = state.query;
  renderError();
  renderPresetControl();
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

function renderPresetControl() {
  if (state.presets.length === 0) {
    presetButton.classList.add('hidden');
    presetButton.classList.remove('flex');
    presetDivider.classList.add('hidden');
    presetMenu.classList.add('hidden');
    return;
  }

  const preset = getSelectedPreset();
  const label = preset
    ? `${preset.name} · ${preset.skillCount}`
    : `全部技能 · ${state.allSkillCount}`;
  presetButtonText.textContent = label;
  presetButton.classList.remove('hidden');
  presetButton.classList.add('flex');
  presetButton.classList.toggle('is-active', Boolean(preset));
  presetButton.setAttribute('aria-expanded', String(state.presetMenuOpen));
  presetDivider.classList.remove('hidden');

  if (!state.presetMenuOpen) {
    presetMenu.classList.add('hidden');
    presetMenu.innerHTML = '';
    return;
  }

  presetMenu.classList.remove('hidden');
  presetMenu.innerHTML = `
    ${renderPresetMenuItem(null, '全部技能', state.allSkillCount, 'layers')}
    <div class="skillquick-preset-menu-divider my-1"></div>
    ${state.presets.map((item) => renderPresetMenuItem(item.id, item.name, item.skillCount, item.icon)).join('')}
  `;
}

function renderPresetMenuItem(
  presetId: string | null,
  name: string,
  skillCount: number,
  icon: string,
) {
  const active = presetId === state.selectedPresetId || (!presetId && !state.selectedPresetId);
  return `
    <button type="button" data-preset-id="${escapeAttr(presetId ?? '__all__')}" class="skillquick-preset-menu-item ${active ? 'is-active' : ''} flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left">
      <span class="skillquick-preset-menu-icon">${renderPresetIcon(icon)}</span>
      <span class="min-w-0 flex-1 truncate">${escapeHtml(name)}</span>
      <span class="skillquick-preset-count">${skillCount}</span>
    </button>
  `;
}

function renderPresetIcon(icon: string) {
  if (icon === 'briefcase') {
    return `
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9.5 7.5V6.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2v1.3M5.5 8h13A2.5 2.5 0 0 1 21 10.5v6A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-6A2.5 2.5 0 0 1 5.5 8Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  return `
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7.5 12 3l8 4.5-8 4.5L4 7.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="m4 12 8 4.5 8-4.5M4 16.5 12 21l8-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function renderRecentQueries() {
  if (state.query.trim() || state.recentQueries.length === 0) {
    recentRow.classList.add('hidden');
    resultsList.classList.remove('has-recent-searches');
    recentRow.innerHTML = '';
    return;
  }

  resultsList.classList.add('has-recent-searches');
  recentRow.classList.remove('hidden');
  recentRow.classList.add('flex');
  recentRow.innerHTML = `
    <span class="skillquick-recent-label shrink-0 text-xs font-medium">
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 8v4l2.5 1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      最近搜索
    </span>
    ${state.recentQueries.slice(0, 6).map((query) => `
      <button type="button" data-query="${escapeAttr(query)}" class="skillquick-query-chip rounded-full px-2.5 py-1 text-xs transition duration-150">
        ${escapeHtml(query)}
      </button>
    `).join('')}
  `;
}

function renderHeader() {
  if (!state.query.trim()) {
    listHeader.classList.add('hidden');
    listHeader.innerHTML = '';
    return;
  }
  listHeader.classList.remove('hidden');
  listHeader.innerHTML = `<span class="skillquick-section-icon" aria-hidden="true">⌁</span><span>搜索结果</span><span class="skillquick-section-line"></span>`;
}

function renderResults() {
  if (state.results.length === 0) {
    resultsList.innerHTML = `
      <div class="skillquick-empty-state flex h-full flex-col items-center justify-center rounded-2xl text-center">
        <div class="skillquick-empty-icon mb-3">
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m21 21-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="text-sm font-semibold">没有找到匹配的技能</div>
        <p class="mt-1 max-w-[340px] text-xs">换个关键词试试，或到设置里重新扫描 skill-manage 目录。</p>
      </div>
    `;
    return;
  }

  resultsList.innerHTML = `
    <div class="skillquick-result-stack space-y-2">
      ${state.results.map((skill, index) => renderSkillItem(skill, index)).join('')}
    </div>
  `;

  const selected = resultsList.querySelector<HTMLElement>(`[data-skill-index="${state.selectedIndex}"]`);
  selected?.scrollIntoView({ block: 'nearest' });
}

function renderSkillItem(skill: SkillResult, index: number) {
  const active = index === state.selectedIndex;
  const copied = state.copiedPath === skill.skillMdPath;
  const query = state.query.trim();
  const usage = skill.usageCount > 0
    ? `<span class="skillquick-usage-badge rounded-full px-2 py-0.5 text-[11px]">已选 ${skill.usageCount} 次</span>`
    : skill.globalUsageCount > 0 && !query
      ? `<span class="skillquick-global-badge rounded-full px-2 py-0.5 text-[11px]">全局 ${skill.globalUsageCount} 次</span>`
      : '';

  return `
    <button type="button" data-skill-index="${index}" class="skillquick-result-item group ${active ? 'is-active' : ''} ${copied ? 'is-copied' : ''} relative block w-full rounded-2xl border px-4 py-3.5 text-left transition-all duration-150" title="${escapeAttr(skill.skillMdPath)}">
      <span class="skillquick-result-accent absolute left-3 top-3.5 bottom-3.5 w-[3px] rounded-full" aria-hidden="true"></span>
      <div class="pl-4">
        <div class="flex items-start justify-between gap-3">
          <div class="skillquick-result-title min-w-0 truncate text-base font-semibold">${highlight(skill.name, query)}</div>
          ${usage}
        </div>
        <p class="skillquick-result-desc mt-1 line-clamp-2 text-sm leading-5">${highlight(skill.shortDesc || '无描述', query)}</p>
        <p class="skillquick-result-path mt-2 truncate font-mono text-[10px] leading-4" title="${escapeAttr(skill.skillMdPath)}">${escapeHtml(skill.skillMdPath)}</p>
      </div>
    </button>
  `;
}

function renderFooter() {
  const preset = getSelectedPreset();
  const label = preset ? preset.name : '全部技能';
  const count = preset ? preset.skillCount : state.allSkillCount;
  totalSkills.innerHTML = `Preset: <span>${escapeHtml(label)}</span> · ${count} 个技能`;
  shortcutText.innerHTML = renderPresetShortcut();
}

function renderPresetShortcut() {
  return [
    '<kbd>⌘</kbd>',
    '<kbd>K</kbd>',
    '<span class="skillquick-shortcut-label">切换 Preset</span>',
    '<span class="skillquick-footer-separator"></span>',
  ].join('');
}

function renderSettings() {
  const config = state.settingsDraft;
  if (!config) return;

  settingsPanel.classList.remove('hidden');
  settingsPanel.innerHTML = `
    <div class="skillquick-settings-head flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">设置</h2>
        <p class="mt-1 text-xs">配置技能目录、快捷键和搜索行为。修改后点击保存才会重新扫描。</p>
      </div>
      <button type="button" data-action="close-settings" class="skillquick-icon-button rounded-xl p-2" aria-label="关闭设置">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="skillquick-settings-body mt-5 space-y-4 overflow-y-auto pr-1">
      <label class="skillquick-setting-field block">
        <span>skill-manage 目录</span>
        <div class="mt-2 flex gap-2">
          <input name="skillDir" value="${escapeAttr(config.skillDir)}" class="min-w-0 flex-1 rounded-xl border px-3 py-2 font-mono text-xs outline-none" />
          <button type="button" data-action="choose-directory" class="skillquick-secondary-button rounded-xl px-3 text-sm">选择</button>
        </div>
      </label>

      <label class="skillquick-setting-field block">
        <span>全局快捷键</span>
        <input name="shortcut" value="${escapeAttr(config.shortcut)}" placeholder="CommandOrControl+Shift+S" class="mt-2 w-full rounded-xl border px-3 py-2 font-mono text-sm outline-none" />
        <p class="mt-1 text-xs">格式示例：CommandOrControl+Shift+S。保存后会重新注册。</p>
      </label>

      <div class="grid grid-cols-2 gap-3">
        <div class="skillquick-setting-field block">
          <span>主题</span>
          <div class="skillquick-setting-static mt-2 rounded-xl border px-3 py-2 text-sm">
            深色主题
          </div>
        </div>

        <label class="skillquick-setting-field block">
          <span>最大结果数</span>
          <input name="maxResults" type="number" min="5" max="50" value="${config.maxResults}" class="mt-2 w-full rounded-xl border px-3 py-2 text-sm outline-none" />
        </label>
      </div>

      <label class="skillquick-toggle-row flex items-center justify-between rounded-xl border px-3 py-2.5">
        <span class="text-sm">启用模糊搜索</span>
        <input name="fuzzySearch" type="checkbox" ${config.fuzzySearch ? 'checked' : ''} class="h-4 w-4" />
      </label>

      <div class="grid grid-cols-3 gap-2 pt-2">
        <button type="button" data-action="rescan" class="skillquick-secondary-button rounded-xl px-3 py-2 text-sm">重新扫描</button>
        <button type="button" data-action="clear-history" class="skillquick-danger-button rounded-xl px-3 py-2 text-sm">清除历史</button>
        <button type="button" data-action="open-directory" class="skillquick-secondary-button rounded-xl px-3 py-2 text-sm">打开目录</button>
      </div>
    </div>

    <div class="skillquick-settings-actions mt-4 grid grid-cols-[1fr_1.7fr] gap-2 border-t pt-3">
      <button type="button" data-action="close-settings" class="skillquick-secondary-button rounded-xl px-4 py-2.5 text-sm font-semibold">
        取消
      </button>
      <button type="button" data-action="save-settings" class="skillquick-save-button rounded-xl px-4 py-2.5 text-sm font-semibold">
        保存设置
      </button>
    </div>
  `;

}

function showToast(text: string, type: ToastType, duration = 1500) {
  window.clearTimeout(toastTimer);
  toastBox.textContent = text;
  toastBox.className = [
    'skillquick-toast absolute left-1/2 top-4 z-40 flex max-w-[560px] -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm',
    type === 'success' ? 'is-success' : 'is-error',
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

async function startWindowDrag() {
  try {
    await appWindow.startDragging();
    return;
  } catch (error) {
    console.error('[SkillQuick] startDragging failed', error);
  }

  try {
    await invoke('start_search_window_drag');
  } catch (error) {
    console.error('[SkillQuick] native start_search_window_drag failed', error);
  }
}

function canStartWindowDrag(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest([
    'input',
    'select',
    'textarea',
    'a',
    '[data-action]',
    '[data-query]',
    '[data-preset-id]',
    '#presetButton',
    '#presetMenu',
    '#settingsButton',
  ].join(','));
}
