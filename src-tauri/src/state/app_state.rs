use crate::commands::agents::AgentInfo;
use crate::commands::timeline::TimelineEvent;
use super::pty_manager::PtyManager;
use notify::RecommendedWatcher;
use parking_lot::Mutex;
use std::collections::HashMap;
use tauri::AppHandle;

pub struct AppState {
    pub pty_manager: Mutex<PtyManager>,
    pub agent_registry: Mutex<HashMap<String, AgentInfo>>,
    pub timeline: Mutex<Vec<TimelineEvent>>,
    pub watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl AppState {
    pub fn new(_app_handle: AppHandle) -> Self {
        Self {
            pty_manager: Mutex::new(PtyManager::new()),
            agent_registry: Mutex::new(HashMap::new()),
            timeline: Mutex::new(Vec::new()),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}
