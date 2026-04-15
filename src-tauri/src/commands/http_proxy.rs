use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;

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

fn is_private_or_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                // CGNAT (100.64.0.0/10) — commonly used for internal services
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 0x40)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique local (fc00::/7) and link-local (fe80::/10)
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

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

    // Scheme validation
    match url.scheme() {
        "https" | "http" => {},
        _ => return Err(format!("Scheme '{}' not allowed — only http(s)", url.scheme())),
    }

    // SSRF guard: block private/loopback/link-local hosts for HTTPS, and block
    // non-loopback hosts for HTTP. This prevents a compromised renderer from
    // reaching Docker sockets, cloud metadata services, internal dashboards,
    // or other private-network targets.
    let host = url.host_str().ok_or("URL must have a host")?;
    let is_loopback_literal = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    if url.scheme() == "http" && !is_loopback_literal {
        return Err("HTTP is only allowed for localhost".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_or_loopback(ip) && url.scheme() == "https" {
            return Err("HTTPS to private/loopback addresses is blocked".to_string());
        }
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
