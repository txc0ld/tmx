use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use url::Url;

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

fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

fn is_loopback_hostname(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
}

/// Validate the destination and return the resolved addresses we're pinning
/// the request to. Returns an empty `Vec` for IP-literal hosts — reqwest will
/// use the literal directly and no DNS happens at connect time.
///
/// Pinning is what defeats DNS rebinding: without it, validation would
/// resolve to a public IP, then the subsequent request phase would do a
/// fresh lookup that could return 127.0.0.1. By passing the validated
/// addresses into `resolve_to_addrs`, the request phase skips DNS entirely.
async fn validate_destination(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url.host_str().ok_or("URL must have a host")?;
    let port = url.port_or_known_default().ok_or("URL must have a port")?;

    if url.scheme() == "http" {
        if let Ok(ip) = host.parse::<IpAddr>() {
            if !is_loopback_ip(ip) {
                return Err("HTTP is only allowed for localhost".to_string());
            }
        } else if !is_loopback_hostname(host) {
            return Err("HTTP is only allowed for localhost".to_string());
        }
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if url.scheme() == "https" && is_private_or_loopback(ip) {
            return Err("HTTPS to private/loopback addresses is blocked".to_string());
        }
        // IP literal — no DNS pinning needed, reqwest connects directly.
        return Ok(Vec::new());
    }

    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS lookup failed: {}", e))?
        .collect();
    if addrs.is_empty() {
        return Err("DNS lookup returned no addresses".to_string());
    }
    for addr in &addrs {
        let ip = addr.ip();
        if url.scheme() == "http" && !is_loopback_ip(ip) {
            return Err("HTTP is only allowed for localhost".to_string());
        }
        if url.scheme() == "https" && is_private_or_loopback(ip) {
            return Err("HTTPS to private/loopback addresses is blocked".to_string());
        }
    }
    Ok(addrs)
}

fn validate_header_name(name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    let blocked = [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "proxy-authorization",
        "proxy-authenticate",
    ];
    if blocked.contains(&lower.as_str()) {
        return Err(format!("Header '{}' is not allowed", name));
    }
    Ok(())
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
    let pinned_addrs = validate_destination(&url).await?;

    // Body size validation
    if let Some(body) = &req.body {
        if body.len() > MAX_REQUEST_BODY {
            return Err(format!("Request body too large (max {}MB)", MAX_REQUEST_BODY / (1024 * 1024)));
        }
    }

    let mut client_builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());

    // Pin DNS resolution to the addresses we just validated so reqwest
    // doesn't do a second (potentially rebinding) lookup at connect time.
    if !pinned_addrs.is_empty() {
        if let Some(host) = url.host_str() {
            client_builder = client_builder.resolve_to_addrs(host, &pinned_addrs);
        }
    }

    let client = client_builder
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();

    let mut builder = match method.as_str() {
        "GET" => client.get(url.as_str()),
        "POST" => client.post(url.as_str()),
        "PUT" => client.put(url.as_str()),
        "DELETE" => client.delete(url.as_str()),
        "PATCH" => client.patch(url.as_str()),
        _ => return Err(format!("HTTP method '{}' is not allowed", method)),
    };

    // Apply custom headers first, then body (body setter should be last)
    if let Some(headers) = &req.headers {
        for (k, v) in headers {
            validate_header_name(k)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn v4_private_and_loopback_detected() {
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(172, 16, 5, 5))));
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)))); // link-local
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));   // multicast
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
    }

    #[test]
    fn v4_cgnat_range_detected() {
        // 100.64.0.0/10 is CGNAT — commonly used for internal services
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 255))));
        // Just below the range — public
        assert!(!is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(100, 63, 0, 1))));
        // Just above — public
        assert!(!is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));
    }

    #[test]
    fn v4_public_ips_allowed() {
        assert!(!is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(!is_private_or_loopback(IpAddr::V4(Ipv4Addr::new(140, 82, 121, 4)))); // github.com
    }

    #[test]
    fn v6_private_and_loopback_detected() {
        assert!(is_private_or_loopback(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_private_or_loopback(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        // Unique-local fc00::/7
        assert!(is_private_or_loopback(IpAddr::V6("fc00::1".parse().unwrap())));
        assert!(is_private_or_loopback(IpAddr::V6("fd12:3456:789a::1".parse().unwrap())));
        // Link-local fe80::/10
        assert!(is_private_or_loopback(IpAddr::V6("fe80::1".parse().unwrap())));
        // Multicast
        assert!(is_private_or_loopback(IpAddr::V6("ff02::1".parse().unwrap())));
    }

    #[test]
    fn v6_public_ips_allowed() {
        // Google DNS
        assert!(!is_private_or_loopback(IpAddr::V6("2001:4860:4860::8888".parse().unwrap())));
        // Cloudflare DNS
        assert!(!is_private_or_loopback(IpAddr::V6("2606:4700:4700::1111".parse().unwrap())));
    }

    #[test]
    fn loopback_hostname_matches_case_insensitive() {
        assert!(is_loopback_hostname("localhost"));
        assert!(is_loopback_hostname("LOCALHOST"));
        assert!(is_loopback_hostname("LocalHost"));
        assert!(!is_loopback_hostname("example.com"));
        assert!(!is_loopback_hostname("localhost.attacker.com"));
    }

    #[test]
    fn blocked_headers_rejected() {
        for blocked in ["host", "Host", "HOST", "content-length", "Transfer-Encoding", "connection", "Proxy-Authorization", "proxy-authenticate"] {
            assert!(validate_header_name(blocked).is_err(), "{} should be blocked", blocked);
        }
    }

    #[test]
    fn benign_headers_allowed() {
        for name in ["Authorization", "Content-Type", "User-Agent", "X-GitHub-Api-Version", "Accept"] {
            assert!(validate_header_name(name).is_ok(), "{} should be allowed", name);
        }
    }

    #[tokio::test]
    async fn validate_destination_rejects_private_ipv4_literal() {
        let url = Url::parse("https://10.0.0.1/secret").unwrap();
        assert!(validate_destination(&url).await.is_err());
    }

    #[tokio::test]
    async fn validate_destination_rejects_cgnat_literal() {
        let url = Url::parse("https://100.64.1.2/api").unwrap();
        assert!(validate_destination(&url).await.is_err());
    }

    #[tokio::test]
    async fn validate_destination_http_requires_loopback() {
        // HTTP to non-loopback hostname must be rejected
        let url = Url::parse("http://example.com/").unwrap();
        assert!(validate_destination(&url).await.is_err());
        // HTTP to non-loopback IP must be rejected
        let url = Url::parse("http://8.8.8.8/").unwrap();
        assert!(validate_destination(&url).await.is_err());
        // HTTP to loopback IP is OK (returns empty Vec — no pinning needed)
        let url = Url::parse("http://127.0.0.1:8080/").unwrap();
        let addrs = validate_destination(&url).await.expect("127.0.0.1 allowed over http");
        assert!(addrs.is_empty());
    }

    #[tokio::test]
    async fn validate_destination_https_ip_literal_returns_no_pinning() {
        // When the host is already an IP literal, no DNS pinning is needed.
        let url = Url::parse("https://1.1.1.1/").unwrap();
        let addrs = validate_destination(&url).await.expect("public ipv4 allowed over https");
        assert!(addrs.is_empty(), "IP-literal host should return empty pinning vec");
    }
}
