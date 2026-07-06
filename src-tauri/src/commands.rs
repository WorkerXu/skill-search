use crate::{skill_parser, window};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const MAX_RECENT_QUERIES: usize = 25;
const MAX_HISTORY_PER_QUERY: usize = 20;
const DEFAULT_MAX_RESULTS: usize = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub skill_dir: String,
    pub shortcut: String,
    pub theme: String,
    pub fuzzy_search: bool,
    pub max_results: usize,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            skill_dir: String::new(),
            shortcut: "CommandOrControl+Shift+S".to_string(),
            theme: "dark".to_string(),
            fuzzy_search: true,
            max_results: DEFAULT_MAX_RESULTS,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistory {
    pub query_history: HashMap<String, HashMap<String, u32>>,
    pub global_usage: HashMap<String, u32>,
    pub recent_queries: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    pub config: AppConfig,
    pub history: UsageHistory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<skill_parser::SkillResult>,
    pub total_skills: usize,
    pub recent_queries: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapState {
    pub config: AppConfig,
    pub total_skills: usize,
    pub recent_queries: Vec<String>,
    pub results: Vec<skill_parser::SkillResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectRequest {
    pub query: String,
    pub skill_md_path: String,
}

#[derive(Default)]
pub struct AppState {
    pub initialized: Mutex<bool>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub current_shortcut: Mutex<Option<String>>,
    pub config: Mutex<AppConfig>,
    pub history: Mutex<UsageHistory>,
    pub skills: Mutex<Vec<skill_parser::SkillMeta>>,
    pub storage_path: Mutex<Option<PathBuf>>,
}

#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<BootstrapState, String> {
    initialize_state(&app, &state)?;
    let config = state.config.lock().expect("config lock poisoned").clone();
    let response = search_with_state(&state, "")?;
    Ok(BootstrapState {
        config,
        total_skills: response.total_skills,
        recent_queries: response.recent_queries,
        results: response.results,
    })
}

#[tauri::command]
pub fn resolve_default_skill_dir() -> Result<String, String> {
    skill_parser::resolve_default_skill_dir().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn search_skills(state: State<'_, AppState>, query: String) -> Result<SearchResponse, String> {
    search_with_state(&state, &query)
}

#[tauri::command]
pub fn select_skill(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SelectRequest,
) -> Result<String, String> {
    app.clipboard()
        .write_text(request.skill_md_path.clone())
        .map_err(|err| format!("写入剪贴板失败：{err}"))?;

    {
        let mut history = state.history.lock().expect("history lock poisoned");
        record_selection(&mut history, &request.query, &request.skill_md_path);
    }

    persist_state(&state)?;
    Ok(request.skill_md_path)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<(), String> {
    *state.history.lock().expect("history lock poisoned") = UsageHistory::default();
    persist_state(&state)
}

#[tauri::command]
pub fn update_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AppConfig,
) -> Result<BootstrapState, String> {
    let mut next_config = config;
    next_config.max_results = next_config.max_results.clamp(5, 50);
    next_config.theme = "dark".to_string();

    let skills = skill_parser::scan_skills(&next_config.skill_dir)?;
    start_watcher_internal(&app, &state, &next_config.skill_dir)?;
    register_shortcut(&app, &state, &next_config.shortcut)?;

    *state.skills.lock().expect("skills lock poisoned") = skills;
    *state.config.lock().expect("config lock poisoned") = next_config.clone();
    persist_state(&state)?;

    let response = search_with_state(&state, "")?;
    Ok(BootstrapState {
        config: next_config,
        total_skills: response.total_skills,
        recent_queries: response.recent_queries,
        results: response.results,
    })
}

#[tauri::command]
pub fn rescan(app: AppHandle, state: State<'_, AppState>) -> Result<SearchResponse, String> {
    let config = state.config.lock().expect("config lock poisoned").clone();
    let skills = skill_parser::scan_skills(&config.skill_dir)?;
    *state.skills.lock().expect("skills lock poisoned") = skills;
    start_watcher_internal(&app, &state, &config.skill_dir)?;
    search_with_state(&state, "")
}

#[tauri::command]
pub fn update_global_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<(), String> {
    register_shortcut(&app, &state, &shortcut)?;
    state.config.lock().expect("config lock poisoned").shortcut = shortcut;
    persist_state(&state)
}

#[tauri::command]
pub fn show_search_window(app: AppHandle) -> Result<(), String> {
    window::show_search_window(&app)
}

#[tauri::command]
pub fn hide_search_window(app: AppHandle) -> Result<(), String> {
    window::hide_search_window(&app)
}

#[tauri::command]
pub fn start_search_window_drag(window: Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|err| format!("启动窗口拖动失败：{err}"))
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map_err(|err| format!("打开路径失败：{err}"))?;
    Ok(())
}

pub fn initialize_state(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    if *state.initialized.lock().expect("initialized lock poisoned") {
        return Ok(());
    }

    let storage_path = storage_path()?;
    *state
        .storage_path
        .lock()
        .expect("storage path lock poisoned") = Some(storage_path.clone());

    let mut persisted = read_persisted_state(&storage_path).unwrap_or_default();
    if persisted.config.skill_dir.trim().is_empty()
        || !Path::new(&persisted.config.skill_dir).is_dir()
    {
        persisted.config.skill_dir = skill_parser::resolve_default_skill_dir()?
            .to_string_lossy()
            .into_owned();
    }
    persisted.config.max_results = persisted.config.max_results.clamp(5, 50);
    persisted.config.theme = "dark".to_string();
    prune_history(&mut persisted.history);

    let skills = skill_parser::scan_skills(&persisted.config.skill_dir)?;
    start_watcher_internal(app, state, &persisted.config.skill_dir)?;
    register_shortcut(app, state, &persisted.config.shortcut)?;

    *state.config.lock().expect("config lock poisoned") = persisted.config;
    *state.history.lock().expect("history lock poisoned") = persisted.history;
    *state.skills.lock().expect("skills lock poisoned") = skills;
    persist_state(state)?;
    *state.initialized.lock().expect("initialized lock poisoned") = true;
    Ok(())
}

fn search_with_state(state: &State<'_, AppState>, query: &str) -> Result<SearchResponse, String> {
    let config = state.config.lock().expect("config lock poisoned").clone();
    let history = state.history.lock().expect("history lock poisoned").clone();
    let skills = state.skills.lock().expect("skills lock poisoned");
    let results = rank_skills(&skills, &history, &config, query);
    Ok(SearchResponse {
        results,
        total_skills: skills.len(),
        recent_queries: history.recent_queries,
    })
}

fn rank_skills(
    skills: &[skill_parser::SkillMeta],
    history: &UsageHistory,
    config: &AppConfig,
    query: &str,
) -> Vec<skill_parser::SkillResult> {
    let normalized_query = normalize_query(query);
    let query_usage = history
        .query_history
        .get(&normalized_query)
        .cloned()
        .unwrap_or_default();
    let limit = config.max_results.clamp(5, 50);

    let mut ranked: Vec<_> = skills
        .iter()
        .filter_map(|skill| {
            let (fuzzy_score, match_rank) =
                score_skill(skill, &normalized_query, config.fuzzy_search)?;
            let path = skill.skill_md_path.as_ref();
            let query_count = query_usage.get(path).copied().unwrap_or(0);
            let global_count = history.global_usage.get(path).copied().unwrap_or(0);
            Some((skill, query_count, global_count, fuzzy_score, match_rank))
        })
        .collect();

    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.3.cmp(&b.3))
            .then_with(|| a.4.cmp(&b.4))
            .then_with(|| a.0.name.as_ref().cmp(b.0.name.as_ref()))
    });

    ranked
        .into_iter()
        .take(limit)
        .map(
            |(skill, query_count, global_count, _, _)| skill_parser::SkillResult {
                id: skill.id.to_string(),
                folder_path: skill.folder_path.to_string(),
                skill_md_path: skill.skill_md_path.to_string(),
                name: skill.name.to_string(),
                short_desc: skill.description.to_string(),
                usage_count: query_count,
                global_usage_count: global_count,
            },
        )
        .collect()
}

