//! `neb://localhost/<id>/<tier>/<crop>/<rev>` (`http://neb.localhost/...` on
//! Windows): preview JPEG bytes without base64 over IPC.
use neb_core::PreviewTier;
use neb_service::{CommandError, Service};
use percent_encoding::percent_decode_str;
use std::sync::Arc;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::Manager;

const MAX_ID_LEN: usize = 64;
const APP_ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

#[derive(Debug, PartialEq, Eq)]
pub struct PreviewRequest {
    pub id: String,
    pub tier: PreviewTier,
    pub uncropped: bool,
}

/// Accepts the request URI path with the four segments either raw or
/// percent-encoded as one segment (`convertFileSrc` encodes `/` as `%2F`).
pub fn parse_request(path: &str) -> Result<PreviewRequest, &'static str> {
    let decoded = percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| "Preview path is not UTF-8")?;
    let rest = decoded
        .strip_prefix('/')
        .ok_or("Preview path must start with /")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let [id, tier, crop, rev] = parts.as_slice() else {
        return Err("Preview path must be <id>/<tier>/<crop>/<rev>");
    };
    if id.is_empty()
        || id.len() > MAX_ID_LEN
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid asset id");
    }
    let tier = PreviewTier::parse(tier).ok_or("Unknown preview tier")?;
    let uncropped = match *crop {
        "0" => false,
        "1" => true,
        _ => return Err("Crop flag must be 0 or 1"),
    };
    if rev.is_empty() || !rev.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Revision must be digits");
    }
    Ok(PreviewRequest {
        id: (*id).to_owned(),
        tier,
        uncropped,
    })
}

pub fn status_for(code: &str) -> StatusCode {
    match code {
        "E_NOT_FOUND" => StatusCode::NOT_FOUND,
        "E_DOWNLOAD_REQUIRED" => StatusCode::CONFLICT,
        "E_UNSUPPORTED_CODEC" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "E_CACHE_BUSY" | "E_WORKER" | "E_OFFLINE" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response<Vec<u8>> {
    let body = serde_json::to_vec(&serde_json::json!({"code": code, "message": message}))
        .unwrap_or_default();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("static error response headers are valid")
}

fn command_error(error: &CommandError) -> Response<Vec<u8>> {
    error_response(status_for(error.code), error.code, &error.message)
}

fn etag_matches(if_none_match: Option<&str>, etag: &str) -> bool {
    if_none_match.is_some_and(|value| {
        value
            .split(',')
            .map(str::trim)
            .any(|candidate| candidate == etag || candidate == "*")
    })
}

/// Checks the ETag first so a revalidation never decodes pixels.
pub fn respond(
    request: &PreviewRequest,
    if_none_match: Option<&str>,
    service: &Service,
) -> Response<Vec<u8>> {
    let etag = match service.preview_etag(&request.id, request.tier, request.uncropped) {
        Ok(etag) => etag,
        Err(error) => return command_error(&error),
    };
    if etag_matches(if_none_match, &etag) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Vec::new())
            .unwrap_or_else(|_| {
                error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "E_OPERATION",
                    "Invalid ETag",
                )
            });
    }
    let image = match service.preview_image(&request.id, request.tier, request.uncropped) {
        Ok(image) => image,
        Err(error) => return command_error(&error),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ETAG, &etag)
        .header("X-Neb-Width", image.width)
        .header("X-Neb-Height", image.height)
        .header("X-Neb-Source", image.source.as_str())
        .body(image.jpeg.clone())
        .unwrap_or_else(|_| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "E_OPERATION",
                "Invalid preview response headers",
            )
        })
}

fn allowed_origin(origin: Option<&str>) -> Option<&str> {
    origin.filter(|origin| APP_ORIGINS.contains(origin))
}

