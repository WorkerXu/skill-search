use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct PresetMeta {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub sort_order: i64,
    pub skill_folder_paths: HashSet<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub skill_count: usize,
}

pub fn load_presets() -> Vec<PresetMeta> {
    match load_presets_from_default_db() {
        Ok(presets) => presets,
        Err(err) => {
            eprintln!("[SkillQuick] load presets failed: {err}");
            Vec::new()
        }
    }
}

fn load_presets_from_default_db() -> Result<Vec<PresetMeta>, String> {
    let db_path = default_db_path()?;
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    load_presets_from_db(&db_path)
}

fn default_db_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 Home 目录".to_string())?;
    Ok(home.join(".skills-manager").join("skills-manager.db"))
}

fn load_presets_from_db(path: &Path) -> Result<Vec<PresetMeta>, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection = Connection::open_with_flags(path, flags)
        .map_err(|err| format!("打开 Skills Manager 数据库失败：{} ({err})", path.display()))?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT
                sc.id,
                sc.name,
                COALESCE(sc.icon, ''),
                COALESCE(sc.sort_order, 0),
                sk.central_path
            FROM scenarios sc
            LEFT JOIN scenario_skills ss ON ss.scenario_id = sc.id
            LEFT JOIN skills sk ON sk.id = ss.skill_id
            ORDER BY sc.sort_order, sc.name, ss.sort_order, sk.name
            "#,
        )
        .map_err(|err| format!("读取 preset 表结构失败：{err}"))?;

    let mut rows = statement
        .query([])
        .map_err(|err| format!("查询 preset 失败：{err}"))?;

    let mut presets: Vec<PresetMeta> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("读取 preset 行失败：{err}"))?
    {
        let id: String = row.get(0).map_err(|err| err.to_string())?;
        let name: String = row.get(1).map_err(|err| err.to_string())?;
        let icon: String = row.get(2).map_err(|err| err.to_string())?;
        let sort_order: i64 = row.get(3).map_err(|err| err.to_string())?;
        let central_path: Option<String> = row.get(4).ok();

        if presets.last().map(|preset| preset.id.as_str()) != Some(id.as_str()) {
            presets.push(PresetMeta {
                id: id.clone(),
                name,
                icon,
                sort_order,
                skill_folder_paths: HashSet::new(),
            });
        }

        if let Some(path) = central_path.and_then(|value| canonicalize_existing_dir(&value)) {
            if let Some(preset) = presets.last_mut() {
                preset.skill_folder_paths.insert(path);
            }
        }
    }

    presets.retain(|preset| !preset.skill_folder_paths.is_empty());
    presets.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(presets)
}

fn canonicalize_existing_dir(path: &str) -> Option<String> {
    Path::new(path)
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| path.to_string_lossy().into_owned())
}