fn score_skill(
    skill: &skill_parser::SkillMeta,
    query: &str,
    fuzzy_search: bool,
) -> Option<(u32, u8)> {
    if query.is_empty() {
        return Some((0, 3));
    }
    if skill.name_lower.as_ref() == query {
        return Some((0, 0));
    }
    if let Some(index) = skill.name_lower.find(query) {
        return Some((10 + index as u32, 1));
    }
    if let Some(index) = skill.description_lower.find(query) {
        return Some((1000 + index as u32, 2));
    }
    if fuzzy_search && is_subsequence(query, skill.search_blob.as_ref()) {
        return Some((5000 + query.len() as u32, 3));
    }
    None
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = needle.chars();
    let Some(mut current) = chars.next() else {
        return true;
    };
    for candidate in haystack.chars() {
        if candidate == current {
            match chars.next() {
                Some(next) => current = next,
                None => return true,
            }
        }
    }
    false
}

fn normalize_query(query: &str) -> String {
    query.trim().to_lowercase()
}

fn record_selection(history: &mut UsageHistory, query: &str, skill_md_path: &str) {
    let normalized_query = normalize_query(query);
    if !normalized_query.is_empty() {
        let entry = history
            .query_history
            .entry(normalized_query.clone())
            .or_default();
        *entry.entry(skill_md_path.to_string()).or_default() += 1;
        history
            .recent_queries
            .retain(|item| item != &normalized_query);
        history.recent_queries.insert(0, normalized_query);
    }

    *history
        .global_usage
        .entry(skill_md_path.to_string())
        .or_default() += 1;
    prune_history(history);
}

