use gitgui_server::{start, ServerConfig};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

async fn preflight(address: SocketAddr, origin: &str, method: &str, path: &str) -> String {
    let request = format!(
        "OPTIONS {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: {origin}\r\nAccess-Control-Request-Method: {method}\r\nAccess-Control-Request-Headers: authorization,b3,content-type,traceparent\r\nConnection: close\r\n\r\n"
    );
    tokio::task::spawn_blocking(move || {
        let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        response.to_ascii_lowercase()
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn renderer_preflights_allow_effect_tracing_only_for_trusted_origins() {
    let data_dir = tempfile::tempdir().unwrap();
    let origins = ["http://127.0.0.1:1420", "gitgui://app"];
    let server = start(ServerConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        data_dir: Some(data_dir.path().to_path_buf()),
        allowed_origins: origins
            .iter()
            .map(|origin| (*origin).to_owned())
            .collect(),
        ..ServerConfig::default()
    })
    .await
    .unwrap();
    let address = server.local_addr();
    let mut responses = Vec::new();
    for origin in origins {
        for (method, path) in [
            ("GET", "/.well-known/gitgui/environment"),
            ("POST", "/oauth/token"),
            ("POST", "/api/auth/websocket-ticket"),
        ] {
            responses.push((
                origin,
                method,
                preflight(address, origin, method, path).await,
            ));
        }
    }
    let untrusted = preflight(address, "https://untrusted.example", "GET", "/health").await;
    server.shutdown().await.unwrap();

    for (origin, method, response) in responses {
        assert!(response.starts_with("http/1.1 200"), "{response}");
        assert!(response.contains(&format!("access-control-allow-origin: {origin}\r\n")));
        let headers = response
            .lines()
            .find_map(|line| line.strip_prefix("access-control-allow-headers: "))
            .unwrap();
        for expected in ["authorization", "b3", "content-type", "traceparent"] {
            assert!(
                headers.split(',').any(|header| header.trim() == expected),
                "missing {expected}: {response}"
            );
        }
        let methods = response
            .lines()
            .find_map(|line| line.strip_prefix("access-control-allow-methods: "))
            .unwrap();
        assert!(methods
            .split(',')
            .any(|allowed| allowed.trim() == method.to_ascii_lowercase()));
    }
    assert!(!untrusted.contains("access-control-allow-origin:"));
}
