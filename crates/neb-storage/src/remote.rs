use super::{validate_key, BrowsePage, Credentials, StorageConfig, StorageEntry};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    Method,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use url::Url;

pub fn validate_endpoint(endpoint: &str) -> Result<Url> {
    let url = Url::parse(endpoint).context("Invalid storage endpoint")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Endpoint must not contain credentials, query parameters or fragments");
    }
    if !matches!(url.scheme(), "https" | "http") {
        bail!("Remote storage requires HTTP or HTTPS");
    }
    if url.host_str().is_none() {
        bail!("Endpoint host is required");
    }
    Ok(url)
}

pub(crate) fn url_for(config: &StorageConfig, key: &str) -> Result<Url> {
    let mut url = validate_endpoint(&config.endpoint)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid endpoint path"))?;
        segments.pop_if_empty();
        if config.kind == "s3" {
            segments.push(config.bucket.as_deref().context("S3 bucket is missing")?);
        }
        if !config.root.is_empty() {
            for part in config.root.split('/') {
                segments.push(part);
            }
        }
        if !key.is_empty() {
            for part in key.trim_end_matches('/').split('/') {
                segments.push(part);
            }
        }
    }
    Ok(url)
}

fn checked(response: Response) -> Result<Response> {
    if !response.status().is_success() {
        bail!(
            "Storage request failed with HTTP {}",
            response.status().as_u16()
        );
    }
    Ok(response)
}