fn prune_history(history: &mut UsageHistory) {
    history.recent_queries.truncate(MAX_RECENT_QUERIES);
    let recent: HashSet<String> = history.recent_queries.iter().cloned().collect();
    history
        .query_history
        .retain(|query, _| recent.contains(query));

    for skill_counts in history.query_history.values_mut() {
        let mut pairs: Vec<_> = skill_counts
            .iter()
            .map(|(path, count)| (path.clone(), *count))
            .collect();
        pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        skill_counts.clear();
        for (path, count) in pairs.into_iter().take(MAX_HISTORY_PER_QUERY) {
            if count > 0 {
                skill_counts.insert(path, count);
            }
        }
    }
}

fn storage_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "无法定位系统配置目录".to_string())?
        .join("SkillQuick");
    fs::create_dir_all(&dir).map_err(|err| format!("创建配置目录失败：{err}"))?;
    Ok(dir.join("state.json"))
}

fn read_persisted_state(path: &Path) -> Result<PersistedState, String> {
    let content = fs::read_to_string(path).map_err(|err| format!("读取状态文件失败：{err}"))?;
    serde_json::from_str(&content).map_err(|err| format!("解析状态文件失败：{err}"))
}

fn persist_state(state: &State<'_, AppState>) -> Result<(), String> {
    let Some(path) = state
        .storage_path
        .lock()
        .expect("storage path lock poisoned")
        .clone()
    else {
        return Ok(());
    };
    let persisted = PersistedState {
        config: state.config.lock().expect("config lock poisoned").clone(),
        history: state.history.lock().expect("history lock poisoned").clone(),
    };
    let content =
        serde_json::to_vec_pretty(&persisted).map_err(|err| format!("序列化状态失败：{err}"))?;
    fs::write(path, content).map_err(|err| format!("写入状态文件失败：{err}"))
}

fn start_watcher_internal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    dir: &str,
) -> Result<(), String> {
    let path = Path::new(dir)
        .canonicalize()
        .map_err(|err| format!("监听目录不存在或无权限：{dir} ({err})"))?;

    let app_for_events = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Err(err) = result {
            eprintln!("[SkillQuick] watch error: {err}");
            return;
        }
        if let Err(err) = app_for_events.emit("skillquick://skills-changed", ()) {
            eprintln!("[SkillQuick] emit skills changed failed: {err}");
        }
    })
    .map_err(|err| format!("创建文件监听失败：{err}"))?;

    watcher
        .watch(&path, RecursiveMode::Recursive)
        .map_err(|err| format!("监听目录失败：{err}"))?;

    *state.watcher.lock().expect("watcher lock poisoned") = Some(watcher);
    Ok(())
}

fn register_shortcut(
    app: &AppHandle,
    state: &State<'_, AppState>,
    shortcut: &str,
) -> Result<(), String> {
    let parsed: Shortcut = shortcut
        .parse()
        .map_err(|err| format!("快捷键格式无效：{shortcut} ({err})"))?;

    let manager = app.global_shortcut();
    if let Some(previous) = state
        .current_shortcut
        .lock()
        .expect("shortcut lock poisoned")
        .take()
    {
        if let Ok(previous_shortcut) = previous.parse::<Shortcut>() {
            let _ = manager.unregister(previous_shortcut);
        }
    }

    manager
        .register(parsed)
        .map_err(|err| format!("注册全局快捷键失败：{err}"))?;
    *state
        .current_shortcut
        .lock()
        .expect("shortcut lock poisoned") = Some(shortcut.to_string());
    Ok(())
}
