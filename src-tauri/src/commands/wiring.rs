use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wire {
    pub id: String,
    pub from_tile: String,
    pub from_port: String,
    pub to_tile: String,
    pub to_port: String,
    pub wire_type: WireType,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WireType {
    ContextPipe,    // Terminal output → Agent context
    RefreshTrigger, // Agent save → Browser reload
    TaskAssign,     // Todo item → Agent prompt
    DiffFeed,       // Agent complete → Diff tile
    AgentChain,     // Agent output → Agent input
}

// Wire commands will be implemented in M2 (Orchestration milestone)
// The wiring logic is primarily frontend SVG + state management
// Rust side handles: data serialization for persistence and
// event routing when wire triggers fire
