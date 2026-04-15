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

const MAX_RESPONSE_SIZE: usize = 10 * 1024 * 1024; // 10MB
const MAX_REQUEST_BODY: usize = 5 * 1024 * 1024;   // 5MB

/// Proxy HTTP requests from the frontend through the Rust backend.
/// This bypasses WebView CSP and CORS restrictions for MCP API calls.
#[tauri::command]
pub async fn http_fetch(req: ProxyRequest) -> Result<ProxyResponse, String> {
    // Parse URL for proper validation
    let url = url::Url::parse(&req.url)
        .map_err(|e| format!("Invalid URL: {}", e))?;

    // Reject URLs with userinfo (prevents auth bypass like http://127.0.0.1@attacker.com)
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with credentials are not allowed".to_string());
    }

    // Scheme validation: HTTPS or localhost HTTP only
    match url.scheme() {
        "https" => {},
        "http" => {
            let host = url.host_str().unwrap_or("");
            if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
                return Err("HTTP is only allowed for localhost".to_string());
            }
        }
        _ => return Err(format!("Scheme '{}' not allowed — only http(s)", url.scheme())),
    }

    // Body size validation
    if let Some(body) = &req.body {
        if body.len() > MAX_REQUEST_BODY {
            return Err(format!("Request body too large (max {}MB)", MAX_REQUEST_BODY / (1024 * 1024)));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let method = req.method.as_deref().unwrap_or("GET");

    let mut builder = match method {
        "POST" => client.post(url.as_str()),
        "PUT" => client.put(url.as_str()),
        "DELETE" => client.delete(url.as_str()),
        "PATCH" => client.patch(url.as_str()),
        _ => client.get(url.as_str()),
    };

    // Apply custom headers first, then body (body setter should be last)
    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    if let Some(body) = &req.body {
        builder = builder
            .header("Content-Type", "application/json")
            .body(body.clone());
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = response.status().as_u16();

    // Check Content-Length if present
    if let Some(len) = response.content_length() {
        if len as usize > MAX_RESPONSE_SIZE {
            return Err(format!("Response too large ({} bytes, max {}MB)", len, MAX_RESPONSE_SIZE / (1024 * 1024)));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    if bytes.len() > MAX_RESPONSE_SIZE {
        return Err(format!("Response too large (max {}MB)", MAX_RESPONSE_SIZE / (1024 * 1024)));
    }

    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(ProxyResponse { status, body })
}
