use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub url: String,
    pub method: Option<String>,          // GET, POST — defaults to GET
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,            // JSON body for POST
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}

/// Proxy HTTP requests from the frontend through the Rust backend.
/// This bypasses WebView CSP and CORS restrictions for MCP API calls.
#[tauri::command]
pub async fn http_fetch(req: ProxyRequest) -> Result<ProxyResponse, String> {
    // Only allow HTTPS URLs (security)
    if !req.url.starts_with("https://") && !req.url.starts_with("http://127.0.0.1") {
        return Err("Only HTTPS URLs and localhost are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let method = req.method.as_deref().unwrap_or("GET");

    let mut builder = match method {
        "POST" => client.post(&req.url),
        "PUT" => client.put(&req.url),
        "DELETE" => client.delete(&req.url),
        "PATCH" => client.patch(&req.url),
        _ => client.get(&req.url),
    };

    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    if let Some(body) = &req.body {
        builder = builder.header("Content-Type", "application/json").body(body.clone());
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(ProxyResponse { status, body })
}