fn handle(request: &Request<Vec<u8>>, service: Option<&Service>) -> Response<Vec<u8>> {
    let mut response = match parse_request(request.uri().path()) {
        Err(message) => error_response(StatusCode::BAD_REQUEST, "E_INVALID", message),
        Ok(_) if service.is_none() => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "E_WORKER",
            "Service is still starting",
        ),
        Ok(preview) => {
            let if_none_match = request
                .headers()
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok());
            respond(&preview, if_none_match, service.expect("checked above"))
        }
    };
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if let Some(origin) = allowed_origin(origin).and_then(|o| o.parse().ok()) {
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, header::HeaderValue::from_static("Origin"));
    }
    response
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("neb", |ctx, request, responder| {
        // `Service` is managed in setup; a request before that gets 503.
        let service = ctx
            .app_handle()
            .try_state::<Arc<Service>>()
            .map(|state| Arc::clone(state.inner()));
        tauri::async_runtime::spawn(async move {
            let response =
                tauri::async_runtime::spawn_blocking(move || handle(&request, service.as_deref()))
                    .await
                    .unwrap_or_else(|_| {
                        error_response(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "E_WORKER",
                            "Preview worker stopped unexpectedly",
                        )
                    });
            responder.respond(response);
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;

    fn ppm(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = format!("P6\n{width} {height}\n255\n").into_bytes();
        for y in 0..height {
            for x in 0..width {
                bytes.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 90]);
            }
        }
        bytes
    }

    fn error_code(response: &Response<Vec<u8>>) -> String {
        let body: Value = serde_json::from_slice(response.body()).unwrap();
        body["code"].as_str().unwrap().to_owned()
    }

    #[test]
    fn parses_valid_paths() {
        let expected = PreviewRequest {
            id: "0f8c-ab".into(),
            tier: PreviewTier::T512,
            uncropped: false,
        };
        assert_eq!(parse_request("/0f8c-ab/t512/0/17"), Ok(expected));
        let expected = PreviewRequest {
            id: "0f8c-ab".into(),
            tier: PreviewTier::T512,
            uncropped: false,
        };
        assert_eq!(parse_request("/0f8c-ab%2Ft512%2F0%2F17"), Ok(expected));
        assert_eq!(
            parse_request("/x/p2560/1/0"),
            Ok(PreviewRequest {
                id: "x".into(),
                tier: PreviewTier::P2560,
                uncropped: true,
            })
        );
    }

    #[test]
    fn rejects_malformed_paths() {
        let long = format!("/{}/t512/0/1", "a".repeat(65));
        for path in [
            "/../etc/t512/0/1",
            "/..%2Fetc%2Ft512%2F0%2F1",
            "/a/t9999/0/1",
            "/a/t512/2/1",
            "/a/t512/0",
            "/a/t512/0/1/extra",
            "/a b/t512/0/1",
            "/a%20b/t512/0/1",
            "/a/t512/0/x",
            "/a/t512/0/",
            "a/t512/0/1",
            "/%FF/t512/0/1",
            long.as_str(),
        ] {
            assert!(parse_request(path).is_err(), "{path} must be rejected");
        }
        assert!(parse_request(&format!("/{}/t512/0/1", "a".repeat(64))).is_ok());
    }

    #[test]
    fn status_mapping_follows_error_codes() {
        for (code, status) in [
            ("E_NOT_FOUND", 404),
            ("E_DOWNLOAD_REQUIRED", 409),
            ("E_UNSUPPORTED_CODEC", 415),
            ("E_CACHE_BUSY", 503),
            ("E_WORKER", 503),
            ("E_OFFLINE", 503),
            ("E_INVALID", 500),
            ("E_OPERATION", 500),
        ] {
            assert_eq!(status_for(code).as_u16(), status, "{code}");
        }
    }

    #[test]
    fn respond_maps_errors_and_not_modified() {
        let data = tempfile::tempdir().unwrap();
        let photos = tempfile::tempdir().unwrap();
        let source = photos.path().join("source.ppm");
        fs::write(&source, ppm(600, 300)).unwrap();
        let service = Service::open(data.path()).unwrap();
        let opened = service
            .execute("file.open", json!({"path":source}))
            .unwrap();
        let jpeg = service
            .preview_image(opened["id"].as_str().unwrap(), PreviewTier::T1024, false)
            .unwrap()
            .jpeg
            .clone();
        let photo = photos.path().join("photo.jpg");
        fs::write(&photo, jpeg).unwrap();
        let asset = service.execute("file.open", json!({"path":photo})).unwrap();
        let request = PreviewRequest {
            id: asset["id"].as_str().unwrap().into(),
            tier: PreviewTier::T512,
            uncropped: false,
        };

        let ok = respond(&request, None, &service);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(ok.headers()["X-Neb-Width"], "512");
        assert_eq!(ok.headers()["X-Neb-Height"], "256");
        assert!(ok.headers().contains_key("X-Neb-Source"));
        assert!(ok.body().starts_with(&[0xFF, 0xD8]));
        let etag = ok.headers()[header::ETAG].to_str().unwrap().to_owned();
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        let cached = respond(&request, Some(&etag), &service);
        assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(cached.headers()[header::ETAG], etag.as_str());
        assert!(cached.body().is_empty());

        let stale = respond(&request, Some("\"other\""), &service);
        assert_eq!(stale.status(), StatusCode::OK);

        let missing = PreviewRequest {
            id: "0000-missing".into(),
            tier: PreviewTier::T512,
            uncropped: false,
        };
        let missing = respond(&missing, None, &service);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(error_code(&missing), "E_NOT_FOUND");
    }

    #[test]
    fn cors_allows_only_app_origins() {
        assert_eq!(
            allowed_origin(Some("tauri://localhost")),
            Some("tauri://localhost")
        );
        assert_eq!(
            allowed_origin(Some("http://tauri.localhost")),
            Some("http://tauri.localhost")
        );
        assert_eq!(allowed_origin(Some("https://example.com")), None);
        assert_eq!(allowed_origin(None), None);
    }
}
