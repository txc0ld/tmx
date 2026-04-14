use chrono::Utc;
use serde::{Deserialize, Serialize};
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub timestamp: String,
    pub event_type: TimelineEventType,
    pub tile_id: Option<String>,
    pub agent_id: Option<String>,
    pub summary: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimelineEventType {
    CommandExecuted,
    FileModified,
    AgentPrompt,
    AgentComplete,
    BuildResult,
    GitOperation,
    WireTriggered,
    SnapshotSaved,
}

#[tauri::command]
pub async fn record_event(
    state: tauri::State<'_, crate::state::app_state::AppState>,
    event_type: TimelineEventType,
    tile_id: Option<String>,
    agent_id: Option<String>,
    summary: String,
    detail: Option<String>,
) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let event = TimelineEvent {
        id: id.clone(),
        timestamp: Utc::now().to_rfc3339(),
        event_type,
        tile_id,
        agent_id,
        summary,
        detail,
    };
    let mut timeline = state.timeline.lock();
    timeline.push(event);
    if timeline.len() > 10000 {
        let excess = timeline.len() - 10000;
        timeline.drain(0..excess);
    }
    drop(timeline);
    Ok(id)
}

#[tauri::command]
pub async fn get_timeline(
    state: tauri::State<'_, crate::state::app_state::AppState>,
    limit: Option<usize>,
) -> Result<Vec<TimelineEvent>, String> {
    let timeline = state.timeline.lock();
    let limit = limit.unwrap_or(200);
    let start = if timeline.len() > limit { timeline.len() - limit } else { 0 };
    Ok(timeline[start..].to_vec())
}

#[tauri::command]
pub async fn clear_timeline(
    state: tauri::State<'_, crate::state::app_state::AppState>,
) -> Result<(), String> {
    state.timeline.lock().clear();
    Ok(())
}
