//! Postgly — Tauri application entry point.

pub mod commands;
pub mod connections;
pub mod db;
pub mod error;
pub mod llm;
pub mod settings;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::test_connection,
            commands::explorer::open_connection,
            commands::explorer::close_connection,
            commands::explorer::list_schemas,
            commands::explorer::list_tables,
            commands::explorer::describe_table,
            commands::explorer::run_query,
            commands::explorer::browse_table,
            commands::explorer::update_row,
            commands::explorer::insert_row,
            commands::explorer::delete_row,
            commands::explorer::query_history,
            commands::explorer::get_database_schema,
            commands::explorer::refresh_database_schema,
            commands::settings::get_settings,
            commands::settings::save_llm_config,
            commands::settings::clear_llm_api_key,
            commands::settings::test_llm_config,
            commands::settings::save_safety_config,
            commands::explorer::analyze_statement,
            commands::llm::generate_sql,
            commands::llm::nl_query_history,
            commands::llm::agent_chat_send,
            commands::llm::agent_execute_pending_mutation,
            commands::llm::agent_generate_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
