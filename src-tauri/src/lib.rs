mod commands;
mod skill_parser;
mod window;

use commands::AppState;
use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Err(err) = crate::window::show_search_window(app) {
                            eprintln!("[SkillQuick] failed to show search window: {err}");
                        }
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::resolve_default_skill_dir,
            commands::search_skills,
            commands::select_skill,
            commands::clear_history,
            commands::update_config,
            commands::rescan,
            commands::update_global_shortcut,
            commands::show_search_window,
            commands::hide_search_window,
            commands::start_search_window_drag,
            commands::open_path
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            commands::initialize_state(&app.handle().clone(), &app.state::<AppState>())
                .map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SkillQuick");
}
