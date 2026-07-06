use serde::Serialize;
use serde_yaml::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Clone)]
pub struct SkillMeta {
    pub id: Arc<str>,
    pub folder_path: Arc<str>,
    pub skill_md_path: Arc<str>,
    pub name: Arc<str>,
    pub description: Arc<str>,
    pub name_lower: Arc<str>,
    pub description_lower: Arc<str>,
    pub search_blob: Arc<str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResult {
    pub id: String,
    pub folder_path: String,
    pub skill_md_path: String,
    pub name: String,
    pub short_desc: String,
    pub usage_count: u32,
    pub global_usage_count: u32,
}

pub fn resolve_default_skill_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户 Home 目录".to_string())?;
    let candidates = [
        home.join("skill-manage"),
        home.join(".skills-manager").join("skills"),
        home.join(".skills-manager"),
        home.join("skills-manager"),
        home.join("skill-manager"),
    ];

    for candidate in candidates {
        if candidate.is_dir() {
            return canonicalize_dir(&candidate);
        }
    }

    Err(
        "未找到 ~/skill-manage，也未找到 ~/.skills-manager/skills。请在设置中选择正确目录。"
            .to_string(),
    )
}

pub fn scan_skills(dir: &str) -> Result<Vec<SkillMeta>, String> {
    let root = expand_tilde(dir);
    let root = canonicalize_dir(&root)?;
    let entries = fs::read_dir(&root).map_err(|err| format!("读取技能目录失败：{err}"))?;
    let mut skills = Vec::new();

    for entry in entries.flatten() {
        let folder_path = entry.path();
        if !folder_path.is_dir() {
            continue;
        }

        match parse_skill_dir(&folder_path) {
            Ok(Some(skill)) => skills.push(skill),
            Ok(None) => {}
            Err(err) => eprintln!("[SkillQuick] skip {}: {err}", folder_path.display()),
        }
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

fn parse_skill_dir(folder_path: &Path) -> Result<Option<SkillMeta>, String> {
    let Some(skill_md_path) = find_skill_md(folder_path)? else {
        return Ok(None);
    };

    let content = fs::read_to_string(&skill_md_path)
        .map_err(|err| format!("读取 {} 失败：{err}", skill_md_path.display()))?;
    let frontmatter =
        extract_frontmatter(&content).ok_or_else(|| "未找到 YAML frontmatter".to_string())?;
    let yaml: Value = serde_yaml::from_str(frontmatter)
        .map_err(|err| format!("YAML frontmatter 解析失败：{err}"))?;

    let name = yaml
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "缺少必填字段 name".to_string())?
        .to_string();

    let description = truncate_chars(
        yaml.get("description")
            .or_else(|| yaml.get("describe"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim(),
        150,
    );

    let id = folder_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法读取目录名".to_string())?
        .to_string();

    let folder_path = canonicalize_dir(folder_path)?
        .to_string_lossy()
        .into_owned();
    let skill_md_path = skill_md_path
        .canonicalize()
        .map_err(|err| format!("规范化 skill.md 路径失败：{err}"))?
        .to_string_lossy()
        .into_owned();
    let name_lower = name.to_lowercase();
    let description_lower = description.to_lowercase();
    let search_blob = format!("{name_lower}\n{description_lower}");

    Ok(Some(SkillMeta {
        id: Arc::from(id),
        folder_path: Arc::from(folder_path),
        skill_md_path: Arc::from(skill_md_path),
        name: Arc::from(name),
        description: Arc::from(description),
        name_lower: Arc::from(name_lower),
        description_lower: Arc::from(description_lower),
        search_blob: Arc::from(search_blob),
    }))
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut iter = normalized.chars();
    let truncated: String = iter.by_ref().take(max_chars).collect();
    if iter.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn find_skill_md(folder_path: &Path) -> Result<Option<PathBuf>, String> {
    let entries =
        fs::read_dir(folder_path).map_err(|err| format!("读取 skill 子目录失败：{err}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let is_skill_md = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case("skill.md"))
                .unwrap_or(false);
            if is_skill_md {
                return Ok(Some(path));
            }
        }
    }

    Ok(None)
}

fn extract_frontmatter(content: &str) -> Option<&str> {
    let mut ranges = content.match_indices("---");
    let (first_index, _) = ranges.next()?;
    if content[..first_index].trim().is_empty() {
        let start = first_index + 3;
        let remaining = &content[start..];
        let second_relative = remaining.find("\n---")?;
        return Some(remaining[..second_relative].trim());
    }

    None
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    PathBuf::from(path)
}

fn canonicalize_dir(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("目录不存在或无权限：{} ({err})", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("不是目录：{}", canonical.display()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn extracts_yaml_frontmatter() {
        let content = "---\nname: demo\ndescription: hello\n---\n# Body";
        assert_eq!(
            extract_frontmatter(content),
            Some("name: demo\ndescription: hello")
        );
    }

    #[test]
    fn scans_only_first_level_skill_dirs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skillquick-test-{unique}"));
        let skill_dir = root.join("demo-skill");
        let nested_dir = skill_dir.join("nested");
        fs::create_dir_all(&nested_dir).expect("create dirs");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Demo Skill\ndescribe: Demo description\n---\nbody",
        )
        .expect("write skill");
        fs::write(
            nested_dir.join("SKILL.md"),
            "---\nname: Nested\ndescription: should not be scanned as separate skill\n---\nbody",
        )
        .expect("write nested skill");

        let skills = scan_skills(root.to_str().expect("utf8 temp path")).expect("scan");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id.as_ref(), "demo-skill");
        assert_eq!(skills[0].name.as_ref(), "Demo Skill");
        assert_eq!(skills[0].description.as_ref(), "Demo description");

        fs::remove_dir_all(root).ok();
    }
}
