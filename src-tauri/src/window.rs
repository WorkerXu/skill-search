use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const SEARCH_WINDOW_LABEL: &str = "search";

pub fn show_search_window(app: &AppHandle) -> Result<(), String> {
    let window = get_or_create_search_window(app)?;

    window.center().map_err(|err| err.to_string())?;
    window.show().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())?;
    app.emit("skillquick://focus-search", ())
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn hide_search_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) else {
        return Ok(());
    };
    window.hide().map_err(|err| err.to_string())
}

fn get_or_create_search_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SEARCH_WINDOW_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        SEARCH_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("SkillQuick")
    .inner_size(760.0, 540.0)
    .min_inner_size(760.0, 540.0)
    .max_inner_size(760.0, 540.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .accept_first_mouse(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .shadow(false)
    .build()
    .map_err(|err| format!("创建搜索窗口失败：{err}"))
}