fn body(response: Response) -> Result<String> {
    const MAX_XML: u64 = 16 * 1024 * 1024;
    let mut bytes = Vec::new();
    checked(response)?
        .take(MAX_XML + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_XML {
        bail!("Storage listing exceeded the 16 MiB response limit");
    }
    String::from_utf8(bytes).context("Storage listing is not UTF-8")
}

pub(crate) fn dav_request(
    client: &Client,
    credentials: &Credentials,
    method: Method,
    url: Url,
) -> RequestBuilder {
    let request = client.request(method, url);
    if let Some(username) = &credentials.username {
        request.basic_auth(username, credentials.password.as_ref())
    } else {
        request
    }
}

pub fn reader(
    client: &Client,
    config: &StorageConfig,
    credentials: &Credentials,
    key: &str,
) -> Result<Box<dyn Read>> {
    Ok(Box::new(read_response(client, config, credentials, key)?))
}

pub(crate) fn read_response(
    client: &Client,
    config: &StorageConfig,
    credentials: &Credentials,
    key: &str,
) -> Result<Response> {
    let url = url_for(config, key)?;
    let response = if config.kind == "s3" {
        s3_request(client, credentials, config, url, &[])?.send()?
    } else {
        dav_request(client, credentials, Method::GET, url).send()?
    };
    checked(response)
}

pub fn browse(
    client: &Client,
    config: &StorageConfig,
    credentials: &Credentials,
    prefix: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<BrowsePage> {
    if config.kind == "s3" {
        browse_s3(client, config, credentials, prefix, limit, cursor)
    } else {
        browse_dav(client, config, credentials, prefix, limit, cursor)
    }
}

#[derive(Deserialize, Default)]
struct Multistatus {
    #[serde(rename = "response", default)]
    responses: Vec<DavResponse>,
}
#[derive(Deserialize)]
struct DavResponse {
    href: String,
    #[serde(rename = "propstat", default)]
    properties: Vec<Propstat>,
}
#[derive(Deserialize)]
struct Propstat {
    prop: Prop,
    #[serde(default)]
    status: String,
}
#[derive(Deserialize, Default)]
struct Prop {
    #[serde(default)]
    // DAV servers can return an empty property, including in a failed propstat.
    // Keep the wire value until its status is known instead of rejecting the XML.
    getcontentlength: Option<String>,
    #[serde(default)]
    resourcetype: ResourceType,
}
#[derive(Deserialize, Default)]
struct ResourceType {
    #[serde(default)]
    collection: Option<Empty>,
}
#[derive(Deserialize)]
struct Empty {}

/// The serde XML model matches local names. Resolve namespaces separately for
/// creationdate so a server-specific property with the same name is not used.
/// Indices match the response/propstat order in the model above.
fn dav_creation_dates(xml: &str) -> Result<HashMap<(usize, usize), Option<String>>> {
    use quick_xml::{events::Event, name::ResolveResult, NsReader};
    let mut reader = NsReader::from_str(xml);
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut response_index = 0;
    let mut propstat_index = 0;
    let mut dates = HashMap::new();
    // Keep consuming resolved events even within the date so namespace scopes
    // are restored correctly. Mark structured content invalid instead of
    // guessing a date from an element's nested text.
    let mut capture: Option<(usize, String, bool)> = None;
    loop {
        let (namespace, event) = reader.read_resolved_event()?;
        match event {
            Event::Start(element) => {
                let local = element.local_name();
                if let Some((_, _, plain_text)) = &mut capture {
                    *plain_text = false;
                }
                if path.len() == 1 && local.as_ref() == b"response" {
                    response_index += 1;
                    propstat_index = 0;
                } else if path.len() == 2 && local.as_ref() == b"propstat" {
                    propstat_index += 1;
                } else if path.len() == 4
                    && path[1] == b"response"
                    && path[2] == b"propstat"
                    && path[3] == b"prop"
                    && local.as_ref() == b"creationdate"
                    && matches!(namespace, ResolveResult::Bound(namespace) if namespace.as_ref() == b"DAV:")
                {
                    capture = Some((path.len() + 1, String::new(), true));
                }
                path.push(local.as_ref().to_vec());
            }
            Event::End(_) => {
                if capture
                    .as_ref()
                    .is_some_and(|(depth, _, _)| *depth == path.len())
                {
                    let (_, value, plain_text) = capture.take().expect("checked above");
                    let date = plain_text
                        .then(|| chrono::DateTime::parse_from_rfc3339(value.trim()).ok())
                        .flatten()
                        .map(|date| {
                            date.with_timezone(&Utc)
                                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
                        });
                    dates
                        .entry((response_index - 1, propstat_index - 1))
                        .and_modify(|previous| {
                            if previous != &date {
                                *previous = None;
                            }
                        })
                        .or_insert(date);
                }
                path.pop();
            }
            Event::Empty(_) => {
                if let Some((_, _, plain_text)) = &mut capture {
                    *plain_text = false;
                }
            }
            Event::Text(text) => {
                if let Some((_, value, _)) = &mut capture {
                    value.push_str(&text.unescape()?);
                }
            }
            Event::CData(text) => {
                if let Some((_, value, _)) = &mut capture {
                    value.push_str(std::str::from_utf8(text.as_ref())?);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(dates)
}

fn browse_dav(
    client: &Client,
    config: &StorageConfig,
    credentials: &Credentials,
    prefix: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<BrowsePage> {
    let mut url = url_for(config, prefix)?;
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    let response = dav_request(client, credentials, Method::from_bytes(b"PROPFIND")?, url.clone())
        .header("Depth", "1").header("Content-Type", "application/xml; charset=utf-8")
        .body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getcontentlength/><d:resourcetype/><d:creationdate/></d:prop></d:propfind>").send()?;
    let xml = body(response)?;
    let document: Multistatus = quick_xml::de::from_str(&xml).context("Invalid WebDAV listing")?;
    let creation_dates = dav_creation_dates(&xml).context("Invalid WebDAV listing")?;
    let root_url = url_for(config, "")?;
    let root_path = format!("{}/", root_url.path().trim_end_matches('/'));
    let mut entries = Vec::new();
    for (response_index, response) in document.responses.into_iter().enumerate() {
        let href = url.join(&response.href).context("Invalid WebDAV href")?;
        if href.origin() != root_url.origin() {
            bail!("WebDAV listing points outside the configured origin");
        }
        if href.path().trim_end_matches('/') == url.path().trim_end_matches('/') {
            continue;
        }
        let encoded = href
            .path()
            .strip_prefix(&root_path)
            .context("WebDAV listing escaped the configured root")?;
        let key = percent_encoding::percent_decode_str(encoded.trim_end_matches('/'))
            .decode_utf8()?
            .into_owned();
        validate_key(&key, false)?;
        let wanted = prefix.trim_end_matches('/');
        let suffix = if wanted.is_empty() {
            key.as_str()
        } else {
            key.strip_prefix(&format!("{wanted}/"))
                .context("WebDAV entry escaped the requested folder")?
        };
        if suffix.contains('/') {
            continue;
        }
        let mut found = false;
        let mut is_dir = false;
        let mut size = None;
        let mut created_at = None;
        let mut creation_date_seen = false;
        let mut conflicting_creation_dates = false;
        for (propstat_index, propstat) in response
            .properties
            .into_iter()
            .enumerate()
            .filter(|(_, p)| p.status.split_whitespace().nth(1) == Some("200"))
        {
            found = true;
            if let Some(date) = creation_dates.get(&(response_index, propstat_index)) {
                if creation_date_seen && &created_at != date {
                    conflicting_creation_dates = true;
                } else if !creation_date_seen {
                    created_at = date.clone();
                    creation_date_seen = true;
                }
            }
            is_dir |= propstat.prop.resourcetype.collection.is_some();
            if let Some(value) = propstat.prop.getcontentlength {
                let value = value.trim();
                if !value.is_empty() {
                    let parsed = if value.bytes().all(|byte| byte.is_ascii_digit()) {
                        value.parse::<u64>().ok()
                    } else {
                        None
                    }
                    .context("Invalid WebDAV getcontentlength: expected a non-negative integer within u64 range")?;
                    if size.is_some_and(|previous| previous != parsed) {
                        bail!("Conflicting WebDAV getcontentlength properties");
                    }
                    size = Some(parsed);
                }
            }
        }
        if found {
            entries.push(StorageEntry {
                key,
                size: size.unwrap_or(0),
                is_dir,
                created_at: if conflicting_creation_dates {
                    None
                } else {
                    created_at
                },
            });
        }
    }
    entries.sort_by(|a, b| a.key.cmp(&b.key));
    entries.dedup_by(|a, b| a.key == b.key);
    if let Some(cursor) = cursor {
        entries.retain(|e| e.key.as_str() > cursor);
    }
    let more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = if more {
        entries.last().map(|e| e.key.clone())
    } else {
        None
    };
    Ok(BrowsePage {
        entries,
        next_cursor,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct S3List {
    #[serde(default)]
    contents: Vec<S3Object>,
    #[serde(default)]
    common_prefixes: Vec<S3Prefix>,
    #[serde(default)]
    next_continuation_token: Option<String>,
    #[serde(default)]
    is_truncated: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct S3Object {
    key: String,
    size: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct S3Prefix {
    prefix: String,
}

fn browse_s3(
    client: &Client,
    config: &StorageConfig,
    credentials: &Credentials,
    prefix: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<BrowsePage> {
    let mut bucket_config = config.clone();
    bucket_config.root.clear();
    let url = url_for(&bucket_config, "")?;
    let root = if config.root.is_empty() {
        String::new()
    } else {
        format!("{}/", config.root)
    };
    let full_prefix = format!(
        "{}{}",
        root,
        if prefix.is_empty() {
            String::new()
        } else {
            format!("{}/", prefix.trim_end_matches('/'))
        }
    );
    let mut query = vec![
        ("list-type".to_string(), "2".to_string()),
        ("prefix".to_string(), full_prefix.clone()),
        ("delimiter".to_string(), "/".to_string()),
        ("max-keys".to_string(), limit.to_string()),
    ];
    if let Some(cursor) = cursor {
        if cursor.len() > 8192 {
            bail!("Invalid S3 cursor");
        }
        query.push(("continuation-token".to_string(), cursor.to_string()));
    }
    let response = s3_request(client, credentials, config, url, &query)?.send()?;
    let listing: S3List =
        quick_xml::de::from_str(&body(response)?).context("Invalid S3 listing")?;
    let mut entries = Vec::new();
    for object in listing.contents {
        if !object.key.starts_with(&full_prefix) {
            bail!("S3 listing escaped the requested prefix");
        }
        if object.key == full_prefix {
            continue;
        }
        let key = object
            .key
            .strip_prefix(&root)
            .context("S3 listing escaped the configured root")?
            .trim_end_matches('/')
            .to_string();
        validate_key(&key, false)?;
        entries.push(StorageEntry {
            key,
            size: object.size,
            is_dir: object.key.ends_with('/'),
            // S3 lists LastModified, not object creation time.
            created_at: None,
        });
    }
    for directory in listing.common_prefixes {
        if !directory.prefix.starts_with(&full_prefix) {
            bail!("S3 directory escaped the requested prefix");
        }
        let key = directory
            .prefix
            .strip_prefix(&root)
            .context("S3 directory escaped the configured root")?
            .trim_end_matches('/')
            .to_string();
        validate_key(&key, false)?;
        entries.push(StorageEntry {
            key,
            size: 0,
            is_dir: true,
            created_at: None,
        });
    }
    if listing.is_truncated && listing.next_continuation_token.is_none() {
        bail!("S3 truncated listing is missing its continuation token");
    }
    Ok(BrowsePage {
        entries,
        next_cursor: if listing.is_truncated {
            listing.next_continuation_token
        } else {
            None
        },
    })
}

fn aws_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}
fn hmac(key: &[u8], value: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts every key length");
    mac.update(value.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn s3_request(
    client: &Client,
    credentials: &Credentials,
    config: &StorageConfig,
    url: Url,
    query: &[(String, String)],
) -> Result<RequestBuilder> {
    s3_request_with_method(client, credentials, config, Method::GET, url, query)
}

pub(crate) fn s3_request_with_method(
    client: &Client,
    credentials: &Credentials,
    config: &StorageConfig,
    method: Method,
    mut url: Url,
    query: &[(String, String)],
) -> Result<RequestBuilder> {
    let access_key = credentials
        .access_key
        .as_deref()
        .context("S3 credentials are required")?;
    let secret_key = credentials
        .secret_key
        .as_deref()
        .context("S3 credentials are required")?;
    let region = config
        .region
        .as_deref()
        .filter(|r| !r.is_empty())
        .unwrap_or("us-east-1");
    let now = Utc::now();
    let date = now.format("%Y%m%d").to_string();
    let timestamp = now.format("%Y%m%dT%H%M%SZ").to_string();
    let mut pairs: Vec<_> = query
        .iter()
        .map(|(key, value)| (aws_encode(key), aws_encode(value)))
        .collect();
    pairs.sort();
    let canonical_query = pairs
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    if !canonical_query.is_empty() {
        url.set_query(Some(&canonical_query));
    }
    let canonical_uri = url
        .path()
        .split('/')
        .map(|segment| {
            Ok(aws_encode(
                &percent_encoding::percent_decode_str(segment).decode_utf8()?,
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join("/");
    url.set_path(&canonical_uri);
    let host = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or("")),
        None => url.host_str().unwrap_or("").to_string(),
    };
    let empty_hash = hex::encode(Sha256::digest(b""));
    let mut canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{empty_hash}\nx-amz-date:{timestamp}\n");
    let mut signed_headers = "host;x-amz-content-sha256;x-amz-date".to_string();
    if let Some(token) = &credentials.session_token {
        canonical_headers.push_str(&format!("x-amz-security-token:{}\n", token.trim()));
        signed_headers.push_str(";x-amz-security-token");
    }
    // URL segments are percent encoded once; S3 must not normalize or double encode keys.
    let canonical_request = format!(
        "{}\n{}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{empty_hash}",
        method.as_str(),
        url.path()
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let key = hmac(format!("AWS4{secret_key}").as_bytes(), &date);
    let key = hmac(&key, region);
    let key = hmac(&key, "s3");
    let key = hmac(&key, "aws4_request");
    let signature = hex::encode(hmac(&key, &to_sign));
    let authorization = format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let mut request = client
        .request(method, url)
        .header("x-amz-date", timestamp)
        .header("x-amz-content-sha256", empty_hash)
        .header("Authorization", authorization);
    if let Some(token) = &credentials.session_token {
        request = request.header("x-amz-security-token", token);
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_insecure_and_credential_urls() {
        assert!(validate_endpoint("https://user:password@example.org").is_err());
        assert!(validate_endpoint("ftp://example.org").is_err());
        assert!(validate_endpoint("https://example.org/photos").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:3214").is_ok());
    }
    #[test]
    fn parses_namespaced_dav() {
        let xml = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
        let value: Multistatus = quick_xml::de::from_str(xml).unwrap();
        assert!(value.responses[0].properties[0]
            .prop
            .resourcetype
            .collection
            .is_some());
    }
    #[test]
    fn aws_query_encoding_is_not_form_encoding() {
        assert_eq!(aws_encode("a b/+雪"), "a%20b%2F%2B%E9%9B%AA");
    }
}
